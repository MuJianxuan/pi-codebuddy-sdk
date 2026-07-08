/**
 * Regression tests for syncSharedSession's session reuse decisions.
 */
import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const debugDir = mkdtempSync(join(tmpdir(), "sync-shared-session-debug-"));
process.env.CODEBUDDY_SDK_DEBUG_PATH = join(debugDir, "codebuddy-sdk.log");
process.env.CODEBUDDY_CONFIG_DIR = join(debugDir, "codebuddy");

const { __test } = await import("../src/index.js");
const { createSession, getSessionPath } = await import("../src/cb-session-io.js");

describe("syncSharedSession", () => {
	after(() => {
		rmSync(debugDir, { recursive: true, force: true });
	});

	afterEach(() => {
		__test.resetSharedSession();
	});

	it("does not reuse a cached main session for a shorter synthetic compact context", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		try {
			const mainSession = {
				sessionId: "11111111-1111-4111-8111-111111111111",
				cursor: 42,
				cwd,
			};
			__test.setSharedSession(mainSession);

			const result = __test.syncSharedSession([
				{
					role: "user",
					content: "Summarize this conversation.",
					timestamp: Date.now(),
				},
			], cwd);

			assert.equal(
				result.sessionId,
				null,
				"synthetic compact contexts have no prior messages and must start a fresh CodeBuddy session instead of resuming the main session",
			);
			assert.equal(
				result.preserveSharedSession,
				true,
				"the fresh synthetic CodeBuddy session must not replace the cached main session when it completes",
			);
			assert.deepEqual(__test.getSharedSession(), mainSession);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("creates AskCodebuddy delegation sessions without reusing or mutating provider sharedSession", () => {
		const cwd = mkdtempSync(join(tmpdir(), "delegation-session-"));
		try {
			const providerPollution = "mcp__custom_tools__read";
			const mainSession = {
				sessionId: "22222222-2222-4222-8222-222222222222",
				cursor: 7,
				cwd,
			};
			const providerSession = createSession({ projectPath: cwd, sessionId: mainSession.sessionId });
			providerSession.messages = [
				{ role: "user", content: `Pi Tool Bridge: ${providerPollution}` },
				{ role: "assistant", content: `Prior provider answer with ${providerPollution}` },
			];
			providerSession.save();
			__test.setSharedSession(mainSession);

			const sessionId = __test.createDelegationSessionFromContext([
				{
					role: "user",
					content: "Use the read tool to inspect context.",
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Prior answer." },
						{ type: "toolCall", id: "provider-tool-1", name: "read", arguments: { path: "README.md" } },
					],
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "provider-tool-1",
					toolName: "read",
					content: "TOOL_RESULT_SECRET_FROM_PROVIDER_HISTORY",
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "Answer after tool result." }],
					timestamp: Date.now(),
				},
			], cwd, "test-model");

			assert.ok(sessionId);
			assert.notEqual(sessionId, mainSession.sessionId);
			assert.deepEqual(__test.getSharedSession(), mainSession);

			const providerJsonl = readFileSync(getSessionPath(mainSession.sessionId, cwd), "utf-8");
			assert.ok(providerJsonl.includes(providerPollution));

			const jsonl = readFileSync(getSessionPath(sessionId, cwd), "utf-8");
			assert.ok(jsonl.includes("Prior answer."));
			assert.ok(jsonl.includes("Answer after tool result."));
			assert.ok(!jsonl.includes("provider-tool-1"));
			assert.ok(!jsonl.includes("TOOL_RESULT_SECRET_FROM_PROVIDER_HISTORY"));
			assert.ok(!jsonl.includes("[tool:"));
			assert.ok(!jsonl.includes(providerPollution));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
