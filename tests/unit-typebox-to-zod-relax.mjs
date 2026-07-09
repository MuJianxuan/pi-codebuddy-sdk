import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jsonSchemaToZodObject } from "../src/typebox-to-zod.js";

describe("jsonSchemaToZodObject relax mode", () => {
	it("makes required properties optional so {} validates (parallel arg-drop workaround)", () => {
		const schema = jsonSchemaToZodObject({
			type: "object",
			properties: { command: { type: "string" }, timeout: { type: "number" } },
			required: ["command"],
		}, true);
		assert.deepEqual(schema.parse({}), {});
		assert.deepEqual(schema.parse({ command: "ls" }), { command: "ls" });
		assert.deepEqual(schema.parse({ command: "ls", timeout: 5 }), { command: "ls", timeout: 5 });
		assert.throws(() => schema.parse({ command: 42 }));
	});

	it("does not relax by default (preserves required enforcement)", () => {
		const schema = jsonSchemaToZodObject({
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		});
		assert.throws(() => schema.parse({}));
		assert.deepEqual(schema.parse({ command: "ls" }), { command: "ls" });
	});
});
