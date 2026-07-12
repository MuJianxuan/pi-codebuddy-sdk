/**
 * Tests for parallel tool-call arg backfill logic.
 *
 * When CodeBuddy dispatches parallel tool_calls, the MCP client may deliver
 * empty args ({}) to some tool handlers, and the stream's input_json_delta
 * may also arrive empty. The bridge defers toolcall_end for such blocks
 * until the assistant message (or MCP dispatch) provides real args.
 *
 * These tests exercise:
 *   - isEmptyArgs helper (detecting empty/absent arg objects)
 *   - QueryContext.argsPendingBlocks lifecycle (reset, populate, drain)
 *   - QueryContext.doneDeferredForArgs flag lifecycle
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ctx, resetStack } from "../src/query-state.js";
import { ToolTurnCoordinator } from "../src/tool-turn-coordinator.js";
import { __test } from "../src/index.js";

const {
	claimSerialToolUse,
	interruptLiveQuery,
	isEmptyArgs,
	mapToolArgs,
	processStreamEvent,
	processAssistantMessage,
	buildMcpServers,
} = __test;

const fakeModel = { api: "anthropic", provider: "anthropic", id: "test-model" };

// --- isEmptyArgs ---

describe("isEmptyArgs", () => {
	it("returns true for undefined", () => {
		assert.strictEqual(isEmptyArgs(undefined), true);
	});

	it("returns true for null", () => {
		assert.strictEqual(isEmptyArgs(null), true);
	});

	it("returns true for empty object", () => {
		assert.strictEqual(isEmptyArgs({}), true);
	});

	it("returns false for object with a string value", () => {
		assert.strictEqual(isEmptyArgs({ command: "ls" }), false);
	});

	it("returns false for object with a number value", () => {
		assert.strictEqual(isEmptyArgs({ timeout: 120 }), false);
	});

	it("returns false for object with a boolean value", () => {
		assert.strictEqual(isEmptyArgs({ flag: true }), false);
	});

	it("returns true for object with only undefined values", () => {
		assert.strictEqual(isEmptyArgs({ command: undefined }), true);
	});

	it("returns true for object with only null values", () => {
		assert.strictEqual(isEmptyArgs({ command: null }), true);
	});

	it("returns true for object with undefined and null values", () => {
		assert.strictEqual(isEmptyArgs({ a: undefined, b: null }), true);
	});

	it("returns false for object with mixed empty and non-empty values", () => {
		assert.strictEqual(isEmptyArgs({ a: undefined, b: "value" }), false);
	});

	it("returns false for object with nested empty object value", () => {
		// A nested {} is still a value (not undefined/null)
		assert.strictEqual(isEmptyArgs({ options: {} }), false);
	});

	it("returns false for object with empty array value", () => {
		// An empty array is still a value
		assert.strictEqual(isEmptyArgs({ items: [] }), false);
	});
});

describe("mapToolArgs", () => {
	it("does not turn empty bash args into a timeout-only object", () => {
		assert.deepStrictEqual(mapToolArgs("bash", {}), {});
		assert.deepStrictEqual(mapToolArgs("bash", undefined), {});
	});

	it("adds the bash timeout only when real args exist", () => {
		assert.deepStrictEqual(mapToolArgs("bash", { command: "ls" }), { command: "ls", timeout: 120 });
	});
});

// --- QueryContext argsPendingBlocks lifecycle ---

describe("QueryContext argsPendingBlocks lifecycle", () => {
	beforeEach(() => resetStack());

	it("starts empty after resetTurnState", () => {
		ctx().resetTurnState(fakeModel);
		assert.strictEqual(ctx().argsPendingBlocks.length, 0);
		assert.strictEqual(ctx().doneDeferredForArgs, false);
	});

	it("resetTurnState clears argsPendingBlocks and doneDeferredForArgs", () => {
		ctx().resetTurnState(fakeModel);
		ctx().argsPendingBlocks.push({ block: { name: "bash" }, contentIndex: 0 });
		ctx().doneDeferredForArgs = true;

		ctx().resetTurnState(fakeModel);
		assert.strictEqual(ctx().argsPendingBlocks.length, 0);
		assert.strictEqual(ctx().doneDeferredForArgs, false);
	});

	it("can hold multiple pending blocks", () => {
		ctx().resetTurnState(fakeModel);
		ctx().argsPendingBlocks.push({ block: { id: "t1", name: "read" }, contentIndex: 0 });
		ctx().argsPendingBlocks.push({ block: { id: "t2", name: "bash" }, contentIndex: 1 });
		assert.strictEqual(ctx().argsPendingBlocks.length, 2);
		assert.strictEqual(ctx().argsPendingBlocks[0].block.id, "t1");
		assert.strictEqual(ctx().argsPendingBlocks[1].block.id, "t2");
	});

	it("can drain blocks by splicing", () => {
		ctx().resetTurnState(fakeModel);
		ctx().argsPendingBlocks.push({ block: { id: "t1", name: "read" }, contentIndex: 0 });
		ctx().argsPendingBlocks.push({ block: { id: "t2", name: "bash" }, contentIndex: 1 });

		// Remove the first one (simulating backfill from assistant message)
		ctx().argsPendingBlocks.splice(0, 1);
		assert.strictEqual(ctx().argsPendingBlocks.length, 1);
		assert.strictEqual(ctx().argsPendingBlocks[0].block.id, "t2");
	});

	it("can find a pending block by block.id", () => {
		ctx().resetTurnState(fakeModel);
		ctx().argsPendingBlocks.push({ block: { id: "t1", name: "read" }, contentIndex: 0 });
		ctx().argsPendingBlocks.push({ block: { id: "t2", name: "bash" }, contentIndex: 1 });

		const idx = ctx().argsPendingBlocks.findIndex((p) => p.block.id === "t2");
		assert.strictEqual(idx, 1);
	});

	it("doneDeferredForArgs can be set and cleared independently", () => {
		ctx().resetTurnState(fakeModel);
		ctx().doneDeferredForArgs = true;
		assert.strictEqual(ctx().doneDeferredForArgs, true);
		ctx().doneDeferredForArgs = false;
		assert.strictEqual(ctx().doneDeferredForArgs, false);
	});
});

// --- Simulated parallel tool-call backfill scenario ---

describe("parallel tool-call backfill simulation", () => {
	beforeEach(() => resetStack());

	it("records each streamed tool_use id only once", () => {
		ctx().resetTurnState(fakeModel);
		const c = ctx();
		const pushed = [];
		c.currentPiStream = {
			push(event) { pushed.push(event); },
			end() {},
		};

		processStreamEvent({
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "t1",
					name: "read",
					input: { path: "/tmp/test.txt" },
				},
			},
		}, new Map(), fakeModel, c);

		assert.deepStrictEqual(c.turnToolCallIds, ["t1"]);
		assert.strictEqual(c.turnBlocks.length, 1);
		assert.strictEqual(c.turnBlocks[0].id, "t1");
		assert.strictEqual(
			pushed.filter((event) => event.type === "toolcall_start").length,
			1,
		);
	});

	it("simulates read+bash parallel call where bash args arrive empty in stream", () => {
		ctx().resetTurnState(fakeModel);
		const c = ctx();

		// Simulate stream events for two parallel tool_use blocks:
		// read (index 0) with args, bash (index 1) with empty args

		// content_block_start for read
		c.turnBlocks.push({
			type: "toolCall", id: "t1", name: "read",
			arguments: {}, partialJson: "", index: 0,
		});
		c.turnToolCallIds.push("t1");

		// content_block_start for bash
		c.turnBlocks.push({
			type: "toolCall", id: "t2", name: "bash",
			arguments: {}, partialJson: "", index: 1,
		});
		c.turnToolCallIds.push("t2");

		// Simulate input_json_delta for read (has args)
		const readBlock = c.turnBlocks[0];
		readBlock.partialJson = '{"path":"/tmp/test.txt"}';
		readBlock.arguments = JSON.parse(readBlock.partialJson);

		// Simulate bash args never arriving (empty stream)
		const bashBlock = c.turnBlocks[1];
		// bashBlock.partialJson stays "", arguments stays {}

		// content_block_stop for read: args non-empty → emit immediately
		assert.strictEqual(isEmptyArgs(readBlock.arguments), false);
		c.turnSawToolCall = true;
		// (in real code, toolcall_end would be pushed here)

		// content_block_stop for bash: args empty → defer
		assert.strictEqual(isEmptyArgs(bashBlock.arguments), true);
		c.argsPendingBlocks.push({ block: bashBlock, contentIndex: 1 });

		// message_stop: done deferred because argsPendingBlocks non-empty
		c.doneDeferredForArgs = true;

		// Verify state: read emitted, bash deferred
		assert.strictEqual(c.argsPendingBlocks.length, 1);
		assert.strictEqual(c.argsPendingBlocks[0].block.id, "t2");
		assert.strictEqual(c.doneDeferredForArgs, true);
		assert.strictEqual(c.turnSawToolCall, true); // read set it

		// Simulate assistant message backfill: bash has real args
		const assistantBashInput = { command: "echo hello" };
		const mappedArgs = assistantBashInput; // simplified
		assert.strictEqual(isEmptyArgs(mappedArgs), false);

		// Backfill
		c.argsPendingBlocks[0].block.arguments = mappedArgs;
		c.argsPendingBlocks.splice(0, 1);

		// All pending resolved → emit deferred done
		if (c.argsPendingBlocks.length === 0 && c.doneDeferredForArgs) {
			c.doneDeferredForArgs = false;
		}

		// Verify final state
		assert.strictEqual(c.argsPendingBlocks.length, 0);
		assert.strictEqual(c.doneDeferredForArgs, false);
		assert.deepStrictEqual(bashBlock.arguments, { command: "echo hello" });
	});

	it("simulates MCP dispatch backfill when assistant args also empty", () => {
		ctx().resetTurnState(fakeModel);
		const c = ctx();

		// One tool block with empty stream args
		c.turnBlocks.push({
			type: "toolCall", id: "t1", name: "bash",
			arguments: {}, partialJson: "", index: 0,
		});
		c.turnToolCallIds.push("t1");
		c.argsPendingBlocks.push({ block: c.turnBlocks[0], contentIndex: 0 });
		c.doneDeferredForArgs = true;

		// MCP handler receives dispatch args (non-empty)
		const dispatchArgs = { command: "ls -la" };
		assert.strictEqual(isEmptyArgs(dispatchArgs), false);

		// Backfill from MCP dispatch
		const pendingIdx = c.argsPendingBlocks.findIndex((p) => p.block.id === "t1");
		c.argsPendingBlocks[pendingIdx].block.arguments = dispatchArgs;
		c.argsPendingBlocks.splice(pendingIdx, 1);

		if (c.argsPendingBlocks.length === 0 && c.doneDeferredForArgs) {
			c.doneDeferredForArgs = false;
		}

		assert.strictEqual(c.argsPendingBlocks.length, 0);
		assert.strictEqual(c.doneDeferredForArgs, false);
		assert.deepStrictEqual(c.turnBlocks[0].arguments, { command: "ls -la" });
	});

	it("simulates both stream and dispatch args empty — emits with empty args", () => {
		ctx().resetTurnState(fakeModel);
		const c = ctx();

		// Tool block with empty stream args
		c.turnBlocks.push({
			type: "toolCall", id: "t1", name: "bash",
			arguments: {}, partialJson: "", index: 0,
		});
		c.turnToolCallIds.push("t1");
		c.argsPendingBlocks.push({ block: c.turnBlocks[0], contentIndex: 0 });
		c.doneDeferredForArgs = true;

		// MCP dispatch also empty
		const dispatchArgs = {};
		assert.strictEqual(isEmptyArgs(dispatchArgs), true);

		// Even with empty args, we must emit toolcall_end + done to avoid hang
		const pendingIdx = c.argsPendingBlocks.findIndex((p) => p.block.id === "t1");
		// block.arguments stays {} (no backfill possible)
		c.argsPendingBlocks.splice(pendingIdx, 1);

		if (c.argsPendingBlocks.length === 0 && c.doneDeferredForArgs) {
			c.doneDeferredForArgs = false;
		}

	it("simulates ALL tool blocks having empty args (turnSawToolCall stays false)", () => {
		// Critical edge case: when ALL tool blocks have empty stream args,
		// turnSawToolCall is never set in content_block_stop. message_stop must
		// still set doneDeferredForArgs so the backfill path can emit done.
		// Without the fix, the stream would hang forever.
		ctx().resetTurnState(fakeModel);
		const c = ctx();

		// Two tool blocks, both with empty args
		c.turnBlocks.push({
			type: "toolCall", id: "t1", name: "read",
			arguments: {}, partialJson: "", index: 0,
		});
		c.turnToolCallIds.push("t1");
		c.turnBlocks.push({
			type: "toolCall", id: "t2", name: "bash",
			arguments: {}, partialJson: "", index: 1,
		});
		c.turnToolCallIds.push("t2");

		// content_block_stop for both: args empty → defer, DON'T set turnSawToolCall
		assert.strictEqual(isEmptyArgs(c.turnBlocks[0].arguments), true);
		c.argsPendingBlocks.push({ block: c.turnBlocks[0], contentIndex: 0 });
		assert.strictEqual(isEmptyArgs(c.turnBlocks[1].arguments), true);
		c.argsPendingBlocks.push({ block: c.turnBlocks[1], contentIndex: 1 });

		// turnSawToolCall is still false!
		assert.strictEqual(c.turnSawToolCall, false);

		// message_stop: argsPendingBlocks > 0 must set doneDeferredForArgs
		// EVEN THOUGH turnSawToolCall is false
		if (c.argsPendingBlocks.length > 0) {
			c.doneDeferredForArgs = true;
		}
		assert.strictEqual(c.doneDeferredForArgs, true);

		// Assistant message backfill: both get real args
		// read gets args from assistant message
		c.argsPendingBlocks[0].block.arguments = { path: "/tmp/test" };
		c.turnSawToolCall = true;
		c.argsPendingBlocks.splice(0, 1);

		// bash gets args from assistant message
		c.argsPendingBlocks[0].block.arguments = { command: "echo hi" };
		c.turnSawToolCall = true;
		c.argsPendingBlocks.splice(0, 1);

		// All resolved → emit done (doneDeferredForArgs was set correctly)
		assert.strictEqual(c.argsPendingBlocks.length, 0);
		assert.strictEqual(c.doneDeferredForArgs, true);
		assert.strictEqual(c.turnSawToolCall, true);
		if (c.argsPendingBlocks.length === 0 && c.doneDeferredForArgs) {
			c.doneDeferredForArgs = false;
		}
		assert.strictEqual(c.doneDeferredForArgs, false);

		// Verify both blocks got their args
		assert.deepStrictEqual(c.turnBlocks[0].arguments, { path: "/tmp/test" });
		assert.deepStrictEqual(c.turnBlocks[1].arguments, { command: "echo hi" });
	});

		// Verify: block emitted with empty args (pi will validate and error)
		assert.strictEqual(c.argsPendingBlocks.length, 0);
		assert.strictEqual(c.doneDeferredForArgs, false);
		assert.deepStrictEqual(c.turnBlocks[0].arguments, {});
	});
});

// --- toolCallId name-based matching (parallel dispatch order fix) ---

describe("toolCallId name-based matching", () => {
	beforeEach(() => resetStack());

	it("matchedToolCallIds starts empty and resets with resetTurnState", () => {
		ctx().resetTurnState(fakeModel);
		assert.strictEqual(ctx().matchedToolCallIds.size, 0);
		ctx().matchedToolCallIds.add("t1");
		ctx().resetTurnState(fakeModel);
		assert.strictEqual(ctx().matchedToolCallIds.size, 0);
	});

	it("resolves correct toolCallId when dispatch order matches stream order", () => {
		ctx().resetTurnState(fakeModel);
		const c = ctx();

		// Stream order: read (t1), bash (t2)
		c.turnToolCallIds = ["t1", "t2"];
		c.turnBlocks.push({ type: "toolCall", id: "t1", name: "read", arguments: { path: "/a" } });
		c.turnBlocks.push({ type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } });

		// Handler for read dispatched first (matches stream order)
		let id = resolveToolCallIdByName(c, "read");
		assert.strictEqual(id, "t1");
		assert.ok(c.matchedToolCallIds.has("t1"));

		// Handler for bash dispatched second
		id = resolveToolCallIdByName(c, "bash");
		assert.strictEqual(id, "t2");
		assert.ok(c.matchedToolCallIds.has("t2"));
	});

	it("resolves correct toolCallId when dispatch order is REVERSED from stream order", () => {
		// This is the core bug: CodeBuddy dispatches bash before read,
		// but stream had read first. Index-based matching would give
		// bash handler → t1 (read's id) and read handler → t2 (bash's id).
		// Name-based matching correctly gives bash → t2, read → t1.
		ctx().resetTurnState(fakeModel);
		const c = ctx();

		// Stream order: read (t1), bash (t2)
		c.turnToolCallIds = ["t1", "t2"];
		c.turnBlocks.push({ type: "toolCall", id: "t1", name: "read", arguments: { path: "/a" } });
		c.turnBlocks.push({ type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } });

		// Handler for bash dispatched FIRST (reversed order)
		let id = resolveToolCallIdByName(c, "bash");
		assert.strictEqual(id, "t2", "bash handler should get t2, not t1");
		assert.ok(c.matchedToolCallIds.has("t2"));

		// Handler for read dispatched second
		id = resolveToolCallIdByName(c, "read");
		assert.strictEqual(id, "t1", "read handler should get t1, not t2");
		assert.ok(c.matchedToolCallIds.has("t1"));
	});

	it("handles same-name tool calls (two reads) by positional fallback", () => {
		ctx().resetTurnState(fakeModel);
		const c = ctx();

		// Two read calls in stream order
		c.turnToolCallIds = ["t1", "t2"];
		c.turnBlocks.push({ type: "toolCall", id: "t1", name: "read", arguments: { path: "/a" } });
		c.turnBlocks.push({ type: "toolCall", id: "t2", name: "read", arguments: { path: "/b" } });

		// First read handler → t1
		let id = resolveToolCallIdByName(c, "read");
		assert.strictEqual(id, "t1");

		// Second read handler → t2
		id = resolveToolCallIdByName(c, "read");
		assert.strictEqual(id, "t2");
	});

	it("does not re-assign an already-matched toolCallId", () => {
		ctx().resetTurnState(fakeModel);
		const c = ctx();

		c.turnToolCallIds = ["t1", "t2"];
		c.turnBlocks.push({ type: "toolCall", id: "t1", name: "read", arguments: {} });
		c.turnBlocks.push({ type: "toolCall", id: "t2", name: "read", arguments: {} });

		// First call claims t1
		const id1 = resolveToolCallIdByName(c, "read");
		assert.strictEqual(id1, "t1");

		// Second call should NOT get t1 again
		const id2 = resolveToolCallIdByName(c, "read");
		assert.strictEqual(id2, "t2");
		assert.notStrictEqual(id1, id2);
	});

	it("returns undefined when all toolCallIds are matched", () => {
		ctx().resetTurnState(fakeModel);
		const c = ctx();

		c.turnToolCallIds = ["t1"];
		c.turnBlocks.push({ type: "toolCall", id: "t1", name: "read", arguments: {} });

		const id1 = resolveToolCallIdByName(c, "read");
		assert.strictEqual(id1, "t1");

		// No more unmatched ids
		const id2 = resolveToolCallIdByName(c, "read");
		assert.strictEqual(id2, undefined);
	});
});

/**
 * Simulates the name-based toolCallId matching logic from buildMcpServers.
 * Extracted as a helper so tests can exercise the matching without activating
 * the full MCP server.
 */
