import { calculateCost, StringEnum, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import { buildSessionContext, compact, keyHint, type CompactionEntry, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createSdkMcpServer, query, unstable_v2_createSession as createSdkSession, type Effort, type Message as CbMessage, type UserMessage as CbUserMessage } from "@tencent-ai/agent-sdk";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { createSession, deleteSession } from "./cb-session-io.js";
import { appendFileSync, mkdirSync, realpathSync, statSync } from "fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "os";
import { dirname, join } from "path";
import { PROVIDER_ID, messageContentToText, convertPiMessages } from "./convert.js";
import { buildModels, codebuddyModelId, FALLBACK_MODELS, rawModelsFromSdk, rawModelsFromSdkRaw, resolveModel as _resolveModel, type PiModel } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, buildCodebuddySystemPrompt, enhancePiToolForCodebuddy } from "./skills.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import {
	QueryContext,
	createQueryRuntimeScope,
	ctx,
	runWithQueryRuntimeScope,
	type PendingMcpDispatch,
	type QueryRuntimeScope,
} from "./query-state.js";
import { loadGlobalConfig, type Config } from "./config.js";
import { tryJsonSchemaToZodObjectForMcp } from "./typebox-to-zod.js";
import { buildActionSummary, type ToolCallState } from "./askcodebuddy-ui.js";
import {
	applyContextWindowCalibrations,
	buildCalibrationEnvironment,
	buildCalibrationKey,
	DEFAULT_CALIBRATION_CACHE_PATH,
	loadCalibrationCache,
	mergeCalibrationCaches,
	mergeContextWindowMetric,
	getCalibrationRecord,
	updateObservedContextWindow,
	type CalibrationCache,
	type CapabilityMetric,
	type CalibrationEnvironment,
} from "./model-calibration.js";
import { withSdkGate } from "./sdk-gate.js";
import {
	buildAskQueryOptions,
	consumeAskQuery,
	type AskMode,
} from "./askcodebuddy-runner.js";
import { ToolTurnCoordinator } from "./tool-turn-coordinator.js";
import { createRuntimeConfigController, type RuntimeConfigSnapshot } from "./runtime-config-controller.js";
import {
	getGlobalProviderDispatcher,
	getGlobalRuntimeConfigRegistry,
	getProviderInvocationRoute,
	withProviderInvocationRoute,
	type RuntimeConfigRegistry,
	type RuntimeProviderStream,
} from "./runtime-config-registry.js";

// Compat (#2): use factory if available (pi-ai ≥0.66), else fall back to constructor (gsd-pi etc.)
const _piAi = piAi as any;
const newAssistantMessageEventStream: () => AssistantMessageEventStream =
	typeof _piAi.createAssistantMessageEventStream === "function"
		? _piAi.createAssistantMessageEventStream
		: () => new _piAi.AssistantMessageEventStream();

type SdkQueryOptions = NonNullable<Parameters<typeof query>[0]["options"]>;
type CliDebugOptions = { debug?: boolean; debugFile?: string };

// --- Debug logging ---
// CODEBUDDY_SDK_DEBUG=1 enables local debug logs (metadata only; paths redacted; no prompt/tool bodies).

const DEBUG = process.env.CODEBUDDY_SDK_DEBUG === "1";
const DEBUG_LOG_PATH = process.env.CODEBUDDY_SDK_DEBUG_PATH || join(homedir(), ".pi", "agent", "codebuddy-sdk.log");
const DIAG_LOG_PATH = join(homedir(), ".pi", "agent", "codebuddy-sdk-diag.log");
const ISSUES_URL = "https://github.com/MuJianxuan/pi-codebuddy-sdk/issues/new";

function redactForLog(value: string): string {
	const home = homedir();
	return home && value.includes(home) ? value.split(home).join("~") : value;
}

function redactLogValue(value: unknown): unknown {
	if (typeof value === "string") return redactForLog(value);
	if (Array.isArray(value)) return value.map(redactLogValue);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = redactLogValue(v);
		return out;
	}
	return value;
}

// Ensure log directories exist when debug is enabled
if (DEBUG) {
	try {
		mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
		mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true });
	} catch {
		// If directory creation fails, debug functions will throw on first use
	}
}

// Unique per module evaluation — confirms whether subagents share module state
const moduleInstanceId = Math.random().toString(36).slice(2, 8);
let nextRuntimeOwnerId = 1;

function debug(...args: unknown[]) {
	if (!DEBUG) return;
	const ts = new Date().toISOString();
	const fmt = (a: unknown): string => {
		if (typeof a === "string") return redactForLog(a);
		if (a instanceof Error) return redactForLog(`${a.name}: ${a.message}`);
		return redactForLog(JSON.stringify(a));
	};
	const msg = args.map(fmt).join(" ");
	appendFileSync(DEBUG_LOG_PATH, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
}

// Per-query CLI debug capture. When CODEBUDDY_SDK_DEBUG=1, ask the CodeBuddy CLI
// subprocess to write its own debug log locally. We do not forward stderr (may
// contain prompt or credential hints).
let nextCliDebugSeq = 1;
function makeCliDebugOptions(tag: string): { debug?: boolean; debugFile?: string } {
	if (!DEBUG) return {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = join(dirname(DEBUG_LOG_PATH), "cb-cli-logs");
	try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
	const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
	debug(`cli-debug: ${tag} #${seq} → ${redactForLog(debugFile)}`);
	return { debug: true, debugFile };
}

/** Diagnostic dump for "should never happen" paths — only when debug is enabled */
function diagDump(label: string, data: Record<string, unknown>) {
	if (!DEBUG) return;
	const ts = new Date().toISOString();
	const entry = { ts, moduleInstanceId, label, ...redactLogValue(data) as Record<string, unknown> };
	appendFileSync(DIAG_LOG_PATH, JSON.stringify(entry) + "\n");
	debug(`DIAG: ${label} (see ${redactForLog(DIAG_LOG_PATH)})`);
}

// --- Constants ---

// Process-wide provider state is shared across cached factories and re-evaluated
// module instances. Every active ExtensionRunner owns its Pi registration, while
// discovery/calibration results are fanned out to all runners.
const PROVIDER_PROCESS_STATE_KEY = Symbol.for("codebuddy-sdk:provider-process-state:v6");

interface ProviderRuntimeState {
	sharedSession: SessionState | null;
	piUI: ExtensionUIContext | null;
	activeQueryContexts: Set<QueryContext>;
	queryScope: QueryRuntimeScope;
}

const defaultProviderRuntimeState: ProviderRuntimeState = {
	sharedSession: null,
	piUI: null,
	activeQueryContexts: new Set(),
	queryScope: createQueryRuntimeScope(),
};
const providerRuntimeStorage = new AsyncLocalStorage<ProviderRuntimeState>();

function createProviderRuntimeState(): ProviderRuntimeState {
	return {
		sharedSession: null,
		piUI: null,
		activeQueryContexts: new Set(),
		queryScope: createQueryRuntimeScope(),
	};
}

function currentProviderRuntimeState(): ProviderRuntimeState {
	return providerRuntimeStorage.getStore() ?? defaultProviderRuntimeState;
}

function runWithProviderRuntimeState<T>(state: ProviderRuntimeState, callback: () => T): T {
	return providerRuntimeStorage.run(
		state,
		() => runWithQueryRuntimeScope(state.queryScope, callback),
	);
}

interface ActiveProviderRunner {
	pi: ExtensionAPI;
	dispatcher: RuntimeProviderStream;
	runtimeState: ProviderRuntimeState;
	runModelDiscovery: ModelDiscovery;
}

interface PendingCalibrationObservation {
	modelId: string;
	environment: CalibrationEnvironment;
	metric: CapabilityMetric;
}

interface ProviderProcessState {
	runners: Map<string, ActiveProviderRunner>;
	models?: PiModel[];
	calibrationCache?: CalibrationCache;
	pendingCalibrationObservations: Map<string, PendingCalibrationObservation>;
	calibrationTransactions: Map<string, Promise<void>>;
	calibrationRefreshPending: boolean;
	discoveryPromise?: Promise<void>;
	discoveryIsSurvivorRestart: boolean;
	generation: number;
}

function getProviderProcessState(): ProviderProcessState {
	const globals = globalThis as Record<symbol, ProviderProcessState | undefined>;
	globals[PROVIDER_PROCESS_STATE_KEY] ??= {
		runners: new Map(),
		pendingCalibrationObservations: new Map(),
		calibrationTransactions: new Map(),
		calibrationRefreshPending: false,
		discoveryIsSurvivorRestart: false,
		generation: 0,
	};
	return globals[PROVIDER_PROCESS_STATE_KEY];
}

const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash",
};

let MODELS: PiModel[] = buildModels(FALLBACK_MODELS);
let globalProviderSettings: NonNullable<Config["provider"]> = {};
let calibrationEnvironment: CalibrationEnvironment = buildCalibrationEnvironment();
let calibrationCache: CalibrationCache = loadCalibrationCache();
type ContentBlockParam =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };
type SettingSource = "user" | "project" | "local";

function resolveModel(input: string) {
	const sharedModels = getProviderProcessState().models;
	if (sharedModels) MODELS = sharedModels;
	return _resolveModel(MODELS, input);
}

function applyModelCalibrations(models: PiModel[]): PiModel[] {
	return buildModels(applyContextWindowCalibrations(models, calibrationCache, calibrationEnvironment));
}

function registerCurrentProvider(
	pi: ExtensionAPI,
	streamFn: RuntimeProviderStream = getGlobalProviderDispatcher(),
	models: PiModel[] = MODELS,
): void {
	pi.registerProvider(PROVIDER_ID, {
		name: "CodeBuddy",
		baseUrl: PROVIDER_ID,
		apiKey: "not-used",
		api: "codebuddy-sdk",
		models: models as any,
		streamSimple: streamFn as any,
	});
}

function fanOutProviderRegistration(models: PiModel[], reason: string): void {
	const processState = getProviderProcessState();
	processState.models = models;
	for (const runner of processState.runners.values()) {
		try {
			registerCurrentProvider(runner.pi, runner.dispatcher, models);
		} catch (error) {
			debug(`provider fan-out failed (${reason})`, error);
		}
	}
}

function scheduleCalibrationRefresh(reason: string): void {
	getProviderProcessState().calibrationRefreshPending = true;
	debug(`calibration: scheduled provider refresh (${reason})`);
	queueMicrotask(() => maybeRefreshProviderRegistration(`microtask:${reason}`));
}

function maybeRefreshProviderRegistration(reason: string): void {
	const processState = getProviderProcessState();
	if (!processState.calibrationRefreshPending) return;
	const activeQueryCount = [...processState.runners.values()]
		.reduce((count, runner) => count + runner.runtimeState.activeQueryContexts.size, 0);
	if (activeQueryCount > 0) {
		debug(`calibration: refresh deferred (${reason}) activeQueries=${activeQueryCount}`);
		return;
	}
	processState.calibrationRefreshPending = false;
	const models = processState.models ?? MODELS;
	debug(`calibration: refreshing provider registrations (${reason}) models=${models.length}`);
	fanOutProviderRegistration(models, `calibration:${reason}`);
}

// --- Error handling ---

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try { return JSON.stringify(err); } catch {}
	}
	return String(err);
}

// --- Session persistence ---

interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	// Force the next syncSharedSession call down the REBUILD path. Set when
	// pi has mutated its messages array out from under us (compact, tree
	// navigation) or after an abort left the JSONL in an indeterminate state.
	// REBUILD wipes and rewrites the file to match pi's current history.
	needsRebuild?: boolean;
	// Set ONLY after an abort. The killed CC subprocess may still be flushing
	// a late "[Request interrupted by user]" record to the session JSONL.
	// Reusing the same sessionId/path would race that orphan write into our
	// fresh file and break CC's parent-uuid chain on the next resume. When
	// this flag is set, REBUILD takes a fresh UUID and skips deleteSession
	// so the orphan writes land on a dead inode. Compact/tree do NOT set
	// this — there's no concurrent CC writer during those events, so
	// in-place rebuild (preserve UUID, deleteSession + createSession) is safe.
	forceRotate?: boolean;
}

const providerSessionSlot = {
	get current(): SessionState | null {
		return currentProviderRuntimeState().sharedSession;
	},
	set current(value: SessionState | null) {
		currentProviderRuntimeState().sharedSession = value;
	},
};
// Convert pi messages to Anthropic API format for session import.
// Lossy: non-Anthropic thinking blocks are dropped (no valid signature), and only
// text/image/toolCall block types are handled. If all blocks in an assistant message
// are filtered, the message is dropped — which can create invalid sequences (e.g.
// two user messages in a row, or tool_result without preceding tool_use).
function convertAndImportMessages(
	session: ReturnType<typeof createSession>,
	messages: Context["messages"],
	customToolNameToSdk?: Map<string, string>,
): void {
	const { anthropicMessages, sanitizedIds } = convertPiMessages(messages, customToolNameToSdk);

	debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
	debug(`convertAndImportMessages: imported roles:`, anthropicMessages.map((m, i) => {
		const c = m.content;
		if (typeof c === "string") return `[${i}]${m.role}:text`;
		if (Array.isArray(c)) return `[${i}]${m.role}:${c.map((b: { type?: string }) => b.type).join("+")}`;
		return `[${i}]${m.role}:?`;
	}).join(" "));
	if (sanitizedIds.size > 0) {
		debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
			[...sanitizedIds.entries()].map(([orig, clean]) => orig === clean ? orig : `${orig}→${clean}`).join(", "));
	}
	if (messages.length) session.importPiMessages(messages);
}

// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
// debug logging at the extraction boundary.
function extractAllToolResults(context: Context): McpResult[] {
	const { results, stopIdx } = _extractAllToolResults(context.messages as unknown as Array<{ role: string; [key: string]: unknown }>);
	debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`);
	debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	for (let r = 0; r < results.length; r++) {
		debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} contentLen=${JSON.stringify(results[r].content).length}`);
	}
	return results;
}

/** Extract the last user message from context as a prompt string. Returns null if last message is not a user message. */
function extractUserPrompt(messages: Context["messages"]): string | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return null;
	if (typeof last.content === "string") return last.content;
	return messageContentToText(last.content) || "";
}

/** Extract the last user message as ContentBlockParam[] (preserving images).
 *  Returns null if no images — caller should fall back to string prompt. */
function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return null;
	if (typeof last.content === "string") {
		debug(`extractUserPromptBlocks: content is string (length=${last.content.length})`);
		return null;
	}
	if (!Array.isArray(last.content)) {
		debug(`extractUserPromptBlocks: content is ${typeof last.content}`);
		return null;
	}
	debug(`extractUserPromptBlocks: ${last.content.length} blocks, types=${last.content.map((b: any) => b.type).join(",")}`);
	let hasImage = false;
	let hadInvalidImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const block of last.content) {
		if (block.type === "text" && block.text) {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			debug(`image block: mimeType=${(block as any).mimeType}, data length=${((block as any).data ?? "").length}, keys=${Object.keys(block).join(",")}`);
			if (!(block as any).data || !(block as any).mimeType) {
				debug(`image block missing data or mimeType, skipping`);
				hadInvalidImage = true;
				continue;
			}
			hasImage = true;
			blocks.push({
				type: "image",
				source: { type: "base64", media_type: block.mimeType, data: block.data },
			});
		}
	}
	if (hadInvalidImage) blocks.push({ type: "text", text: "[invalid image omitted]" });
	return hasImage || hadInvalidImage ? blocks : null;
}

