// Query state: QueryContext class + runtime scope.
//
// All per-query and per-turn mutable state lives here. Reentrant queries
// create their own QueryContext and keep it in the caller's closure.
// Adding a new field = one property on the class.
//
// Extracted from index.ts so tests can import without activating the extension.

import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import { AsyncLocalStorage } from "node:async_hooks";
import type { McpResult } from "./extract-tool-results.js";
import { ToolTurnCoordinator } from "./tool-turn-coordinator.js";

export interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

export interface PendingMcpDispatch {
	toolName: string;
	args: Record<string, unknown>;
	resolve: (result: McpResult) => void;
	deadlineTimer?: ReturnType<typeof setTimeout>;
}

export interface AwaitingTrailingAssistant {
	generation: number;
	toolCallIds: Set<string>;
}

export class QueryContext {
	// Query-scoped (fully isolated per query)
	activeQuery: unknown | null = null;
	currentPiStream: AssistantMessageEventStream | null = null;
	latestCursor = 0;
	pendingToolCalls = new Map<string, PendingToolCall>();
	pendingResults = new Map<string, McpResult>();
	pendingMcpDispatches: PendingMcpDispatch[] = [];
	turnToolCallIds: string[] = [];
	nextHandlerIdx = 0;
	// toolCallIds already assigned to an MCP handler. Used by name-based
	// matching to avoid the index-order race when CodeBuddy dispatches
	// parallel tool handlers in a different order than the stream's
	// content_block_start events. Without this, bash's handler could get
	// read's toolCallId, causing result misassignment.
	matchedToolCallIds = new Set<string>();
	deferredUserMessages: string[] = [];

	// Tool-call blocks whose stream args came through empty (parallel tool_call
	// dispatch dropping args to {}). Their toolcall_end is deferred until either
	// the assistant message arrives with complete args, or the MCP handler
	// receives non-empty dispatch args. The done event is also deferred while
	// this list is non-empty, so pi does not execute tools with empty args.
	argsPendingBlocks: Array<{ block: any; contentIndex: number }> = [];
	permissionPendingBlocks: Array<{ block: any; contentIndex: number }> = [];
	permissionBufferedStreamEvents: any[] = [];
	permissionBufferedAssistantMessages: any[] = [];
	permissionReplayInProgress = false;
	permissionReplay?: () => void;
	// Set when message_stop arrived but done was deferred due to pending blocks.
	// Prevents double-deferral and lets the assistant-message path know it
	// must emit the done event after backfilling.
	doneDeferredForArgs = false;
	// First toolUseID observed by canUseTool in this assistant turn.
	// Any different toolUseID in the same turn is denied so provider-path
	// tools always execute serially.
	claimedToolUseId: string | null = null;
	// Set only when tool-result delivery preserves the current assistant turn.
	// The next assistant message boundary then starts a fresh coordinator.
	toolTurnStatePreserved = false;
	sdkTurnGeneration = 0;
	awaitingTrailingAssistant: AwaitingTrailingAssistant | null = null;
	/** Shared permission/dispatch fact source for the current assistant turn. */
	turnCoordinator: ToolTurnCoordinator = new ToolTurnCoordinator();

	// Per-turn (reset together)
	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;

	get turnBlocks(): Array<any> {
		if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content;
	}

	drainPendingMcpDispatches(text: string): void {
		for (const pending of this.pendingMcpDispatches.splice(0)) {
			if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
			this.turnCoordinator.cancelPendingDispatch(pending.toolName);
			pending.resolve({
				content: [{ type: "text", text }],
				isError: true,
			});
		}
	}

	/**
	 * Start a Pi-facing stream for a turn. Tool-result delivery can happen while
	 * the SDK is still finishing sibling tool calls from the same assistant turn;
	 * in that case preserve the tool correlation/permission state until the next
	 * assistant message starts.
	 */
	resetTurnState(model: Model<any>, preserveToolTurnState = false): void {
		this.turnOutput = {
			role: "assistant", content: [],
			api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		};
		this.turnStarted = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
		this.argsPendingBlocks = [];
		this.permissionPendingBlocks = [];
		this.permissionBufferedStreamEvents = [];
		this.permissionBufferedAssistantMessages = [];
		this.permissionReplayInProgress = false;
		this.permissionReplay = undefined;
		this.doneDeferredForArgs = false;
		this.toolTurnStatePreserved = preserveToolTurnState;
		if (!preserveToolTurnState) {
			this.claimedToolUseId = null;
			this.drainPendingMcpDispatches("Tool turn reset before dispatch was matched");
			this.turnCoordinator.reset();
			this.matchedToolCallIds = new Set();
			this.sdkTurnGeneration = 0;
			this.awaitingTrailingAssistant = null;
		}
		// turnToolCallIds and nextHandlerIdx are NOT reset — they persist across
		// tool-result delivery callbacks within the same assistant message.
	}
}

export interface QueryRuntimeScope {
	context: QueryContext;
}

const defaultScope: QueryRuntimeScope = {
	context: new QueryContext(),
};
const queryRuntimeStorage = new AsyncLocalStorage<QueryRuntimeScope>();

export function createQueryRuntimeScope(): QueryRuntimeScope {
	return { context: new QueryContext() };
}

export function runWithQueryRuntimeScope<T>(scope: QueryRuntimeScope, callback: () => T): T {
	return queryRuntimeStorage.run(scope, callback);
}

function currentScope(): QueryRuntimeScope {
	return queryRuntimeStorage.getStore() ?? defaultScope;
}

export function ctx(): QueryContext { return currentScope().context; }

// Test-only: drop all state so test files can start from a clean module.
// Not called from production.
export function resetStack(): void {
	const scope = currentScope();
	scope.context.drainPendingMcpDispatches("Query context reset before dispatch was matched");
	scope.context = new QueryContext();
}
