import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildActionSummary,
	formatToolAction,
	sanitizeActionLabel,
} from "../src/askcodebuddy-ui.js";

describe("AskCodebuddy action-label sanitization", () => {
	it("never persists a raw Bash/PowerShell/Terminal command", () => {
		const secret = "sk-live-secret-sentinel";
		const calls = new Map([
			["bash", { name: "Bash", status: "complete", rawInput: { command: `echo ${secret}\n\u001b[31mred` } }],
			["powershell", { name: "PowerShell", status: "complete", rawInput: { command: `Write-Host ${secret}` } }],
			["terminal", { name: "Terminal", status: "complete", rawInput: { input: secret } }],
		]);
		const summary = buildActionSummary(calls);
		assert.equal(summary, "Bash; PowerShell; Terminal");
		assert.equal(summary.includes(secret), false);
		assert.equal(summary.includes("red"), false);
	});

	it("sanitizes controls and collapses whitespace", () => {
		const value = sanitizeActionLabel("\u001b[31mfirst\u001b[0m\r\nsecond\tthird\u0000");
		assert.equal(value, "first second third");
	});

	it("keeps useful file labels but applies a bounded truncation marker", () => {
		const action = formatToolAction({
			name: "Read",
			status: "complete",
			rawInput: { path: `/project/${"a".repeat(200)}.ts` },
		});
		assert.ok(action.startsWith("Read("));
		assert.ok(action.endsWith("…"));
		assert.ok(action.length <= 80);
	});

	it("sanitizes generic labels and patterns", () => {
		const summary = buildActionSummary(new Map([
			["grep", { name: "Grep\u001b[2J", status: "complete", rawInput: { pattern: "line\nwith\tcontrols" } }],
			["agent", { name: "Agent", status: "complete", rawInput: { description: "review\nthis" } }],
		]));
		assert.equal(summary.includes("\u001b"), false);
		assert.equal(summary.includes("\n"), false);
		assert.equal(summary, "Grep(line with controls); Agent(review this)");
	});
});
