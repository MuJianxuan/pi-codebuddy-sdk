// Dynamic model list from CodeBuddy SDK supportedModels().
import type { ModelInfo } from "@tencent-ai/agent-sdk";

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

export const FALLBACK_MODELS: PiModel[] = [
	{
		id: "hy3-preview-agent-ioa",
		name: "Hunyuan 3 Preview",
		reasoning: true,
		input: ["text"],
		contextWindow: conservativeContextWindow("hy3-preview-agent-ioa"),
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
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower || m.id.toLowerCase().includes(lower));
}
