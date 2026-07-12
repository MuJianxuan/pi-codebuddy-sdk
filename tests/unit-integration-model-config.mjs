import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_BRIDGE_MODEL,
	resolveBridgeModel,
} from "./lib/model-config.mjs";

describe("integration model config", () => {
	it("defaults to the current public Hy3 model id", () => {
		assert.equal(DEFAULT_BRIDGE_MODEL, "codebuddy/hy3");
		assert.equal(resolveBridgeModel({}), "codebuddy/hy3");
		assert.doesNotMatch(DEFAULT_BRIDGE_MODEL, /preview|-ioa/);
	});

	it("accepts a non-empty environment override", () => {
		assert.equal(
			resolveBridgeModel({ CODEBUDDY_SDK_TEST_MODEL: " codebuddy/glm-5.2 " }),
			"codebuddy/glm-5.2",
		);
	});

	it("ignores an empty environment override", () => {
		assert.equal(
			resolveBridgeModel({ CODEBUDDY_SDK_TEST_MODEL: "   " }),
			"codebuddy/hy3",
		);
	});
});
