import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { __test } from "../src/index.js";

const fakeModel = {
	api: "anthropic",
	provider: "codebuddy",
	id: "test-model",
	contextWindow: 200_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("isolated summary lifecycle", () => {
	it("returns a successful summary without closing a completed query", async () => {
		let returnCalls = 0;
		let forceCloseCalls = 0;
		const sdkQuery = {
			async *[Symbol.asyncIterator]() {
				yield {
					type: "assistant",
					message: { content: [{ type: "text", text: "summary text" }] },
				};
				yield { type: "result", subtype: "success", result: "summary text" };
			},
			async return() { returnCalls++; },
		};

		const outcome = await __test.consumeIsolatedSummaryQuery({
			sdkQuery,
			model: fakeModel,
			abortController: new AbortController(),
			timeoutMs: 10,
			closeGraceMs: 5,
			forceClose() { forceCloseCalls++; },
		});

		assert.deepEqual(outcome, { kind: "success", text: "summary text" });
		assert.equal(returnCalls, 0);
		assert.equal(forceCloseCalls, 0);
	});

	it("times out and force-closes a summary query that never yields", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let finishNext;
		let returnCalls = 0;
		let forceCloseCalls = 0;
		const iterator = {
			next() {
				return new Promise((resolve) => { finishNext = resolve; });
			},
			return() {
				return Promise.resolve({ done: true, value: undefined });
			},
		};
		const sdkQuery = {
			[Symbol.asyncIterator]() { return iterator; },
			return() {
				returnCalls++;
				return new Promise(() => {});
			},
		};

		const outcomePromise = __test.consumeIsolatedSummaryQuery({
			sdkQuery,
			model: fakeModel,
			abortController: new AbortController(),
			timeoutMs: 10,
			closeGraceMs: 5,
			forceClose() {
				forceCloseCalls++;
				finishNext?.({ done: true, value: undefined });
			},
		});

		await Promise.resolve();
		t.mock.timers.tick(10);
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(returnCalls, 1);
		t.mock.timers.tick(5);
		await Promise.resolve();
		await Promise.resolve();

		assert.deepEqual(await outcomePromise, {
			kind: "error",
			message: "CodeBuddy compact summary timed out after 10ms",
		});
		assert.equal(forceCloseCalls, 1);
	});

	it("aborts and force-closes a summary query exactly once", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const externalAbort = new AbortController();
		let finishNext;
		let returnCalls = 0;
		let forceCloseCalls = 0;
		const iterator = {
			next() {
				return new Promise((resolve) => { finishNext = resolve; });
			},
			return() { return Promise.resolve({ done: true, value: undefined }); },
		};
		const sdkQuery = {
			[Symbol.asyncIterator]() { return iterator; },
			async return() {
				returnCalls++;
				throw new Error("graceful return failed");
			},
		};

		const outcomePromise = __test.consumeIsolatedSummaryQuery({
			sdkQuery,
			model: fakeModel,
			abortController: new AbortController(),
			signal: externalAbort.signal,
			timeoutMs: 100,
			closeGraceMs: 5,
			forceClose() {
				forceCloseCalls++;
				finishNext?.({ done: true, value: undefined });
			},
		});

		await Promise.resolve();
		externalAbort.abort();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(returnCalls, 1);
		t.mock.timers.tick(5);
		await Promise.resolve();
		await Promise.resolve();

		assert.deepEqual(await outcomePromise, { kind: "aborted" });
		assert.equal(forceCloseCalls, 1);
	});

	it("force-closes after a synchronous graceful-return failure", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let finishNext;
		let forceCloseCalls = 0;
		const sdkQuery = {
			[Symbol.asyncIterator]() {
				return {
					next() { return new Promise((resolve) => { finishNext = resolve; }); },
					return() { return Promise.resolve({ done: true, value: undefined }); },
				};
			},
			return() { throw new Error("synchronous return failure"); },
		};
		const outcomePromise = __test.consumeIsolatedSummaryQuery({
			sdkQuery,
			model: fakeModel,
			abortController: new AbortController(),
			timeoutMs: 10,
			closeGraceMs: 5,
			forceClose() {
				forceCloseCalls++;
				finishNext?.({ done: true, value: undefined });
			},
		});

		await Promise.resolve();
		t.mock.timers.tick(10);
		await Promise.resolve();
		await Promise.resolve();
		t.mock.timers.tick(5);
		await Promise.resolve();
		await Promise.resolve();

		assert.equal((await outcomePromise).kind, "error");
		assert.equal(forceCloseCalls, 1);
	});
});
