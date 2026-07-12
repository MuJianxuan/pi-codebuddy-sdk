#!/usr/bin/env node
// Integration tests for tool execution + message interaction scenarios.
// Uses pi in RPC mode with the bridge + SlowTool test extension.
// Exercises how the bridge handles messages arriving during tool execution.

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRpcHarness } from "./lib/rpc-harness.mjs";
import { BRIDGE_MODEL } from "./lib/model-config.mjs";

const TEST_TIMEOUT = 60_000;

const harness = createRpcHarness({
	name: "tool-message",
	args: [
		"-e", "./tests/fixtures/slow-tool-extension.ts",
		"-e", "./tests/fixtures/immediate-large-result-extension.ts",
		"--model", BRIDGE_MODEL,
	],
	defaultTimeout: TEST_TIMEOUT,
});

describe("tool-message integration", () => {
	const { startAndWait, stop, send, waitForEvent, waitForMatch, collectText, promptAndWait, DEBUG_LOG, RPC_LOG } = harness;

	// --- Lifecycle ---

	before(async () => {
		await startAndWait();
	});

	afterEach(async () => {
		await stop();
		await startAndWait();
	});

	after(async () => {
		await stop();
		console.log(`  RPC log: ${RPC_LOG}`);
		console.log(`  Debug log: ${DEBUG_LOG}`);
	});

	// --- Tests ---

	it("tool call completes normally", { timeout: TEST_TIMEOUT }, async () => {
		const text = await promptAndWait(
			"Call SlowTool with seconds=1. Then repeat exactly what it returned, nothing else."
		);
		assert.match(text.toLowerCase(), /slowtool completed/);
	});

	it("continues to a second tool after an immediate large result", { timeout: TEST_TIMEOUT }, async () => {
		const collector = collectText();
		const agentEnd = waitForEvent("agent_end");
		await send({
			type: "prompt",
			message: [
				"Call ImmediateLargeResult exactly once.",
				"After it returns, call read on src/tool-turn-coordinator.ts exactly once.",
				"After read returns, reply exactly FAST-RESULT-CHAIN-OK and do not call more tools.",
			].join(" "),
		});
		const end = await agentEnd;
		const text = collector.stop();
		const toolResults = (end.messages ?? []).filter((message) => message.role === "toolResult");

		assert.equal(
			toolResults.some((message) => JSON.stringify(message.content).includes("FAST-LARGE-RESULT-END")),
			true,
			"missing the immediate 24KB tool result",
		);
		assert.equal(
			toolResults.some((message) => message.toolName === "read"),
			true,
			"the read tool did not complete after the immediate result",
		);
		assert.match(text, /FAST-RESULT-CHAIN-OK/);
	});

	it("followUp during tool execution delivers after tool completes", { timeout: TEST_TIMEOUT }, async () => {
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=5. Then repeat exactly what it returned.",
		});
		await waitForEvent("tool_execution_start");
		// followUp is queued by pi until the current turn finishes
		await send({
			type: "prompt",
			message: "This is a followUp during tool execution.",
			streamingBehavior: "followUp",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /slowtool completed/);
	});

	it("steer during tool execution still delivers tool result", { timeout: TEST_TIMEOUT }, async () => {
		// Issue #3: steer injects a user message into the context during an active
		// tool call. extractAllToolResults stops at the user message and returns 0
		// results, leaving the pending handler stuck.
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=2. Then repeat exactly what it returned.",
		});
		await waitForEvent("tool_execution_start");
		await send({
			type: "prompt",
			message: "This is a steer message during tool execution.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /slowtool completed/);
	});

	it("multi-round tool calls with steer delivers all results", { timeout: TEST_TIMEOUT }, async () => {
		const collector = collectText();
		const agentEnd = waitForEvent("agent_end");
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=3, then seconds=4, then seconds=5. After all three complete, list all three results.",
		});
		// Wait for the first tool round to start, then inject steer while later
		// tool rounds are still pending.
		await waitForEvent("tool_execution_start");
		await send({
			type: "prompt",
			message: "This is a steer during multi-round tool execution.",
			streamingBehavior: "steer",
		});
		const end = await agentEnd;
		const text = collector.stop();
		// Bridge must deliver all tool results into context even when a steer lands
		// during the broader multi-round tool workflow (model text may summarize).
		const toolResults = (end.messages ?? []).filter((m) => m.role === "toolResult");
		const slowResults = toolResults.filter((m) => JSON.stringify(m.content).toLowerCase().includes("slowtool completed"));
		assert.ok(
			slowResults.length >= 3,
			`Expected 3 SlowTool results in context, found ${slowResults.length}; text=${text.slice(0, 300)}`,
		);
	});

	it("steer during text response (no tool call) completes both turns", { timeout: TEST_TIMEOUT }, async () => {
		// Steer during text-only streaming: the assistant is generating text (no tool
		// calls), a steer arrives, and pi delivers it after the current turn ends.
		// Risk: if activeQuery hasn't been cleared by the time pi calls streamSimple
		// for the steer, the bridge enters the tool-result-delivery path incorrectly.
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Write exactly 12 short numbered sentences about the history of computing, from Babbage to modern times. Do NOT call any tools.",
		});
		// Wait until text is actually streaming before injecting the steer
		await waitForMatch(
			(msg) => msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta",
			"text_delta during assistant response",
		);
		await send({
			type: "prompt",
			message: "After you finish, also say the exact word 'PINEAPPLE' on its own line.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /pineapple/);
	});

	it("steer during tool execution is visible to assistant", { timeout: TEST_TIMEOUT }, async () => {
		// Bug: when a steer arrives during tool execution, pi drains it at the turn
		// boundary and injects it into context alongside the tool result. The bridge
		// sees activeQuery=true, enters tool-result-delivery mode, extracts the tool
		// result, but silently ignores the trailing user message (the steer). Claude
		// never sees the steer content.
		const collector = collectText();
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=2. After it returns, repeat exactly what it returned.",
		});
		await waitForEvent("tool_execution_start");
		await send({
			type: "prompt",
			message: "IMPORTANT: Also say the exact word 'MANGO' on its own line in your response.",
			streamingBehavior: "steer",
		});
		await waitForEvent("agent_end");
		const text = collector.stop();
		assert.match(text.toLowerCase(), /mango/, `Steer content not visible to assistant: ${text.slice(0, 300)}`);
	});

	it("abort during tool execution recovers cleanly", { timeout: TEST_TIMEOUT }, async () => {
		await send({
			type: "prompt",
			message: "Call SlowTool with seconds=30.",
		});
		await waitForEvent("tool_execution_start");
		const idle = waitForEvent("agent_end");
		await send({ type: "abort" });
		await idle;
		// Next prompt should work without hanging
		const text = await promptAndWait("Reply with just the word 'recovered'.");
		assert.match(text.toLowerCase(), /recovered/);
	});
});
