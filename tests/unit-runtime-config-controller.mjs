import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGlobalConfig } from "../src/config.js";
import { PROJECT_CONFIG_TRUST_CHOICES } from "../src/project-config-trust.js";
import { createRuntimeConfigController } from "../src/runtime-config-controller.js";
import { createRuntimeConfigRegistry } from "../src/runtime-config-registry.js";

async function withTempHome(fn) {
	const oldHome = process.env.HOME;
	const home = mkdtempSync(join(tmpdir(), "codebuddy-sdk-runtime-home-"));
	try {
		process.env.HOME = home;
		return await fn(home);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		rmSync(home, { recursive: true, force: true });
	}
}

describe("runtime config controller", () => {
	it("publishes trusted provider config and freezes Ask config per runtime", () => withTempHome(async (home) => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-runtime-project-"));
		try {
			const globalDir = join(home, ".pi", "agent");
			const projectDir = join(cwd, ".pi");
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "codebuddy-sdk.json"), JSON.stringify({
				provider: {
					appendSystemPrompt: false,
					pathToCodebuddyCode: "/trusted/codebuddy",
				},
				askCodebuddy: { name: "GlobalAsk", label: "Global label" },
			}));
			writeFileSync(join(projectDir, "codebuddy-sdk.json"), JSON.stringify({
				provider: {
					appendSystemPrompt: true,
					pathToCodebuddyCode: "/project/codebuddy",
				},
				askCodebuddy: { name: "ProjectAsk", label: "Project label" },
			}));

			const registry = createRuntimeConfigRegistry();
			const controller = createRuntimeConfigController({
				ownerId: "runtime-owner",
				globalConfig: loadGlobalConfig(),
				registry,
				streamSimple: () => "stream",
			});
			let askSnapshot;
			const result = await controller.start({
				cwd,
				sessionId: "pi-session",
				hasUI: true,
				select: async () => PROJECT_CONFIG_TRUST_CHOICES.allow,
				registerAsk: (config) => {
					askSnapshot = config;
					return config.askCodebuddy?.name;
				},
			});

			assert.equal(result.projectAuthorized, true);
			assert.equal(askSnapshot.askCodebuddy.name, "ProjectAsk");
			assert.equal(askSnapshot.askCodebuddy.label, "Project label");
			assert.equal(askSnapshot.provider.pathToCodebuddyCode, "/trusted/codebuddy");
			const route = registry.resolveSession("pi-session");
			assert.equal(route.provider.appendSystemPrompt, true);
			assert.equal(route.provider.pathToCodebuddyCode, "/trusted/codebuddy");
			assert.deepEqual([...route.askAliases], ["ProjectAsk"]);

			controller.shutdown();
			assert.equal(registry.resolveSession("pi-session"), undefined);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("remembers an ignore decision only for the current runtime controller", () => withTempHome(async () => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-runtime-project-"));
		try {
			const projectDir = join(cwd, ".pi");
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(projectDir, "codebuddy-sdk.json"), "{}");
			const registry = createRuntimeConfigRegistry();
			const controller = createRuntimeConfigController({
				ownerId: "runtime-owner",
				globalConfig: loadGlobalConfig(),
				registry,
				streamSimple: () => "stream",
			});
			let promptCount = 0;
			const startOptions = {
				cwd,
				sessionId: "pi-session",
				hasUI: true,
				select: async () => {
					promptCount++;
					return PROJECT_CONFIG_TRUST_CHOICES.ignoreRuntime;
				},
				registerAsk: () => "AskCodebuddy",
			};

			await controller.start(startOptions);
			await controller.start(startOptions);
			assert.equal(promptCount, 1);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("does not pollute an existing route when same-session takeover fails", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-runtime-project-"));
		const registry = createRuntimeConfigRegistry();
		const controllerA = createRuntimeConfigController({
			ownerId: "owner-a",
			globalConfig: {
				config: { provider: { appendSystemPrompt: false }, askCodebuddy: { name: "AskA" } },
				diagnostics: [],
			},
			registry,
			streamSimple: () => "stream-a",
		});
		const controllerB = createRuntimeConfigController({
			ownerId: "owner-b",
			globalConfig: {
				config: { provider: { appendSystemPrompt: true }, askCodebuddy: { name: "AskB" } },
				diagnostics: [],
			},
			registry,
			streamSimple: () => "stream-b",
		});
		let askBCalls = 0;
		try {
			await controllerA.start({
				cwd,
				sessionId: "pi-session",
				hasUI: false,
				registerAsk: () => "AskA",
			});
			await assert.rejects(
				controllerB.start({
					cwd,
					sessionId: "pi-session",
					hasUI: false,
					registerAsk: () => {
						askBCalls++;
						return "AskB";
					},
				}),
				/already owned by another extension runtime/,
			);
			const route = registry.resolveSession("pi-session");
			assert.equal(route.provider.appendSystemPrompt, false);
			assert.deepEqual([...route.askAliases], ["AskA"]);
			assert.equal(askBCalls, 0);
		} finally {
			controllerA.shutdown();
			controllerB.shutdown();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
