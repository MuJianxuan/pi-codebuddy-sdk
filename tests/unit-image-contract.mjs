import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { __test } from "../src/index.js";

describe("image contract", () => {
	it("keeps current-turn typed image data", () => {
		assert.deepEqual(__test.extractUserPromptBlocks([
			{ role: "user", content: [
				{ type: "text", text: "inspect this" },
				{ type: "image", data: "base64-data", mimeType: "image/png" },
			] },
		]), [
			{ type: "text", text: "inspect this" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "base64-data" } },
		]);
	});

	it("uses a placeholder for malformed current-turn images", () => {
		assert.deepEqual(__test.extractUserPromptBlocks([
			{ role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }] },
		]), [{ type: "text", text: "[invalid image omitted]" }]);
	});
});
