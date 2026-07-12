/**
 * Tests for skills block extraction and rewriting.
 * Verifies we correctly extract skills from pi's system prompt and rewrite
 * the read tool reference for the CodeBuddy MCP bridge.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPiToolBridgeInstruction, enhancePiToolForCodebuddy, extractSkillsBlock } from "../src/skills.js";

// Realistic pi system prompt with skills block
const SYSTEM_PROMPT = `You are a coding assistant.

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>br</name>
    <description>Browser automation CLI.</description>
    <location>/tmp/skills/br/SKILL.md</location>
  </skill>
  <skill>
    <name>deep-research</name>
    <description>Deep research via parallel web agents.</description>
    <location>/tmp/agent-skills/deep-research/SKILL.md</location>
  </skill>
</available_skills>

Some other system prompt content after skills.`;

describe("skills block extraction", () => {
	it("extracts and rewrites read tool reference", () => {
		const result = extractSkillsBlock(SYSTEM_PROMPT);
		assert.ok(result, "should extract skills block");
		assert.ok(result.includes("Use the read tool (mcp__custom_tools__read) to load a skill's file"));
		assert.ok(!result.includes("Use the read tool to load a skill's file\n"));
	});

	it("preserves skill paths as-is", () => {
		const result = extractSkillsBlock(SYSTEM_PROMPT);
		assert.ok(result.includes("/tmp/skills/br/SKILL.md"));
		assert.ok(result.includes("/tmp/agent-skills/deep-research/SKILL.md"));
	});

	it("correct boundaries", () => {
		const result = extractSkillsBlock(SYSTEM_PROMPT);
		assert.ok(result.startsWith("The following skills"));
		assert.ok(result.endsWith("</available_skills>"));
		assert.ok(!result.includes("Some other system prompt"));
	});

	it("no skills in prompt → undefined", () => {
		assert.strictEqual(extractSkillsBlock("Just a normal prompt"), undefined);
		assert.strictEqual(extractSkillsBlock(undefined), undefined);
		assert.strictEqual(extractSkillsBlock(""), undefined);
	});

	it("malformed: start marker but no end marker → undefined", () => {
		const partial = "The following skills provide specialized instructions for specific tasks.\nBut no closing tag.";
		assert.strictEqual(extractSkillsBlock(partial), undefined);
	});
});

describe("enhancePiToolForCodebuddy", () => {
	it("adds guidance for built-in Pi file and shell tools", () => {
		const read = enhancePiToolForCodebuddy({
			name: "read",
			description: "Read a file.",
			parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
		});
		assert.equal(read.name, "read");
		assert.equal(read.parameters.required[0], "path");
		assert.ok(read.description.includes("Read a file."));
		assert.ok(read.description.includes("CodeBuddy guidance:"));
		assert.ok(read.description.includes("inspect file contents"));

		const edit = enhancePiToolForCodebuddy({ name: "edit", description: "Edit a file." });
		assert.ok(edit.description.includes("oldText/old_string value must exactly match"));
	});

	it("leaves custom tools unchanged", () => {
		const custom = { name: "DeployPreview", description: "Deploy a preview.", parameters: { type: "object" } };
		const result = enhancePiToolForCodebuddy(custom);
		assert.strictEqual(result, custom);
		assert.equal(result.description, "Deploy a preview.");
	});

	it("does not duplicate guidance", () => {
		const tool = {
			name: "bash",
			description: "Run a command.\n\nCodeBuddy guidance: already present.",
		};
		const result = enhancePiToolForCodebuddy(tool);
		assert.strictEqual(result, tool);
		assert.equal(result.description.match(/CodeBuddy guidance:/g).length, 1);
	});
});

describe("buildPiToolBridgeInstruction", () => {
	it("mentions only available built-in tools", () => {
		const result = buildPiToolBridgeInstruction({ availableToolNames: ["read", "bash"] });
		assert.ok(result.includes("mcp__custom_tools__read"));
		assert.ok(result.includes("mcp__custom_tools__bash"));
		assert.ok(!result.includes("mcp__custom_tools__edit"));
		assert.ok(!result.includes("mcp__custom_tools__write"));
		assert.ok(result.includes("Prefer it over shelling out to cat/sed"));
	});

	it("handles no available Pi tools without suggesting tool calls", () => {
		const result = buildPiToolBridgeInstruction({ availableToolNames: [] });
		assert.ok(result.includes("No Pi tools are currently available"));
		assert.ok(!result.includes("Tool selection rules:"));
		assert.ok(!result.includes("mcp__custom_tools__read"));
	});

	it("does not copy active tool descriptions into bridge guidance", () => {
		const description = "THIS_SINGLE_TOOL_DESCRIPTION_SHOULD_NOT_APPEAR";
		const result = buildPiToolBridgeInstruction({ availableToolNames: ["read", "DeployPreview"] });
		assert.ok(result.includes("mcp__custom_tools__read"));
		assert.ok(!result.includes(description));
		assert.ok(result.includes("mcp__custom_tools__DeployPreview"));
	});

	it("preserves original custom tool case in MCP names", () => {
		const result = buildPiToolBridgeInstruction({ availableToolNames: ["Read", "DeployPreview"] });
		assert.ok(result.includes("mcp__custom_tools__Read"));
		assert.ok(result.includes("mcp__custom_tools__DeployPreview"));
		assert.ok(!result.includes("mcp__custom_tools__read"));
	});
});
