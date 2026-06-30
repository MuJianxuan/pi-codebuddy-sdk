/**
 * Tests for CodeBuddy model helpers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildModels, codebuddyModelId, rawModelsFromSdk, resolveModel, FALLBACK_MODELS } from "../src/models.js";

describe("rawModelsFromSdk", () => {
	it("maps SDK ModelInfo to pi models", () => {
		const models = rawModelsFromSdk([
			{ value: "hy3-preview-agent-ioa", displayName: "Hunyuan 3", description: "" },
			{ id: "claude-sonnet-4.6", name: "Claude Sonnet", description: "" },
		]);
		assert.equal(models[0].id, "hy3-preview-agent-ioa");
		assert.equal(models[1].input.includes("image"), true);
		assert.deepEqual(models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
});

describe("buildModels", () => {
	it("preserves order from SDK", () => {
		const models = buildModels(rawModelsFromSdk([
			{ value: "model-b", displayName: "B", description: "" },
			{ value: "model-a", displayName: "A", description: "" },
		]));
		assert.deepEqual(models.map((m) => m.id), ["model-b", "model-a"]);
	});
});

describe("codebuddyModelId", () => {
	it("returns model id unchanged", () => {
		assert.equal(codebuddyModelId({ id: "hy3-preview-agent-ioa" }), "hy3-preview-agent-ioa");
	});
});

describe("resolveModel", () => {
	const models = buildModels(FALLBACK_MODELS);

	it("resolves by partial id", () => {
		assert.equal(resolveModel(models, "hy3")?.id, "hy3-preview-agent-ioa");
	});

	it("returns undefined when no match", () => {
		assert.equal(resolveModel(models, "gpt-9"), undefined);
	});
});
