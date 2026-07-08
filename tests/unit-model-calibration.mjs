import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyContextWindowCalibrations,
	buildCalibrationEnvironment,
	buildCalibrationKey,
	loadCalibrationCache,
	recordObservedContextWindow,
	saveCalibrationCache,
} from "../src/model-calibration.js";

const tempDirs = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop(), { recursive: true, force: true });
	}
});

function tempFile(name) {
	const dir = mkdtempSync(join(tmpdir(), "codebuddy-calibration-"));
	tempDirs.push(dir);
	return join(dir, name);
}

describe("buildCalibrationEnvironment", () => {
	it("captures runtime environment signals with defaults", () => {
		const previousInternet = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
		const previousConfigDir = process.env.CODEBUDDY_CONFIG_DIR;
		process.env.CODEBUDDY_INTERNET_ENVIRONMENT = "ioa";
		process.env.CODEBUDDY_CONFIG_DIR = "/tmp/codebuddy-config";
		try {
			assert.deepEqual(buildCalibrationEnvironment("/usr/local/bin/codebuddy"), {
				internetEnvironment: "ioa",
				codebuddyConfigDir: "/tmp/codebuddy-config",
				codebuddyExecutable: "/usr/local/bin/codebuddy",
			});
		} finally {
			if (previousInternet == null) delete process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
			else process.env.CODEBUDDY_INTERNET_ENVIRONMENT = previousInternet;
			if (previousConfigDir == null) delete process.env.CODEBUDDY_CONFIG_DIR;
			else process.env.CODEBUDDY_CONFIG_DIR = previousConfigDir;
		}
	});
});

describe("recordObservedContextWindow", () => {
	it("keeps the proven floor while tracking latest and max", () => {
		const cache = loadCalibrationCache(tempFile("empty.json"));
		const environment = {
			internetEnvironment: "default",
			codebuddyConfigDir: "default",
			codebuddyExecutable: "default",
		};

		const first = recordObservedContextWindow(cache, "codebuddy/foo", environment, 120_000);
		assert.equal(first.record.capabilities.contextWindow.floor, 120_000);
		assert.equal(first.record.capabilities.contextWindow.latest, 120_000);
		assert.equal(first.record.capabilities.contextWindow.max, 120_000);

		const second = recordObservedContextWindow(cache, "codebuddy/foo", environment, 200_000);
		assert.equal(second.record.capabilities.contextWindow.floor, 120_000);
		assert.equal(second.record.capabilities.contextWindow.latest, 200_000);
		assert.equal(second.record.capabilities.contextWindow.max, 200_000);
		assert.equal(second.floorChanged, false);

		const third = recordObservedContextWindow(cache, "codebuddy/foo", environment, 80_000);
		assert.equal(third.record.capabilities.contextWindow.floor, 80_000);
		assert.equal(third.record.capabilities.contextWindow.latest, 80_000);
		assert.equal(third.record.capabilities.contextWindow.max, 200_000);
		assert.equal(third.floorChanged, true);
	});

	it("persists and reloads records by environment-scoped key", () => {
		const cachePath = tempFile("cache.json");
		const cache = loadCalibrationCache(cachePath);
		const environment = {
			internetEnvironment: "ioa",
			codebuddyConfigDir: "/tmp/a",
			codebuddyExecutable: "/opt/codebuddy",
		};
		recordObservedContextWindow(cache, "codebuddy/foo", environment, 64_000);
		saveCalibrationCache(cache, cachePath);

		const reloaded = loadCalibrationCache(cachePath);
		const key = buildCalibrationKey("codebuddy/foo", environment);
		assert.equal(reloaded.records[key].capabilities.contextWindow.floor, 64_000);
	});
});

describe("applyContextWindowCalibrations", () => {
	it("caps registered models to the cached floor for the matching environment", () => {
		const cache = loadCalibrationCache(tempFile("cache.json"));
		const environment = {
			internetEnvironment: "default",
			codebuddyConfigDir: "default",
			codebuddyExecutable: "default",
		};
		recordObservedContextWindow(cache, "codebuddy/foo", environment, 48_000);

		const calibrated = applyContextWindowCalibrations([
			{ id: "codebuddy/foo", contextWindow: 65_536 },
			{ id: "codebuddy/bar", contextWindow: 65_536 },
		], cache, environment);
		assert.deepEqual(calibrated, [
			{ id: "codebuddy/foo", contextWindow: 48_000 },
			{ id: "codebuddy/bar", contextWindow: 65_536 },
		]);
	});

	it("promotes a conservative default to the proven floor for that environment", () => {
		const cache = loadCalibrationCache(tempFile("cache.json"));
		const environment = {
			internetEnvironment: "ioa",
			codebuddyConfigDir: "default",
			codebuddyExecutable: "default",
		};
		recordObservedContextWindow(cache, "codebuddy/foo", environment, 120_000);

		const calibrated = applyContextWindowCalibrations([
			{ id: "codebuddy/foo", contextWindow: 65_536 },
		], cache, environment);
		assert.deepEqual(calibrated, [
			{ id: "codebuddy/foo", contextWindow: 120_000 },
		]);
	});
});
