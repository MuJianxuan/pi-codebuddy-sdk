import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
	loadConfig,
	loadEffectiveConfig,
	loadGlobalConfig,
	loadProjectConfig,
	mergeConfig,
} from "../src/config.js";

function withTempHome(fn) {
	const oldHome = process.env.HOME;
	const home = mkdtempSync(join(tmpdir(), "codebuddy-sdk-home-"));
	try {
		process.env.HOME = home;
		return fn(home);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		rmSync(home, { recursive: true, force: true });
	}
}

describe("loadConfig", () => {
	it("rejects a non-object global config without throwing", () => withTempHome((home) => {
		const globalDir = join(home, ".pi", "agent");
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "codebuddy-sdk.json"), "null");

		const result = loadGlobalConfig();
		assert.deepEqual(result.config, {});
		assert.equal(result.diagnostics.length, 1);
		assert.equal(result.diagnostics[0].code, "invalid-top-level");
	}));

	it("rejects array and primitive top-level config values", () => withTempHome((home) => {
		const globalDir = join(home, ".pi", "agent");
		mkdirSync(globalDir, { recursive: true });
		for (const value of ["[]", "42", "true", "\"text\""]) {
			writeFileSync(join(globalDir, "codebuddy-sdk.json"), value);
			const result = loadGlobalConfig();
			assert.deepEqual(result.config, {});
			assert.equal(result.diagnostics[0].code, "invalid-top-level");
		}
	}));

	it("redacts the real home path from config read diagnostics", () => withTempHome((home) => {
		const result = loadGlobalConfig({
			homeDir: () => home,
			exists: () => true,
			read: () => {
				throw new Error(`EACCES: cannot read ${join(home, ".pi", "agent", "codebuddy-sdk.json")}`);
			},
		});
		assert.equal(result.diagnostics[0].code, "parse-error");
		assert.equal(result.diagnostics[0].message.includes(home), false);
		assert.equal(result.diagnostics[0].message.includes("~/.pi/agent/codebuddy-sdk.json"), true);
	}));

	it("does not echo malformed JSON content in diagnostics", () => withTempHome((home) => {
		const globalDir = join(home, ".pi", "agent");
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "codebuddy-sdk.json"), "SECRET_SENTINEL");

		const result = loadGlobalConfig();
		assert.equal(result.diagnostics[0].code, "parse-error");
		assert.equal(result.diagnostics[0].message.includes("SECRET_SENTINEL"), false);
		assert.equal(result.diagnostics[0].message.includes("invalid JSON"), true);
	}));

	it("isolates invalid config sections and keeps valid sections", () => withTempHome((home) => {
		const globalDir = join(home, ".pi", "agent");
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "codebuddy-sdk.json"), JSON.stringify({
			askCodebuddy: null,
			provider: [],
			futureSection: { enabled: true },
		}));

		const result = loadGlobalConfig();
		assert.deepEqual(result.config, { futureSection: { enabled: true } });
		assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
			"invalid-section",
			"invalid-section",
		]);
	}));

	it("isolates invalid known fields without dropping valid fields", () => withTempHome((home) => {
		const globalDir = join(home, ".pi", "agent");
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "codebuddy-sdk.json"), JSON.stringify({
			askCodebuddy: { name: 42, label: "Valid label", defaultMode: "invalid" },
			provider: { appendSystemPrompt: "yes", settingSources: ["user", "invalid"], pathToCodebuddyCode: 7 },
		}));

		const result = loadGlobalConfig();
		assert.deepEqual(result.config, {
			askCodebuddy: { label: "Valid label" },
			provider: {},
		});
		assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
			"invalid-field",
			"invalid-field",
			"invalid-field",
			"invalid-field",
			"invalid-field",
		]);
	}));

	it("merges project keys but keeps the executable global-only", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-project-"));
		try {
			const globalDir = join(home, ".pi", "agent");
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "codebuddy-sdk.json"), JSON.stringify({
				provider: {
					appendSystemPrompt: false,
					settingSources: ["user", "local"],
					pathToCodebuddyCode: "/trusted/codebuddy",
				},
				askCodebuddy: { enabled: true, label: "Global label" },
			}));
			writeFileSync(join(projectDir, "codebuddy-sdk.json"), JSON.stringify({
				provider: {
					appendSystemPrompt: true,
					settingSources: ["project"],
					pathToCodebuddyCode: "/project/codebuddy",
				},
				askCodebuddy: { label: "Project label" },
			}));

			const globalResult = loadGlobalConfig();
			const projectResult = loadProjectConfig(cwd);
			const merged = mergeConfig(globalResult.config, projectResult.config);

			assert.deepEqual(merged.config, {
				provider: {
					appendSystemPrompt: true,
					settingSources: ["project"],
					pathToCodebuddyCode: "/trusted/codebuddy",
				},
				askCodebuddy: { enabled: true, label: "Project label" },
			});
			assert.deepEqual(merged.diagnostics.map((diagnostic) => diagnostic.code), [
				"project-executable-ignored",
			]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("does not read project config content before authorization", () => withTempHome((home) => {
		const cwd = join(home, "project");
		let projectReads = 0;
		const system = {
			homeDir: () => home,
			exists: () => true,
			read: () => {
				projectReads++;
				return "{malformed";
			},
		};
		const globalResult = {
			config: { provider: { appendSystemPrompt: false } },
			diagnostics: [],
		};
		const denied = loadEffectiveConfig(globalResult, cwd, false, system);
		assert.deepEqual(denied.config, globalResult.config);
		assert.deepEqual(denied.diagnostics, globalResult.diagnostics);
		assert.equal(projectReads, 0);

		const allowed = loadEffectiveConfig(globalResult, cwd, true, system);
		assert.equal(projectReads, 1);
		assert.equal(allowed.diagnostics.some((diagnostic) => (
			diagnostic.source === "project" && diagnostic.code === "parse-error"
		)), true);
	}));
	it("keeps the compatibility loader global-only without authorization", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-project-"));
		try {
			const configDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "codebuddy-sdk.json"), JSON.stringify({
				provider: { plan: "max" },
				askCodebuddy: { enabled: false },
			}));

			assert.deepEqual(loadConfig(cwd), {});
			assert.deepEqual(loadConfig(cwd, true), {
				provider: { plan: "max" },
				askCodebuddy: { enabled: false },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("merges project config over global config", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-project-"));
		try {
			const globalDir = join(home, ".pi", "agent");
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "codebuddy-sdk.json"), JSON.stringify({
				provider: { plan: "pro" },
				askCodebuddy: { enabled: true, defaultMode: "read" },
			}));
			writeFileSync(join(projectDir, "codebuddy-sdk.json"), JSON.stringify({
				provider: { plan: "max" },
				askCodebuddy: { enabled: false },
			}));

			assert.deepEqual(loadConfig(cwd, true), {
				provider: { plan: "max" },
				askCodebuddy: { enabled: false, defaultMode: "read" },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));
});
