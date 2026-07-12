import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PROJECT_CONFIG_TRUST_CHOICES,
	resolveProjectConfigAuthorization,
	__test as trustTest,
} from "../src/project-config-trust.js";
import { loadCalibrationCache, saveCalibrationCache } from "../src/model-calibration.js";

async function withTempHome(fn) {
	const oldHome = process.env.HOME;
	const home = mkdtempSync(join(tmpdir(), "codebuddy-sdk-trust-home-"));
	try {
		process.env.HOME = home;
		return await fn(home);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		rmSync(home, { recursive: true, force: true });
	}
}

function runTrustWorker(home, cwd, readyPath, startPath) {
	return new Promise((resolve, reject) => {
		const worker = spawn(process.execPath, [
			"--import",
			"tsx",
			join(process.cwd(), "tests", "fixtures", "project-config-trust-worker.mjs"),
			cwd,
			readyPath,
			startPath,
		], {
			env: { ...process.env, HOME: home },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		worker.stderr.setEncoding("utf8");
		worker.stderr.on("data", (chunk) => { stderr += chunk; });
		worker.on("error", reject);
		worker.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`trust worker exited ${code}: ${stderr}`));
		});
	});
}

async function waitForBarrier(paths) {
	const deadline = Date.now() + 60_000;
	while (!paths.every((path) => existsSync(path))) {
		if (Date.now() > deadline) throw new Error("timed out waiting for trust workers");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("project config authorization", () => {
	it("does not prompt when the project has no CodeBuddy config", () => withTempHome(async () => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-trust-project-"));
		let promptCount = 0;
		try {
			const result = await resolveProjectConfigAuthorization({
				cwd,
				hasUI: true,
				select: async () => {
					promptCount++;
					return undefined;
				},
			});

			assert.equal(result.authorized, false);
			assert.equal(result.decision, "no-project-config");
			assert.equal(promptCount, 0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("warns and ignores an unapproved project config without UI", () => withTempHome(async () => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-trust-project-"));
		try {
			const configDir = join(cwd, ".pi");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "codebuddy-sdk.json"), "{}");

			const result = await resolveProjectConfigAuthorization({ cwd, hasUI: false });
			assert.equal(result.authorized, false);
			assert.equal(result.decision, "ignore-runtime");
			assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
				"project-config-unapproved",
			]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("persists an allow decision for later runtimes without UI", () => withTempHome(async (home) => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-trust-project-"));
		try {
			const configDir = join(cwd, ".pi");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "codebuddy-sdk.json"), "{}");

			const first = await resolveProjectConfigAuthorization({
				cwd,
				hasUI: true,
				select: async () => PROJECT_CONFIG_TRUST_CHOICES.allow,
			});
			assert.equal(first.authorized, true);
			assert.equal(first.decision, "allow");

			const persisted = JSON.parse(readFileSync(
				join(home, ".pi", "agent", "codebuddy-sdk-project-trust.json"),
				"utf8",
			));
			assert.equal(persisted.version, 1);
			assert.equal(persisted.projects[first.canonicalCwd], true);

			const second = await resolveProjectConfigAuthorization({ cwd, hasUI: false });
			assert.equal(second.authorized, true);
			assert.equal(second.decision, "allow");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("uses one persisted decision for canonical cwd aliases", () => withTempHome(async () => {
		const parent = mkdtempSync(join(tmpdir(), "codebuddy-sdk-trust-alias-"));
		const cwd = join(parent, "project");
		const alias = join(parent, "project-link");
		try {
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "codebuddy-sdk.json"), "{}");
			symlinkSync(cwd, alias, "dir");
			const first = await resolveProjectConfigAuthorization({
				cwd,
				hasUI: true,
				select: async () => PROJECT_CONFIG_TRUST_CHOICES.allow,
			});
			const second = await resolveProjectConfigAuthorization({ cwd: alias, hasUI: false });
			assert.equal(second.authorized, true);
			assert.equal(second.canonicalCwd, first.canonicalCwd);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	}));

	it("persists a deny decision and does not prompt later runtimes", () => withTempHome(async () => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-trust-project-"));
		try {
			const configDir = join(cwd, ".pi");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "codebuddy-sdk.json"), "{}");
			const first = await resolveProjectConfigAuthorization({
				cwd,
				hasUI: true,
				select: async () => PROJECT_CONFIG_TRUST_CHOICES.deny,
			});
			let promptCount = 0;
			const second = await resolveProjectConfigAuthorization({
				cwd,
				hasUI: true,
				select: async () => {
					promptCount++;
					return PROJECT_CONFIG_TRUST_CHOICES.allow;
				},
			});
			assert.equal(first.decision, "deny");
			assert.equal(second.decision, "deny");
			assert.equal(second.authorized, false);
			assert.equal(promptCount, 0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("fails closed when the trust store is corrupt", () => withTempHome(async (home) => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-trust-project-"));
		try {
			const configDir = join(cwd, ".pi");
			const agentDir = join(home, ".pi", "agent");
			mkdirSync(configDir, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(join(configDir, "codebuddy-sdk.json"), "{}");
			writeFileSync(join(agentDir, "codebuddy-sdk-project-trust.json"), "SECRET_SENTINEL");
			let promptCount = 0;
			const result = await resolveProjectConfigAuthorization({
				cwd,
				hasUI: true,
				select: async () => {
					promptCount++;
					return PROJECT_CONFIG_TRUST_CHOICES.allow;
				},
			});
			assert.equal(result.authorized, false);
			assert.equal(promptCount, 0);
			assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["trust-store-error"]);
			assert.equal(result.diagnostics[0].message.includes("SECRET_SENTINEL"), false);
			assert.equal(readFileSync(join(agentDir, "codebuddy-sdk-project-trust.json"), "utf8"), "SECRET_SENTINEL");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("contains a compromised lock and preserves the previous JSON", () => withTempHome(async (home) => {
		const storePath = join(home, ".pi", "agent", "codebuddy-sdk-project-trust.json");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		const oldContent = `${JSON.stringify({ version: 1, projects: { "/old": true } }, null, 2)}\n`;
		writeFileSync(storePath, oldContent);

		await assert.rejects(
			trustTest.withTrustStoreLock(
				storePath,
				async (assertHealthy) => {
					rmSync(`${storePath}.lock`, { recursive: true, force: true });
					await new Promise((resolve) => setTimeout(resolve, 1_300));
					await trustTest.writeTrustDataAtomic(
						storePath,
						{ version: 1, projects: { "/new": true } },
						assertHealthy,
					);
				},
				{ stale: 2_000, update: 1_000 },
			),
			(error) => error?.code === "ECOMPROMISED",
		);
		assert.equal(readFileSync(storePath, "utf8"), oldContent);
	}));

	it("keeps trust and calibration lock ownership independent", () => withTempHome(async (home) => {
		const agentDir = join(home, ".pi", "agent");
		const trustPath = join(agentDir, "codebuddy-sdk-project-trust.json");
		const calibrationPath = join(agentDir, "codebuddy-sdk-model-calibration.json");
		await trustTest.withTrustStoreLock(trustPath, async (assertHealthy) => {
			const calibration = loadCalibrationCache(calibrationPath);
			await saveCalibrationCache(calibration, calibrationPath);
			assertHealthy();
		});
		assert.equal(existsSync(`${trustPath}.lock`), false);
		assert.equal(existsSync(`${calibrationPath}.lock`), false);
	}));

	it("preserves concurrent decisions from separate processes", () => withTempHome(async (home) => {
		const cwdA = mkdtempSync(join(tmpdir(), "codebuddy-sdk-trust-project-a-"));
		const cwdB = mkdtempSync(join(tmpdir(), "codebuddy-sdk-trust-project-b-"));
		try {
			for (const cwd of [cwdA, cwdB]) {
				const configDir = join(cwd, ".pi");
				mkdirSync(configDir, { recursive: true });
				writeFileSync(join(configDir, "codebuddy-sdk.json"), "{}");
			}
			const barrierDir = join(home, "trust-worker-barrier");
			const readyA = join(barrierDir, "ready-a");
			const readyB = join(barrierDir, "ready-b");
			const start = join(barrierDir, "start");
			mkdirSync(barrierDir, { recursive: true });
			const workerA = runTrustWorker(home, cwdA, readyA, start);
			const workerB = runTrustWorker(home, cwdB, readyB, start);
			await waitForBarrier([readyA, readyB]);
			writeFileSync(start, "go\n");
			await Promise.all([workerA, workerB]);
			const persisted = JSON.parse(readFileSync(
				join(home, ".pi", "agent", "codebuddy-sdk-project-trust.json"),
				"utf8",
			));
			assert.equal(Object.keys(persisted.projects).length, 2);
			assert.deepEqual(Object.values(persisted.projects), [true, true]);
		} finally {
			rmSync(cwdA, { recursive: true, force: true });
			rmSync(cwdB, { recursive: true, force: true });
		}
	}));
});