async function* wrapPromptStream(blocks: ContentBlockParam[]): AsyncIterable<CbUserMessage> {
	yield {
		type: "user",
		session_id: "",
		parent_tool_use_id: null,
		message: { role: "user", content: blocks as any },
	};
}

function newAssistantOutput(model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function extractIsolatedSummaryPrompt(messages: Context["messages"]): string {
	if (messages.length !== 1 || messages[0].role !== "user") {
		throw new Error(
			`isolatedStreamFn: expected exactly 1 user message, got ${messages.length} ` +
			`(${messages.map((m) => m.role).join(",")})`,
		);
	}
	const promptText = extractUserPrompt(messages);
	if (!promptText) throw new Error("isolatedStreamFn: summarization prompt is empty");
	return promptText;
}

function resultErrorText(message: CbMessage): string {
	const result = message as CbMessage & { subtype?: string; errors?: unknown; error?: unknown };
	if (Array.isArray(result.errors)) return result.errors.map(String).join("\n");
	if (typeof result.error === "string") return result.error;
	return `CodeBuddy summary failed: ${result.subtype ?? "unknown result"}`;
}

function isolatedStreamFn(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = newAssistantMessageEventStream();
	void runIsolatedSummary(model, context, options, stream);
	return stream;
}

const COMPACT_SUMMARY_TIMEOUT_MS = 60_000;
const COMPACT_SUMMARY_CLOSE_GRACE_MS = 1_000;

type IsolatedSummaryOutcome =
	| { kind: "success"; text: string }
	| { kind: "aborted" }
	| { kind: "error"; message: string };

type IsolatedSummaryQuery = AsyncIterable<CbMessage> & {
	return(): Promise<unknown>;
};

interface ConsumeIsolatedSummaryQueryInput {
	sdkQuery: IsolatedSummaryQuery;
	model: Model<any>;
	abortController: AbortController;
	signal?: AbortSignal;
	timeoutMs?: number;
	closeGraceMs?: number;
	forceClose?: (sdkQuery: IsolatedSummaryQuery) => void;
}

// The current SDK's Query.return() only interrupts; cleanup() is the operation
// that closes the transport. Keep this version-coupled fallback in one adapter.
function forceCloseSdkQuery(sdkQuery: IsolatedSummaryQuery): void {
	const cleanup = (sdkQuery as IsolatedSummaryQuery & { cleanup?: () => void }).cleanup;
	if (typeof cleanup === "function") cleanup.call(sdkQuery);
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(() => true, () => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function consumeIsolatedSummaryQuery(
	input: ConsumeIsolatedSummaryQueryInput,
): Promise<IsolatedSummaryOutcome> {
	const timeoutMs = input.timeoutMs ?? COMPACT_SUMMARY_TIMEOUT_MS;
	const closeGraceMs = input.closeGraceMs ?? COMPACT_SUMMARY_CLOSE_GRACE_MS;
	const forceClose = input.forceClose ?? forceCloseSdkQuery;
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;

	const consumePromise = (async (): Promise<IsolatedSummaryOutcome> => {
		let assistantText = "";
		let finalText = "";
		let errorText: string | undefined;
		let firstEventLogged = false;
		try {
			for await (const message of input.sdkQuery) {
				if (!firstEventLogged) {
					debug(`compact summary: first event type=${message.type}`);
					firstEventLogged = true;
				}
				if (message.type === "assistant") {
					for (const block of (message as any).message?.content ?? []) {
						if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
					}
				} else if (message.type === "result") {
					await logServedContextWindow("compact summary", message, input.model);
					if (message.subtype === "success") finalText = message.result || assistantText;
					else errorText = resultErrorText(message);
				}
			}
			const text = finalText || assistantText;
			if (errorText || !text.trim()) {
				return { kind: "error", message: errorText ?? "CodeBuddy summary returned empty text" };
			}
			return { kind: "success", text };
		} catch (error) {
			return { kind: "error", message: errorMessage(error) };
		}
	})();

	const timeoutPromise = new Promise<{ source: "timeout" }>((resolve) => {
		timeoutTimer = setTimeout(() => resolve({ source: "timeout" }), timeoutMs);
		timeoutTimer.unref?.();
	});
	const abortPromise = new Promise<{ source: "abort" }>((resolve) => {
		if (!input.signal) return;
		abortListener = () => resolve({ source: "abort" });
		if (input.signal.aborted) abortListener();
		else input.signal.addEventListener("abort", abortListener, { once: true });
	});

	try {
		const winner = await Promise.race([
			consumePromise.then((outcome) => ({ source: "consume" as const, outcome })),
			timeoutPromise,
			abortPromise,
		]);
		if (winner.source === "consume") return winner.outcome;

		input.abortController.abort();
		try {
			void Promise.resolve(input.sdkQuery.return()).catch((error) => {
				debug("compact summary: graceful return failed", error);
			});
		} catch (error) {
			debug("compact summary: graceful return threw", error);
		}
		if (!(await settlesWithin(consumePromise, closeGraceMs))) {
			try {
				forceClose(input.sdkQuery);
			} catch (error) {
				debug("compact summary: hard close failed", error);
			}
		}
		if (winner.source === "abort") return { kind: "aborted" };
		return { kind: "error", message: `CodeBuddy compact summary timed out after ${timeoutMs}ms` };
	} finally {
		if (timeoutTimer) clearTimeout(timeoutTimer);
		if (input.signal && abortListener) input.signal.removeEventListener("abort", abortListener);
	}
}

async function runIsolatedSummary(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	try {
		if (options?.signal?.aborted) {
			const output = newAssistantOutput(model, "", "aborted", "Operation aborted");
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			return;
		}
		const promptText = extractIsolatedSummaryPrompt(context.messages);
		const invocationRoute = getProviderInvocationRoute(options);
		if (!invocationRoute) throw new Error("CodeBuddy compact summary is missing its Pi runtime route");
		const cwd = invocationRoute.canonicalCwd;
		const codebuddyExecutable = invocationRoute.provider.pathToCodebuddyCode;
		const cliModel = codebuddyModelId(model);
		debug(`compact summary: spawn model=${cliModel} registeredModel=${model.id} promptLen=${promptText.length}`);

		const abortController = new AbortController();
		const sdkQuery = query({
			prompt: promptText,
			options: {
				cwd,
				env: { ...process.env, DISABLE_AUTO_COMPACT: "1" },
				tools: [],
				strictMcpConfig: true,
				settingSources: [] as SettingSource[],
				persistSession: false,
				systemPrompt: context.systemPrompt,
				model: cliModel,
				maxTurns: 1,
				abortController,
				...(codebuddyExecutable ? { pathToCodebuddyCode: codebuddyExecutable } : {}),
				...makeCliDebugOptions("compact-summary"),
			},
		});
		const outcome = await consumeIsolatedSummaryQuery({
			sdkQuery,
			model,
			abortController,
			signal: options?.signal,
		});
		if (outcome.kind === "aborted") {
			const output = newAssistantOutput(model, "", "aborted", "Operation aborted");
			debug("compact summary: aborted");
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			return;
		}
		if (outcome.kind === "error") {
			debug(`compact summary: error ${outcome.message}`);
			stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", outcome.message) });
			stream.end();
			return;
		}
		debug(`compact summary: done textLen=${outcome.text.length}`);
		stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, outcome.text, "stop") });
		stream.end();
	} catch (err) {
		const msg = errorMessage(err);
		debug("runIsolatedSummary threw; pushing terminal error", err);
		stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
		stream.end();
	}
}

function reinjectPriorCompactionFileOps(branchEntries: Array<{ type: string; details?: unknown }>, preparation: { fileOps: { read: Set<string>; edited: Set<string> } }): void {
	const prior = [...branchEntries]
		.reverse()
		.find((entry): entry is CompactionEntry => entry.type === "compaction");
	const details = prior?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	if (!Array.isArray(details?.readFiles) || !Array.isArray(details?.modifiedFiles)) return;
	for (const file of details.readFiles) preparation.fileOps.read.add(String(file));
	for (const file of details.modifiedFiles) preparation.fileOps.edited.add(String(file));
	debug(`compact takeover: re-injected prior file ops read=${details.readFiles.length} modified=${details.modifiedFiles.length}`);
}

interface SyncResult {
	sessionId: string | null;
	preserveSharedSession?: boolean;
}

/**
 * Ensure the shared session has all messages up to (but not including) the last user message.
 * Returns session ID to resume from, or null if no resume needed.
 */
// Read the session file we just wrote and sanity-check it. Warns instead of
// throwing — CC may be more tolerant than our checks, so a false positive
// shouldn't block the user. Pure logic is in session-verify.js; this wrapper
// fans each warning out to debug log + piUI notify + diagDump.
function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		providerUiSlot.current?.notify(
			`Session sync issue: ${msg}. ` +
			`cwd=${redactForLog(cwd)}` +
			(DEBUG ? ` (see ${redactForLog(DEBUG_LOG_PATH)})` : ` (set CODEBUDDY_SDK_DEBUG=1 for a local log)`) +
			`. Report: ${ISSUES_URL}`,
			"warning",
		);
		diagDump("session_verify_fail", { msg, jsonlPath, cwd, realpath: safeRealpath(cwd), codebuddyConfigDir: process.env.CODEBUDDY_CONFIG_DIR ?? null });
	}
}

function safeRealpath(p: string): string {
	try { return realpathSync(p); } catch (e) { return `<failed: ${(e as Error).message}>`; }
}

