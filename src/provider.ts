import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai/compat";
import type {
  Message as CbMessage,
  ThinkingConfig,
  Effort,
} from "@tencent-ai/agent-sdk";
import { buildFullMessage, buildDeltaMessage } from "./context.js";
import { acquireSession, evictSession } from "./session-pool.js";

type CodebuddySdk = typeof import("@tencent-ai/agent-sdk");

async function loadCodebuddySdk(): Promise<CodebuddySdk> {
  return import("@tencent-ai/agent-sdk");
}

// ── helpers ──

function makePartial(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeErrorPartial(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    ...makePartial(model),
    stopReason: "error",
    errorMessage: `CodeBuddy SDK error: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function extractUsageUpdate(msg: CbMessage): Partial<AssistantMessage> | null {
  if (msg.type === "result" && msg.usage) {
    return {
      usage: {
        input: msg.usage.input_tokens ?? 0,
        output: msg.usage.output_tokens ?? 0,
        cacheRead: msg.usage.cache_read_input_tokens ?? 0,
        cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
        totalTokens: (msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: msg.total_cost_usd ?? 0,
        },
      },
    };
  }
  return null;
}

// ── thinking config mapping ──

const DEFAULT_THINKING_BUDGETS: Record<string, number> = {
  minimal: 1600,
  low: 4000,
  medium: 0,  // adaptive
  high: 0,    // adaptive
  xhigh: 32000,
};

const DEFAULT_EFFORT: Record<string, Effort | undefined> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
};

function buildThinkingConfig(
  reasoning: string | undefined,
  thinkingBudgets?: SimpleStreamOptions["thinkingBudgets"],
): { thinking?: ThinkingConfig; effort?: Effort } {
  if (!reasoning) return {};
  if (reasoning === "off") return { thinking: { type: "disabled" } };

  const budget = thinkingBudgets?.[reasoning as keyof typeof thinkingBudgets]
    ?? DEFAULT_THINKING_BUDGETS[reasoning] ?? 0;
  const effort = DEFAULT_EFFORT[reasoning];

  if (budget > 0) return { thinking: { type: "enabled", budgetTokens: budget }, effort };
  return { thinking: { type: "adaptive" }, effort };
}

// ── main provider ──

export function streamCodebuddy(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const partial = makePartial(model);

  queueMicrotask(async () => {
    let session: Awaited<ReturnType<CodebuddySdk["unstable_v2_createSession"]>> | undefined;
    let isFirst = false;

    try {
      stream.push({ type: "start", partial });

      const sdk = await loadCodebuddySdk();

      const { thinking, effort } = buildThinkingConfig(
        options?.reasoning,
        options?.thinkingBudgets,
      );

      const includePartial = !!(model.reasoning && options?.reasoning && options.reasoning !== "off");

      const cwd = process.cwd();

      const { session: pooled, message: userMessage, isFirst: first } =
        await acquireSession(cwd, sdk, context, buildFullMessage, buildDeltaMessage, {
          model: model.id,
          permissionMode: "bypassPermissions",
          maxTurns: 100,
          thinking,
          effort,
          includePartialMessages: includePartial,
        });

      session = pooled;
      isFirst = first;

      let contentIndex = 0;
      let msgCount = 0; // track assistant messages for empty-response detection

      // ── abort handling ──
      let aborted = false;
      const onAbort = async () => {
        if (aborted) return;
        aborted = true;
        try { await session!.interrupt(); } catch { /* best-effort */ }
        partial.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: partial });
      };
      if (options?.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
        if (options.signal.aborted) {
          await onAbort();
          return;
        }
      }

      // ── send prompt ──
      await session.send(userMessage);

      // ── iterate responses ──
      for await (const msg of session.stream()) {
        if (aborted) return;

        if (msg.type === "system") {
          if (msg.model) partial.responseModel = msg.model;
          continue;
        }

        if (msg.type === "assistant") {
          msgCount++;
          for (const block of msg.message.content) {
            // Non-reasoning models may emit thinking blocks wrapping text (Hunyuan quirk).
            // Treat them as text.
            if (block.type === "thinking") {
              if (model.reasoning) {
                const ci = contentIndex++;
                const tc: ThinkingContent = { type: "thinking", thinking: block.thinking };
                partial.content = [...partial.content, tc];
                stream.push({ type: "thinking_start", contentIndex: ci, partial });
                stream.push({ type: "thinking_delta", contentIndex: ci, delta: block.thinking, partial });
                stream.push({ type: "thinking_end", contentIndex: ci, content: block.thinking, partial });
              } else {
                // Fallback: emit as text for non-reasoning models
                const ci = contentIndex++;
                const textBlock: TextContent = { type: "text", text: block.thinking };
                partial.content = [...partial.content, textBlock];
                stream.push({ type: "text_start", contentIndex: ci, partial });
                stream.push({ type: "text_delta", contentIndex: ci, delta: block.thinking, partial });
                stream.push({ type: "text_end", contentIndex: ci, content: block.thinking, partial });
              }
            } else if (block.type === "redacted_thinking") {
              const ci = contentIndex++;
              const tc: ThinkingContent = {
                type: "thinking", thinking: "[redacted]",
                thinkingSignature: block.data, redacted: true,
              };
              partial.content = [...partial.content, tc];
              stream.push({ type: "thinking_start", contentIndex: ci, partial });
              stream.push({ type: "thinking_end", contentIndex: ci, content: "[redacted]", partial });
            } else if (block.type === "text") {
              const ci = contentIndex++;
              const textBlock: TextContent = { type: "text", text: block.text };
              partial.content = [...partial.content, textBlock];
              stream.push({ type: "text_start", contentIndex: ci, partial });
              stream.push({ type: "text_delta", contentIndex: ci, delta: block.text, partial });
              stream.push({ type: "text_end", contentIndex: ci, content: block.text, partial });
            } else if (block.type === "tool_use") {
              const ci = contentIndex++;
              const toolCall: ToolCall = {
                type: "toolCall", id: block.id, name: block.name,
                arguments: (block.input ?? {}) as Record<string, unknown>,
              };
              partial.content = [...partial.content, toolCall];
              stream.push({ type: "toolcall_start", contentIndex: ci, partial });
              stream.push({ type: "toolcall_end", contentIndex: ci, toolCall, partial });
            }
          }
        }

        if (msg.type === "result") {
          const usageUpdate = extractUsageUpdate(msg);
          if (usageUpdate) Object.assign(partial, usageUpdate);

          if (msg.subtype === "success") {
            partial.stopReason = "stop";
            stream.push({ type: "done", reason: "stop", message: { ...partial } });
          } else {
            partial.stopReason = "error";
            partial.errorMessage = msg.errors?.join("; ") ?? `CodeBuddy error: ${msg.subtype}`;
            stream.push({ type: "error", reason: "error", error: { ...partial } });
            // Error on a turn: evict session so next turn starts fresh
            evictSession(cwd);
          }
          // break (not return) to let iterator drain naturally
          break;
        }
      }

      // Some models (Hunyuan) return empty on session reuse → evict for fresh session next turn
      if (msgCount === 0) {
        evictSession(cwd);
      }

      // Stream ended; no extra done emission (handled in result branch above)
    } catch (error) {
      evictSession(process.cwd());
      const errPartial = makeErrorPartial(model, error);
      stream.push({ type: "error", reason: "error", error: errPartial });
    } finally {
      // ponytail: do NOT close pooled sessions — they are reused across turns.
      // Only close when evicted (via evictSession).
      // session?.close() intentionally omitted here.
    }
  });

  return stream;
}
