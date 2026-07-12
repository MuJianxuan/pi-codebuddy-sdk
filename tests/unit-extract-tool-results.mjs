import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractAllToolResults, toolResultToMcpContent } from "../src/extract-tool-results.js";

describe("extract tool results converter", () => {
	it("preserves text, typed image, and empty result contracts", () => {
		assert.deepEqual(toolResultToMcpContent("hello"), [{ type: "text", text: "hello" }]);
		assert.deepEqual(toolResultToMcpContent([
			{ type: "text", text: "caption" },
			{ type: "image", data: "base64", mimeType: "image/png" },
		]), [
			{ type: "text", text: "caption" },
			{ type: "image", data: "base64", mimeType: "image/png" },
		]);
		assert.deepEqual(toolResultToMcpContent([]), [{ type: "text", text: "" }]);
	});

	it("uses an explicit placeholder for malformed images", () => {
		assert.deepEqual(toolResultToMcpContent([{ type: "image", data: "", mimeType: "image/png" }]), [
			{ type: "text", text: "[invalid image omitted]" },
		]);
	});

	it("extracts only the current tail and preserves image content", () => {
		const result = extractAllToolResults([
			{ role: "assistant", content: [] },
			{ role: "toolResult", toolCallId: "old", content: "old" },
			{ role: "assistant", content: [] },
			{ role: "toolResult", toolCallId: "new", content: [{ type: "image", data: "data", mimeType: "image/png" }] },
		]);
		assert.deepEqual(result.results, [{
			toolCallId: "new",
			isError: undefined,
			content: [{ type: "image", data: "data", mimeType: "image/png" }],
		}]);
	});
});