function resolveToolCallIdByName(c, toolName) {
	for (const id of c.turnToolCallIds) {
		if (c.matchedToolCallIds.has(id)) continue;
		const block = c.turnBlocks.find((b) => b.id === id && b.type === "toolCall");
		if (block && block.name === toolName) {
			c.matchedToolCallIds.add(id);
			return id;
		}
	}
	return undefined;
}

// --- canUseTool pre-validation (P4) ---

describe("hasRequiredParams", () => {
	const { hasRequiredParams } = __test;

	it("returns false for a tool with no required array", () => {
		const tools = [{ name: "foo", parameters: { type: "object", properties: { x: { type: "string" } } } }];
		assert.strictEqual(hasRequiredParams("foo", tools), false);
	});

	it("returns false for a tool with empty required array", () => {
		const tools = [{ name: "foo", parameters: { type: "object", properties: { x: { type: "string" } }, required: [] } }];
		assert.strictEqual(hasRequiredParams("foo", tools), false);
	});

	it("returns true for a tool with required params", () => {
		const tools = [{ name: "bash", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }];
		assert.strictEqual(hasRequiredParams("bash", tools), true);
	});

	it("returns false for a tool not in the list", () => {
		const tools = [{ name: "bash", parameters: { type: "object", required: ["command"] } }];
		assert.strictEqual(hasRequiredParams("nonexistent", tools), false);
	});

	it("returns false for a tool with no parameters", () => {
		const tools = [{ name: "foo", parameters: undefined }];
		assert.strictEqual(hasRequiredParams("foo", tools), false);
	});
});

