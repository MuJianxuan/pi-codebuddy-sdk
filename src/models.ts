// Dynamic model list from CodeBuddy SDK.
// - supportedModels(): simplified ModelInfo (no token limits) — legacy fallback.
// - getAvailableModelsRaw(): RawLanguageModel with real maxInputTokens / maxOutputTokens.
import type { ModelInfo, RawLanguageModel } from "@tencent-ai/agent-sdk";

export type PiModel = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string>;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

const CONSERVATIVE_DEFAULT_CONTEXT = 200_000;
const CONSERVATIVE_GEMINI_CONTEXT = 1_048_576;
const DEFAULT_MAX_TOKENS = 8192;

function detectThinking(id: string): boolean {
	return /claude|gemini|gpt-5|hy3|deepseek|glm/i.test(id);
}

function detectImages(id: string): boolean {
	return /claude|gemini|gpt/i.test(id);
}

export function conservativeContextWindow(id: string): number {
	const lower = id.toLowerCase();
	if (lower.includes("gemini")) return CONSERVATIVE_GEMINI_CONTEXT;
	return CONSERVATIVE_DEFAULT_CONTEXT;
}

export function conservativeMaxTokens(id: string): number {
	if (id.toLowerCase().includes("gpt")) return 16_384;
	return DEFAULT_MAX_TOKENS;
}

export function rawModelsFromSdk(supported: Array<ModelInfo & { id?: string; name?: string }>): PiModel[] {
	return supported
		.map((m) => ({ id: m.id ?? m.value, name: m.name ?? m.displayName ?? m.id ?? m.value }))
		.filter((m) => m.id)
		.map((m) => ({
			id: m.id!,
			name: m.name || m.id!,
			reasoning: detectThinking(m.id!),
			input: detectImages(m.id!) ? ["text", "image"] as const : ["text"] as const,
			contextWindow: conservativeContextWindow(m.id!),
			maxTokens: conservativeMaxTokens(m.id!),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

// Build PiModel[] from the SDK Session API's getAvailableModelsRaw() result.
// Unlike rawModelsFromSdk() (which only gets the simplified ModelInfo and must
// fall back to conservativeContextWindow), this reads the real per-model token
// limits (maxInputTokens = context window, maxOutputTokens = max output) plus
// capability flags (supportsImages / supportsReasoning) directly from the CLI.
// Models marked disabled are filtered out so Pi never offers an unusable model.
export function rawModelsFromSdkRaw(raw: RawLanguageModel[]): PiModel[] {
	return raw
		.filter((m) => m.id && !m.disabled)
		.map((m) => {
			const id = m.id!;
			return {
				id,
				name: m.name || id,
				reasoning: m.supportsReasoning ?? detectThinking(id),
				input: (m.supportsImages ?? detectImages(id)) ? ["text", "image"] as const : ["text"] as const,
				contextWindow: m.maxInputTokens ?? conservativeContextWindow(id),
				maxTokens: m.maxOutputTokens ?? conservativeMaxTokens(id),
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
		});
}

export const FALLBACK_MODELS: PiModel[] = [
	{
		id: "hy3",
		name: "Hy3",
		reasoning: true,
		input: ["text"],
		contextWindow: conservativeContextWindow("hy3"),
		maxTokens: DEFAULT_MAX_TOKENS,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
];

export function buildModels(models: PiModel[]): PiModel[] {
	return models.map((m) => ({
		...m,
		cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
}

export function codebuddyModelId(model: { id: string }): string {
	return model.id;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const normalized = input.trim().toLowerCase();
	if (!normalized) return undefined;
	const exact = models.find((model) => model.id.toLowerCase() === normalized);
	if (exact) return exact;
	const prefixes = models.filter((model) => model.id.toLowerCase().startsWith(normalized));
	if (prefixes.length === 1) return prefixes[0];
	// Explicit user-facing aliases accepted by the AskCodebuddy schema. These
	// are deliberately finite; arbitrary substring matching remains disabled.
	if (["opus", "sonnet", "haiku"].includes(normalized)) {
		const aliases = models.filter((model) => new RegExp(`(?:^|[-_/])${normalized}(?:[-_/]|$)`, "i").test(model.id));
		if (aliases.length === 1) return aliases[0];
	}
	return undefined;
}