// Diagnostic snapshot of where a session file was just written. Catches the
// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
// from ~/.claude/projects/<Y> (symlinks, CODEBUDDY_CONFIG_DIR, hash mismatch).
function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
	const realCwd = safeRealpath(cwd);
	let fileSize: number | null = null;
	let fileExists = false;
	try {
		const st = statSync(jsonlPath);
		fileExists = true;
		fileSize = st.size;
	} catch { /* file may not exist yet */ }
	debug(`${label}: cwd=${redactForLog(cwd)}`);
	if (realCwd !== cwd) debug(`${label}: realpath(cwd)=${redactForLog(realCwd)} (symlink-resolved)`);
	debug(`${label}: jsonlPath=${redactForLog(jsonlPath)}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
}

// Two semantic paths:
//   REUSE — pi's history is in sync with the existing providerSessionSlot.current (or drifted
//     only by the trailing final-assistant message that pi appends after
//     streamSimple returns, which CC's own persisted session already has).
//     Returns the existing sessionId. Keeps CC's prompt cache warm.
//   REBUILD — no session yet, or pi's history has diverged (non-trailing
//     missed messages, e.g. another provider took a turn). Wipes the existing
//     session file (if any) and writes a fresh one containing all prior
//     messages, reusing the same sessionId across rebuilds so UUIDs stay
//     stable for the lifetime of pi's session.
//
// Why a full rebuild rather than patching:
//   Injecting deltas into an existing session creates a branch that CC's
//   --resume doesn't follow (documented attempt prior to this). A complete
//   overwrite at the same path is simpler and correct.
//
// Why reuse the sessionId across rebuilds:
//   CC re-reads the JSONL on every --resume call — no in-process UUID
//   caching. Validated in tests/exp-session-clear.mjs, including the case
//   where CC had appended its own tool_use/tool_result records between
//   rebuilds. Preserving the UUID means stable log correlation across
//   provider switches and no orphaned session files.
//
// Log strings still say "Case 1/2/3/4" so existing diagnostics (int-cache.sh,
// int-session-resume.mjs) keep grepping the same anchors.
function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
): SyncResult {
	const priorMessages = messages.slice(0, -1); // everything before the new user prompt

	// REUSE path
	//
	// Guard on priorMessages.length >= cursor: a shorter incoming context cannot
	// be a continuation of the cached session. This is the general invariant for
	// pi-side history rewrites such as /compact and session_tree: without it,
	// missed = [].slice(cursor) can falsely hit REUSE and resume an unrelated
	// longer CC session. See issue #25.
	const cachedSession = providerSessionSlot.current;
	const sameStorageCwd = cachedSession?.cwd === cwd;
	if (cachedSession && sameStorageCwd && !cachedSession.needsRebuild && priorMessages.length >= cachedSession.cursor) {
		const missed = priorMessages.slice(providerSessionSlot.current.cursor);
		const trailingAssistantOnly =
			missed.length === 1 && (missed[0] as { role?: string }).role === "assistant";
		if (missed.length === 0 || trailingAssistantOnly) {
			if (trailingAssistantOnly) {
				providerSessionSlot.current = { ...providerSessionSlot.current, cursor: priorMessages.length, cwd };
			}
			debug(`Case 3: ${trailingAssistantOnly ? "advanced cursor past trailing assistant, " : ""}resuming session ${providerSessionSlot.current.sessionId.slice(0, 8)}, cursor=${providerSessionSlot.current.cursor}`);
			debug(`syncResult: path=reuse sessionId=${providerSessionSlot.current.sessionId} cursor=${providerSessionSlot.current.cursor}`);
			return { sessionId: providerSessionSlot.current.sessionId };
		}
	}
	// Only reachable when needsRebuild is false — user-facing history rewrites
	// (/compact, session_tree, /new, fork) always set needsRebuild or clear
	// providerSessionSlot.current before the next syncSharedSession call. In practice this
	// fires only for isolated compact-summary subprocesses.
	if (cachedSession && sameStorageCwd && !cachedSession.needsRebuild && priorMessages.length < cachedSession.cursor) {
		debug(`Case 1 synthetic: clean start for shorter context, preserving shared session ${providerSessionSlot.current.sessionId.slice(0, 8)}, cursor=${providerSessionSlot.current.cursor}`);
		debug(`syncResult: path=clean-start preserve-shared sessionId=${providerSessionSlot.current.sessionId} cursor=${providerSessionSlot.current.cursor}`);
		return { sessionId: null, preserveSharedSession: true };
	}

	// REBUILD path
	if (priorMessages.length === 0) {
		debug(`Case 1: clean start, ${messages.length} total messages`);
		debug(`syncResult: path=clean-start`);
		return { sessionId: null };
	}
	const previousSessionId = sameStorageCwd ? providerSessionSlot.current?.sessionId : undefined;
	const previousCursor = sameStorageCwd ? providerSessionSlot.current?.cursor ?? 0 : 0;
	if (cachedSession && !sameStorageCwd) {
		debug(`syncSharedSession: storage cwd mismatch; cached=${redactForLog(cachedSession.cwd)} current=${redactForLog(cwd)} — creating an independent session without deleting the cached project session`);
	}
	// preserveId: rebuild in place (deleteSession + createSession with the
	// existing UUID), so prompt-cache UUIDs stay stable for log correlation
	// and for any tools that key off them. Skipped only when there's a
	// concurrent writer we shouldn't race — see forceRotate docs above.
	const preserveId = previousSessionId !== undefined && !providerSessionSlot.current?.forceRotate;
	if (preserveId) {
		// Wipe prior jsonl + companion dir (no-op if nothing to wipe).
		deleteSession(previousSessionId!, cwd, process.env.CODEBUDDY_CONFIG_DIR);
	}
	const session = createSession({
		projectPath: cwd,
		codebuddyDir: process.env.CODEBUDDY_CONFIG_DIR,
		...(preserveId ? { sessionId: previousSessionId } : {}),
		...(modelId ? { model: modelId } : {}),
	});
	convertAndImportMessages(session, priorMessages, customToolNameToSdk);
	session.save();
	verifyWrittenSession(session.jsonlPath, session.sessionId, session.messages.length, cwd);
	providerSessionSlot.current = { sessionId: session.sessionId, cursor: priorMessages.length, cwd };
	if (previousSessionId === undefined) {
		debug(`Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.messages.length} records`);
	} else if (preserveId) {
		const missedCount = priorMessages.length - previousCursor;
		debug(`Case 4: ${missedCount} missed messages, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.messages.length} records`);
	} else {
		debug(`Case 4 post-abort: ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId.slice(0, 8)}, rotated to avoid race with orphan writer), ${session.messages.length} records`);
	}
	debugSessionPaths(`${session.sessionId.slice(0, 8)}`, cwd, session.jsonlPath);
	debug(`syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`);
	return { sessionId: session.sessionId };
}

// @internal
export const __test = {
	resetSharedSession() {
		providerSessionSlot.current = null;
	},
	setSharedSession(state: SessionState | null) {
		providerSessionSlot.current = state;
	},
	getSharedSession() {
		return providerSessionSlot.current;
	},
	createProviderRuntimeState,
	runWithProviderRuntimeState,
	createDelegationSessionFromContext,
	extractUserPromptBlocks,
	buildProviderBoundaryOptions,
	buildProviderQueryOptions,
	resolveMcpTools,
	syncSharedSession,
	isEmptyArgs,
	mapToolArgs,
	hasRequiredParams,
	claimSerialToolUse,
	interruptLiveQuery,
	processStreamEvent,
	processAssistantMessage,
	resolvePermissionPendingTool,
	finalizePermissionPending,
	buildMcpServers,
	consumeIsolatedSummaryQuery,
	buildModelDiscoveryOptions,
};

function createDelegationSessionFromContext(
	messages: Context["messages"] | undefined,
	cwd: string,
	modelId?: string,
): string | null {
	if (!messages?.length) return null;
	const delegationMessages = stripToolHistoryForDelegation(messages);
	if (!delegationMessages.length) return null;
	const session = createSession({
		projectPath: cwd,
		codebuddyDir: process.env.CODEBUDDY_CONFIG_DIR,
		...(modelId ? { model: modelId } : {}),
	});
	convertAndImportMessages(session, delegationMessages);
	session.save();
	verifyWrittenSession(session.jsonlPath, session.sessionId, session.messages.length, cwd);
	debug(`askCodebuddy: created delegation session ${session.sessionId.slice(0, 8)} records=${session.messages.length}`);
	return session.sessionId;
}

function stripToolHistoryForDelegation(messages: Context["messages"]): Context["messages"] {
	return messages.flatMap((message) => {
		if (message.role === "toolResult") return [];
		if (message.role !== "assistant" || !Array.isArray(message.content)) return [message];
		const content = message.content.filter((block) => block.type !== "toolCall");
		return content.length ? [{ ...message, content }] : [];
	}) as Context["messages"];
}

function buildProviderBoundaryOptions(settings: NonNullable<Config["provider"]>) {
	const appendSystemPrompt = settings.appendSystemPrompt !== false;
	return {
		appendSystemPrompt,
		tools: [] as string[],
		extraArgs: { "strict-mcp-config": null } as Record<string, string | null>,
		settingSources: appendSystemPrompt
			? undefined
			: settings.settingSources ?? ["user", "project"] as SettingSource[],
	};
}

function buildProviderQueryOptions(input: {
	providerSettings: NonNullable<Config["provider"]>;
	cliModel: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	systemPrompt?: string;
	effort?: Effort;
	mcpServers?: SdkQueryOptions["mcpServers"];
	resumeSessionId?: string | null;
	codebuddyExecutable?: string;
	debugOptions?: CliDebugOptions;
}): SdkQueryOptions {
	const boundaryOptions = buildProviderBoundaryOptions(input.providerSettings);
	return {
		cwd: input.cwd,
		env: input.env,
		tools: boundaryOptions.tools,
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		systemPrompt: input.systemPrompt,
		extraArgs: { ...boundaryOptions.extraArgs, model: input.cliModel },
		...(input.effort ? { effort: input.effort } : {}),
		...(boundaryOptions.settingSources ? { settingSources: boundaryOptions.settingSources } : {}),
		...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
		...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
		...(input.codebuddyExecutable ? { pathToCodebuddyCode: input.codebuddyExecutable } : {}),
		...(input.debugOptions ?? {}),
	};
}

// --- Provider helpers: tool name mapping ---

function mapToolName(name: string, customToolNameToPi?: Map<string, string>): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	if (customToolNameToPi) {
		const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
		if (mapped) return mapped;
	}
	if (normalized.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);
	return name;
}

// True when a tool-call argument object is empty or absent. Used to detect
// the parallel-tool-call arg-dropping failure: CodeBuddy's MCP client may
// dispatch tool_call arguments as {} (especially in parallel batches), and
// the stream's input_json_delta may also arrive empty. We defer toolcall_end
// for such blocks until the assistant message (or MCP dispatch) provides
// real arguments, preventing pi from executing tools with empty args.
function isEmptyArgs(args: Record<string, unknown> | undefined | null): boolean {
	if (!args) return true;
	if (Object.keys(args).length === 0) return true;
	// Treat an object with only undefined/null values as empty
	const hasValue = Object.values(args).some((v) => v !== undefined && v !== null);
	return !hasValue;
}

// Checks whether a Pi tool has any required parameters. Used by the canUseTool
// pre-validation to decide whether empty dispatch args should be rejected.
// If a tool has no required params, empty args are legitimate and should pass.
function hasRequiredParams(toolName: string, tools: Tool[]): boolean {
	const tool = tools.find((t) => t.name === toolName);
	if (!tool?.parameters) return false;
	const required = (tool.parameters as Record<string, unknown>).required;
	return Array.isArray(required) && required.length > 0;
}

function claimSerialToolUse(queryCtx: QueryContext, toolUseId: string): boolean {
	if (queryCtx.claimedToolUseId && queryCtx.claimedToolUseId !== toolUseId) return false;
	if (queryCtx.claimedToolUseId === toolUseId) return true;
	const decision = queryCtx.turnCoordinator.recordPermissionDecision(toolUseId, "unknown", "allow");
	if (decision.behavior === "allow") {
		queryCtx.claimedToolUseId = toolUseId;
		return true;
	}
	return false;
}

function interruptLiveQuery(ref: { current?: { interrupt?: () => Promise<void> | void } }): void {
	void ref.current?.interrupt?.();
}

// Renames for CodeBuddy SDK param names that differ from pi's native names.
// Keys not listed here pass through unchanged, so new pi params work automatically.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// Maps SDK tool args to pi tool args via key renaming + pass-through.
// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value; // first alias wins
	}
	// Add the default only after a real argument object is present. Otherwise a
	// parallel-dispatch {} becomes { timeout: 120 } and bypasses the empty-args
	// guard while still missing bash's required command field.
	if (toolName.toLowerCase() === "bash" && !isEmptyArgs(input) && result.timeout == null) {
		result.timeout = 120;
	}
	return result;
}

// --- Provider helpers: tool resolution ---

// --- Provider helpers: tool bridge ---

const MCP_DISPATCH_MATCH_TIMEOUT_MS = 30_000;

// --- Query state ---
// QueryContext lives in query-state.js so tests can import it without
// activating the extension.

// Global (not query state):
const providerUiSlot = {
	get current(): ExtensionUIContext | null {
		return currentProviderRuntimeState().piUI;
	},
	set current(value: ExtensionUIContext | null) {
		currentProviderRuntimeState().piUI = value;
	},
};

function providerActiveQueries(): Set<QueryContext> {
	return currentProviderRuntimeState().activeQueryContexts;
}

function contextForToolResults(results: McpResult[]): QueryContext | undefined {
	for (const result of results) {
		const id = result.toolCallId;
		if (!id) continue;
		for (const queryCtx of providerActiveQueries()) {
			if (queryCtx.pendingToolCalls.has(id) || queryCtx.pendingResults.has(id) || queryCtx.turnToolCallIds.includes(id)) {
				return queryCtx;
			}
		}
	}
	return undefined;
}

function resolveMcpTools(context: Context, excludeToolNames?: ReadonlySet<string>): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		if (excludeToolNames?.has(tool.name)) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(enhancePiToolForCodebuddy(tool));
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

function bindPendingMcpDispatch(
	queryCtx: QueryContext,
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const pendingIndex = queryCtx.pendingMcpDispatches.findIndex((pending) => pending.toolName === toolName);
	if (pendingIndex < 0) return undefined;
	const pending = queryCtx.pendingMcpDispatches.splice(pendingIndex, 1)[0];
	if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
	queryCtx.matchedToolCallIds.add(toolCallId);
	if (isEmptyArgs(args)) {
		queryCtx.pendingToolCalls.set(toolCallId, { toolName, resolve: pending.resolve });
		return pending.args;
	}
	if (queryCtx.pendingResults.has(toolCallId)) {
		const result = queryCtx.pendingResults.get(toolCallId)!;
		queryCtx.pendingResults.delete(toolCallId);
		pending.resolve(result);
		return pending.args;
	}
	queryCtx.pendingToolCalls.set(toolCallId, { toolName, resolve: pending.resolve });
	return pending.args;
}

function drainPendingMcpDispatches(queryCtx: QueryContext, text: string): void {
	queryCtx.drainPendingMcpDispatches(text);
}

function deniedMcpResult(toolName: string): McpResult {
	return {
		content: [{ type: "text", text: `Tool "${toolName}" was denied before execution.` }],
		isError: true,
	};
}

// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
// blocks on a Promise until pi delivers the tool result via streamSimple.
// Handlers are assigned toolCallIds from turnToolCallIds (populated when the SDK
// emits tool_use blocks). Results are matched by ID, not position.
// Handlers close over the captured `queryCtx`, ensuring they operate on the
// correct query's state while multiple queries run concurrently.
function buildMcpServers(tools: Tool[], queryCtx: QueryContext): {
	servers?: Record<string, ReturnType<typeof createSdkMcpServer>>;
	tools: Tool[];
} {
	if (!tools.length) return { tools: [] };
	const mcpTools = tools.flatMap((tool) => {
		const conversion = tryJsonSchemaToZodObjectForMcp(tool.parameters);
		if (conversion.error) {
			const warning = `CodeBuddy SDK: skipped Pi tool ${tool.name} because its schema is unsupported at ${conversion.error.path} (${conversion.error.keyword})`;
			providerUiSlot.current?.notify(warning, "warning");
			if (!providerUiSlot.current) console.warn(warning);
			return [];
		}
		return [{
		name: tool.name,
		description: tool.description,
		// MCP schema preserves required constraints so empty {} (from parallel
		// tool_call arg-dropping) is rejected at MCP validation time — an early
		// signal that args were lost. The deferred-backfill logic handles the
		// stream side; this handles the dispatch side. Passthrough allows extra
		// keys for forward-compat.
			inputSchema: conversion.schema!,
			handler: async (dispatchArgs?: Record<string, unknown>) => {
				const mappedDispatchArgs = mapToolArgs(tool.name, dispatchArgs);
				// Name-based toolCallId matching: find the first toolCallId whose
			// corresponding turnBlock has a name matching this tool, and hasn't
			// been claimed by a previous handler invocation. This fixes the
			// parallel-dispatch race where CodeBuddy calls MCP handlers in a
			// different order than the stream's content_block_start events —
			// without this, bash's handler could get read's toolCallId, causing
			// result misassignment (bash result → read handler, vice versa).
			//
			// Fallback to index-based for robustness (e.g. if turnBlocks doesn't
			// have the block yet, or same-name dedup edge cases).
				let toolCallId = queryCtx.turnCoordinator.observeDispatch(tool.name, mappedDispatchArgs);
				if (toolCallId) queryCtx.matchedToolCallIds.add(toolCallId);
					if (!toolCallId) {
						debug(`mcp handler ${tool.name} arrived before a matching stream tool id; buffering by tool name`);
						return new Promise<McpResult>((resolve) => {
							const pending: PendingMcpDispatch = {
								toolName: tool.name,
								args: mappedDispatchArgs,
								resolve,
							};
							pending.deadlineTimer = setTimeout(() => {
								const index = queryCtx.pendingMcpDispatches.indexOf(pending);
								if (index < 0) return;
								queryCtx.pendingMcpDispatches.splice(index, 1);
								queryCtx.turnCoordinator.cancelPendingDispatch(tool.name);
								debug(`mcp handler ${tool.name} timed out waiting for a stream tool id`);
								resolve({
									content: [{ type: "text", text: `Tool "${tool.name}" timed out waiting for its streamed tool call.` }],
									isError: true,
								});
							}, MCP_DISPATCH_MATCH_TIMEOUT_MS);
							pending.deadlineTimer.unref?.();
							queryCtx.pendingMcpDispatches.push(pending);
						});
					}
				if (queryCtx.turnCoordinator.snapshot().deniedIds.includes(toolCallId)) {
					debug(`mcp handler: ${tool.name} [${toolCallId}] denied before execution`);
					resolvePermissionPendingTool(queryCtx, toolCallId, false);
					return deniedMcpResult(tool.name);
				}
				if (queryCtx.turnCoordinator.isAllowed(toolCallId)) {
					resolvePermissionPendingTool(queryCtx, toolCallId, true, true);
				}

				debug(`mcp dispatch: ${tool.name} dispatchArgsLen=${JSON.stringify(mappedDispatchArgs).length} dispatchArgsEmpty=${isEmptyArgs(mappedDispatchArgs)} matched=${queryCtx.matchedToolCallIds.size}/${queryCtx.turnToolCallIds.length} pendingBlocks=${queryCtx.argsPendingBlocks.length}`);

			// Backfill path: if there are args-pending blocks whose toolcall_end
			// was deferred (stream args were empty), try to backfill using the
			// MCP dispatch args. This handles the case where the assistant message
			// also had empty args but the MCP dispatch carries the real args.
			if (queryCtx.argsPendingBlocks.length > 0 && toolCallId) {
				const pendingIdx = queryCtx.argsPendingBlocks.findIndex((p) => p.block.id === toolCallId);
				if (pendingIdx >= 0) {
					const pending = queryCtx.argsPendingBlocks[pendingIdx];
						const backfillArgs = mappedDispatchArgs;
						if (!isEmptyArgs(backfillArgs)) {
						pending.block.arguments = backfillArgs;
						debug(`mcp handler: backfilled ${tool.name} [${toolCallId}] from MCP dispatch args (argsLen=${JSON.stringify(backfillArgs).length})`);
					} else {
						debug(`mcp handler: dispatch args also empty for ${tool.name} [${toolCallId}], emitting with current args`);
						}
						queryCtx.turnSawToolCall = true;
						queryCtx.currentPiStream?.push({ type: "toolcall_end", contentIndex: pending.contentIndex, toolCall: pending.block, partial: queryCtx.turnOutput });
						pending.block.__piToolcallEndEmitted = true;
					queryCtx.argsPendingBlocks.splice(pendingIdx, 1);

					// If all pending blocks are now resolved and done was deferred, emit it
						if (queryCtx.argsPendingBlocks.length === 0 && queryCtx.doneDeferredForArgs && queryCtx.currentPiStream && queryCtx.turnOutput) {
							queryCtx.doneDeferredForArgs = false;
							queryCtx.turnOutput.stopReason = "toolUse";
							expectTrailingAssistant(queryCtx);
							const stream = queryCtx.currentPiStream;
						stream.push({ type: "done", reason: "toolUse", message: queryCtx.turnOutput });
						markStreamComplete(stream);
						stream.end();
						queryCtx.currentPiStream = null;
						debug(`mcp handler: all pending blocks resolved, emitted deferred done event`);
					}
				}
			}

			if (toolCallId && queryCtx.pendingResults.has(toolCallId)) {
				const result = queryCtx.pendingResults.get(toolCallId)!;
				queryCtx.pendingResults.delete(toolCallId);
				debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`);
				return result;
			}
			debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
			return new Promise<McpResult>((resolve) => {
				queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
			});
		}}];
	});
	if (!mcpTools.length) return { tools: [] };
	const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: mcpTools });
	return { servers: { [MCP_SERVER_NAME]: server }, tools: tools.filter((tool) => mcpTools.some((mcpTool) => mcpTool.name === tool.name)) };
}

