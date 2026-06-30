// Pure pi -> SDK message conversion helpers.

import type { Message as PiMessage } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "codebuddy";

export const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
  read: "Read", write: "Write", edit: "Edit", bash: "Bash",
};

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
  const existing = cache.get(id);
  if (existing) return existing;
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  cache.set(id, clean);
  return clean;
}

export function mapPiToolNameToSdk(name: string, customToolNameToSdk?: Map<string, string>): string {
  if (!name) return "";
  const normalized = name.toLowerCase();
  if (customToolNameToSdk) {
    const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
    if (mapped) return mapped;
  }
  if (PI_TO_SDK_TOOL_NAME[normalized]) return PI_TO_SDK_TOOL_NAME[normalized];
  // ponytail: simple PascalCase fallback instead of change-case dep
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function messageContentToText(
  content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  let hasText = false;
  for (const block of content) {
    if (block.type === "text" && block.text) { parts.push(block.text); hasText = true; }
    else if (block.type !== "text" && block.type !== "image") { parts.push(`[${block.type}]`); }
  }
  return hasText ? parts.join("\n") : "";
}

// SessionMessage is an internal type used by the provider's session persistence.
// It mirrors the Anthropic API message format.
export interface SessionMessage {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
}

/** Convert pi message array to SDK-compatible format. */
export function convertPiMessages(
  messages: PiMessage[],
  customToolNameToSdk?: Map<string, string>,
): { anthropicMessages: SessionMessage[]; sanitizedIds: Map<string, string> } {
  const anthropicMessages: SessionMessage[] = [];
  const sanitizedIds = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        anthropicMessages.push({ role: "user", content: msg.content || "[empty]" });
      } else if (Array.isArray(msg.content)) {
        const parts: Array<Record<string, unknown>> = [];
        for (const block of msg.content) {
          if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
          else if (block.type === "image" && (block as any).data && (block as any).mimeType) {
            parts.push({ type: "image", source: { type: "base64", media_type: (block as any).mimeType, data: (block as any).data } });
          }
        }
        anthropicMessages.push({ role: "user", content: parts.length ? parts : "[image]" });
      } else {
        anthropicMessages.push({ role: "user", content: "[empty]" });
      }
    } else if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const blocks: Array<Record<string, unknown>> = [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          const sig = (block as any).thinkingSignature;
          const isCodebuddyProvider = msg.provider === PROVIDER_ID || msg.api === "codebuddy-sdk";
          if (isCodebuddyProvider && sig) {
            blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: sig });
          }
        } else if (block.type === "toolCall") {
          const toolName = mapPiToolNameToSdk((block as any).name, customToolNameToSdk);
          blocks.push({ type: "tool_use", id: sanitizeToolId((block as any).id, sanitizedIds), name: toolName, input: (block as any).arguments ?? {} });
        }
      }
      if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
      anthropicMessages.push({ role: "assistant", content: blocks });
    } else if (msg.role === "toolResult") {
      const text = typeof msg.content === "string" ? msg.content : messageContentToText(msg.content);
      anthropicMessages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: sanitizeToolId((msg as any).toolCallId, sanitizedIds), content: text || "", is_error: (msg as any).isError }],
      });
    }
  }

  return { anthropicMessages, sanitizedIds };
}