describe("canUseTool pre-validation logic", () => {
	const { hasRequiredParams, isEmptyArgs } = __test;

	// Simulate the canUseTool decision logic without activating the full provider
	function canUseToolDecision(toolName, input, tools) {
		const mappedArgs = input; // simplified — mapToolArgs is a no-op for test tools
		if (isEmptyArgs(mappedArgs) && hasRequiredParams(toolName, tools)) {
			return { behavior: "deny", message: `Tool "${toolName}" requires arguments but received empty input.` };
		}
		return { behavior: "allow" };
	}

	it("denies empty args for a tool with required params", () => {
		const tools = [{ name: "bash", parameters: { type: "object", required: ["command"] } }];
		const result = canUseToolDecision("bash", {}, tools);
		assert.strictEqual(result.behavior, "deny");
		assert.match(result.message, /requires arguments/);
	});

	it("allows non-empty args for a tool with required params", () => {
		const tools = [{ name: "bash", parameters: { type: "object", required: ["command"] } }];
		const result = canUseToolDecision("bash", { command: "ls" }, tools);
		assert.strictEqual(result.behavior, "allow");
	});

	it("allows empty args for a tool without required params", () => {
		const tools = [{ name: "status", parameters: { type: "object", properties: {} } }];
		const result = canUseToolDecision("status", {}, tools);
		assert.strictEqual(result.behavior, "allow");
	});

	it("allows empty args when tool is not found (conservative allow)", () => {
		const tools = [];
		const result = canUseToolDecision("unknown", {}, tools);
		assert.strictEqual(result.behavior, "allow");
	});

	it("denies undefined args for a tool with required params", () => {
		const tools = [{ name: "read", parameters: { type: "object", required: ["path"] } }];
		const result = canUseToolDecision("read", undefined, tools);
		assert.strictEqual(result.behavior, "deny");
	});

	it("denies null-valued args for a tool with required params", () => {
		const tools = [{ name: "bash", parameters: { type: "object", required: ["command"] } }];
		const result = canUseToolDecision("bash", { command: null }, tools);
		assert.strictEqual(result.behavior, "deny");
	});
});