// --- Usage helpers ---

function updateUsage(output: AssistantMessage, usage: Record<string, number | undefined>, model: Model<any>): void {
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
	// CodeBuddy may report reasoning/thinking tokens separately, while pi's Usage type does not model that field.
	const reasoning = usage.reasoning_tokens ?? usage.thinking_tokens;
	if (reasoning != null) (output.usage as typeof output.usage & { reasoning?: number }).reasoning = reasoning;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const cachePct = promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0;
	const reasoningText = reasoning != null ? ` reasoning=${reasoning}` : "";
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`);
}

// Log the *served* context window reported by an SDK result message
// (modelUsage[id].contextWindow), which can differ from the window pi
// registered (model.contextWindow) when the runtime entitlement doesn't
// match the docs — e.g. bare Opus served 200K on Pro, or [1m] not honored.
// The result message's modelUsage is otherwise discarded; this makes the
// gap observable. See issue #18.
async function logServedContextWindow(label: string, message: CbMessage, model: Model<any>): Promise<void> {
	const modelUsage = (message as any).modelUsage as Record<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined;
	if (!modelUsage) return;
	for (const [k, v] of Object.entries(modelUsage)) {
		debug(`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`);
		if (typeof v.contextWindow === "number") await observeServedContextWindow(label, k, v.contextWindow, model);
	}
}

async function observeServedContextWindow(
	label: string,
	servedModel: string,
	observed: number,
	model: Model<any>,
): Promise<void> {
	if (!Number.isFinite(observed) || observed <= 0) return;
	const processState = getProviderProcessState();
	const environment = calibrationEnvironment;
	const transactionKey = buildCalibrationKey(model.id, environment);
	const previousTransaction = processState.calibrationTransactions.get(transactionKey) ?? Promise.resolve();
	const transaction = previousTransaction
		.catch(() => undefined)
		.then(() => commitServedContextWindow(label, servedModel, observed, model, environment));
	processState.calibrationTransactions.set(transactionKey, transaction);
	try {
		await transaction;
	} finally {
		if (processState.calibrationTransactions.get(transactionKey) === transaction) {
			processState.calibrationTransactions.delete(transactionKey);
		}
	}
}

async function commitServedContextWindow(
	label: string,
	servedModel: string,
	observed: number,
	model: Model<any>,
	environment: CalibrationEnvironment,
): Promise<void> {
	const processState = getProviderProcessState();
	if (processState.models) MODELS = processState.models;
	calibrationCache = processState.calibrationCache ?? calibrationCache;
	processState.calibrationCache = calibrationCache;
	const previousRegistered = MODELS.find((candidate) => candidate.id === model.id)?.contextWindow;
	const pendingKey = buildCalibrationKey(model.id, environment);
	const pendingObservation = processState.pendingCalibrationObservations.get(pendingKey);
	const transaction = await updateObservedContextWindow(
		DEFAULT_CALIBRATION_CACHE_PATH,
		model.id,
		environment,
		observed,
		calibrationCache,
		pendingObservation ? { pendingMetric: pendingObservation.metric } : {},
	);
	if (transaction.persisted) processState.pendingCalibrationObservations.delete(pendingKey);
	else {
		const failedMetric = transaction.record.capabilities.contextWindow;
		if (failedMetric) {
			processState.pendingCalibrationObservations.set(pendingKey, {
				modelId: model.id,
				environment,
				metric: failedMetric,
			});
		}
	}
	calibrationCache = transaction.cache;
	processState.calibrationCache = transaction.cache;
	const committedRecord = getCalibrationRecord(transaction.cache, model.id, environment);
	const metric = committedRecord?.capabilities.contextWindow;
	const floor = metric?.floor;
	let lowered = false;
	if (floor != null) {
		MODELS = MODELS.map((candidate) => {
			if (candidate.id !== model.id) return candidate;
			const contextWindow = Math.min(candidate.contextWindow, floor);
			lowered ||= contextWindow < candidate.contextWindow;
			return { ...candidate, contextWindow };
		});
		processState.models = MODELS;
	}
	debug(
		`calibration: ${label} observed=${observed} floor=${floor ?? "?"} ` +
			`latest=${metric?.latest ?? "?"} servedModel=${servedModel} registeredBefore=${previousRegistered ?? "?"} persisted=${transaction.persisted}`,
	);
	if (lowered) scheduleCalibrationRefresh(`contextWindow:${model.id}`);
}

// --- Effort level mapping ---
// Pi reasoning levels → CC SDK effort levels

const REASONING_TO_EFFORT: Record<string, Effort> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh",
};

// --- Provider helpers: misc ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}


// --- Provider: streaming function ---
//
// Push-based streaming with MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current pi stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
//
// Completed assistant snapshots may arrive after Pi has already installed the
// tool-result continuation stream. Track their tool ids explicitly so they are
// consumed as the prior turn instead of being mistaken for a new assistant turn.

const completedStreams = new WeakSet<object>();

function markStreamComplete(stream: AssistantMessageEventStream | null): void {
	if (stream) completedStreams.add(stream as object);
}

function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext): void {
	if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
		debug(`WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`);
	}
	c.currentPiStream = stream;
}

function ensureTurnStarted(c: QueryContext): void {
	if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
		c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
		c.turnStarted = true;
	}
}

function emitAllowedToolBlock(c: QueryContext, block: any, contentIndex: number, emitEmpty = false): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	ensureTurnStarted(c);
	if (!block.__piToolcallStartEmitted) {
		c.currentPiStream.push({ type: "toolcall_start", contentIndex, partial: c.turnOutput });
		block.__piToolcallStartEmitted = true;
	}
	if (block.__piToolcallEndEmitted) return;
	if (!emitEmpty && isEmptyArgs(block.arguments)) {
		if (!c.argsPendingBlocks.some((pending) => pending.block === block)) {
			c.argsPendingBlocks.push({ block, contentIndex });
		}
		return;
	}
	c.turnSawToolCall = true;
	c.currentPiStream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: c.turnOutput });
	block.__piToolcallEndEmitted = true;
}

function finishPermissionDeferredTurn(c: QueryContext): void {
	if (!c.doneDeferredForArgs || c.permissionPendingBlocks.length > 0 || c.argsPendingBlocks.length > 0 || !c.currentPiStream || !c.turnOutput) return;
	c.doneDeferredForArgs = false;
	const stream = c.currentPiStream;
	const reason = c.turnSawToolCall ? "toolUse" : "stop";
	c.turnOutput.stopReason = reason;
	if (reason === "toolUse") expectTrailingAssistant(c);
	stream.push({ type: "done", reason, message: c.turnOutput });
	markStreamComplete(stream);
	stream.end();
	c.currentPiStream = null;
}

function resetCoordinatorForNewAssistantTurn(c: QueryContext): void {
	if (!c.toolTurnStatePreserved) return;
	const pendingDispatches = c.pendingMcpDispatches.map((pending) => ({
		toolName: pending.toolName,
		args: { ...pending.args },
	}));
	c.turnCoordinator.reset();
	for (const pending of pendingDispatches) {
		c.turnCoordinator.observeDispatch(pending.toolName, pending.args);
	}
	c.toolTurnStatePreserved = false;
}

function expectTrailingAssistant(c: QueryContext): void {
	const snapshot = c.turnCoordinator.snapshot();
	const toolCallIds = new Set([
		...c.turnToolCallIds,
		...snapshot.allowedIds,
		...snapshot.deniedIds,
		...snapshot.pendingIds,
	]);
	if (toolCallIds.size === 0) return;
	c.awaitingTrailingAssistant = {
		generation: c.sdkTurnGeneration,
		toolCallIds,
	};
	debug(`provider: awaiting trailing assistant generation=${c.sdkTurnGeneration} toolIds=${toolCallIds.size}`);
}

function consumeTrailingAssistant(message: CbMessage, c: QueryContext): boolean {
	const expected = c.awaitingTrailingAssistant;
	if (!expected) return false;
	const content = (message as any).message?.content;
	c.awaitingTrailingAssistant = null;
	if (!Array.isArray(content)) {
		debug(`provider: trailing assistant malformed generation=${c.sdkTurnGeneration}; delivering`);
		return false;
	}
	const toolCallIds = content
		.filter((block: any) => block?.type === "tool_use" && typeof block.id === "string")
		.map((block: any) => block.id as string);
	const matches = expected.generation === c.sdkTurnGeneration
		&& toolCallIds.length > 0
		&& toolCallIds.every((id) => expected.toolCallIds.has(id));
	if (!matches) {
		debug(`provider: trailing assistant mismatch generation=${c.sdkTurnGeneration} expectedIds=${expected.toolCallIds.size} actualIds=${toolCallIds.length}; delivering`);
		return false;
	}
	debug(`provider: consumed trailing assistant generation=${c.sdkTurnGeneration} toolIds=${toolCallIds.length}`);
	return true;
}

function replayPermissionBufferedEvents(c: QueryContext, customToolNameToPi: Map<string, string>, model: Model<any>): void {
	if (c.permissionReplayInProgress) return;
	c.permissionReplayInProgress = true;
	try {
		while (c.permissionPendingBlocks.length === 0) {
			if (c.permissionBufferedStreamEvents.length > 0) {
				const message = c.permissionBufferedStreamEvents.shift() as CbMessage;
				processStreamEvent(message, customToolNameToPi, model, c);
				continue;
			}
			if (c.permissionBufferedAssistantMessages.length > 0) {
				const message = c.permissionBufferedAssistantMessages.shift() as CbMessage;
				processAssistantMessage(message, model, customToolNameToPi, c);
				continue;
			}
			break;
		}
	} finally {
		c.permissionReplayInProgress = false;
	}
}

function resolvePermissionPendingTool(c: QueryContext, toolUseId: string, allowed: boolean, emitEmpty = false): void {
	const pendingIndex = c.permissionPendingBlocks.findIndex((pending) => pending.block.id === toolUseId);
	let shouldAllow = allowed;
	if (pendingIndex >= 0) {
		const pending = c.permissionPendingBlocks.splice(pendingIndex, 1)[0];
		if (c.turnCoordinator.snapshot().pendingIds.includes(toolUseId)) {
			const decision = c.turnCoordinator.recordPermissionDecision(
				toolUseId,
				pending.block.name,
				allowed ? "allow" : "deny",
				allowed ? undefined : "permission-denied",
				pending.block.arguments,
			);
			shouldAllow = allowed && decision.behavior === "allow";
		}
		if (shouldAllow) {
			const coordinatorArgs = c.turnCoordinator.getArgs(toolUseId);
			if (!isEmptyArgs(coordinatorArgs)) {
				pending.block.arguments = mapToolArgs(pending.block.name, {
					...(pending.block.arguments ?? {}),
					...coordinatorArgs,
				});
			}
			emitAllowedToolBlock(c, pending.block, pending.contentIndex, emitEmpty);
		}
	}
	if (!shouldAllow) {
		// The pending block has already been removed from permissionPendingBlocks;
		// locate it from the turn content by id and remove it before Pi sees the
		// final assistant message.
		const deniedBlockIndex = c.turnBlocks.findIndex((block: any) => block.type === "toolCall" && block.id === toolUseId);
		if (deniedBlockIndex >= 0) c.turnBlocks.splice(deniedBlockIndex, 1);
		c.argsPendingBlocks = c.argsPendingBlocks.filter((pending) => pending.block.id !== toolUseId);
		const idIndex = c.turnToolCallIds.indexOf(toolUseId);
		if (idIndex >= 0) c.turnToolCallIds.splice(idIndex, 1);
		c.matchedToolCallIds.delete(toolUseId);
		c.pendingResults.delete(toolUseId);
		const pendingCall = c.pendingToolCalls.get(toolUseId);
		if (pendingCall) {
			c.pendingToolCalls.delete(toolUseId);
			pendingCall.resolve({ content: [{ type: "text", text: "Tool call was denied before execution." }], isError: true });
		}
	}
	c.permissionReplay?.();
	finishPermissionDeferredTurn(c);
}

function finalizePermissionPending(c: QueryContext, message: string): void {
	for (let attempt = 0; attempt < 1_000; attempt++) {
		if (c.permissionPendingBlocks.length > 0) {
			for (const pending of [...c.permissionPendingBlocks]) {
				resolvePermissionPendingTool(c, pending.block.id, false);
			}
			continue;
		}
		if (c.permissionBufferedStreamEvents.length > 0 || c.permissionBufferedAssistantMessages.length > 0) {
			c.permissionReplay?.();
			if (c.permissionPendingBlocks.length > 0) continue;
		}
		break;
	}
	c.permissionBufferedStreamEvents = [];
	c.permissionBufferedAssistantMessages = [];
	drainPendingMcpDispatches(c, message);
	for (const id of c.turnCoordinator.snapshot().deniedIds) resolvePermissionPendingTool(c, id, false);
}

function finalizeCurrentStream(c: QueryContext, stopReason?: string): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	debug(`provider: finalizeCurrentStream called, stopReason=${stopReason}, outputStop=${c.turnOutput!.stopReason}`);
	if (!c.turnStarted) ensureTurnStarted(c);
	const reason = stopReason === "length" ? "length" : "stop";
	const stream = c.currentPiStream;

	// Drain any args-pending blocks: if the SDK ended abnormally (crash, network
	// error) without yielding an assistant message, these blocks were never
	// backfilled. Emit them with their current (possibly empty) args so pi can
	// surface validation errors rather than silently dropping the tool calls.
	if (c.argsPendingBlocks.length > 0) {
		debug(`finalizeCurrentStream: draining ${c.argsPendingBlocks.length} pending block(s) with current args`);
		for (const pending of c.argsPendingBlocks) {
			c.turnSawToolCall = true;
			stream!.push({ type: "toolcall_end", contentIndex: pending.contentIndex, toolCall: pending.block, partial: c.turnOutput });
		}
		c.argsPendingBlocks = [];
		c.doneDeferredForArgs = false;
	}
	stream!.push({ type: "done", reason, message: c.turnOutput });
	markStreamComplete(stream);
	stream!.end();
	c.currentPiStream = null;
}

/** Maps Anthropic stream events to pi stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
function processStreamEvent(
	message: CbMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	c: QueryContext,
): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	const event = (message as CbMessage & { event: any }).event;
	c.permissionReplay = () => replayPermissionBufferedEvents(c, customToolNameToPi, model);
	if (c.turnCoordinator.requirePermission && c.permissionPendingBlocks.length > 0 && !c.permissionReplayInProgress) {
		if (event?.type === "message_stop") c.doneDeferredForArgs = true;
		c.permissionBufferedStreamEvents.push(message);
		return;
	}
	c.turnSawStreamEvent = true;

	if (event?.type === "message_start") {
		if (c.awaitingTrailingAssistant) {
			debug(`provider: trailing assistant missing before generation ${c.sdkTurnGeneration + 1}; clearing marker`);
			c.awaitingTrailingAssistant = null;
		}
		c.sdkTurnGeneration++;
		c.turnToolCallIds = [];
		c.nextHandlerIdx = 0;
		c.matchedToolCallIds = new Set();
		c.claimedToolUseId = null;
		resetCoordinatorForNewAssistantTurn(c);
		if (event.message?.usage) updateUsage(c.turnOutput, event.message.usage, model);
		return;
	}

	if (event?.type === "content_block_start") {
		ensureTurnStarted(c);
		if (event.content_block?.type === "text") {
			c.turnBlocks.push({ type: "text", text: "", index: event.index });
			c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "thinking") {
			c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			c.currentPiStream!.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "tool_use") {
			// Enforce serial execution at the stream boundary, before Pi sees a
			// second toolcall_start. canUseTool runs later in the SDK control path;
			// relying on it alone still exposes denied parallel blocks to Pi.
			if (c.turnToolCallIds.length > 0 && !c.turnCoordinator.requirePermission) {
				debug(`processStreamEvent: suppressing parallel tool_use ${event.content_block.name} [${event.content_block.id}] — first tool [${c.turnToolCallIds[0]}] owns this turn`);
				return;
			}
			const mappedToolName = mapToolName(event.content_block.name, customToolNameToPi);
				const permission = c.turnCoordinator.observeStreamStart(
					event.content_block.id,
					mappedToolName,
					(event.content_block.input as Record<string, unknown>) ?? {},
					event.index,
				);
				const initialInput = (event.content_block.input as Record<string, unknown>) ?? {};
				const knownArgs = c.turnCoordinator.getArgs(event.content_block.id);
				const initialArgs = mapToolArgs(mappedToolName, { ...knownArgs, ...initialInput });
				const dispatchArgs = bindPendingMcpDispatch(c, mappedToolName, event.content_block.id, initialArgs);
				if (c.turnCoordinator.requirePermission && permission === "deny") {
					resolvePermissionPendingTool(c, event.content_block.id, false);
					return;
				}
				c.turnToolCallIds.push(event.content_block.id);
				c.claimedToolUseId = event.content_block.id;
				const block: any = {
					type: "toolCall", id: event.content_block.id,
					name: mappedToolName,
					arguments: initialArgs,
					partialJson: "", index: event.index,
				};
				if (!isEmptyArgs(dispatchArgs)) block.arguments = mapToolArgs(mappedToolName, dispatchArgs);
			c.turnBlocks.push(block);
			const contentIndex = c.turnBlocks.length - 1;
			if (!c.turnCoordinator.requirePermission || permission === "allow") {
				c.currentPiStream!.push({ type: "toolcall_start", contentIndex, partial: c.turnOutput });
				block.__piToolcallStartEmitted = true;
			} else if (permission === "pending") {
				c.permissionPendingBlocks.push({ block, contentIndex });
			}
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	function closeOpenToolBlocksAtMessageStop(): void {
		for (let index = 0; index < c.turnBlocks.length; index++) {
			const block = c.turnBlocks[index];
			if (block.type !== "toolCall" || block.index === undefined) continue;
			delete block.index;
			block.arguments = mapToolArgs(block.name, block.arguments);
			delete block.partialJson;
			const permission = c.turnCoordinator.observeStreamArgs(block.id, block.arguments, true);
			if (c.turnCoordinator.requirePermission && permission !== "allow") {
				if (permission === "pending" && !c.permissionPendingBlocks.some((pending) => pending.block === block)) {
					c.permissionPendingBlocks.push({ block, contentIndex: index });
				}
				continue;
			}
			if (isEmptyArgs(block.arguments)) {
				if (!c.argsPendingBlocks.some((pending) => pending.block === block)) {
					debug(`processStreamEvent: message_stop found open tool block ${block.name} [${block.id}] with empty args; deferring for assistant backfill`);
					c.argsPendingBlocks.push({ block, contentIndex: index });
				}
				continue;
			}
			if (block.__piToolcallEndEmitted) continue;
			c.turnSawToolCall = true;
			c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
			block.__piToolcallEndEmitted = true;
		}
	}

	if (event?.type === "content_block_delta") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
			if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
			} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
				block.partialJson += event.delta.partial_json;
				block.arguments = parsePartialJson(block.partialJson, block.arguments);
				c.turnCoordinator.observeStreamArgs(block.id, block.arguments, false, event.delta.partial_json);
				if (!c.turnCoordinator.requirePermission || c.turnCoordinator.isAllowed(block.id)) {
					c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
				}
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
		} else if (block.type === "toolCall") {
			const partialJsonLen = block.partialJson?.length ?? 0;
				block.arguments = mapToolArgs(
					block.name, parsePartialJson(block.partialJson, block.arguments),
				);
				const permission = c.turnCoordinator.observeStreamArgs(block.id, block.arguments, true);
				delete block.partialJson;

			debug(`processStreamEvent: content_block_stop ${block.name} [${block.id}] argsSource=${
				isEmptyArgs(block.arguments) ? "EMPTY" : "stream"
			} argsLen=${JSON.stringify(block.arguments).length} partialJsonLen=${partialJsonLen}`);

			// Parallel tool-call arg-dropping defense: when the stream delivers
			// empty args (CodeBuddy's MCP client may dispatch parallel tool_call
			// arguments as {}), defer toolcall_end until the assistant message
			// (or MCP dispatch) provides real args. This prevents pi from
			// executing tools with empty args (e.g. "bash" with no command).
			//
			// turnSawToolCall is set only when we actually emit a toolcall_end
			// (here for non-empty args, or in the backfill path for deferred
			// blocks). This ensures message_stop's done-deferral check fires
			// correctly even when ALL tool blocks had empty args.
				if (c.turnCoordinator.requirePermission && permission !== "allow") {
					if (permission === "pending" && !c.permissionPendingBlocks.some((pending) => pending.block === block)) {
						c.permissionPendingBlocks.push({ block, contentIndex: index });
					}
					return;
				}
				if (block.__piToolcallEndEmitted) return;
				if (isEmptyArgs(block.arguments)) {
				debug(`processStreamEvent: deferring toolcall_end for ${block.name} [${block.id}] — stream args empty, will backfill from assistant message or MCP dispatch`);
				c.argsPendingBlocks.push({ block, contentIndex: index });
				} else {
					c.turnSawToolCall = true;
					c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
					block.__piToolcallEndEmitted = true;
			}
		}
		return;
	}

	if (event?.type === "message_delta") {
		c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) updateUsage(c.turnOutput, event.usage, model);
		return;
	}

	// A dropped parallel block may never receive content_block_stop. Close the
	// accepted block here so its start cannot remain dangling with {} args.
	if (event?.type === "message_stop") closeOpenToolBlocksAtMessageStop();

	// Check args-pending blocks FIRST, before the turnSawToolCall gate.
	// turnSawToolCall is only set when a toolcall_end is actually emitted (non-empty
	// args in content_block_stop, or during backfill). When ALL tool blocks had
	// empty stream args, turnSawToolCall is false here. Without this early check,
	// doneDeferredForArgs would never be set and the stream would hang forever.
	// This is defense-in-depth: the backfill path also handles this, but setting
	// doneDeferredForArgs here ensures the assistant message path knows to emit done.
	if (event?.type === "message_stop" && c.permissionPendingBlocks.length > 0) {
		debug(`processStreamEvent: message_stop deferring done event — ${c.permissionPendingBlocks.length} block(s) awaiting permission`);
		c.doneDeferredForArgs = true;
		return;
	}

	if (event?.type === "message_stop" && c.argsPendingBlocks.length > 0) {
		debug(`processStreamEvent: message_stop deferring done event — ${c.argsPendingBlocks.length} block(s) awaiting args backfill (turnSawToolCall=${c.turnSawToolCall})`);
		c.doneDeferredForArgs = true;
		return;
	}

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		// Tool call complete — end this pi stream. The SDK will still yield an
		// assistant message for this turn, but currentPiStream=null causes
		// consumeQuery to skip it. The MCP handler blocks the generator until
		// pi delivers the tool result via the next streamSimple call.
		c.turnOutput.stopReason = "toolUse";
		expectTrailingAssistant(c);
		const stream = c.currentPiStream;
		stream!.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		markStreamComplete(stream);
		stream!.end();
		c.currentPiStream = null;

		// Cursor is updated by the next streamSimple call (tool result delivery path)
		// which sets cursor = context.messages.length with the post-tool-result context.
		return;
	}

	if (event?.type !== "message_stop" && event?.type !== "ping") {
		debug("processStreamEvent: unhandled event type", event?.type);
	}
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
function processAssistantMessage(message: CbMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
	if (consumeTrailingAssistant(message, c)) return;
	if (!c.currentPiStream || !c.turnOutput) return;
	c.permissionReplay = () => replayPermissionBufferedEvents(c, customToolNameToPi, model);
	if (c.turnCoordinator.requirePermission && c.permissionPendingBlocks.length > 0 && !c.permissionReplayInProgress) {
		c.permissionBufferedAssistantMessages.push(message);
		return;
	}
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;

	function emitAssistantOnlyToolUse(block: any): void {
		if (c.turnToolCallIds.length > 0 && !c.turnCoordinator.requirePermission) {
			debug(`processAssistantMessage: suppressing assistant-only tool_use ${block.name} [${block.id}] — first tool [${c.turnToolCallIds[0]}] owns this turn`);
			return;
		}
		ensureTurnStarted(c);
		c.turnToolCallIds.push(block.id);
		c.claimedToolUseId = block.id;
		const mappedName = mapToolName(block.name, customToolNameToPi);
		let mappedArgs = mapToolArgs(mappedName, {
			...c.turnCoordinator.getArgs(block.id),
			...(block.input ?? {}),
		});
		const permission = c.turnCoordinator.observeAssistantBlock(block.id, mappedName, mappedArgs);
		const dispatchArgs = bindPendingMcpDispatch(c, mappedName, block.id, mappedArgs);
		if (!isEmptyArgs(dispatchArgs)) mappedArgs = mapToolArgs(mappedName, dispatchArgs);
		if (c.turnCoordinator.requirePermission && permission === "deny") {
			resolvePermissionPendingTool(c, block.id, false);
			return;
		}
		c.turnBlocks.push({
			type: "toolCall", id: block.id,
			name: mappedName,
			arguments: mappedArgs,
		});
		const idx = c.turnBlocks.length - 1;
		const toolBlock = c.turnBlocks[idx];
		if (!c.turnCoordinator.requirePermission || permission === "allow") {
			c.turnSawToolCall = true;
			c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
			toolBlock.__piToolcallStartEmitted = true;
			c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
			toolBlock.__piToolcallEndEmitted = true;
		} else if (permission === "pending") {
			c.permissionPendingBlocks.push({ block: toolBlock, contentIndex: idx });
			c.doneDeferredForArgs = true;
		}
	}

	// --- Args-backfill path (stream already delivered content, but some tool
	// blocks had empty args). Use the assistant message's complete tool_use
	// input to backfill the deferred blocks, then emit the pending toolcall_end
	// events and the deferred done event.
	if (c.turnSawStreamEvent && c.argsPendingBlocks.length > 0) {
		debug(`processAssistantMessage: backfill path — ${c.argsPendingBlocks.length} pending block(s), assistant has ${assistantMsg.content.length} blocks`);
		const toolUseBlocks = assistantMsg.content.filter((b: any) => b.type === "tool_use");

		// Match pending blocks to assistant message tool_use blocks by position.
		// Stream order and assistant message order should align (both follow the
	// model's content_block index). If names mismatch we log a warning but still
	// backfill by position — the stream is the source of truth for ids.
		const remaining = [...c.argsPendingBlocks];
		for (const tuBlock of toolUseBlocks) {
			if (remaining.length === 0) break;
			const tuName = mapToolName(tuBlock.name, customToolNameToPi);
			// Find the first pending block whose name matches (or just the first
		// pending block if names don't match — positional fallback).
			let matchIdx = remaining.findIndex((p) => p.block.name === tuName);
			if (matchIdx < 0) {
				debug(`processAssistantMessage: backfill name mismatch — assistant '${tuName}' vs pending [${remaining.map((p) => p.block.name).join(",")}], using positional fallback`);
				matchIdx = 0;
			}
			const pending = remaining.splice(matchIdx, 1)[0];
			const dispatchArgs = mapToolArgs(pending.block.name, tuBlock.input);
			c.turnCoordinator.observeAssistantBlock(pending.block.id, pending.block.name, dispatchArgs);
			if (isEmptyArgs(dispatchArgs)) {
				debug(`processAssistantMessage: backfill for ${pending.block.name} [${pending.block.id}] — assistant args also empty, emitting with empty args (pi will validate)`);
			} else {
				debug(`processAssistantMessage: backfilled ${pending.block.name} [${pending.block.id}] from assistant message (argsLen=${JSON.stringify(dispatchArgs).length})`);
			}
			pending.block.arguments = dispatchArgs;
			delete pending.block.index;
			c.turnSawToolCall = true;
			c.currentPiStream?.push({ type: "toolcall_end", contentIndex: pending.contentIndex, toolCall: pending.block, partial: c.turnOutput });
			// Remove from the original argsPendingBlocks array
			const origIdx = c.argsPendingBlocks.indexOf(pending);
			if (origIdx >= 0) c.argsPendingBlocks.splice(origIdx, 1);
		}

		// Any remaining pending blocks (no matching assistant tool_use) get
		// emitted with their (empty) args so pi can surface the validation error
		// rather than hanging forever.
		for (const pending of remaining) {
			debug(`processAssistantMessage: backfill — no matching assistant tool_use for ${pending.block.name} [${pending.block.id}], emitting with current args`);
			c.turnSawToolCall = true;
			c.currentPiStream?.push({ type: "toolcall_end", contentIndex: pending.contentIndex, toolCall: pending.block, partial: c.turnOutput });
			const origIdx = c.argsPendingBlocks.indexOf(pending);
			if (origIdx >= 0) c.argsPendingBlocks.splice(origIdx, 1);
		}

		// Emit the deferred done event (message_stop skipped it because of pending blocks)
		if (c.doneDeferredForArgs && c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
			c.doneDeferredForArgs = false;
			c.turnOutput.stopReason = "toolUse";
			const stream = c.currentPiStream;
			expectTrailingAssistant(c);
			stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
			markStreamComplete(stream);
			stream.end();
			c.currentPiStream = null;
			debug(`processAssistantMessage: backfill complete, emitted deferred done event`);
		}
		return;
	}

	// --- Original path: no stream events, this is the primary content path ---
	if (c.turnSawStreamEvent) {
		const unseenToolUseBlocks = assistantMsg.content.filter((block: any) =>
			block?.type === "tool_use"
			&& typeof block.id === "string"
			&& !c.turnToolCallIds.includes(block.id)
			&& !c.turnBlocks.some((turnBlock: any) => turnBlock.type === "toolCall" && turnBlock.id === block.id),
		);
		if (unseenToolUseBlocks.length === 0 || c.turnToolCallIds.length > 0) return;
		debug(`processAssistantMessage: mixed stream/assistant path — ${unseenToolUseBlocks.length} unseen tool_use block(s)`);
		for (const block of unseenToolUseBlocks) {
			emitAssistantOnlyToolUse(block);
			if (c.turnSawToolCall || c.permissionPendingBlocks.length > 0) break;
		}
		if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
			c.turnOutput.stopReason = "toolUse";
			const stream = c.currentPiStream;
			expectTrailingAssistant(c);
			stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
			markStreamComplete(stream);
			stream.end();
			c.currentPiStream = null;
		}
		return;
	}
	c.sdkTurnGeneration++;
	c.turnToolCallIds = [];
	c.nextHandlerIdx = 0;
	c.matchedToolCallIds = new Set();
	c.claimedToolUseId = null;
	resetCoordinatorForNewAssistantTurn(c);
	debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "text", text: block.text });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
			if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
			} else if (block.type === "tool_use") {
				emitAssistantOnlyToolUse(block);
		} else {
			debug("processAssistantMessage: unhandled block type", block.type);
		}
	}
	if (assistantMsg.usage && c.turnOutput) updateUsage(c.turnOutput, assistantMsg.usage, model);

	// End the stream on tool_use, same as processStreamEvent's message_stop handler.
	if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		expectTrailingAssistant(c);
		stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		markStreamComplete(stream);
		stream.end();
		c.currentPiStream = null;
	}
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result. */
async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	wasAborted: () => boolean,
	queryCtx: QueryContext,
): Promise<{ capturedSessionId?: string }> {
	let capturedSessionId: string | undefined;

	for await (const message of sdkQuery) {
		if (wasAborted()) break;
		if ((message as { type: string }).type === "assistant") {
			processAssistantMessage(message, model, customToolNameToPi, queryCtx);
			continue;
		}
		if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

		switch ((message as { type: string }).type) {
			case "stream_event":
				processStreamEvent(message, customToolNameToPi, model, queryCtx);
				break;
			case "result": {
				const resultMsg = message as Extract<CbMessage, { type: "result" }>;
				await logServedContextWindow("result", message, model);
				if (!queryCtx.turnSawStreamEvent && resultMsg.subtype === "success") {
					ensureTurnStarted(queryCtx);
					const text = resultMsg.result || "";
					queryCtx.turnBlocks.push({ type: "text", text });
					const idx = queryCtx.turnBlocks.length - 1;
					queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
				}
				break;
			}
			case "system":
				if ((message as any).subtype === "init" && (message as any).session_id) {
					capturedSessionId = (message as any).session_id;
				}
				break;
			case "user":
			case "file-history-snapshot":
				break;
			case "rate_limit_event": {
				const info = (message as any).rate_limit_info;
				debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
				if (info?.status === "rejected") {
					const resetsAt = info.resetsAt ? new Date(info.resetsAt).toLocaleTimeString() : "unknown";
					providerUiSlot.current?.notify(`CodeBuddy rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, "warning");
				} else if (info?.status === "allowed_warning") {
					providerUiSlot.current?.notify(`CodeBuddy rate limit warning: ${Math.round(info.utilization ?? 0)}% used (${info.rateLimitType ?? ""})`, "warning");
				}
				break;
			}
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	// DEBUG: trace when consumeQuery exits
	debug(`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);
	queryCtx.awaitingTrailingAssistant = null;
	if (wasAborted()) {
		queryCtx.turnCoordinator.abort();
		finalizePermissionPending(queryCtx, "Operation aborted");
	} else {
		queryCtx.turnCoordinator.finishTurn();
		finalizePermissionPending(queryCtx, "Query ended");
	}

	return { capturedSessionId };
}

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. */
function streamCodebuddySdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = newAssistantMessageEventStream();
	const invocationRoute = getProviderInvocationRoute(options);
	if (!invocationRoute) throw new Error("CodeBuddy provider invocation is missing its Pi runtime route");
	const providerSettings = invocationRoute.provider;
	const cwd = invocationRoute.canonicalCwd;

	// DEBUG: trace followUp message triggering
	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(`provider: streamCodebuddySdk called, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${ctx().activeQuery !== null}`);

	const activeQuery = ctx().activeQuery !== null;
	const allResults = providerActiveQueries().size > 0 ? extractAllToolResults(context) : [];
	const resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;
	const isReentrantUserQuery = activeQuery && lastMsgRole === "user" && allResults.length === 0;
	if (isReentrantUserQuery) {
		debug(`provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${ctx().pendingToolCalls.size}, ctx.msgs=${context.messages.length}`);
	}

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (resultCtx) {
		claimCurrentPiStream(stream, "tool-result", resultCtx);
		// The SDK may still be dispatching sibling MCP tools from the same
		// assistant turn. Preserve their coordinator and pending dispatches until
		// the next assistant message starts, otherwise a late sibling handler loses
		// its toolCallId and waits forever.
		resultCtx.resetTurnState(model, true);
		debug(`provider: tool results, ${allResults.length} results, ${resultCtx.pendingToolCalls.size} waiting handlers, ctx.msgs=${context.messages.length}`);
		for (const result of allResults) {
			const id = result.toolCallId;
			if (id && resultCtx.pendingToolCalls.has(id)) {
				const pending = resultCtx.pendingToolCalls.get(id)!;
				resultCtx.pendingToolCalls.delete(id);
				debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""} contentLen=${JSON.stringify(result.content).length}`);
				pending.resolve(result);
			} else if (id) {
				resultCtx.pendingResults.set(id, result);
				debug(`provider: queued result [${id}] (${resultCtx.pendingResults.size} pending)`);
			} else {
				debug(`WARNING: tool result without toolCallId, cannot match`);
			}
			if (resultCtx.pendingToolCalls.size > 0 && resultCtx.pendingResults.size > 0) {
				debug(`BUG: both maps non-empty! handlers=${resultCtx.pendingToolCalls.size} results=${resultCtx.pendingResults.size}`);
			}
		}
		if (resultCtx.pendingToolCalls.size > 0) {
			debug(`WARNING: ${resultCtx.pendingToolCalls.size} MCP handlers still waiting after delivering ${allResults.length} results`);
			providerUiSlot.current?.notify(`CodeBuddy SDK: ${resultCtx.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
		}

		// Detect user messages (steer/followUp) that pi injected into context
		// during the active query. This happens when:
		//   - User sends a steer while a tool is executing; pi drains the steer
		//     queue at the turn boundary and appends it to context alongside the
		//     tool result, then calls the provider again.
		//   - A followUp is delivered between tool-result turns.
		// The bridge can't forward these mid-query (the SDK query is in progress),
		// so we save them for replay as continuation queries after consumeQuery ends.
		if (lastMsgRole === "user") {
			const userPrompt = extractUserPrompt(context.messages);
			if (userPrompt) {
				resultCtx.deferredUserMessages.push(userPrompt);
				debug(`provider: deferred user message for replay after query (len=${userPrompt.length})`);
			}
		}

		if (providerSessionSlot.current) providerSessionSlot.current.cursor = context.messages.length;
		resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
		return stream;
	}

	// --- Orphaned tool result (e.g. user aborted a tool call) ---
	// The query is gone but pi still delivered the result. Nothing to do — just
	// emit end_turn so pi waits for the next real user message.
	const lastMsg = context.messages[context.messages.length - 1];
	if (lastMsg?.role === "toolResult") {
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		if (providerSessionSlot.current) providerSessionSlot.current.cursor = context.messages.length;
		const c = ctx();  // capture current context for the microtask
		queueMicrotask(() => {
			c.resetTurnState(model);
			stream.push({ type: "done", reason: "stop", message: c.turnOutput });
			markStreamComplete(stream);
			stream.end();
		});
		return stream;
	}

	// --- Fresh query ---

	// 1. Determine reentrancy. Reentrant queries get their own QueryContext so
	//    background subagents can run concurrently with the parent query.
	const isReentrant = activeQuery;
	const queryCtx = isReentrant ? new QueryContext() : ctx();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${providerActiveQueries().size}`);

	// 2. Fresh child context — constructor already gave us clean Maps and empty
	//    arrays. For a reused top-level context, clear explicitly.
	claimCurrentPiStream(stream, "fresh-query", queryCtx);
	queryCtx.pendingToolCalls.clear();
	queryCtx.pendingResults.clear();
	queryCtx.deferredUserMessages = [];
	queryCtx.resetTurnState(model);
	queryCtx.latestCursor = 0;

	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(
		context,
		invocationRoute.askAliases,
	);
	const syncResult = syncSharedSession(context.messages, cwd, customToolNameToSdk, model.id);
	const { sessionId: resumeSessionId } = syncResult;
	const promptBlocks = extractUserPromptBlocks(context.messages);
	let promptText = extractUserPrompt(context.messages) ?? "";

	// Guard: empty prompt means the last context message isn't a user message.
	// This should never happen with per-query state — dump diagnostics if it does.
	if (!promptText && !promptBlocks) {
		diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: lastMsg?.role,
			isReentrant,
			activeQueryContexts: providerActiveQueries().size,
			activeQueryExists: queryCtx.activeQuery !== null,
			sharedSession: providerSessionSlot.current ? { sessionId: providerSessionSlot.current.sessionId.slice(0, 8), cursor: providerSessionSlot.current.cursor } : null,
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Recover: use a continuation prompt so the SDK doesn't send an empty text block
		promptText = "[continue]";
	}

	const prompt: string | AsyncIterable<CbUserMessage> = promptBlocks
		? wrapPromptStream(promptBlocks)
		: promptText;
	const mcpBridge = buildMcpServers(mcpTools, queryCtx);
	const supportedMcpToolNames = new Set(mcpBridge.tools.map((tool) => tool.name));
	for (const key of [...customToolNameToSdk.keys()]) {
		if (!supportedMcpToolNames.has(key) && !supportedMcpToolNames.has(key.toLowerCase())) customToolNameToSdk.delete(key);
	}
	for (const [key, value] of [...customToolNameToPi.entries()]) {
		if (!supportedMcpToolNames.has(value)) customToolNameToPi.delete(key);
	}
	const mcpServers = mcpBridge.servers;
	const boundaryOptions = buildProviderBoundaryOptions(providerSettings);
	const appendSystemPrompt = boundaryOptions.appendSystemPrompt;
	const systemPrompt = appendSystemPrompt
		? buildCodebuddySystemPrompt(context.systemPrompt, { availableToolNames: mcpBridge.tools.map((tool) => tool.name) })
		: undefined;

	// Provider Path keeps CodeBuddy inside Pi's tool boundary: no built-in SDK
	// tools, strict MCP by default, and no filesystem settings while Pi's system
	// prompt override is active. Current SDK maps settingSources=undefined to
	// `--setting-sources none`; appendSystemPrompt=false is the compatibility
	// escape hatch that re-enables user/project settings by default.
	const codebuddyExecutable = providerSettings.pathToCodebuddyCode;

	// Prefer the model's own thinkingLevelMap when present (pi-ai 0.72+ ships
	// per-model overrides — e.g. opus-4-7 wants xhigh→xhigh, not xhigh→max).
	// Fall back to our generic table for older pi-ai or unmapped levels.
	const effort = options?.reasoning
		? ((model as any).thinkingLevelMap?.[options.reasoning] as Effort | undefined)
			?? REASONING_TO_EFFORT[options.reasoning]
		: undefined;

	// cliModel is the actual id sent to CodeBuddy (may carry [1m]); model.id is the
	// pi-registered id. Log cliModel so debug lines reflect what CC actually received.
	const cliModel = codebuddyModelId(model);

	const childEnv = { ...process.env, DISABLE_AUTO_COMPACT: "1" };
	const queryOptions = buildProviderQueryOptions({
		providerSettings,
		cliModel,
		cwd,
		env: childEnv,
		systemPrompt,
		effort,
		mcpServers,
		resumeSessionId,
		codebuddyExecutable,
		debugOptions: makeCliDebugOptions("provider"),
	});

	// P4: canUseTool pre-validation — reject empty dispatch args at MCP layer
	// before they reach pi. This is an early signal to CodeBuddy that args
	// were dropped (parallel tool_call dispatch bug), giving the model a chance
	// to regenerate proper args in the same turn rather than failing at pi-side
	// validation and requiring a full retry.
	//
	// Only rejects when the tool has required params AND dispatch args are empty.
	// Tools without required params (e.g. some MCP tools) pass through normally.
	const piTools = context.tools ?? [];
	queryCtx.turnCoordinator = new ToolTurnCoordinator({
		hasRequiredArgs: (toolName) => hasRequiredParams(toolName, piTools),
		requirePermission: true,
	});
	(queryOptions as SdkQueryOptions).canUseTool = async (toolName: string, input: Record<string, unknown>, opts) => {
		const piName = mapToolName(toolName, customToolNameToPi);
		const mappedArgs = mapToolArgs(piName, input);
		const requiresArgs = hasRequiredParams(piName, piTools);
		if (isEmptyArgs(mappedArgs) && requiresArgs) {
			queryCtx.turnCoordinator.recordPermissionDecision(
				opts.toolUseID,
				piName,
				"deny",
				"empty-required-args",
				mappedArgs,
			);
			resolvePermissionPendingTool(queryCtx, opts.toolUseID, false);
			debug(`canUseTool: rejecting ${toolName}→${piName} — empty args for tool with required params (toolUseId=${opts.toolUseID})`);
			return {
				behavior: "deny" as const,
				message: `Tool "${piName}" requires arguments but received empty input. This can happen with parallel tool calls. Please provide complete arguments for all required fields.`,
				toolUseID: opts.toolUseID,
			};
		}
		const decision = queryCtx.turnCoordinator.recordPermissionDecision(
			opts.toolUseID,
			piName,
			"allow",
			undefined,
			mappedArgs,
		);
		if (decision.behavior !== "allow") {
			resolvePermissionPendingTool(queryCtx, opts.toolUseID, false);
			debug(`canUseTool: rejecting ${toolName}→${piName} — serial mode already claimed by ${queryCtx.claimedToolUseId} (toolUseId=${opts.toolUseID})`);
			return {
				behavior: "deny" as const,
				message: `Only one tool call is allowed per assistant turn. Wait for the current tool result before calling another tool in a later turn.`,
				toolUseID: opts.toolUseID,
			};
		}
		queryCtx.claimedToolUseId = opts.toolUseID;
		resolvePermissionPendingTool(queryCtx, opts.toolUseID, true);
		return { behavior: "allow" as const, toolUseID: opts.toolUseID };
	};

	debug("provider: fresh query",
		`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
		`appendSys=${appendSystemPrompt} strictMcp=true`,
		`promptLen=${promptText.length}${promptBlocks ? " [+images]" : ""}`);

	// 3. Start SDK query (wait for model discovery + serialize SDK subprocess access)
	let wasAborted = false;
	let sdkQuery: ReturnType<typeof query> | undefined;
	const liveQueryRef: { current?: ReturnType<typeof query> } = {};
	const abortCtx = queryCtx;

	const requestAbort = () => {
		interruptLiveQuery(liveQueryRef);
	};
	const onAbort = () => {
		wasAborted = true;
		abortCtx.deferredUserMessages = [];
		abortCtx.awaitingTrailingAssistant = null;
		abortCtx.turnCoordinator.abort();
		finalizePermissionPending(abortCtx, "Operation aborted");
		drainPendingMcpDispatches(abortCtx, "Operation aborted");
		for (const pending of abortCtx.pendingToolCalls.values()) { pending.resolve({ content: [{ type: "text", text: "Operation aborted" }] }); }
		abortCtx.pendingToolCalls.clear();
		abortCtx.pendingResults.clear();
		requestAbort();
	};
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

		void (async () => {
			await ensureModelsDiscovered();
			sdkQuery = query({ prompt, options: queryOptions });
			liveQueryRef.current = sdkQuery;
			queryCtx.activeQuery = sdkQuery;
			providerActiveQueries().add(queryCtx);

		try {
			const { capturedSessionId } = await consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx);
			debug(`provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`);

			if (wasAborted || options?.signal?.aborted) {
				if (providerSessionSlot.current) providerSessionSlot.current = { ...providerSessionSlot.current, needsRebuild: true, forceRotate: true };
				queryCtx.deferredUserMessages = [];
				debug(`provider: abort detected, marked providerSessionSlot.current needsRebuild + forceRotate`);
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "aborted";
					queryCtx.turnOutput.errorMessage = "Operation aborted";
				}
				const errStream = queryCtx.currentPiStream;
				errStream?.push({ type: "error", reason: "aborted", error: queryCtx.turnOutput! });
				markStreamComplete(errStream);
				errStream?.end();
				queryCtx.currentPiStream = null;
				return;
			}

			const sessionId = capturedSessionId ?? providerSessionSlot.current?.sessionId;
			if (syncResult.preserveSharedSession) {
				if (capturedSessionId && capturedSessionId !== providerSessionSlot.current?.sessionId) {
					deleteSession(capturedSessionId, cwd, process.env.CODEBUDDY_CONFIG_DIR);
					debug(`provider: query done, deleted ephemeral session ${capturedSessionId.slice(0, 8)} to preserve shared session`);
				}
				debug(`provider: query done, ignoring captured session ${capturedSessionId?.slice(0, 8) ?? "none"} to preserve shared session`);
			} else if (sessionId) {
				const cursor = Math.max(context.messages.length, queryCtx.latestCursor, providerSessionSlot.current?.cursor ?? 0);
				debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`);
				providerSessionSlot.current = { sessionId, cursor, cwd };
			}

			while (queryCtx.deferredUserMessages.length > 0 && !isReentrant && !wasAborted) {
				const steerPrompt = queryCtx.deferredUserMessages.shift()!;
				debug(`provider: replaying deferred user message (len=${steerPrompt.length})`);
				queryCtx.resetTurnState(model);

				const resumeId = providerSessionSlot.current?.sessionId;
				if (!resumeId) {
					debug(`WARNING: no session to resume for deferred message, dropping`);
					break;
				}

					const contOptions = { ...queryOptions, resume: resumeId, ...makeCliDebugOptions("continuation") };
					const contQuery = query({ prompt: steerPrompt, options: contOptions });
					liveQueryRef.current = contQuery;
					queryCtx.activeQuery = contQuery;
					debug(`provider: continuation query, model=${cliModel}, resume=${resumeId.slice(0, 8)}, promptLen=${steerPrompt.length}`);

				try {
					const { capturedSessionId: contSid } = await consumeQuery(contQuery, customToolNameToPi, model, () => wasAborted, queryCtx);
					const sid = contSid ?? providerSessionSlot.current?.sessionId;
					if (sid) providerSessionSlot.current = { sessionId: sid, cursor: providerSessionSlot.current?.cursor ?? 0, cwd };
				} catch (contError) {
					debug(`provider: continuation query error:`, contError);
					break;
				} finally {
					if (wasAborted || options?.signal?.aborted) {
						await contQuery.return().catch(() => {});
					}
				}
			}

			if (!isReentrant) {
				debug("provider: clearing activeQuery before final stream completion");
				queryCtx.activeQuery = null;
			}
			finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
		} catch (error) {
			debug(`provider: query error, model=${cliModel}, aborted=${Boolean(options?.signal?.aborted)}, error=`, error);
			if ((wasAborted || options?.signal?.aborted) && providerSessionSlot.current) {
				providerSessionSlot.current = { ...providerSessionSlot.current, needsRebuild: true, forceRotate: true };
			} else {
				providerSessionSlot.current = null;
			}
			queryCtx.deferredUserMessages = [];
			if (queryCtx.turnOutput) {
				queryCtx.turnOutput.stopReason = options?.signal?.aborted ? "aborted" : "error";
				queryCtx.turnOutput.errorMessage = error instanceof Error ? error.message : String(error);
			}
			if (!isReentrant) {
				drainPendingMcpDispatches(queryCtx, "Query ended");
				for (const pending of queryCtx.pendingToolCalls.values()) { pending.resolve({ content: [{ type: "text", text: "Query ended" }] }); }
				queryCtx.pendingToolCalls.clear();
				queryCtx.pendingResults.clear();
				queryCtx.activeQuery = null;
			}
			const errStream = queryCtx.currentPiStream;
			errStream?.push({ type: "error", reason: (queryCtx.turnOutput?.stopReason ?? "error") as "aborted" | "error", error: queryCtx.turnOutput! });
			markStreamComplete(errStream);
			errStream?.end();
			queryCtx.currentPiStream = null;
		} finally {
			if (options?.signal) options.signal.removeEventListener("abort", onAbort);
			liveQueryRef.current = undefined;
			if (queryCtx.activeQuery === sdkQuery) {
				drainPendingMcpDispatches(queryCtx, "Query ended");
				for (const pending of queryCtx.pendingToolCalls.values()) { pending.resolve({ content: [{ type: "text", text: "Query ended" }] }); }
				queryCtx.pendingToolCalls.clear();
				queryCtx.pendingResults.clear();
				queryCtx.activeQuery = null;
			}
			providerActiveQueries().delete(queryCtx);
			maybeRefreshProviderRegistration(`query-finished:${cliModel}`);
		}
	})();

	return stream;
}

