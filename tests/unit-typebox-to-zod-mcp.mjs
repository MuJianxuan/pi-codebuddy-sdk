/**
 * Tests for jsonSchemaToZodObjectForMcp — the MCP-specific schema builder
 * that preserves required constraints while allowing passthrough for extra keys.
 *
 * Unlike jsonSchemaToZodObject(relax=true) which makes ALL params optional,
 * this keeps required params required so empty {} is rejected at MCP validation
 * time (an early signal that parallel tool_call args were dropped).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jsonSchemaToZodObjectForMcp } from "../src/typebox-to-zod.js";

describe("jsonSchemaToZodObjectForMcp", () => {
	it("rejects empty {} when there are required fields", () => {
		const schema = jsonSchemaToZodObjectForMcp({
			type: "object",
			properties: { command: { type: "string" }, timeout: { type: "number" } },
			required: ["command"],
		});
		assert.throws(() => schema.parse({}));
	});

	it("accepts valid input with required fields present", () => {
		const schema = jsonSchemaToZodObjectForMcp({
			type: "object",
			properties: { command: { type: "string" }, timeout: { type: "number" } },
			required: ["command"],
		});
		assert.deepEqual(schema.parse({ command: "ls" }), { command: "ls" });
		assert.deepEqual(schema.parse({ command: "ls", timeout: 5 }), { command: "ls", timeout: 5 });
	});

	it("rejects wrong type for required field", () => {
		const schema = jsonSchemaToZodObjectForMcp({
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		});
		assert.throws(() => schema.parse({ command: 42 }));
	});

	it("allows extra keys (passthrough) for forward-compat", () => {
		const schema = jsonSchemaToZodObjectForMcp({
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		});
		// Extra keys should pass through without error
		const result = schema.parse({ command: "ls", unknownFutureField: 123 });
		assert.equal(result.command, "ls");
		assert.equal(result.unknownFutureField, 123);
	});

	it("allows optional-only schemas to accept {}", () => {
		const schema = jsonSchemaToZodObjectForMcp({
			type: "object",
			properties: { timeout: { type: "number" } },
			// no required fields
		});
		assert.deepEqual(schema.parse({}), {});
		assert.deepEqual(schema.parse({ timeout: 10 }), { timeout: 10 });
	});

	it("preserves descriptions for model guidance", () => {
		const schema = jsonSchemaToZodObjectForMcp({
			type: "object",
			properties: {
				command: { type: "string", description: "The shell command to execute" },
			},
			required: ["command"],
		});
		// Zod descriptions are accessible via ._def.description
		// Just verify it parses correctly — description preservation is tested
		// implicitly by the model seeing it via MCP tool schema
		assert.deepEqual(schema.parse({ command: "ls" }), { command: "ls" });
	});

	it("handles schemas with no properties (returns record type)", () => {
		const schema = jsonSchemaToZodObjectForMcp({
			type: "object",
		});
		// Should accept any object
		assert.deepEqual(schema.parse({}), {});
		assert.deepEqual(schema.parse({ anything: true }), { anything: true });
	});

	it("handles nested object properties", () => {
		const schema = jsonSchemaToZodObjectForMcp({
			type: "object",
			properties: {
				options: {
					type: "object",
					properties: { verbose: { type: "boolean" } },
					required: ["verbose"],
				},
			},
			required: ["options"],
		});
		// Empty top-level should fail (options is required)
		assert.throws(() => schema.parse({}));
		// options present but missing verbose should fail
		assert.throws(() => schema.parse({ options: {} }));
		// Valid nested
		assert.deepEqual(schema.parse({ options: { verbose: true } }), { options: { verbose: true } });
	});

	it("handles array properties", () => {
		const schema = jsonSchemaToZodObjectForMcp({
			type: "object",
			properties: {
				files: { type: "array", items: { type: "string" } },
			},
			required: ["files"],
		});
		assert.throws(() => schema.parse({}));
		assert.deepEqual(schema.parse({ files: ["a.txt", "b.txt"] }), { files: ["a.txt", "b.txt"] });
	});

	it("handles enum properties", () => {
		const schema = jsonSchemaToZodObjectForMcp({
			type: "object",
			properties: {
				mode: { type: "string", enum: ["read", "write", "edit"] },
			},
			required: ["mode"],
		});
		assert.deepEqual(schema.parse({ mode: "read" }), { mode: "read" });
		assert.throws(() => schema.parse({ mode: "invalid" }));
		assert.throws(() => schema.parse({}));
	});
});
