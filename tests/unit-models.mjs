/**
 * Tests for CodeBuddy model helpers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildModels,
	codebuddyModelId,
	conservativeContextWindow,
	rawModelsFromSdk,
	resolveModel,
	FALLBACK_MODELS,
} from "../src/models.js";

describe("rawModelsFromSdk", () => {
	it("maps SDK ModelInfo to pi models", () => {
		const models = rawModelsFromSdk([
			{ value: "hy3", displayName: "Hunyuan 3", description: "" },
			{ id: "claude-sonnet-4.6", name: "Claude Sonnet", description: "" },
		]);
		assert.equal(models[0].id, "hy3");
		assert.equal(models[1].input.includes("image"), true);
		assert.deepEqual(models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
});

	describe("conservativeContextWindow", () => {
		it("uses family-bounded conservative defaults", () => {
			assert.equal(conservativeContextWindow("gemini-2.5-pro"), 1_048_576);
			assert.equal(conservativeContextWindow("claude-sonnet-4.6"), 200_000);
			assert.equal(conservativeContextWindow("hy3"), 200_000);
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
		assert.equal(codebuddyModelId({ id: "hy3" }), "hy3");
	});
});

describe("resolveModel", () => {
	const models = buildModels(FALLBACK_MODELS);

	it("uses the current public CodeBuddy model id as the startup fallback", () => {
		assert.deepEqual(models.map(({ id }) => id), ["hy3"]);
		assert.equal(resolveModel(models, "hy3")?.id, "hy3");
	});

	it("returns undefined when no match", () => {
		assert.equal(resolveModel(models, "gpt-9"), undefined);
	});

	it("matches exact ids case-insensitively before prefixes", () => {
		const candidates = [{ id: "alpha-long" }, { id: "alpha" }, { id: "beta" }];
		assert.equal(resolveModel(candidates, " ALPHA ").id, "alpha");
	});

	it("rejects ambiguous prefixes and arbitrary substrings", () => {
		const candidates = [{ id: "alpha-one" }, { id: "alpha-two" }, { id: "beta" }];
		assert.equal(resolveModel(candidates, "alpha"), undefined);
		assert.equal(resolveModel(candidates, "one"), undefined);
		assert.equal(resolveModel(candidates, "   "), undefined);
	});

	it("allows only explicit shorthand aliases", () => {
		assert.equal(resolveModel([{ id: "claude-opus-4" }], "opus").id, "claude-opus-4");
		assert.equal(resolveModel([{ id: "claude-alpha-one" }], "one"), undefined);
	});
});