// --- AskCodebuddy: prompt and wait ---

async function promptAndWait(
	prompt: string,
	mode: AskMode,
	toolCalls: Map<string, ToolCallState>,
	signal: AbortSignal | undefined,
	options: {
		systemPrompt?: string;
		appendSkills?: boolean;
		onStreamUpdate?: (responseText: string) => void;
		model?: string;
		thinking?: string;
		isolated?: boolean;
		context?: Context["messages"];
		cwd: string;
		providerSettings: NonNullable<Config["provider"]>;
	},
): Promise<{ responseText: string; stopReason: string }> {
	const cwd = options.cwd;
	const requestedModel = options?.model ?? "opus";
	const model = resolveModel(requestedModel);
	const modelId = model?.id ?? requestedModel;
	const cliModel = model ? codebuddyModelId(model) : modelId;

	// Session resume for shared mode: create a delegation-only session from Pi's
	// conversation context. Do not reuse or mutate the provider providerSessionSlot.current;
	// provider sessions contain Provider Tool Guidance and Pi MCP tool history,
	// which must not leak into AskCodebuddy's Delegation Path.
	let resumeSessionId: string | null = null;
	if (!options?.isolated && options?.context?.length) {
		resumeSessionId = createDelegationSessionFromContext(options.context, cwd, modelId);
	}

	const askSystemPrompt = options?.systemPrompt
		? buildCodebuddySystemPrompt(options.systemPrompt, {
			includeSkills: options.appendSkills !== false,
			includeToolBridge: false,
		})
		: undefined;

	// Effort
	const effort = options?.thinking && options.thinking !== "off"
		? REASONING_TO_EFFORT[options.thinking] : undefined;

	debug("askCodebuddy:",
		`mode=${mode} model=${modelId} cliModel=${cliModel} effort=${effort ?? "default"}`,
		`isolated=${options?.isolated ?? false} resume=${resumeSessionId?.slice(0, 8) ?? "none"}`,
		`sysPrompt=${Boolean(askSystemPrompt)} promptLen=${prompt.length}`);

	const askOptions = buildAskQueryOptions({
		mode,
		cwd,
		cliModel,
		providerSettings: options.providerSettings,
		systemPrompt: askSystemPrompt,
		effort,
		resumeSessionId,
		isolated: options.isolated,
		debugOptions: makeCliDebugOptions("ask"),
	});
	const sdkQuery = query({ prompt, options: askOptions });
	let responseText = "";
	const result = await consumeAskQuery(sdkQuery, signal, {
		onTextDelta(delta) {
			responseText += delta;
			options.onStreamUpdate?.(responseText);
		},
		onToolStart(tool) {
			debug(`askCodebuddy: tool_use start: ${tool.name}`);
			toolCalls.set(tool.id, {
				name: mapToolName(tool.name),
				status: "running",
			});
		},
		onToolComplete(tool) {
			toolCalls.set(tool.id, {
				name: mapToolName(tool.name),
				status: "complete",
				rawInput: tool.input,
			});
		},
		onResult(message) {
			const usage = (message as any).usage;
			if (usage) {
				debug(`askCodebuddy: result usage: in=${usage.input_tokens} out=${usage.output_tokens} cacheRead=${usage.cache_read_input_tokens ?? 0} cacheWrite=${usage.cache_creation_input_tokens ?? 0} turns=${(message as any).num_turns ?? "?"}`);
			}
		},
	});
	if (!responseText) responseText = result.responseText;
	debug(`askCodebuddy: done stopReason=${result.stopReason} responseLen=${responseText.length} toolCalls=${toolCalls.size}`);
	return { responseText, stopReason: result.stopReason };
}

