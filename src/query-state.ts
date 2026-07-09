// Query state: QueryContext class + context stack.
//
// All per-query and per-turn mutable state lives here. Reentrant queries
// (subagents) push the parent context onto a stack and get a fresh instance.
// Adding a new field = one property on the class.
//
// Extracted from index.ts so tests can import without activating the extension.

import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { McpResult } from "./extract-tool-results.js";

export interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

export class QueryContext {
	// Query-scoped (fully isolated per query)
	activeQuery: unknown | null = null;
	currentPiStream: AssistantMessageEventStream | null = null;
	latestCursor = 0;
	pendingToolCalls = new Map<string, PendingToolCall>();
	pendingResults = new Map<string, McpResult>();
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
	// Set when message_stop arrived but done was deferred due to pending blocks.
	// Prevents double-deferral and lets the assistant-message path know it
	// must emit the done event after backfilling.
	doneDeferredForArgs = false;

	// Per-turn (reset together)
	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;

	get turnBlocks(): Array<any> {
		if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content;
	}

	resetTurnState(model: Model<any>): void {
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
		this.doneDeferredForArgs = false;
		this.matchedToolCallIds = new Set();
		// turnToolCallIds and nextHandlerIdx are NOT reset — they persist across
		// tool-result delivery callbacks within the same assistant message.
	}
}

let _ctx = new QueryContext();
const contextStack: QueryContext[] = [];

export function ctx(): QueryContext { return _ctx; }

export function stackDepth(): number { return contextStack.length; }

export function pushContext(): void {
	if (!_ctx.activeQuery) throw new Error("pushContext() called with no active query");
	contextStack.push(_ctx);
	_ctx = new QueryContext();
}

export function popContext(): void {
	if (contextStack.length === 0) throw new Error("popContext() called with empty stack");
	const parent = contextStack[contextStack.length - 1];
	parent.deferredUserMessages.push(..._ctx.deferredUserMessages);
	_ctx = contextStack.pop()!;
}

// Test-only: drop all state so test files can start from a clean module.
// Not called from production.
export function resetStack(): void {
	_ctx = new QueryContext();
	contextStack.length = 0;
}
