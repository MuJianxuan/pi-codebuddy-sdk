import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withSdkGate } from "../src/sdk-gate.js";

describe("withSdkGate", () => {
	it("serializes SDK operations", async () => {
		let releaseFirst;
		const first = withSdkGate(async () => {
			await new Promise((resolve) => { releaseFirst = resolve; });
			return "first";
		});
		const second = withSdkGate(async () => "second");

		await Promise.resolve();
		let secondSettled = false;
		void second.then(() => { secondSettled = true; });
		await Promise.resolve();
		assert.equal(secondSettled, false);

		releaseFirst();
		assert.equal(await first, "first");
		assert.equal(await second, "second");
	});

	it("releases the gate after a rejected operation", async () => {
		await assert.rejects(withSdkGate(async () => {
			throw new Error("first failed");
		}), /first failed/);
		assert.equal(await withSdkGate(async () => "next"), "next");
	});
});
