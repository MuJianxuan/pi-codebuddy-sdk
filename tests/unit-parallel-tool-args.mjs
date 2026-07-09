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

const { isEmptyArgs } = __test;

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
