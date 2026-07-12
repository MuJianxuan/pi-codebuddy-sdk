import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyContextWindowCalibrations,
	buildCalibrationEnvironment,
	buildCalibrationKey,
	loadCalibrationCache,
	mergeContextWindowMetric,
	recordObservedContextWindow,
	saveCalibrationCache,
	updateObservedContextWindow,
	__test as calibrationTest,
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

	it("persists and reloads records by environment-scoped key", async () => {
		const cachePath = tempFile("cache.json");
		const cache = loadCalibrationCache(cachePath);
		const environment = {
			internetEnvironment: "ioa",
			codebuddyConfigDir: "/tmp/a",
			codebuddyExecutable: "/opt/codebuddy",
		};
		recordObservedContextWindow(cache, "codebuddy/foo", environment, 64_000);
		await saveCalibrationCache(cache, cachePath);

		const reloaded = loadCalibrationCache(cachePath);
		const key = buildCalibrationKey("codebuddy/foo", environment);
		assert.equal(reloaded.records[key].capabilities.contextWindow.floor, 64_000);
	});

	it("merges records from stale writers instead of losing observations", async () => {
		const cachePath = tempFile("shared-cache.json");
		const environment = {
			internetEnvironment: "default",
			codebuddyConfigDir: "default",
			codebuddyExecutable: "default",
		};
		const cacheA = loadCalibrationCache(cachePath);
		const cacheB = loadCalibrationCache(cachePath);
		recordObservedContextWindow(cacheA, "codebuddy/a", environment, 80_000);
		recordObservedContextWindow(cacheB, "codebuddy/b", environment, 120_000);

		await saveCalibrationCache(cacheA, cachePath);
		await saveCalibrationCache(cacheB, cachePath);
		const reloaded = loadCalibrationCache(cachePath);
		assert.equal(reloaded.records[buildCalibrationKey("codebuddy/a", environment)].capabilities.contextWindow.latest, 80_000);
		assert.equal(reloaded.records[buildCalibrationKey("codebuddy/b", environment)].capabilities.contextWindow.latest, 120_000);
	});

	it("preserves pending observation floor, latest, and max", () => {
		const environment = {
			internetEnvironment: "default",
			codebuddyConfigDir: "default",
			codebuddyExecutable: "default",
		};
		const failedCandidate = { version: 1, records: {} };
		recordObservedContextWindow(failedCandidate, "codebuddy/foo", environment, 200_000);
		recordObservedContextWindow(failedCandidate, "codebuddy/foo", environment, 100_000);
		const pendingMetric = failedCandidate.records[
			buildCalibrationKey("codebuddy/foo", environment)
		].capabilities.contextWindow;
		const retryCandidate = { version: 1, records: {} };
		mergeContextWindowMetric(retryCandidate, "codebuddy/foo", environment, pendingMetric);
		recordObservedContextWindow(retryCandidate, "codebuddy/foo", environment, 150_000);

		assert.deepEqual(retryCandidate.records[
			buildCalibrationKey("codebuddy/foo", environment)
		].capabilities.contextWindow, {
			floor: 100_000,
			latest: 150_000,
			max: 200_000,
			observedAt: retryCandidate.records[
				buildCalibrationKey("codebuddy/foo", environment)
			].capabilities.contextWindow.observedAt,
		});
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
		recordObservedContextWindow(cache, "codebuddy/foo", environment, 200_000);

		const calibrated = applyContextWindowCalibrations([
			{ id: "codebuddy/foo", contextWindow: 65_536 },
		], cache, environment);
		assert.deepEqual(calibrated, [
			{ id: "codebuddy/foo", contextWindow: 120_000 },
		]);

		recordObservedContextWindow(cache, "codebuddy/foo", environment, 80_000);
		assert.deepEqual(applyContextWindowCalibrations([
			{ id: "codebuddy/foo", contextWindow: 200_000 },
		], cache, environment), [
			{ id: "codebuddy/foo", contextWindow: 80_000 },
		]);
	});

	it("ignores malformed cache records instead of throwing", () => {
		const cachePath = tempFile("malformed-cache.json");
		const environment = {
			internetEnvironment: "default",
			codebuddyConfigDir: "default",
			codebuddyExecutable: "default",
		};
		const key = buildCalibrationKey("codebuddy/foo", environment);
		writeFileSync(cachePath, JSON.stringify({
			version: 1,
			records: {
				[key]: { modelId: "codebuddy/foo", environment },
			},
		}));

		const cache = loadCalibrationCache(cachePath);
		assert.deepEqual(cache.records, {});
		assert.deepEqual(applyContextWindowCalibrations([
			{ id: "codebuddy/foo", contextWindow: 65_536 },
		], cache, environment), [
			{ id: "codebuddy/foo", contextWindow: 65_536 },
		]);
	});
});

