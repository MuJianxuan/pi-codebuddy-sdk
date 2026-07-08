import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { jsonSchemaPropertyToZod, jsonSchemaToZodObject, jsonSchemaToZodShape } from "../src/typebox-to-zod.js";

describe("jsonSchemaPropertyToZod", () => {
	it("supports nested object properties", () => {
		const schema = jsonSchemaPropertyToZod({
			type: "object",
			properties: {
				path: { type: "string" },
				options: {
					type: "object",
					properties: {
						recursive: { type: "boolean" },
					},
					required: ["recursive"],
				},
			},
			required: ["path", "options"],
		});

		const parsed = schema.parse({ path: "README.md", options: { recursive: true } });
		assert.deepEqual(parsed, { path: "README.md", options: { recursive: true } });
		assert.throws(() => schema.parse({ path: "README.md", options: {} }));
	});

	it("supports nullable union-like type arrays", () => {
		const schema = jsonSchemaPropertyToZod({ type: ["string", "null"] });
		assert.equal(schema.parse("hello"), "hello");
		assert.equal(schema.parse(null), null);
		assert.throws(() => schema.parse(42));
	});

	it("supports oneOf unions", () => {
		const schema = jsonSchemaPropertyToZod({
			oneOf: [
				{ type: "string" },
				{ type: "number" },
			],
		});
		assert.equal(schema.parse("hello"), "hello");
		assert.equal(schema.parse(42), 42);
		assert.throws(() => schema.parse(false));
	});

	it("preserves nullable on oneOf schemas", () => {
		const schema = jsonSchemaPropertyToZod({
			nullable: true,
			oneOf: [
				{ type: "string" },
				{ type: "number" },
			],
		});
		assert.equal(schema.parse(null), null);
		assert.equal(schema.parse("hello"), "hello");
		assert.equal(schema.parse(42), 42);
	});

	it("preserves additionalProperties schema when known properties also exist", () => {
		const schema = jsonSchemaPropertyToZod({
			type: "object",
			properties: {
				fixed: { type: "string" },
			},
			additionalProperties: { type: "number" },
			required: ["fixed"],
		});
		assert.deepEqual(schema.parse({ fixed: "ok", extra: 1 }), { fixed: "ok", extra: 1 });
		assert.throws(() => schema.parse({ fixed: "ok", extra: "bad" }));
	});

	it("rejects unknown keys when additionalProperties is false", () => {
		const schema = jsonSchemaPropertyToZod({
			type: "object",
			properties: {
				fixed: { type: "string" },
			},
			additionalProperties: false,
			required: ["fixed"],
		});
		assert.deepEqual(schema.parse({ fixed: "ok" }), { fixed: "ok" });
		assert.throws(() => schema.parse({ fixed: "ok", extra: 1 }));
	});
});

describe("jsonSchemaToZodShape", () => {
	it("merges object properties from allOf fragments", () => {
		const shape = jsonSchemaToZodShape({
			type: "object",
			allOf: [
				{
					type: "object",
					properties: {
						path: { type: "string" },
					},
					required: ["path"],
				},
				{
					type: "object",
					properties: {
						force: { type: "boolean" },
					},
				},
			],
		});
		const schema = z.object(shape);
		assert.deepEqual(schema.parse({ path: "README.md", force: true }), { path: "README.md", force: true });
		assert.throws(() => schema.parse({ force: true }));
	});
});

	describe("jsonSchemaToZodObject", () => {
		it("preserves root-level additionalProperties false", () => {
			const schema = jsonSchemaToZodObject({
				type: "object",
				properties: {
					path: { type: "string" },
				},
				required: ["path"],
				additionalProperties: false,
			});
			assert.deepEqual(schema.parse({ path: "README.md" }), { path: "README.md" });
			assert.throws(() => schema.parse({ path: "README.md", extra: true }));
		});
	});