// --- Extension registration ---

const DEFAULT_TOOL_DESCRIPTION_FULL = "Delegate to CodeBuddy for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.";
const DEFAULT_TOOL_DESCRIPTION = "Delegate to CodeBuddy for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — CodeBuddy can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.";

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

type ModelDiscovery = (pi: ExtensionAPI) => Promise<PiModel[]>;

function buildModelDiscoveryOptions(
	providerSettings: NonNullable<Config["provider"]>,
	cwd = process.cwd(),
): SdkQueryOptions {
	const codebuddyExecutable = providerSettings.pathToCodebuddyCode;
	return {
		maxTurns: 0,
		permissionMode: "bypassPermissions",
		tools: [],
		settingSources: [],
		cwd,
		env: { ...process.env, DISABLE_AUTO_COMPACT: "1" },
		...(codebuddyExecutable ? { pathToCodebuddyCode: codebuddyExecutable } : {}),
		...makeCliDebugOptions("discover-models"),
	};
}

async function discoverModels(_pi: ExtensionAPI): Promise<PiModel[]> {
	return withSdkGate(async () => {
		const commonOpts = buildModelDiscoveryOptions(globalProviderSettings);

		// Preferred path: Session API getAvailableModelsRaw() returns RawLanguageModel[]
		// with the real per-model maxInputTokens (context window) and maxOutputTokens,
		// plus capability flags (supportsImages / supportsReasoning). This eliminates
		// first-run Window Drift — Pi registers the true context window up front
		// instead of the 200K conservative default. Runtime calibration remains as a
		// downward correction layer for entitlement-limited served windows.
		try {
			const session = createSdkSession(commonOpts);
			try {
				await session.connect();
				const rawModels = await session.getAvailableModelsRaw();
				if (rawModels.length) {
					MODELS = applyModelCalibrations(rawModelsFromSdkRaw(rawModels));
					debug(`discoverModels: discovered ${MODELS.length} models via getAvailableModelsRaw()`);
					return MODELS;
				}
				debug("discoverModels: getAvailableModelsRaw() returned empty, falling back to supportedModels()");
			} finally {
				session.close();
			}
		} catch (err) {
			debug("discoverModels: getAvailableModelsRaw() failed, falling back to supportedModels()", err);
		}

		// Fallback path: one-shot query().supportedModels() returns the simplified
		// ModelInfo (value/displayName/description) without token limits, so we must
		// use the conservativeContextWindow() heuristic. Used when the CLI doesn't
		// support the get_available_models control request or the Session API errors.
		try {
			const q = query({
				prompt: " ",
				options: commonOpts,
			});
			const supported = await q.supportedModels();
			await q.return().catch(() => {});
			if (!supported.length) return MODELS;
			MODELS = applyModelCalibrations(rawModelsFromSdk(supported as any));
			debug(`discoverModels: discovered ${MODELS.length} models from supportedModels()`);
		} catch (err) {
			debug("discoverModels: supportedModels() failed, using fallback models", err);
		}
		return MODELS;
	});
}