describe("calibration validation and transactions", () => {
	it("keeps valid records when one record is malformed", () => {
		const path = tempFile("mixed-cache.json");
		const environment = { internetEnvironment: "default", codebuddyConfigDir: "default", codebuddyExecutable: "default" };
		const goodKey = buildCalibrationKey("codebuddy/good", environment);
		const badKey = buildCalibrationKey("codebuddy/bad", environment);
		writeFileSync(path, JSON.stringify({
			version: 1,
			records: {
				[goodKey]: {
					modelId: "codebuddy/good",
					environment,
					capabilities: { contextWindow: { floor: 10, latest: 20, max: 30, observedAt: new Date().toISOString() } },
				},
				[badKey]: {
					modelId: "codebuddy/bad",
					environment: { ...environment, codebuddyExecutable: "" },
					capabilities: { contextWindow: { floor: NaN, latest: 2, max: 3, observedAt: "bad" } },
				},
			},
		}));
		const cache = loadCalibrationCache(path);
		assert.equal(cache.records[goodKey].capabilities.contextWindow.floor, 10);
		assert.equal(cache.records[badKey], undefined);
	});

	it("rejects non-finite observations before they enter the cache", () => {
		const cache = { version: 1, records: {} };
		const environment = { internetEnvironment: "default", codebuddyConfigDir: "default", codebuddyExecutable: "default" };
		assert.throws(() => recordObservedContextWindow(cache, "codebuddy/foo", environment, Number.NaN), /finite positive/);
		assert.throws(() => recordObservedContextWindow(cache, "codebuddy/foo", environment, Infinity), /finite positive/);
		assert.deepEqual(cache.records, {});
	});

	it("merges concurrent observations without losing keys", async () => {
		const path = tempFile("transaction-cache.json");
		const environment = { internetEnvironment: "default", codebuddyConfigDir: "default", codebuddyExecutable: "default" };
		const empty = loadCalibrationCache(path);
		const results = await Promise.all([
			updateObservedContextWindow(path, "codebuddy/a", environment, 80_000, empty),
			updateObservedContextWindow(path, "codebuddy/b", environment, 120_000, empty),
			updateObservedContextWindow(path, "codebuddy/a", environment, 200_000, empty),
		]);
		assert.equal(results.every((result) => result.persisted), true);
		const cache = loadCalibrationCache(path);
		assert.equal(cache.records[buildCalibrationKey("codebuddy/a", environment)].capabilities.contextWindow.floor, 80_000);
		assert.equal(cache.records[buildCalibrationKey("codebuddy/a", environment)].capabilities.contextWindow.max, 200_000);
		assert.equal(cache.records[buildCalibrationKey("codebuddy/b", environment)].capabilities.contextWindow.latest, 120_000);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 1);
	});

	it("supports two child processes writing different keys", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codebuddy-calibration-workers-"));
		tempDirs.push(dir);
		const path = join(dir, "cache.json");
		const barrier = join(dir, "barrier");
		const ready = [join(dir, "ready-a"), join(dir, "ready-b")];
		const workerPath = join(process.cwd(), "tests", "fixtures", "model-calibration-worker.mjs");
		const workers = ["codebuddy/a", "codebuddy/b"].map((modelId, index) => new Promise((resolve, reject) => {
			const child = spawn(process.execPath, ["--import", "tsx", workerPath, path, modelId, String(index + 1), ready[index], barrier], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (data) => { stderr += data; });
			child.on("error", reject);
			child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `worker ${code}`)));
		}));
		const deadline = Date.now() + 60_000;
		while (!ready.every((file) => existsSync(file))) {
			if (Date.now() > deadline) throw new Error("timed out waiting for calibration workers");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		writeFileSync(barrier, "go\n");
		await Promise.all(workers);
		const environment = { internetEnvironment: "default", codebuddyConfigDir: "default", codebuddyExecutable: "default" };
		const cache = loadCalibrationCache(path);
		assert.equal(cache.records[buildCalibrationKey("codebuddy/a", environment)].capabilities.contextWindow.latest, 1);
		assert.equal(cache.records[buildCalibrationKey("codebuddy/b", environment)].capabilities.contextWindow.latest, 2);
	});

	it("keeps the runtime monotonic when the calibration lock cannot be acquired", async () => {
		const path = tempFile("locked-cache.json");
		const environment = { internetEnvironment: "default", codebuddyConfigDir: "default", codebuddyExecutable: "default" };
		writeFileSync(path, JSON.stringify({ version: 1, records: {} }));

		await calibrationTest.withCalibrationLock(path, async () => {
			const result = await updateObservedContextWindow(
				path,
				"codebuddy/locked",
				environment,
				120_000,
				loadCalibrationCache(path),
				{ timing: { stale: 200, update: 100 } },
			);
			assert.equal(result.persisted, false);
			assert.equal(result.record.capabilities.contextWindow.floor, 120_000);
			assert.deepEqual(loadCalibrationCache(path).records, {});
		}, { stale: 200, update: 100 });
	});
});
