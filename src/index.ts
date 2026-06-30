/**
 * pi-codebuddy-sdk — CodeBuddy Agent SDK as a Pi provider.
 *
 * Architecture follows pi-claude-bridge:
 * - Stateless: one sdk.query() per Pi turn
 * - No Pi systemPrompt forwarding — CodeBuddy uses its own default
 * - No MCP tool bridge — CodeBuddy SDK tools are used natively
 * - Only the latest user message is forwarded (Pi manages conversation)
 *
 * Two files: index.ts (registration + model discovery), provider.ts (streaming).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProviderApi } from "@earendil-works/pi-ai/compat";
import { streamCodebuddy } from "./provider.js";

// ── provider registration ──

export default function activate(api: ExtensionAPI) {
  // Register synchronously with hardcoded models first.
  // Lazy discovery runs after startup — if it succeeds, re-registers with full list.
  api.registerProvider("codebuddy", {
    name: "CodeBuddy",
    baseUrl: "codebuddy-local",
    apiKey: "codebuddy-local-auth",
    api: "codebuddy-sdk",
    models: FALLBACK_MODELS,
    streamSimple: streamCodebuddy,
  });

  // Async model discovery — updates provider with live model list
  discoverAndUpdate(api);
}

async function discoverAndUpdate(api: ExtensionAPI) {
  try {
    const models = await discoverModels();
    api.registerProvider("codebuddy", {
      name: "CodeBuddy",
      baseUrl: "codebuddy-local",
      apiKey: "codebuddy-local-auth",
      api: "codebuddy-sdk",
      models,
      streamSimple: streamCodebuddy,
    });
  } catch {
    // Fallback models already registered
  }
}

// ── hardcoded fallback models (used before async discovery completes) ──

const FALLBACK_MODELS: ProviderApi["models"] = [
  {
    id: "hy3-preview-agent-ioa", name: "Hunyuan 3", api: "codebuddy-sdk", provider: "codebuddy",
    baseUrl: "https://codebuddy.tencent.com", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072, maxTokens: 8192,
  },
  {
    id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", api: "codebuddy-sdk", provider: "codebuddy",
    baseUrl: "https://codebuddy.tencent.com", reasoning: true, input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000, maxTokens: 8192,
  },
  {
    id: "deepseek-v4-pro-ioa", name: "DeepSeek V4 Pro", api: "codebuddy-sdk", provider: "codebuddy",
    baseUrl: "https://codebuddy.tencent.com", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072, maxTokens: 8192,
  },
];

// ── model discovery ──

let _sdk: typeof import("@tencent-ai/agent-sdk") | undefined;
async function getSdk() {
  if (!_sdk) _sdk = await import("@tencent-ai/agent-sdk");
  return _sdk;
}

async function discoverModels(): Promise<ProviderApi["models"]> {
  const sdk = await getSdk();
  const q = sdk.query({ prompt: " ", options: { maxTurns: 0 } });
  const supported = await q.supportedModels();
  await q.interrupt();

  return supported.map((m) => {
    const caps = detectCapabilities(m.id);
    return {
      id: m.id,
      name: m.name || m.id,
      api: "codebuddy-sdk" as const,
      provider: "codebuddy" as const,
      reasoning: caps.reasoning,
      input: caps.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: caps.contextWindow,
      maxTokens: caps.maxTokens,
    };
  });
}

// ── capability detection ──

const THINKING_PATTERNS = [/claude/i, /gemini/i, /gpt-5/i];
const IMAGE_PATTERNS = [/claude/i, /gemini/i, /gpt/i];
const CONTEXT_ESTIMATES: Record<string, { window: number; maxTokens: number }> = {
  claude: { window: 200000, maxTokens: 8192 },
  gemini: { window: 1048576, maxTokens: 8192 },
  gpt: { window: 200000, maxTokens: 16384 },
  deepseek: { window: 131072, maxTokens: 8192 },
  glm: { window: 131072, maxTokens: 8192 },
  minimax: { window: 131072, maxTokens: 8192 },
  kimi: { window: 131072, maxTokens: 8192 },
  hy: { window: 131072, maxTokens: 8192 },
};

function detectCapabilities(id: string) {
  const reasoning = THINKING_PATTERNS.some((p) => p.test(id));
  const supportsImages = IMAGE_PATTERNS.some((p) => p.test(id));
  const input = supportsImages ? (["text", "image"] as const) : (["text"] as const);
  const family = Object.keys(CONTEXT_ESTIMATES).find((k) => id.toLowerCase().includes(k));
  const est = family ? CONTEXT_ESTIMATES[family] : { window: 131072, maxTokens: 8192 };
  return { reasoning, input, contextWindow: est.window, maxTokens: est.maxTokens };
}
