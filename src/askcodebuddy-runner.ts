import {
	query,
	type Message as CbMessage,
} from "@tencent-ai/agent-sdk";
import type { Effort } from "@tencent-ai/agent-sdk";
import type { Config } from "./config.js";

export type AskMode = "full" | "read" | "none";
export type AskQueryOptions = NonNullable<Parameters<typeof query>[0]["options"]>;
export type AskQuery = ReturnType<typeof query>;

const ALWAYS_BLOCKED_TOOLS = [
	"AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "ToolSearch",
	"ScheduleWakeup",
] as const;

const FULL_BLOCKED_TOOLS = [...ALWAYS_BLOCKED_TOOLS];

export interface AskQueryOptionsInput {
	mode: AskMode;
	cwd: string;
	cliModel: string;
	providerSettings: NonNullable<Config["provider"]>;
	systemPrompt?: string;
	effort?: Effort;
	resumeSessionId?: string | null;
	isolated?: boolean;
	debugOptions?: Record<string, unknown>;
}

export interface AskQueryCallbacks {
	onTextDelta?: (text: string) => void;
	onToolStart?: (tool: { id: string; name: string }) => void;
	onToolComplete?: (tool: { id: string; name: string; input: unknown }) => void;
	onResult?: (message: Extract<CbMessage, { type: "result" }>) => void;
}

export interface AskQueryResult {
	responseText: string;
	stopReason: "stop" | "cancelled";
}

function modeTools(mode: AskMode): string[] | undefined {
	if (mode === "read") return ["Read", "Glob", "Grep"];
	if (mode === "none") return [];
	return undefined;
}

function modeSettingSources(mode: AskMode): NonNullable<AskQueryOptions["settingSources"]> {
	return mode === "full" ? ["user", "project"] : [];
}

export function buildAskQueryOptions(input: AskQueryOptionsInput): AskQueryOptions {
	const tools = modeTools(input.mode);
	const options: AskQueryOptions = {
		cwd: input.cwd,
		env: { ...process.env, DISABLE_AUTO_COMPACT: "1" },
		permissionMode: "bypassPermissions",
		settingSources: modeSettingSources(input.mode),
		systemPrompt: input.systemPrompt,
		extraArgs: {
			"strict-mcp-config": null,
			model: input.cliModel,
		},
		...(tools === undefined ? {} : { tools }),
		...(input.mode === "full" ? { disallowedTools: FULL_BLOCKED_TOOLS } : {}),
		...(input.effort ? { effort: input.effort } : {}),
		...(input.resumeSessionId && !input.isolated ? { resume: input.resumeSessionId } : {}),
		...(input.isolated ? { persistSession: false } : {}),
		...(input.providerSettings.pathToCodebuddyCode
			? { pathToCodebuddyCode: input.providerSettings.pathToCodebuddyCode }
			: {}),
		...(input.debugOptions ?? {}),
	};
	return options;
}

function errorTextFromResult(message: Extract<CbMessage, { type: "result" }>): string {
	const result = message as Extract<CbMessage, { type: "result" }> & {
		subtype?: string;
		errors?: unknown;
		error?: unknown;
	};
	if (Array.isArray(result.errors) && result.errors.length > 0) {
		return result.errors.map((error) => String(error)).join("\n");
	}
	if (typeof result.error === "string" && result.error) return result.error;
	return `CodeBuddy query failed (${result.subtype ?? "non-success"})`;
}

function isSuccessResult(message: CbMessage): message is Extract<CbMessage, { type: "result" }> {
	return message.type === "result" && (message as { subtype?: string }).subtype === "success";
}

export async function consumeAskQuery(
	sdkQuery: AskQuery,
	signal: AbortSignal | undefined,
	callbacks: AskQueryCallbacks = {},
): Promise<AskQueryResult> {
	let aborted = Boolean(signal?.aborted);
	let responseText = "";
	let sawResult = false;
	let resultText = "";

	const interrupt = () => {
		aborted = true;
		void sdkQuery.interrupt().catch(() => undefined);
	};

	if (aborted) {
		interrupt();
		throw new Error("Operation aborted");
	}
	signal?.addEventListener("abort", interrupt, { once: true });

	try {
		for await (const message of sdkQuery) {
			if (aborted) break;
			switch (message.type) {
				case "stream_event": {
					const event = (message as CbMessage & { event?: any }).event;
					if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
						const delta = typeof event.delta.text === "string" ? event.delta.text : "";
						responseText += delta;
						callbacks.onTextDelta?.(delta);
					}
					if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
						callbacks.onToolStart?.({
							id: String(event.content_block.id),
							name: String(event.content_block.name),
						});
					}
					break;
				}
				case "assistant": {
					for (const block of (message as any).message?.content ?? []) {
						if (block.type === "tool_use") {
							callbacks.onToolComplete?.({
								id: String(block.id),
								name: String(block.name),
								input: block.input,
							});
						}
						if (block.type === "text" && typeof block.text === "string" && !responseText) {
							responseText += block.text;
						}
					}
					break;
				}
				case "result": {
					sawResult = true;
					callbacks.onResult?.(message as Extract<CbMessage, { type: "result" }>);
					resultText = (message as any).result || "";
					if (!isSuccessResult(message) && !responseText && !resultText) {
						throw new Error(errorTextFromResult(message as Extract<CbMessage, { type: "result" }>));
					}
					break;
				}
				default:
					break;
			}
		}

		if (aborted) throw new Error("Operation aborted");
		if (!sawResult) throw new Error("CodeBuddy query ended without a terminal result");
		if (sawResult && !resultText && !responseText) {
			throw new Error("CodeBuddy query returned an empty success result");
		}
		return { responseText: resultText || responseText, stopReason: "stop" };
	} finally {
		signal?.removeEventListener("abort", interrupt);
		void sdkQuery.interrupt().catch(() => undefined);
	}
}

export type AskQueryFactory = (prompt: string, options: AskQueryOptions) => AskQuery;

export function createAskQueryRunner(queryFactory: AskQueryFactory = (prompt, options) => query({ prompt, options })) {
	return async function runAskQuery(
		prompt: string,
		options: AskQueryOptions,
		signal?: AbortSignal,
		callbacks?: AskQueryCallbacks,
	): Promise<AskQueryResult> {
		const sdkQuery = queryFactory(prompt, options);
		return consumeAskQuery(sdkQuery, signal, callbacks);
	};
}