function beginProviderDiscovery(
	pi: ExtensionAPI,
	runDiscovery: ModelDiscovery,
	source: "activation" | "survivor",
): Promise<void> {
	const processState = getProviderProcessState();
	if (processState.discoveryPromise) {
		if (source !== "activation" || !processState.discoveryIsSurvivorRestart) {
			return processState.discoveryPromise;
		}
		processState.generation++;
		processState.discoveryPromise = undefined;
	}
	processState.discoveryIsSurvivorRestart = source === "survivor";
	const generation = processState.generation;
	processState.discoveryPromise = (async () => {
		try {
			const discoveredModels = await runDiscovery(pi);
			if (processState.generation !== generation) return;
			const discoveryModels = Array.isArray(discoveredModels) ? discoveredModels : MODELS;
			calibrationCache = processState.calibrationCache ?? calibrationCache;
			const calibratedModels = applyModelCalibrations(discoveryModels);
			MODELS = processState.models
				? calibratedModels.map((model) => {
					const previous = processState.models?.find((candidate) => candidate.id === model.id);
					return previous
						? { ...model, contextWindow: Math.min(previous.contextWindow, model.contextWindow) }
						: model;
				})
				: calibratedModels;
			fanOutProviderRegistration(MODELS, "discovery");
		} catch (error) {
			debug("provider model discovery failed", error);
		}
	})();
	return processState.discoveryPromise;
}

async function ensureModelsDiscovered(): Promise<void> {
	const processState = getProviderProcessState();
	if (processState.models) MODELS = processState.models;
	if (processState.discoveryPromise) {
		await processState.discoveryPromise;
		if (processState.models) MODELS = processState.models;
		return;
	}
	const runner = processState.runners.values().next().value as ActiveProviderRunner | undefined;
	if (runner) await beginProviderDiscovery(runner.pi, runner.runModelDiscovery, "survivor");
}

export interface CodebuddySdkExtensionDependencies {
	runtimeRegistry?: RuntimeConfigRegistry;
	providerDispatcher?: RuntimeProviderStream;
	runtimeStream?: RuntimeProviderStream;
	discoverModels?: ModelDiscovery;
	loadCalibrationCache?: () => CalibrationCache;
	compact?: typeof compact;
	isolatedSummaryStream?: RuntimeProviderStream;
	createOwnerId?: () => string;
}

