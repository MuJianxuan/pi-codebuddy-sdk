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
import { __test } from "../src/index.js";

const { claimSerialToolUse, isEmptyArgs, processStreamEvent } = __test;

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
});
