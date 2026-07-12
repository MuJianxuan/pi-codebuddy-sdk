/**
 * Tests for Pi → CodeBuddy system prompt forwarding.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCodebuddySystemPrompt, buildPiToolBridgeInstruction } from "../src/skills.js";

const PI_PROMPT = `You are Pi's coding assistant in the terminal.

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.

<available_skills>
  <skill>
    <name>br</name>
    <description>Browser automation.</description>
    <location>/tmp/skills/br/SKILL.md</location>
  </skill>
</available_skills>

Follow user rules.`;

describe("buildCodebuddySystemPrompt", () => {
	it("includes Pi Tool Bridge instructions", () => {
		const availableToolNames = ["read", "edit", "write", "bash"];
		const result = buildCodebuddySystemPrompt(PI_PROMPT, { availableToolNames });
		assert.ok(result?.includes("Pi Tool Bridge:"));
		assert.ok(result?.includes("mcp__custom_tools__read"));
		assert.ok(result?.includes("Use `mcp__custom_tools__read`"));
		assert.ok(result?.includes("oldText/old_string value must exactly match"));
		assert.ok(result?.startsWith(buildPiToolBridgeInstruction({ availableToolNames })));
	});

	it("adapts tool bridge instructions to available tools", () => {
		const result = buildCodebuddySystemPrompt(PI_PROMPT, {
			availableToolNames: ["read", "bash"],
		});
		assert.ok(result?.includes("`mcp__custom_tools__read`, `mcp__custom_tools__bash`"));
		assert.ok(result?.includes("Use `mcp__custom_tools__read`"));
		assert.ok(result?.includes("Use `mcp__custom_tools__bash`"));
		assert.ok(!result?.includes("mcp__custom_tools__edit"));
		assert.ok(!result?.includes("mcp__custom_tools__write"));
	});

	it("defaults to serial tool-call enforcement when multiple tools available", () => {
		const result = buildCodebuddySystemPrompt(PI_PROMPT, {
			availableToolNames: ["read", "bash"],
		});
		assert.ok(result?.includes("AT MOST ONE tool per turn"));
		assert.ok(result?.includes("will be denied"));
		assert.ok(result?.includes("Parallel tool calls are unsupported"));
	});

	it("does not include parallel tool-call guidance when only one tool available", () => {
		const result = buildCodebuddySystemPrompt(PI_PROMPT, {
			availableToolNames: ["read"],
		});
		assert.ok(result?.includes("AT MOST ONE tool per turn"));
		assert.ok(!result?.includes("multiple tools in a single response"));
	});

	it("does not inject provider tool guidance when disabled", () => {
		const result = buildCodebuddySystemPrompt(PI_PROMPT, {
			includeToolBridge: false,
		});
		assert.ok(result?.includes("You are Pi's coding assistant"));
		assert.ok(!result?.includes("Pi Tool Bridge:"));
		assert.ok(!result?.includes("mcp__custom_tools__read"));
		assert.ok(result?.includes("Use the read tool to load a skill's file"));
	});

	it("uses Pi identity instead of CodeBuddy default", () => {
		const result = buildCodebuddySystemPrompt(PI_PROMPT, { availableToolNames: ["read", "edit", "write", "bash"] });
		assert.ok(result?.includes("You are Pi's coding assistant"));
		assert.ok(result?.includes("mcp__custom_tools__read"));
		assert.ok(!result?.includes("CodeBuddy Code"));
	});

	it("rewrites skills read tool inside full prompt", () => {
		const result = buildCodebuddySystemPrompt(PI_PROMPT, { availableToolNames: ["read", "edit", "write", "bash"] });
		assert.ok(result?.includes("Use the read tool (mcp__custom_tools__read)"));
		assert.ok(!result?.includes("Use the read tool to load a skill's file\n"));
	});

	it("includeSkills=false strips skills block", () => {
		const result = buildCodebuddySystemPrompt(PI_PROMPT, { availableToolNames: ["read", "edit", "write", "bash"], includeSkills: false });
		assert.ok(result?.includes("You are Pi's coding assistant"));
		assert.ok(!result?.includes("<available_skills>"));
	});

	it("undefined prompt with no context → bridge only", () => {
		const availableToolNames = ["read", "edit", "write", "bash"];
		assert.strictEqual(
			buildCodebuddySystemPrompt(undefined, { availableToolNames }),
			buildPiToolBridgeInstruction({ availableToolNames }),
		);
	});

	it("undefined prompt with tool bridge disabled → undefined", () => {
		assert.strictEqual(buildCodebuddySystemPrompt(undefined, { includeToolBridge: false }), undefined);
	});
});