export function createCodebuddySdkExtension(
	dependencies: CodebuddySdkExtensionDependencies = {},
): (pi: ExtensionAPI) => void {
	const runtimeRegistry = dependencies.runtimeRegistry ?? getGlobalRuntimeConfigRegistry();
	const providerDispatcher = dependencies.providerDispatcher ?? getGlobalProviderDispatcher();
	const runtimeStreamOverride = dependencies.runtimeStream;
	const createOwnerId = dependencies.createOwnerId ?? (() => `${moduleInstanceId}:${nextRuntimeOwnerId++}`);
	const runModelDiscovery = dependencies.discoverModels ?? discoverModels;
	const loadRuntimeCalibrationCache = dependencies.loadCalibrationCache ?? loadCalibrationCache;
	const runCompaction = dependencies.compact ?? compact;
	const summaryStream = dependencies.isolatedSummaryStream ?? isolatedStreamFn;

	return function activateCodebuddySdk(pi: ExtensionAPI): void {
	const ownerId = createOwnerId();
	const runtimeState = createProviderRuntimeState();
	const runtimeStream = runtimeStreamOverride ?? ((model, context, options) => (
		runWithProviderRuntimeState(
			runtimeState,
			() => streamCodebuddySdk(model, context, options),
		)
	));
	const processState = getProviderProcessState();
	processState.runners.set(ownerId, {
		pi,
		dispatcher: providerDispatcher,
		runtimeState,
		runModelDiscovery,
	});
	const globalConfig = loadGlobalConfig();
	debug(`loadGlobalConfig: askCodebuddy=${!!globalConfig.config.askCodebuddy} provider=${!!globalConfig.config.provider} diagnostics=${globalConfig.diagnostics.map(({ code }) => code).join(",") || "none"}`);
	globalProviderSettings = globalConfig.config.provider ?? {};
	calibrationEnvironment = buildCalibrationEnvironment(globalProviderSettings.pathToCodebuddyCode);
	const previousProcessModels = processState.models;
	const loadedCalibrationCache = loadRuntimeCalibrationCache();
	calibrationCache = processState.calibrationCache
		? mergeCalibrationCaches(loadedCalibrationCache, processState.calibrationCache)
		: loadedCalibrationCache;
	for (const pending of processState.pendingCalibrationObservations.values()) {
		mergeContextWindowMetric(
			calibrationCache,
			pending.modelId,
			pending.environment,
			pending.metric,
		);
	}
	processState.calibrationCache = calibrationCache;
	const fallbackModels = buildModels(FALLBACK_MODELS);
	const baseModels = processState.models ?? fallbackModels;
	const calibratedModels = applyModelCalibrations(baseModels);
	MODELS = processState.models
		? calibratedModels.map((model) => {
			const previous = processState.models?.find((candidate) => candidate.id === model.id);
			return previous
				? { ...model, contextWindow: Math.min(previous.contextWindow, model.contextWindow) }
				: model;
		})
		: calibratedModels;
	processState.models = MODELS;
	if (previousProcessModels?.some((previous) => {
		const current = MODELS.find((model) => model.id === previous.id);
		return current != null && current.contextWindow < previous.contextWindow;
	})) {
		fanOutProviderRegistration(MODELS, "activation-calibration");
	}
	const runtimeController = createRuntimeConfigController({
		ownerId,
		globalConfig,
		registry: runtimeRegistry,
		streamSimple: runtimeStream,
	});
	let askRegistrationResolved = false;
	let registeredAskAlias: string | undefined;
	const registerRuntimeAsk = (
		config: Readonly<Config>,
		canonicalCwd: string,
		warn: (message: string) => void,
	): string | undefined => {
		if (askRegistrationResolved) return registeredAskAlias;
		registeredAskAlias = registerAskCodebuddyTool(pi, config, canonicalCwd, warn);
		askRegistrationResolved = true;
		return registeredAskAlias;
	};
	let runtimeSnapshot: Readonly<RuntimeConfigSnapshot> | undefined;

	const clearSession = (event: string) => {
		debug(`${event}: clearing session ${providerSessionSlot.current?.sessionId?.slice(0, 8) ?? "none"}`);
		providerSessionSlot.current = null;
	};

	pi.on("session_start", (event, ctx) => runWithProviderRuntimeState(runtimeState, async () => {
		providerUiSlot.current = ctx.ui;
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork" || event.reason === "reload") {
			clearSession(`session_start:${event.reason}`);
		}
		try {
			const isReload = event.reason === "reload";
			const snapshot = runtimeSnapshot
				&& !isReload
				? runtimeController.rebindSession(runtimeSnapshot, ctx.sessionManager.getSessionId())
				: await runtimeController.start({
					cwd: ctx.cwd,
					sessionId: ctx.sessionManager.getSessionId(),
					hasUI: ctx.hasUI,
					forceReload: isReload,
					select: ctx.hasUI ? ctx.ui.select.bind(ctx.ui) : undefined,
					registerAsk: (config, canonicalCwd) => registerRuntimeAsk(
						config,
						canonicalCwd,
						ctx.hasUI
							? (message) => ctx.ui.notify(message, "warning")
							: (message) => console.warn(message),
					),
				});
			runtimeSnapshot = snapshot;
			for (const diagnostic of snapshot.diagnostics) {
				if (ctx.hasUI) ctx.ui.notify(diagnostic.message, "warning");
				else console.warn(diagnostic.message);
			}
			debug(`runtime config: cwd=${snapshot.canonicalCwd} projectAuthorized=${snapshot.projectAuthorized} ask=${snapshot.askAlias ?? "disabled"}`);
		} catch (error) {
			const message = `CodeBuddy SDK could not initialize runtime config: ${errorMessage(error)}`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else console.error(message);
		}
	}));
	pi.on("session_shutdown", () => runWithProviderRuntimeState(runtimeState, () => {
		clearSession("session_shutdown");
		runtimeController.shutdown();
		processState.runners.delete(ownerId);
		processState.generation++;
		processState.discoveryPromise = undefined;
		processState.discoveryIsSurvivorRestart = false;
		if (processState.runners.size === 0) {
			processState.models = undefined;
			processState.calibrationCache = undefined;
			processState.calibrationRefreshPending = false;
		} else {
			const survivor = processState.runners.values().next().value as ActiveProviderRunner;
			void beginProviderDiscovery(survivor.pi, survivor.runModelDiscovery, "survivor");
		}
	}));

	pi.on("session_before_compact", (event, ctx) => runWithProviderRuntimeState(runtimeState, async () => {
		if (ctx.model?.baseUrl !== PROVIDER_ID) return undefined;
		debug(
			`session_before_compact: takeover reason=${event.reason} willRetry=${event.willRetry} ` +
			`isSplitTurn=${event.preparation.isSplitTurn} messages=${event.preparation.messagesToSummarize.length} ` +
			`turnPrefix=${event.preparation.turnPrefixMessages.length}`,
		);
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			const invocationRoute = runtimeRegistry.resolveSession(sessionId);
			if (!invocationRoute) {
				throw new Error(`Pi session ${sessionId} does not belong to an active CodeBuddy runtime`);
			}
			const routedSummaryStream: RuntimeProviderStream = (model, context, options) => (
				summaryStream(model, context, withProviderInvocationRoute(options, invocationRoute))
			);
			reinjectPriorCompactionFileOps(event.branchEntries, event.preparation);
			const compaction = await runCompaction(
				event.preparation,
				ctx.model,
				undefined,
				undefined,
				event.customInstructions,
				event.signal,
				undefined,
				routedSummaryStream,
				undefined,
			);
			debug(`session_before_compact: takeover complete summaryLen=${compaction.summary.length}`);
			return { compaction };
		} catch (err) {
			const msg = errorMessage(err);
			debug("session_before_compact: takeover failed; cancelling to avoid native compact fallback", err);
			ctx.ui?.notify?.(
				`CodeBuddy SDK compact failed (${redactForLog(msg)}). Retry, switch model, or reduce context.`,
				"error",
			);
			return { cancel: true };
		}
	}));

	// pi /compact and session-tree navigation (rewind / fork-at-point /
	// branch switch) both mutate pi's messages array out from under the
	// bridge. syncSharedSession's REUSE check would otherwise see
	// slice(cursor) === [] (or skip entries) and keep --resume'ing a CC
	// session that no longer matches pi's history. /compact in particular
	// triggers CC's autocompact-thrashing guard (issue #8). Force the next
	// call down the REBUILD path so CC sees the current history.
	const markRebuild = (event: string) => {
		if (providerSessionSlot.current) {
			debug(`${event}: marking needsRebuild on session ${providerSessionSlot.current.sessionId.slice(0, 8)}`);
			providerSessionSlot.current = { ...providerSessionSlot.current, needsRebuild: true };
		}
	};
	pi.on("session_compact", (event) => runWithProviderRuntimeState(runtimeState, () => markRebuild(`session_compact:${event.reason}:willRetry=${event.willRetry}`)));
	pi.on("session_tree", () => runWithProviderRuntimeState(runtimeState, () => markRebuild("session_tree")));

	// --- Provider ---
	// Every ExtensionRunner owns a registration; discovery is process-wide and
	// re-registers every active runner with the shared result.
	registerCurrentProvider(pi, providerDispatcher, processState.models ?? MODELS);
	void beginProviderDiscovery(pi, runModelDiscovery, "activation");

	function registerAskCodebuddyTool(
		pi: ExtensionAPI,
		config: Readonly<Config>,
		runtimeCwd: string,
		warn: (message: string) => void,
	): string | undefined {
		const askConf = config.askCodebuddy;
		if (askConf?.enabled === false) return undefined;
		const allowFull = askConf?.allowFullMode !== false;
		const defaultMode = askConf?.defaultMode ?? "read";
		const defaultIsolated = askConf?.defaultIsolated ?? false;
		const toolName = askConf?.name ?? "AskCodebuddy";
		if (!toolName.trim()) {
			warn("CodeBuddy SDK: AskCodebuddy tool name cannot be empty or whitespace-only; the tool is disabled for this runtime");
			return undefined;
		}
		if (pi.getAllTools().some((tool) => tool.name === toolName)) {
			warn("CodeBuddy SDK: the configured AskCodebuddy tool name is already registered; AskCodebuddy is disabled for this runtime");
			return undefined;
		}

		const modeValues = allowFull ? ["read", "full", "none"] as const : ["read", "none"] as const;
		let modeDesc = `"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access).`;
		if (allowFull) modeDesc += ` "full": allows writing and bash execution (careful: runs without feedback to pi).`;

		const askCodebuddyParams = Type.Object({
			prompt: Type.String({ description: "The question or task for CodeBuddy. By default Claude sees the full conversation history. Don't research up front, let Claude explore." }),
			mode: Type.Optional(StringEnum(modeValues, { description: modeDesc })),
			model: Type.Optional(Type.String({ description: 'Claude model (e.g. "opus", "sonnet", "haiku", or full ID). Defaults to "opus".' })),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, { description: "Thinking effort level. Omit to use CodeBuddy's default." })),
			isolated: Type.Optional(Type.Boolean({ description: "When true, Claude sees only this prompt (clean session). When false (default), Claude sees the full conversation history." })),
		});
		pi.registerTool<typeof askCodebuddyParams>({
			name: toolName,
			label: askConf?.label ?? "Ask CodeBuddy",
			description: askConf?.description ?? (allowFull ? DEFAULT_TOOL_DESCRIPTION_FULL : DEFAULT_TOOL_DESCRIPTION),
			parameters: askCodebuddyParams,
			renderCall(args, theme) {
				let text = theme.fg("mdLink", theme.bold("AskCodebuddy "));
				const mode = args.mode ?? defaultMode;
				const tags: string[] = [];
				if (mode !== defaultMode) tags.push(`mode=${mode}`);
				if (args.model) tags.push(`model=${args.model}`);
				if (args.thinking) tags.push(`thinking=${args.thinking}`);
				if (args.isolated) tags.push("isolated");
				if (tags.length) text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
				const truncated = args.prompt.length > PREVIEW_MAX_CHARS ? args.prompt.substring(0, PREVIEW_MAX_CHARS) : args.prompt;
				const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
				text += theme.fg("muted", `"${lines.join("\n")}"`);
				if (args.prompt.length > PREVIEW_MAX_CHARS || args.prompt.split("\n").length > PREVIEW_MAX_LINES) text += theme.fg("dim", " …");
				return new Text(text, 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
					return new Text(theme.fg("mdLink", "◉ CodeBuddy ") + theme.fg("muted", status), 0, 0);
				}

				const details = result.details as { prompt?: string; executionTime?: number; actions?: string; error?: boolean } | undefined;
				const body = result.content[0]?.type === "text" ? result.content[0].text : "";

				let text = details?.error
					? theme.fg("error", "✗ CodeBuddy error")
					: theme.fg("mdLink", "✓ CodeBuddy");

				if (details?.executionTime) text += ` ${theme.fg("dim", `${(details.executionTime / 1000).toFixed(1)}s`)}`;
				if (details?.actions) text += ` ${theme.fg("muted", details.actions)}`;

				if (expanded) {
					if (details?.prompt) text += `\n${theme.fg("dim", `Prompt: ${details.prompt}`)}`;
					if (details?.prompt && body) text += `\n${theme.fg("dim", "─".repeat(40))}`;
					if (body) text += `\n${theme.fg("toolOutput", body)}`;
				} else {
					const truncated = body.length > PREVIEW_MAX_CHARS ? body.substring(0, PREVIEW_MAX_CHARS) : body;
					const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
					if (lines.length) text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
					if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) text += `\n${theme.fg("dim", `… (${keyHint("app.tools.expand", "to expand")})`)}`;

				}

				return new Text(text, 0, 0);
			},
				async execute(_id, params, signal, onUpdate, ctx) {
				// Guard: circular delegation
				if (ctx.model?.baseUrl === PROVIDER_ID) {
					debug("askCodebuddy: blocked circular delegation (active provider is codebuddy-sdk)");
					return {
						content: [{ type: "text" as const, text: "Error: AskCodebuddy cannot be used when the active provider is codebuddy-sdk — you're already running through CodeBuddy." }],
						details: { error: true },
					};
				}

				const mode = (params.mode ?? defaultMode) as "full" | "read" | "none";
				const isolated = params.isolated ?? defaultIsolated;
				const toolCalls = new Map<string, ToolCallState>();
				const start = Date.now();

				const progressInterval = setInterval(() => {
					const elapsed = ((Date.now() - start) / 1000).toFixed(0);
					const summary = buildActionSummary(toolCalls);
					const status = summary ? `${elapsed}s — ${summary}` : `${elapsed}s — working...`;
					onUpdate?.({
						content: [{ type: "text", text: status }],
						details: { prompt: params.prompt, executionTime: Date.now() - start },
					});
				}, 1000);

					try {
						const result = await promptAndWait(params.prompt, mode, toolCalls, signal, {
						systemPrompt: ctx.getSystemPrompt(),
						appendSkills: askConf?.appendSkills,
						model: params.model,
						thinking: params.thinking,
						isolated,
						context: isolated ? undefined : buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"],
						cwd: ctx.cwd || runtimeCwd,
						providerSettings: config.provider ?? {},
					});
					clearInterval(progressInterval);
					onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
					const executionTime = Date.now() - start;
					const actions = buildActionSummary(toolCalls);

					const text = actions
						? `${result.responseText}\n\n[CodeBuddy actions: ${actions}]`
						: result.responseText;
						return {
							content: [{ type: "text" as const, text }],
							details: { prompt: params.prompt, executionTime, actions },
						};
					} catch (err) {
						debug(`askCodebuddy error: mode=${mode}, model=${params.model ?? "default"}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`, err);
						onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
						throw err instanceof Error ? err : new Error(errorMessage(err));
					} finally {
						clearInterval(progressInterval);
					}
			},
		});
		return toolName;
	}
	};
}

export default createCodebuddySdkExtension();
