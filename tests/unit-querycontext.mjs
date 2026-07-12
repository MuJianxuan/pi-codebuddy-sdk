/**
 * Tests for the production QueryContext state.
 * Uses the real module — no API calls, no extension activation.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ctx, resetStack } from "../src/query-state.js";

const fakeModel = { api: "anthropic", provider: "anthropic", id: "test-model" };

describe("QueryContext class", () => {
	beforeEach(() => resetStack());

	it("turnBlocks throws before resetTurnState", () => {
		assert.throws(() => ctx().turnBlocks, /turnBlocks accessed before resetTurnState/);
	});

	it("turnBlocks reflects turnOutput.content after resetTurnState", () => {
		ctx().resetTurnState(fakeModel);
		assert.ok(Array.isArray(ctx().turnBlocks));
		assert.strictEqual(ctx().turnBlocks.length, 0);

		ctx().turnBlocks.push({ type: "text", text: "hello" });
		assert.strictEqual(ctx().turnOutput.content.length, 1);
		assert.strictEqual(ctx().turnOutput.content[0].text, "hello");
		// Same array reference
		assert.strictEqual(ctx().turnBlocks, ctx().turnOutput.content);
	});

	it("resetTurnState preserves turnToolCallIds and nextHandlerIdx", () => {
		ctx().turnToolCallIds = ["id1", "id2"];
		ctx().nextHandlerIdx = 5;
		ctx().resetTurnState(fakeModel);

		assert.deepStrictEqual(ctx().turnToolCallIds, ["id1", "id2"]);
		assert.strictEqual(ctx().nextHandlerIdx, 5);
	});

	it("resetTurnState settles unmatched MCP dispatches on a normal reset", async () => {
		const c = ctx();
		let settled;
		c.turnCoordinator.observeDispatch("read", { path: "pending.txt" });
		c.pendingMcpDispatches.push({
			toolName: "read",
			args: { path: "pending.txt" },
			resolve(result) { settled = result; },
		});

		c.resetTurnState(fakeModel);
		await Promise.resolve();

		assert.equal(settled?.isError, true);
		assert.equal(c.pendingMcpDispatches.length, 0);
		assert.equal(c.turnCoordinator.snapshot().pendingDispatches, 0);
	});

	it("resetTurnState preserves unmatched MCP dispatches across tool-result delivery", () => {
		const c = ctx();
		c.turnCoordinator.observeDispatch("read", { path: "pending.txt" });
		const pending = {
			toolName: "read",
			args: { path: "pending.txt" },
			resolve() {},
		};
		c.pendingMcpDispatches.push(pending);

		c.resetTurnState(fakeModel, true);

		assert.strictEqual(c.pendingMcpDispatches[0], pending);
		assert.equal(c.turnCoordinator.snapshot().pendingDispatches, 1);
		c.drainPendingMcpDispatches("test cleanup");
	});
});