describe("serial tool-call gate", () => {
	beforeEach(() => resetStack());
	const { hasRequiredParams } = __test;

	it("claims the first toolUseID in a turn", () => {
		ctx().resetTurnState(fakeModel);
		assert.strictEqual(claimSerialToolUse(ctx(), "toolu_1"), true);
		assert.strictEqual(ctx().claimedToolUseId, "toolu_1");
	});

	it("allows repeated checks for the same toolUseID", () => {
		ctx().resetTurnState(fakeModel);
		assert.strictEqual(claimSerialToolUse(ctx(), "toolu_1"), true);
		assert.strictEqual(claimSerialToolUse(ctx(), "toolu_1"), true);
		assert.strictEqual(ctx().claimedToolUseId, "toolu_1");
	});

	it("denies a different toolUseID in the same turn", () => {
		ctx().resetTurnState(fakeModel);
		assert.strictEqual(claimSerialToolUse(ctx(), "toolu_1"), true);
		assert.strictEqual(claimSerialToolUse(ctx(), "toolu_2"), false);
		assert.strictEqual(ctx().claimedToolUseId, "toolu_1");
	});

	it("resets the claimed toolUseID between turns", () => {
		ctx().resetTurnState(fakeModel);
		assert.strictEqual(claimSerialToolUse(ctx(), "toolu_1"), true);

		ctx().resetTurnState(fakeModel);
		assert.strictEqual(ctx().claimedToolUseId, null);
		assert.strictEqual(claimSerialToolUse(ctx(), "toolu_2"), true);
		assert.strictEqual(ctx().claimedToolUseId, "toolu_2");
	});

	it("does not consume the serial slot when the first tool is denied for empty args", () => {
		ctx().resetTurnState(fakeModel);
		const tools = [{ name: "read", parameters: { type: "object", required: ["path"] } }];

		function canUseToolDecisionWithSerial(c, toolName, input, toolUseId) {
			const mappedArgs = input;
			if (isEmptyArgs(mappedArgs) && hasRequiredParams(toolName, tools)) {
				return { behavior: "deny", reason: "empty-args" };
			}
			if (!claimSerialToolUse(c, toolUseId)) {
				return { behavior: "deny", reason: "serial-gate" };
			}
			return { behavior: "allow" };
		}

		const first = canUseToolDecisionWithSerial(ctx(), "read", {}, "toolu_bad");
		assert.strictEqual(first.behavior, "deny");
		assert.strictEqual(first.reason, "empty-args");
		assert.strictEqual(ctx().claimedToolUseId, null);

		const retry = canUseToolDecisionWithSerial(ctx(), "read", { path: "/tmp/file.txt" }, "toolu_retry");
		assert.strictEqual(retry.behavior, "allow");
		assert.strictEqual(ctx().claimedToolUseId, "toolu_retry");
	});
});

