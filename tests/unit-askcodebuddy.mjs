import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildAskQueryOptions,
	consumeAskQuery,
	createAskQueryRunner,
} from "../src/askcodebuddy-runner.js";

const providerSettings = { pathToCodebuddyCode: "/global/codebuddy" };

function fakeQuery(messages, { onInterrupt } = {}) {
	let interrupted = false;
	return {
		async *[Symbol.asyncIterator]() {
			for (const message of messages) {
				if (interrupted) return;
				yield message;
			}
		},
		interrupt: async () => {
			interrupted = true;
			onInterrupt?.();
		},
	};
}

describe("AskCodebuddy query options", () => {
	it("uses a native-tool whitelist and no filesystem settings for read", () => {
		const options = buildAskQueryOptions({
			mode: "read",
			cwd: "/project",
			cliModel: "opus",
			providerSettings,
		});
		assert.deepEqual(options.tools, ["Read", "Glob", "Grep"]);
		assert.deepEqual(options.settingSources, []);
		assert.equal(options.permissionMode, "bypassPermissions");
	});

	it("disables all native tools and filesystem settings for none", () => {
		const options = buildAskQueryOptions({
			mode: "none",
			cwd: "/project",
			cliModel: "opus",
			providerSettings,
		});
		assert.deepEqual(options.tools, []);
		assert.deepEqual(options.settingSources, []);
	});

	it("keeps full mode capability explicit and isolated mode cannot resume", () => {
		const options = buildAskQueryOptions({
			mode: "full",
			cwd: "/project",
			cliModel: "opus",
			providerSettings,
			resumeSessionId: "session-id",
			isolated: true,
		});
		assert.equal(options.tools, undefined);
		assert.deepEqual(options.settingSources, ["user", "project"]);
		assert.equal(options.resume, undefined);
		assert.equal(options.persistSession, false);
		assert.ok(options.disallowedTools.includes("AskUserQuestion"));
	});
});

describe("consumeAskQuery", () => {
	it("returns streamed text and falls back to a successful result", async () => {
		const updates = [];
		const result = await consumeAskQuery(fakeQuery([
			{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } },
			{ type: "result", subtype: "success", result: "" },
		]), undefined, { onTextDelta: (text) => updates.push(text) });
		assert.deepEqual(updates, ["hello"]);
		assert.deepEqual(result, { responseText: "hello", stopReason: "stop" });
	});

	it("returns streamed text when a non-success result ends the query", async () => {
		const updates = [];
		const result = await consumeAskQuery(fakeQuery([
			{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } },
			{ type: "result", subtype: "error", errors: ["rate limited"] },
		]), undefined, { onTextDelta: (text) => updates.push(text) });

		assert.deepEqual(updates, ["partial"]);
		assert.deepEqual(result, { responseText: "partial", stopReason: "stop" });
	});

	it("returns terminal result text when a non-success result has no streamed text", async () => {
		const result = await consumeAskQuery(fakeQuery([
			{ type: "result", subtype: "cancelled", result: "partial result" },
		]), undefined);

		assert.deepEqual(result, { responseText: "partial result", stopReason: "stop" });
	});

	it("captures tool lifecycle through the same production consumer", async () => {
		const events = [];
		await consumeAskQuery(fakeQuery([
			{ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool-1", name: "Read" } } },
			{ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { path: "README.md" } }] } },
			{ type: "result", subtype: "success", result: "done" },
		]), undefined, {
			onToolStart: (tool) => events.push(["start", tool]),
			onToolComplete: (tool) => events.push(["complete", tool]),
		});
		assert.equal(events.length, 2);
		assert.equal(events[0][1].name, "Read");
		assert.deepEqual(events[1][1].input, { path: "README.md" });
	});

	for (const [label, resultMessage] of [
		["empty errors", { type: "result", subtype: "error", errors: [] }],
		["missing errors", { type: "result", subtype: "error" }],
	]) {
		it(`rejects non-success results with ${label}`, async () => {
			await assert.rejects(
				consumeAskQuery(fakeQuery([resultMessage]), undefined),
				/CodeBuddy query failed/,
			);
		});
	}

	it("propagates an SDK execution error", async () => {
		const executionError = new Error("ExecutionError");
		const throwingQuery = {
			async *[Symbol.asyncIterator]() { throw executionError; },
			interrupt: async () => {},
		};
		await assert.rejects(consumeAskQuery(throwingQuery, undefined), executionError);
	});

	it("rejects a query that ends without a terminal result", async () => {
		await assert.rejects(
			consumeAskQuery(fakeQuery([{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } }]), undefined),
			/without a terminal result/,
		);
	});

	it("turns abort into a rejected terminal result and interrupts the SDK query", async () => {
		let interrupted = 0;
		const controller = new AbortController();
		const query = fakeQuery([], { onInterrupt: () => interrupted++ });
		controller.abort();
		await assert.rejects(consumeAskQuery(query, controller.signal), /Operation aborted/);
		assert.equal(interrupted, 1);
	});

	it("uses the injected query factory", async () => {
		const calls = [];
		const runner = createAskQueryRunner((prompt, options) => {
			calls.push({ prompt, options });
			return fakeQuery([{ type: "result", subtype: "success", result: "ok" }]);
		});
		const result = await runner("question", { cwd: "/project", tools: [], settingSources: [] });
		assert.equal(result.responseText, "ok");
		assert.equal(calls[0].prompt, "question");
	});
});