describe("serial stream emission", () => {
	beforeEach(() => resetStack());

	function setupStream() {
		ctx().resetTurnState(fakeModelWithCost);
		const c = ctx();
		const events = [];
		c.currentPiStream = {
			push(event) { events.push(event); },
			end() { events.push({ type: "stream_end" }); },
		};
		return { c, events };
	}

	const fakeModelWithCost = {
		api: "anthropic", provider: "anthropic", id: "test-model",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};

	function emit(event, c) {
		processStreamEvent({ event }, new Map(), fakeModelWithCost, c);
	}

	function finishStreamedToolTurn(c, id, name, input) {
		emit({ type: "message_start", index: 0, message: {} }, c);
		emit({
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id, name, input },
		}, c);
		emit({ type: "content_block_stop", index: 0 }, c);
		emit({ type: "message_stop" }, c);
	}

	it("does not expose a second tool when its content_block_stop is missing", () => {
		const { c, events } = setupStream();

		emit({
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "t1", name: "read", input: { path: "a.txt" } },
		}, c);
		emit({
			type: "content_block_start", index: 1,
			content_block: { type: "tool_use", id: "t2", name: "read", input: {} },
		}, c);
		emit({ type: "content_block_stop", index: 0 }, c);
		emit({ type: "message_stop" }, c);

		assert.deepStrictEqual(
			events.filter((event) => event.type === "toolcall_start").map((event) => event.partial.content.at(-1).id),
			["t1"],
		);
		assert.deepStrictEqual(
			events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall.id),
			["t1"],
		);
		assert.strictEqual(events.filter((event) => event.type === "done").length, 1);
		assert.deepStrictEqual(c.turnToolCallIds, ["t1"]);
		assert.strictEqual(c.claimedToolUseId, "t1");
		assert.strictEqual(claimSerialToolUse(c, "t2"), false);
	});

	it("backfills an open first tool block from the assistant message", () => {
		const { c, events } = setupStream();

		emit({
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "t1", name: "read", input: {} },
		}, c);
		emit({ type: "message_stop" }, c);

		assert.strictEqual(c.argsPendingBlocks.length, 1);
		assert.strictEqual(events.filter((event) => event.type === "done").length, 0);

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "validation.md" } }],
			},
		}, fakeModelWithCost, new Map(), c);

		const ends = events.filter((event) => event.type === "toolcall_end");
		assert.strictEqual(ends.length, 1);
		assert.strictEqual(ends[0].toolCall.id, "t1");
		assert.deepStrictEqual(ends[0].toolCall.arguments, { path: "validation.md" });
		assert.strictEqual(events.filter((event) => event.type === "done").length, 1);
		assert.strictEqual(c.argsPendingBlocks.length, 0);
	});

	it("emits only the first tool from a parallel complete batch", () => {
		const { c, events } = setupStream();

		emit({
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "t1", name: "read", input: { path: "a.txt" } },
		}, c);
		emit({
			type: "content_block_start", index: 1,
			content_block: { type: "tool_use", id: "t2", name: "bash", input: { command: "ls" } },
		}, c);
		emit({ type: "content_block_stop", index: 0 }, c);
		emit({ type: "content_block_stop", index: 1 }, c);
		emit({ type: "message_stop" }, c);

		assert.deepStrictEqual(
			events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall.id),
			["t1"],
		);
		assert.deepStrictEqual(c.turnToolCallIds, ["t1"]);
		assert.strictEqual(events.filter((event) => event.type === "done").length, 1);
	});

	it("emits only the first tool on the assistant-message fallback path", () => {
		const { c, events } = setupStream();

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [
					{ type: "tool_use", id: "t1", name: "read", input: { path: "a.txt" } },
					{ type: "tool_use", id: "t2", name: "bash", input: { command: "ls" } },
				],
			},
		}, fakeModelWithCost, new Map(), c);

		assert.deepStrictEqual(
			events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall.id),
			["t1"],
		);
		assert.deepStrictEqual(c.turnToolCallIds, ["t1"]);
		assert.strictEqual(events.filter((event) => event.type === "done").length, 1);
	});

	it("buffers production tool events until the permission decision allows the id", () => {
		ctx().resetTurnState(fakeModel);
		const c = ctx();
		c.turnCoordinator = new ToolTurnCoordinator({ requirePermission: true });
		const events = [];
		c.currentPiStream = { push(event) { events.push(event); }, end() { events.push({ type: "stream_end" }); } };
		processStreamEvent({ event: {
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "permission-id", name: "read", input: { path: "README.md" } },
		} }, new Map(), fakeModel, c);
		processStreamEvent({ event: { type: "content_block_stop", index: 0 } }, new Map(), fakeModel, c);
		processStreamEvent({ event: { type: "message_stop" } }, new Map(), fakeModel, c);
		assert.equal(events.some((event) => event.type === "toolcall_start"), false);
		assert.equal(events.some((event) => event.type === "toolcall_end"), false);
		__test.resolvePermissionPendingTool(c, "permission-id", true);
		assert.equal(events.filter((event) => event.type === "toolcall_start").length, 1);
		assert.equal(events.filter((event) => event.type === "toolcall_end").length, 1);
		assert.equal(events.filter((event) => event.type === "done").length, 1);
	});

	it("settles a permission-pending tool after message_stop when no SDK decision arrives", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		ctx().resetTurnState(fakeModel);
		const c = ctx();
		c.turnCoordinator = new ToolTurnCoordinator({ requirePermission: true });
		const events = [];
		c.currentPiStream = { push(event) { events.push(event); }, end() { events.push({ type: "stream_end" }); } };
		processStreamEvent({ event: {
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "no-callback-id", name: "read", input: { path: "README.md" } },
		} }, new Map(), fakeModel, c);
		processStreamEvent({ event: { type: "content_block_stop", index: 0 } }, new Map(), fakeModel, c);
		processStreamEvent({ event: { type: "message_stop" } }, new Map(), fakeModel, c);

		assert.equal(events.some((event) => event.type === "done"), false);
		assert.equal(c.permissionPendingBlocks.length, 1);

		t.mock.timers.tick(30_000);
		await Promise.resolve();

		assert.equal(c.permissionPendingBlocks.length, 0);
		assert.equal(c.currentPiStream, null);
		assert.equal(events.filter((event) => event.type === "done").length, 1);
		assert.equal(events.filter((event) => event.type === "stream_end").length, 1);
		assert.equal(events.some((event) => event.type === "toolcall_start"), false);
		assert.deepEqual(c.turnBlocks, []);
	});

	it("allows a same-turn retry with a new id after empty required args were denied", () => {
		ctx().resetTurnState(fakeModel);
		const c = ctx();
		c.turnCoordinator = new ToolTurnCoordinator({
			requirePermission: true,
			hasRequiredArgs: (name) => name === "read",
		});
		const events = [];
		c.currentPiStream = { push(event) { events.push(event); }, end() { events.push({ type: "stream_end" }); } };
		const emit = (event) => processStreamEvent({ event }, new Map(), fakeModel, c);

		emit({
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "empty-id", name: "read", input: {} },
		});
		emit({ type: "content_block_stop", index: 0 });
		c.turnCoordinator.recordPermissionDecision("empty-id", "read", "deny", "empty-required-args", {});
		__test.resolvePermissionPendingTool(c, "empty-id", false);

		emit({
			type: "content_block_start", index: 1,
			content_block: { type: "tool_use", id: "retry-id", name: "read", input: { path: "README.md" } },
		});
		__test.resolvePermissionPendingTool(c, "retry-id", true);
		emit({ type: "content_block_stop", index: 1 });
		emit({ type: "message_stop" });

		assert.equal(c.claimedToolUseId, "retry-id");
		assert.deepEqual(
			events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall.id),
			["retry-id"],
		);
		assert.deepEqual(events.find((event) => event.type === "toolcall_end").toolCall.arguments, { path: "README.md" });
		assert.equal(events.filter((event) => event.type === "done").length, 1);
	});

	it("does not leave a denied id in Pi content or pending matching state", () => {
		ctx().resetTurnState(fakeModel);
		const c = ctx();
		c.turnCoordinator = new ToolTurnCoordinator({ requirePermission: true });
		const events = [];
		c.currentPiStream = { push(event) { events.push(event); }, end() {} };
		processStreamEvent({ event: {
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "denied-id", name: "read", input: { path: "README.md" } },
		} }, new Map(), fakeModel, c);
		__test.resolvePermissionPendingTool(c, "denied-id", false);
		assert.deepEqual(c.turnToolCallIds, []);
		assert.deepEqual(c.turnBlocks, []);
		assert.equal(c.matchedToolCallIds.has("denied-id"), false);
		assert.equal(events.some((event) => event.type === "toolcall_start"), false);
	});

	it("keeps later text indexes contiguous when a pending tool is denied", () => {
		ctx().resetTurnState(fakeModel);
		const c = ctx();
		c.turnCoordinator = new ToolTurnCoordinator({ requirePermission: true });
		const events = [];
		c.currentPiStream = { push(event) { events.push(event); }, end() { events.push({ type: "stream_end" }); } };

		const emit = (event) => processStreamEvent({ event }, new Map(), fakeModel, c);
		emit({ type: "content_block_start", index: 0, content_block: { type: "text" } });
		emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "before" } });
		emit({ type: "content_block_stop", index: 0 });
		emit({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "denied-late", name: "read", input: { path: "secret.txt" } } });
		emit({ type: "content_block_stop", index: 1 });
		emit({ type: "content_block_start", index: 2, content_block: { type: "text" } });
		emit({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "after" } });
		emit({ type: "content_block_stop", index: 2 });
		emit({ type: "message_stop" });

		assert.equal(events.filter((event) => event.type === "text_start").length, 1);
		assert.equal(events.filter((event) => event.type === "text_end").length, 1);
		__test.resolvePermissionPendingTool(c, "denied-late", false);

		assert.deepEqual(c.turnBlocks.map((block) => block.type), ["text", "text"]);
		assert.deepEqual(events.filter((event) => event.type === "text_start").map((event) => event.contentIndex), [0, 1]);
		assert.deepEqual(events.filter((event) => event.type === "text_end").map((event) => event.contentIndex), [0, 1]);
		assert.equal(events.filter((event) => event.type === "toolcall_start").length, 0);
		assert.equal(events.filter((event) => event.type === "done").length, 1);
	});

	it("uses permission input when permission arrives before the stream block", () => {
		ctx().resetTurnState(fakeModel);
		const c = ctx();
		c.turnCoordinator = new ToolTurnCoordinator({ requirePermission: true });
		c.turnCoordinator.recordPermissionDecision("pre-authorized", "read", "allow", undefined, { path: "from-permission.txt" });
		const events = [];
		c.currentPiStream = { push(event) { events.push(event); }, end() {} };
		const emit = (event) => processStreamEvent({ event }, new Map(), fakeModel, c);
		emit({ type: "message_start", index: 0, message: {} });
		emit({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "pre-authorized", name: "read", input: {} } });
		emit({ type: "content_block_stop", index: 0 });
		emit({ type: "message_stop" });

		const end = events.find((event) => event.type === "toolcall_end");
		assert.deepEqual(end.toolCall.arguments, { path: "from-permission.txt" });
		assert.equal(events.filter((event) => event.type === "toolcall_start").length, 1);
		assert.equal(events.filter((event) => event.type === "toolcall_end").length, 1);
	});

	it("routes duplicate-index tool deltas to the most recently started block", () => {
		ctx().resetTurnState(fakeModel);
		const c = ctx();
		const events = [];
		c.currentPiStream = { push(event) { events.push(event); }, end() {} };
		c.turnBlocks.push({
			type: "toolCall", id: "read-id", name: "read",
			arguments: { path: "README.md" },
			partialJson: "{\"path\":\"README.md\"}",
			index: 2,
		});
		c.turnBlocks.push({
			type: "toolCall", id: "bash-id", name: "bash",
			arguments: {}, partialJson: "", index: 2,
		});

		processStreamEvent({
			event: {
				type: "content_block_delta", index: 2,
				delta: { type: "input_json_delta", partial_json: "{\"command\":\"ls\"}" },
			},
		}, new Map(), fakeModel, c);

		assert.deepEqual(c.turnBlocks.map((block) => block.id), ["read-id", "bash-id"]);
		assert.equal(c.turnBlocks[0].partialJson, "{\"path\":\"README.md\"}");
		assert.deepEqual(c.turnBlocks[0].arguments, { path: "README.md" });
		assert.equal(c.turnBlocks[1].partialJson, "{\"command\":\"ls\"}");
		assert.deepEqual(c.turnBlocks[1].arguments, { command: "ls" });
		assert.deepEqual(
			events.filter((event) => event.type === "toolcall_delta").map((event) => event.contentIndex),
			[1],
		);
	});

	it("ignores the completed assistant from a tool turn after a fast result resumes the stream", () => {
		const { c, events } = setupStream();
		c.turnCoordinator = new ToolTurnCoordinator({ requirePermission: true });
		c.turnCoordinator.recordPermissionDecision(
			"old-tool-id",
			"get_subagent_result",
			"allow",
			undefined,
			{ agent_id: "agent-1" },
		);

		emit({ type: "message_start", index: 0, message: {} }, c);
		emit({
			type: "content_block_start", index: 0,
			content_block: {
				type: "tool_use",
				id: "old-tool-id",
				name: "get_subagent_result",
				input: { agent_id: "agent-1" },
			},
		}, c);
		emit({ type: "content_block_stop", index: 0 }, c);
		emit({ type: "message_stop" }, c);

		assert.equal(c.currentPiStream, null);

		// Pi delivers an immediate result and installs the continuation stream before
		// the SDK yields the completed assistant snapshot for the previous tool turn.
		c.currentPiStream = {
			push(event) { events.push(event); },
			end() { events.push({ type: "stream_end" }); },
		};
		c.resetTurnState(fakeModelWithCost, true);
		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{
					type: "tool_use",
					id: "old-tool-id",
					name: "get_subagent_result",
					input: { agent_id: "agent-1" },
				}],
			},
		}, fakeModelWithCost, new Map(), c);

		assert.deepEqual(c.permissionPendingBlocks, []);

		emit({ type: "message_start", index: 0, message: {} }, c);
		assert.equal(c.permissionBufferedStreamEvents.length, 0);
		c.turnCoordinator.recordPermissionDecision(
			"next-tool-id",
			"read",
			"allow",
			undefined,
			{ path: "src/tool-turn-coordinator.ts" },
		);
		emit({
			type: "content_block_start", index: 0,
			content_block: {
				type: "tool_use",
				id: "next-tool-id",
				name: "read",
				input: { path: "src/tool-turn-coordinator.ts" },
			},
		}, c);
		emit({ type: "content_block_stop", index: 0 }, c);
		emit({ type: "message_stop" }, c);

		assert.equal(events.filter((event) => event.type === "toolcall_start").length, 2);
		assert.deepEqual(
			events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall.id),
			["old-tool-id", "next-tool-id"],
		);
	});

	it("consumes a delayed completed assistant by parent tool id after the next stream starts", () => {
		const { c, events } = setupStream();
		finishStreamedToolTurn(c, "old-tool-id", "read", { path: "old.txt" });
		c.currentPiStream = {
			push(event) { events.push(event); },
			end() { events.push({ type: "stream_end" }); },
		};
		c.resetTurnState(fakeModelWithCost, true);
		emit({ type: "message_start", index: 0, message: {} }, c);

		processAssistantMessage({
			type: "assistant",
			parent_tool_use_id: "old-tool-id",
			message: {
				content: [{
					type: "tool_use",
					id: "old-tool-id",
					name: "read",
					input: { path: "old.txt" },
				}],
			},
		}, fakeModelWithCost, new Map(), c);

		assert.equal(c.awaitingTrailingAssistant, null);
		assert.deepEqual(
			events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall.id),
			["old-tool-id"],
		);
	});

	it("delivers a fresh assistant with a null parent even when it reuses an old tool id", () => {
		const { c, events } = setupStream();
		finishStreamedToolTurn(c, "old-tool-id", "read", { path: "old.txt" });
		c.currentPiStream = {
			push(event) { events.push(event); },
			end() { events.push({ type: "stream_end" }); },
		};
		c.resetTurnState(fakeModelWithCost, true);
		emit({ type: "message_start", index: 0, message: {} }, c);

		processAssistantMessage({
			type: "assistant",
			parent_tool_use_id: null,
			message: {
				content: [{
					type: "tool_use",
					id: "old-tool-id",
					name: "read",
					input: { path: "fresh.txt" },
				}],
			},
		}, fakeModelWithCost, new Map(), c);

		assert.deepEqual(
			events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall.arguments),
			[{ path: "old.txt" }, { path: "fresh.txt" }],
		);
	});

	it("delivers a fresh assistant that calls the same tool with a different id", () => {
		const { c, events } = setupStream();
		finishStreamedToolTurn(c, "old-tool-id", "read", { path: "old.txt" });
		c.currentPiStream = {
			push(event) { events.push(event); },
			end() { events.push({ type: "stream_end" }); },
		};
		c.resetTurnState(fakeModelWithCost, true);

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{
					type: "tool_use",
					id: "new-tool-id",
					name: "read",
					input: { path: "new.txt" },
				}],
			},
		}, fakeModelWithCost, new Map(), c);

		assert.deepEqual(
			events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall.id),
			["old-tool-id", "new-tool-id"],
		);
	});

	it("consumes the completed assistant before the tool-result continuation stream is attached", () => {
		const { c, events } = setupStream();
		finishStreamedToolTurn(c, "old-tool-id", "read", { path: "old.txt" });

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{
					type: "tool_use",
					id: "old-tool-id",
					name: "read",
					input: { path: "old.txt" },
				}],
			},
		}, fakeModelWithCost, new Map(), c);

		assert.equal(c.awaitingTrailingAssistant, null);
		assert.equal(events.filter((event) => event.type === "toolcall_end").length, 1);
	});

	it("delivers a text-only assistant while a trailing assistant marker is armed", () => {
		const { c, events } = setupStream();
		finishStreamedToolTurn(c, "old-tool-id", "read", { path: "old.txt" });
		c.currentPiStream = {
			push(event) { events.push(event); },
			end() { events.push({ type: "stream_end" }); },
		};
		c.resetTurnState(fakeModelWithCost, true);

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{ type: "text", text: "fresh text-only answer" }],
			},
		}, fakeModelWithCost, new Map(), c);

		assert.equal(
			events.some((event) => event.type === "text_delta" && event.delta === "fresh text-only answer"),
			true,
		);
	});

	it("clears a trailing assistant marker when a malformed assistant fails open", () => {
		const { c, events } = setupStream();
		finishStreamedToolTurn(c, "old-tool-id", "read", { path: "old.txt" });
		c.currentPiStream = {
			push(event) { events.push(event); },
			end() { events.push({ type: "stream_end" }); },
		};
		c.resetTurnState(fakeModelWithCost, true);

		processAssistantMessage({
			type: "assistant",
			message: { content: null },
		}, fakeModelWithCost, new Map(), c);

		assert.equal(c.awaitingTrailingAssistant, null);
	});

	it("advances the generation for an assistant-message fallback turn", () => {
		const { c, events } = setupStream();
		assert.equal(c.sdkTurnGeneration, 0);

		processAssistantMessage({
			type: "assistant",
			message: { content: [{ type: "text", text: "fallback answer" }] },
		}, fakeModelWithCost, new Map(), c);

		assert.equal(c.sdkTurnGeneration, 1);
		assert.equal(events.some((event) => event.type === "text_delta" && event.delta === "fallback answer"), true);
	});

	function setupMcpDispatchHarness() {
		ctx().resetTurnState(fakeModel);
		const c = ctx();
		c.turnCoordinator = new ToolTurnCoordinator({ requirePermission: true });
		const events = [];
		c.currentPiStream = {
			push(event) { events.push(event); },
			end() { events.push({ type: "stream_end" }); },
		};
		const tool = {
			name: "read",
			description: "read a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		};
		const bridge = buildMcpServers([tool], c);
		const handler = bridge.servers.custom_tools.instance._registeredTools.read.handler;
		const emit = (event) => processStreamEvent({ event }, new Map(), fakeModel, c);
		return { c, events, handler, emit };
	}

	async function resolvePiResult(c, toolCallId, handlerPromise) {
		const pending = c.pendingToolCalls.get(toolCallId);
		assert.ok(pending, `MCP handler ${toolCallId} should wait for the Pi tool result`);
		pending.resolve({ content: [{ type: "text", text: "ok" }] });
		await handlerPromise;
	}

	it("releases a pending tool when MCP dispatch arrives without a canUseTool callback", async () => {
		const { c, events, handler, emit } = setupMcpDispatchHarness();
		emit({
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "dispatch-late", name: "read", input: { path: "a.txt" } },
		});
		emit({ type: "content_block_stop", index: 0 });
		emit({ type: "message_stop" });

		const handlerPromise = handler({ path: "a.txt" });
		await Promise.resolve();

		assert.deepEqual(events.filter((event) => event.type).map((event) => event.type), [
			"start", "toolcall_start", "toolcall_end", "done", "stream_end",
		]);
		assert.equal(c.permissionPendingBlocks.length, 0);
		assert.equal(c.currentPiStream, null);
		assert.deepEqual(events.find((event) => event.type === "toolcall_end").toolCall.arguments, { path: "a.txt" });

		await resolvePiResult(c, "dispatch-late", handlerPromise);
	});

	it("executes correctly when MCP dispatch arrives before the stream block", async () => {
		const { c, events, handler, emit } = setupMcpDispatchHarness();
		const handlerPromise = handler({ path: "a.txt" });

		emit({
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "dispatch-early", name: "read", input: {} },
		});
		emit({ type: "content_block_stop", index: 0 });
		emit({ type: "message_stop" });
		await Promise.resolve();

		assert.deepEqual(events.filter((event) => event.type).map((event) => event.type), [
			"start", "toolcall_start", "toolcall_end", "done", "stream_end",
		]);
		assert.equal(c.permissionPendingBlocks.length, 0);
		assert.equal(c.pendingMcpDispatches.length, 0);
		assert.deepEqual(events.find((event) => event.type === "toolcall_end").toolCall.arguments, { path: "a.txt" });

		await resolvePiResult(c, "dispatch-early", handlerPromise);
	});

	it("times out an MCP dispatch that never receives a stream tool id", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { c, handler } = setupMcpDispatchHarness();
		let settled;
		void handler({ path: "never-streamed.txt" }).then((result) => { settled = result; });

		await Promise.resolve();
		assert.equal(c.pendingMcpDispatches.length, 1);
		assert.equal(c.turnCoordinator.snapshot().pendingDispatches, 1);
		t.mock.timers.tick(29_999);
		await Promise.resolve();
		assert.equal(settled, undefined);

		t.mock.timers.tick(1);
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(settled?.isError, true);
		assert.match(settled?.content?.[0]?.text ?? "", /timed out/i);
		assert.equal(c.pendingMcpDispatches.length, 0);
		assert.equal(c.turnCoordinator.snapshot().pendingDispatches, 0);
	});

	it("does not time out a dispatch after it binds to a stream tool id", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { c, handler, emit } = setupMcpDispatchHarness();
		let settled;
		const handlerPromise = handler({ path: "long-running.txt" });
		void handlerPromise.then((result) => { settled = result; });

		emit({
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "long-running-id", name: "read", input: {} },
		});
		emit({ type: "content_block_stop", index: 0 });
		emit({ type: "message_stop" });
		await Promise.resolve();

		assert.equal(c.pendingMcpDispatches.length, 0);
		assert.equal(c.pendingToolCalls.has("long-running-id"), true);
		t.mock.timers.tick(300_000);
		await Promise.resolve();
		assert.equal(settled, undefined);

		await resolvePiResult(c, "long-running-id", handlerPromise);
	});

	it("does not execute a tool after an explicit permission deny", async () => {
		const { c, events, handler, emit } = setupMcpDispatchHarness();
		emit({
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "explicit-deny", name: "read", input: { path: "secret.txt" } },
		});
		__test.resolvePermissionPendingTool(c, "explicit-deny", false);

		const timeout = Symbol("timeout");
		let timer;
		const result = await Promise.race([
			handler({ path: "secret.txt" }),
			new Promise((resolve) => { timer = setTimeout(() => resolve(timeout), 100); }),
		]);
		clearTimeout(timer);

		assert.notEqual(result, timeout, "a denied dispatch must not leave the MCP handler waiting");
		assert.equal(result.isError, true);
		assert.equal(events.some((event) => event.type === "toolcall_start"), false);
		assert.equal(events.some((event) => event.type === "toolcall_end"), false);
	});

	it("does not orphan a sibling MCP dispatch across the first tool-result reset", async () => {
		ctx().resetTurnState(fakeModel);
		const c = ctx();
		c.turnCoordinator = new ToolTurnCoordinator({ requirePermission: true });
		const events = [];
		c.currentPiStream = {
			push(event) { events.push(event); },
			end() { events.push({ type: "stream_end" }); },
		};
		const tools = [
			{
				name: "read",
				description: "read a file",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
			{
				name: "bash",
				description: "run a command",
				parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
			},
		];
		const bridge = buildMcpServers(tools, c);
		const read = bridge.servers.custom_tools.instance._registeredTools.read.handler;
		const bash = bridge.servers.custom_tools.instance._registeredTools.bash.handler;
		const emit = (event) => processStreamEvent({ event }, new Map(), fakeModel, c);

		emit({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "read-id", name: "read", input: { path: "README.md" } } });
		emit({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "bash-id", name: "bash", input: { command: "ls" } } });
		const readPromise = read({ path: "README.md" });
		await Promise.resolve();

		assert.ok(c.permissionPendingBlocks.some((pending) => pending.block.id === "bash-id"));
		const readPending = c.pendingToolCalls.get("read-id");
		assert.ok(readPending);

		// streamCodebuddySdk currently performs this reset before resolving the
		// first Pi tool result. The sibling handler must remain resolvable.
		c.resetTurnState(fakeModel, true);
		readPending.resolve({ content: [{ type: "text", text: "read ok" }] });
		await readPromise;

		const timeout = Symbol("timeout");
		let timer;
		const bashResult = await Promise.race([
			bash({ command: "ls" }),
			new Promise((resolve) => { timer = setTimeout(() => resolve(timeout), 100); }),
		]);
		clearTimeout(timer);

		assert.notEqual(bashResult, timeout, "a sibling dispatch must not wait forever after the first tool result");
		assert.equal(bashResult.isError, true);
		assert.equal(c.pendingMcpDispatches.length, 0);
		assert.equal(c.permissionPendingBlocks.some((pending) => pending.block.id === "bash-id"), false);
		assert.equal(events.filter((event) => event.type === "toolcall_start").length, 1);
	});

	it("rebinds a dispatch-first handler after the next assistant turn starts", async () => {
		const { c, events, handler, emit } = setupMcpDispatchHarness();
		c.turnCoordinator.observeStreamStart("old-id", "read", { path: "old.txt" });
		c.turnCoordinator.observeDispatch("read", { path: "old.txt" });
		c.resetTurnState(fakeModel, true);

		const handlerPromise = handler({ path: "new.txt" });
		emit({ type: "message_start", index: 0, message: {} });
		emit({
			type: "content_block_start", index: 0,
			content_block: { type: "tool_use", id: "new-id", name: "read", input: {} },
		});
		emit({ type: "content_block_stop", index: 0 });
		emit({ type: "message_stop" });
		await Promise.resolve();

		assert.equal(events.filter((event) => event.type === "toolcall_start").length, 1);
		assert.equal(events.filter((event) => event.type === "toolcall_end").length, 1);
		assert.equal(events.filter((event) => event.type === "done").length, 1);
		await resolvePiResult(c, "new-id", handlerPromise);
	});

	it("binds a dispatch when mixed stream text is followed by assistant-only tool_use", async () => {
		const { c, events, handler, emit } = setupMcpDispatchHarness();
		emit({ type: "message_start", index: 0, message: {} });
		emit({ type: "content_block_start", index: 0, content_block: { type: "text" } });
		emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "planning" } });
		emit({ type: "content_block_stop", index: 0 });

		const handlerPromise = handler({ path: "README.md" });
		await Promise.resolve();
		assert.equal(c.pendingMcpDispatches.length, 1);

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [
					{ type: "text", text: "planning" },
					{ type: "tool_use", id: "assistant-only-id", name: "read", input: { path: "README.md" } },
				],
			},
		}, fakeModel, new Map(), c);
		await Promise.resolve();

		assert.equal(c.pendingMcpDispatches.length, 0);
		assert.equal(c.pendingToolCalls.has("assistant-only-id"), true);
		assert.deepEqual(
			events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall.id),
			["assistant-only-id"],
		);
		assert.equal(events.filter((event) => event.type === "done").length, 1);
		await resolvePiResult(c, "assistant-only-id", handlerPromise);
	});
});

describe("live query abort targeting", () => {
	it("interrupts whichever query is currently live", async () => {
		const calls = [];
		const primary = {
			interrupt: async () => { calls.push("primary"); },
		};
		const continuation = {
			interrupt: async () => { calls.push("continuation"); },
		};
		const ref = { current: primary };

		interruptLiveQuery(ref);
		await Promise.resolve();
		assert.deepStrictEqual(calls, ["primary"]);

		ref.current = continuation;
		interruptLiveQuery(ref);
		await Promise.resolve();
		assert.deepStrictEqual(calls, ["primary", "continuation"]);

		ref.current = undefined;
		interruptLiveQuery(ref);
		await Promise.resolve();
		assert.deepStrictEqual(calls, ["primary", "continuation"]);
	});
});
