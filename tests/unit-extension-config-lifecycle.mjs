import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodebuddySdkExtension } from "../src/index.js";
import { PROJECT_CONFIG_TRUST_CHOICES } from "../src/project-config-trust.js";
import {
	createProviderDispatcher,
	createRuntimeConfigRegistry,
	getProviderInvocationRoute,
} from "../src/runtime-config-registry.js";
import { buildCalibrationEnvironment, recordObservedContextWindow } from "../src/model-calibration.js";

async function withTempHome(fn) {
	const oldHome = process.env.HOME;
	const home = mkdtempSync(join(tmpdir(), "codebuddy-sdk-extension-home-"));
	try {
		process.env.HOME = home;
		return await fn(home);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		rmSync(home, { recursive: true, force: true });
	}
}

function createFakeExtensionApi(existingTools = []) {
	const handlers = new Map();
	const providers = [];
	const tools = [];
	return {
		api: {
			on(event, handler) {
				handlers.set(event, handler);
			},
			registerProvider(id, provider) {
				providers.push({ id, provider });
			},
			registerTool(tool) {
				tools.push(tool);
			},
			getAllTools() {
				return [...existingTools, ...tools];
			},
		},
		handlers,
		providers,
		tools,
	};
}

describe("extension config lifecycle", () => {
	it("keeps project config inactive until session authorization", () => withTempHome(async (home) => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-extension-project-"));
		try {
			const globalDir = join(home, ".pi", "agent");
			const projectDir = join(cwd, ".pi");
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "codebuddy-sdk.json"), JSON.stringify({
				provider: { pathToCodebuddyCode: "/trusted/codebuddy" },
				askCodebuddy: { name: "GlobalAsk" },
			}));
			writeFileSync(join(projectDir, "codebuddy-sdk.json"), JSON.stringify({
				provider: { pathToCodebuddyCode: "/project/codebuddy" },
				askCodebuddy: { name: "ProjectAsk" },
			}));

			const registry = createRuntimeConfigRegistry();
			const fake = createFakeExtensionApi();
			const extension = createCodebuddySdkExtension({
				runtimeRegistry: registry,
				providerDispatcher: createProviderDispatcher(registry),
				discoverModels: async () => {},
				createOwnerId: () => "test-runtime",
			});
			extension(fake.api);
			assert.equal(fake.tools.length, 0);

			const context = {
				cwd,
				hasUI: false,
				ui: { notify() {} },
				sessionManager: { getSessionId: () => "pi-session" },
			};
			await fake.handlers.get("session_start")({ type: "session_start", reason: "startup" }, context);
			assert.deepEqual(fake.tools.map((tool) => tool.name), ["GlobalAsk"]);
			const route = registry.resolveSession("pi-session");
			assert.equal(route.provider.pathToCodebuddyCode, "/trusted/codebuddy");
			assert.deepEqual([...route.askAliases], ["GlobalAsk"]);

			await fake.handlers.get("session_start")({ type: "session_start", reason: "new" }, context);
			assert.deepEqual(fake.tools.map((tool) => tool.name), ["GlobalAsk"]);
			assert.deepEqual([...registry.resolveSession("pi-session").askAliases], ["GlobalAsk"]);

			await fake.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
			assert.equal(registry.resolveSession("pi-session"), undefined);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("routes the first provider call while project authorization is pending", () => withTempHome(async (home) => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-extension-project-"));
		let resolveSelection;
		const selection = new Promise((resolve) => { resolveSelection = resolve; });
		try {
			const globalDir = join(home, ".pi", "agent");
			const projectDir = join(cwd, ".pi");
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "codebuddy-sdk.json"), JSON.stringify({
				provider: { appendSystemPrompt: false },
			}));
			writeFileSync(join(projectDir, "codebuddy-sdk.json"), JSON.stringify({
				provider: { appendSystemPrompt: true },
			}));

			const registry = createRuntimeConfigRegistry();
			const dispatcher = createProviderDispatcher(registry);
			const observedRoutes = [];
			const fake = createFakeExtensionApi();
			createCodebuddySdkExtension({
				runtimeRegistry: registry,
				providerDispatcher: dispatcher,
				runtimeStream: (_model, _context, options) => {
					observedRoutes.push(getProviderInvocationRoute(options));
					return "stream-result";
				},
				discoverModels: async () => {},
				createOwnerId: () => "pending-auth-runtime",
			})(fake.api);

			const context = {
				cwd,
				hasUI: true,
				ui: {
					select: async () => selection,
					notify() {},
				},
				sessionManager: { getSessionId: () => "pending-auth-session" },
			};
			const startPromise = fake.handlers.get("session_start")({ type: "session_start", reason: "startup" }, context);
			const capturedDispatcher = fake.providers[0].provider.streamSimple;

			assert.equal(capturedDispatcher({}, {}, { sessionId: "pending-auth-session" }), "stream-result");
			assert.equal(observedRoutes[0].provider.appendSystemPrompt, false);

			resolveSelection(PROJECT_CONFIG_TRUST_CHOICES.allow);
			await startPromise;
			assert.equal(registry.resolveSession("pending-auth-session").provider.appendSystemPrompt, true);
			await fake.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("applies approved project keys while keeping the executable global-only", () => withTempHome(async (home) => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-extension-project-"));
		try {
			const globalDir = join(home, ".pi", "agent");
			const projectDir = join(cwd, ".pi");
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "codebuddy-sdk.json"), JSON.stringify({
				provider: { appendSystemPrompt: false, pathToCodebuddyCode: "/trusted/codebuddy" },
				askCodebuddy: { name: "GlobalAsk" },
			}));
			writeFileSync(join(projectDir, "codebuddy-sdk.json"), JSON.stringify({
				provider: { appendSystemPrompt: true, pathToCodebuddyCode: "/project/codebuddy" },
				askCodebuddy: { name: "ProjectAsk" },
			}));

			const registry = createRuntimeConfigRegistry();
			const fake = createFakeExtensionApi();
			createCodebuddySdkExtension({
				runtimeRegistry: registry,
				providerDispatcher: createProviderDispatcher(registry),
				discoverModels: async () => {},
				createOwnerId: () => "approved-runtime",
			})(fake.api);
			const notifications = [];
			const context = {
				cwd,
				hasUI: true,
				ui: {
					select: async () => PROJECT_CONFIG_TRUST_CHOICES.allow,
					notify: (message, type) => notifications.push({ message, type }),
				},
				sessionManager: { getSessionId: () => "approved-session" },
			};
			await fake.handlers.get("session_start")({ type: "session_start", reason: "startup" }, context);

			assert.deepEqual(fake.tools.map((tool) => tool.name), ["ProjectAsk"]);
			const route = registry.resolveSession("approved-session");
			assert.equal(route.provider.appendSystemPrompt, true);
			assert.equal(route.provider.pathToCodebuddyCode, "/trusted/codebuddy");
			assert.equal(notifications.some(({ message }) => message.includes("pathToCodebuddyCode")), true);
			writeFileSync(join(projectDir, "codebuddy-sdk.json"), JSON.stringify({
				provider: { appendSystemPrompt: false, pathToCodebuddyCode: "/project/codebuddy-a" },
				askCodebuddy: { enabled: false, name: "AskA" },
			}));
			await fake.handlers.get("session_start")({
				type: "session_start",
				reason: "new",
			}, {
				...context,
				sessionManager: { getSessionId: () => "approved-session-2" },
			});
			const reboundRoute = registry.resolveSession("approved-session-2");
			assert.equal(reboundRoute.provider.appendSystemPrompt, true);
			assert.deepEqual([...reboundRoute.askAliases], ["ProjectAsk"]);
			await fake.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);

		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("keeps two activations from the same factory independently routed", () => withTempHome(async () => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-extension-project-"));
		try {
			const registry = createRuntimeConfigRegistry();
			const dispatcher = createProviderDispatcher(registry);
			const extension = createCodebuddySdkExtension({
				runtimeRegistry: registry,
				providerDispatcher: dispatcher,
				discoverModels: async () => {},
			});
			const runtimeA = createFakeExtensionApi();
			const runtimeB = createFakeExtensionApi();
			extension(runtimeA.api);
			extension(runtimeB.api);
			assert.equal(runtimeA.providers.length, 1);
			assert.equal(runtimeB.providers.length, 1);
			const contextA = {
				cwd,
				hasUI: false,
				ui: { notify() {} },
				sessionManager: { getSessionId: () => "session-a" },
			};
			const contextB = {
				cwd,
				hasUI: false,
				ui: { notify() {} },
				sessionManager: { getSessionId: () => "session-b" },
			};

			await runtimeA.handlers.get("session_start")({ type: "session_start", reason: "startup" }, contextA);
			await runtimeB.handlers.get("session_start")({ type: "session_start", reason: "startup" }, contextB);
			assert.notEqual(registry.resolveSession("session-a"), undefined);
			assert.notEqual(registry.resolveSession("session-b"), undefined);
			assert.notEqual(
				registry.resolveSession("session-a").streamSimple,
				registry.resolveSession("session-b").streamSimple,
			);

			await runtimeA.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, contextA);
			assert.equal(registry.resolveSession("session-a"), undefined);
			assert.notEqual(registry.resolveSession("session-b"), undefined);

			const reloadedRuntime = createFakeExtensionApi();
			extension(reloadedRuntime.api);
			assert.equal(reloadedRuntime.providers.length, 1);
			const reloadedContext = {
				cwd,
				hasUI: false,
				ui: { notify() {} },
				sessionManager: { getSessionId: () => "session-reloaded" },
			};
			await reloadedRuntime.handlers.get("session_start")(
				{ type: "session_start", reason: "reload" },
				reloadedContext,
			);
			assert.notEqual(registry.resolveSession("session-b"), undefined);
			assert.notEqual(registry.resolveSession("session-reloaded"), undefined);
			await reloadedRuntime.handlers.get("session_shutdown")(
				{ type: "session_shutdown", reason: "quit" },
				reloadedContext,
			);
			await runtimeB.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, contextB);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("binds the current runtime route into compact summarization", () => withTempHome(async (home) => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-extension-project-"));
		try {
			const globalDir = join(home, ".pi", "agent");
			mkdirSync(globalDir, { recursive: true });
			writeFileSync(join(globalDir, "codebuddy-sdk.json"), JSON.stringify({
				provider: { pathToCodebuddyCode: "/trusted/codebuddy" },
			}));
			const registry = createRuntimeConfigRegistry();
			const fake = createFakeExtensionApi();
			let summaryRoute;
			const extension = createCodebuddySdkExtension({
				runtimeRegistry: registry,
				providerDispatcher: createProviderDispatcher(registry),
				discoverModels: async () => {},
				compact: async (...args) => {
					const summaryStream = args[7];
					summaryStream({}, {}, {});
					return { summary: "compact summary" };
				},
				isolatedSummaryStream: (_model, _context, options) => {
					summaryRoute = getProviderInvocationRoute(options);
					return "summary-stream";
				},
			});
			extension(fake.api);
			const context = {
				cwd,
				hasUI: false,
				ui: { notify() {} },
				model: { baseUrl: "codebuddy" },
				sessionManager: { getSessionId: () => "compact-session" },
			};
			await fake.handlers.get("session_start")({ type: "session_start", reason: "startup" }, context);
			const result = await fake.handlers.get("session_before_compact")({
				type: "session_before_compact",
				reason: "manual",
				willRetry: false,
				branchEntries: [],
				preparation: {
					isSplitTurn: false,
					messagesToSummarize: [],
					turnPrefixMessages: [],
					fileOps: { read: new Set(), edited: new Set() },
				},
				signal: new AbortController().signal,
			}, context);

			assert.equal(result.compaction.summary, "compact summary");
			assert.equal(summaryRoute.canonicalCwd, realpathSync.native(cwd));
			assert.equal(summaryRoute.provider.pathToCodebuddyCode, "/trusted/codebuddy");
			await fake.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("warns on the console when Ask collides without UI", () => withTempHome(async (home) => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-extension-project-"));
		const oldWarn = console.warn;
		const warnings = [];
		try {
			const globalDir = join(home, ".pi", "agent");
			mkdirSync(globalDir, { recursive: true });
			writeFileSync(join(globalDir, "codebuddy-sdk.json"), JSON.stringify({
				askCodebuddy: { name: "SECRET_TOOL_ALIAS" },
			}));
			console.warn = (message) => warnings.push(String(message));
			const registry = createRuntimeConfigRegistry();
			const fake = createFakeExtensionApi([{ name: "SECRET_TOOL_ALIAS" }]);
			createCodebuddySdkExtension({
				runtimeRegistry: registry,
				providerDispatcher: createProviderDispatcher(registry),
				discoverModels: async () => {},
			})(fake.api);
			const context = {
				cwd,
				hasUI: false,
				ui: { notify() {} },
				sessionManager: { getSessionId: () => "collision-session" },
			};
			await fake.handlers.get("session_start")({ type: "session_start", reason: "startup" }, context);

			assert.equal(fake.tools.length, 0);
			assert.equal(warnings.some((message) => message.includes("already registered")), true);
			assert.equal(warnings.some((message) => message.includes("SECRET_TOOL_ALIAS")), false);
			assert.deepEqual([...registry.resolveSession("collision-session").askAliases], []);
			await fake.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
		} finally {
			console.warn = oldWarn;
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("keeps the registered Ask alias exact", () => withTempHome(async (home) => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-extension-project-"));
		try {
			const globalDir = join(home, ".pi", "agent");
			mkdirSync(globalDir, { recursive: true });
			writeFileSync(join(globalDir, "codebuddy-sdk.json"), JSON.stringify({
				askCodebuddy: { name: "Review " },
			}));
			const registry = createRuntimeConfigRegistry();
			const fake = createFakeExtensionApi();
			createCodebuddySdkExtension({
				runtimeRegistry: registry,
				providerDispatcher: createProviderDispatcher(registry),
				discoverModels: async () => {},
			})(fake.api);
			const context = {
				cwd,
				hasUI: false,
				ui: { notify() {} },
				sessionManager: { getSessionId: () => "exact-alias-session" },
			};
			await fake.handlers.get("session_start")({ type: "session_start", reason: "startup" }, context);

			assert.deepEqual(fake.tools.map((tool) => tool.name), ["Review "]);
			assert.deepEqual([...registry.resolveSession("exact-alias-session").askAliases], ["Review "]);
			await fake.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("routes different cwd configs through the captured provider dispatcher", () => withTempHome(async (home) => {
		const cwdA = mkdtempSync(join(tmpdir(), "codebuddy-sdk-extension-project-a-"));
		const cwdB = mkdtempSync(join(tmpdir(), "codebuddy-sdk-extension-project-b-"));
		try {
			const globalDir = join(home, ".pi", "agent");
			mkdirSync(globalDir, { recursive: true });
			writeFileSync(join(globalDir, "codebuddy-sdk.json"), JSON.stringify({
				provider: { pathToCodebuddyCode: "/trusted/codebuddy" },
			}));
			for (const [cwd, config] of [
				[cwdA, { provider: { appendSystemPrompt: false, settingSources: ["local"] }, askCodebuddy: { name: "AskA" } }],
				[cwdB, { provider: { appendSystemPrompt: true }, askCodebuddy: { name: "AskB" } }],
			]) {
				mkdirSync(join(cwd, ".pi"), { recursive: true });
				writeFileSync(join(cwd, ".pi", "codebuddy-sdk.json"), JSON.stringify(config));
			}

			const registry = createRuntimeConfigRegistry();
			const dispatcher = createProviderDispatcher(registry);
			const observedRoutes = [];
			const runtimeStream = (_model, _context, options) => {
				observedRoutes.push(getProviderInvocationRoute(options));
				return "stream-result";
			};
			const extension = createCodebuddySdkExtension({
				runtimeRegistry: registry,
				providerDispatcher: dispatcher,
				runtimeStream,
				discoverModels: async () => {},
			});
			const runtimeA = createFakeExtensionApi();
			const runtimeB = createFakeExtensionApi();
			extension(runtimeA.api);
			extension(runtimeB.api);
			const contextFor = (cwd, sessionId) => ({
				cwd,
				hasUI: true,
				ui: { select: async () => PROJECT_CONFIG_TRUST_CHOICES.allow, notify() {} },
				sessionManager: { getSessionId: () => sessionId },
			});
			const contextA = contextFor(cwdA, "session-cwd-a");
			const contextB = contextFor(cwdB, "session-cwd-b");
			await runtimeA.handlers.get("session_start")({ type: "session_start", reason: "startup" }, contextA);
			await runtimeB.handlers.get("session_start")({ type: "session_start", reason: "startup" }, contextB);

			assert.equal(registry.resolveSession("session-cwd-a").streamSimple, runtimeStream);
			assert.equal(registry.resolveSession("session-cwd-b").streamSimple, runtimeStream);
			const capturedDispatcher = runtimeA.providers[0].provider.streamSimple;
			assert.equal(capturedDispatcher({}, {}, { sessionId: "session-cwd-a" }), "stream-result");
			assert.equal(capturedDispatcher({}, {}, { sessionId: "session-cwd-b" }), "stream-result");
			assert.equal(observedRoutes[0].canonicalCwd, realpathSync.native(cwdA));
			assert.equal(observedRoutes[0].provider.appendSystemPrompt, false);
			assert.deepEqual(observedRoutes[0].provider.settingSources, ["local"]);
			assert.deepEqual([...observedRoutes[0].askAliases], ["AskA"]);
			assert.equal(observedRoutes[1].canonicalCwd, realpathSync.native(cwdB));
			assert.equal(observedRoutes[1].provider.appendSystemPrompt, true);
			assert.deepEqual([...observedRoutes[1].askAliases], ["AskB"]);

			await runtimeA.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, contextA);
			await runtimeB.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, contextB);
		} finally {
			rmSync(cwdA, { recursive: true, force: true });
			rmSync(cwdB, { recursive: true, force: true });
		}
	}));

	it("uses the latest provider generation while keeping Ask snapshots per runtime", () => withTempHome(async () => {
		const cwd = mkdtempSync(join(tmpdir(), "codebuddy-sdk-extension-project-"));
		try {
			const projectDir = join(cwd, ".pi");
			const projectConfigPath = join(projectDir, "codebuddy-sdk.json");
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(projectConfigPath, JSON.stringify({
				provider: { appendSystemPrompt: false },
				askCodebuddy: { name: "AskA" },
			}));
			const registry = createRuntimeConfigRegistry();
			const dispatcher = createProviderDispatcher(registry);
			const observedRoutes = [];
			const extension = createCodebuddySdkExtension({
				runtimeRegistry: registry,
				providerDispatcher: dispatcher,
				runtimeStream: (_model, _context, options) => {
					observedRoutes.push(getProviderInvocationRoute(options));
					return "stream-result";
				},
				discoverModels: async () => {},
			});
			const oldRuntime = createFakeExtensionApi();
			extension(oldRuntime.api);
			const oldContext = {
				cwd,
				hasUI: true,
				ui: { select: async () => PROJECT_CONFIG_TRUST_CHOICES.allow, notify() {} },
				sessionManager: { getSessionId: () => "old-session" },
			};
			await oldRuntime.handlers.get("session_start")({ type: "session_start", reason: "startup" }, oldContext);
			assert.deepEqual(oldRuntime.tools.map((tool) => tool.name), ["AskA"]);

			writeFileSync(projectConfigPath, JSON.stringify({
				provider: { appendSystemPrompt: true },
				askCodebuddy: { name: "AskB" },
			}));
			const newRuntime = createFakeExtensionApi();
			extension(newRuntime.api);
			const newContext = {
				cwd,
				hasUI: false,
				ui: { notify() {} },
				sessionManager: { getSessionId: () => "new-session" },
			};
			await newRuntime.handlers.get("session_start")({ type: "session_start", reason: "reload" }, newContext);
			assert.deepEqual(newRuntime.tools.map((tool) => tool.name), ["AskB"]);
			assert.deepEqual(oldRuntime.tools.map((tool) => tool.name), ["AskA"]);

			const capturedDispatcher = newRuntime.providers[0].provider.streamSimple;
			assert.equal(capturedDispatcher({}, {}, { sessionId: "old-session" }), "stream-result");
			assert.equal(capturedDispatcher({}, {}, { sessionId: "new-session" }), "stream-result");
			for (const route of observedRoutes) {
				assert.equal(route.provider.appendSystemPrompt, true);
				assert.deepEqual([...route.askAliases].sort(), ["AskA", "AskB"]);
			}

			await oldRuntime.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, oldContext);
			assert.deepEqual([...registry.resolveSession("new-session").askAliases], ["AskB"]);
			await newRuntime.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, newContext);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("fans discovered models out to every active runner", async () => {
		const registry = createRuntimeConfigRegistry();
		let finishDiscovery;
		const discovery = new Promise((resolve) => { finishDiscovery = resolve; });
		const discoveredModels = [{ id: "discovered-model" }];
		const extension = createCodebuddySdkExtension({
			runtimeRegistry: registry,
			providerDispatcher: createProviderDispatcher(registry),
			discoverModels: async () => discovery,
		});
		const runtimeA = createFakeExtensionApi();
		const runtimeB = createFakeExtensionApi();
		extension(runtimeA.api);
		extension(runtimeB.api);
		assert.equal(runtimeA.providers.length, 1);
		assert.equal(runtimeB.providers.length, 1);

		finishDiscovery(discoveredModels);
		await discovery;
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(runtimeA.providers.at(-1).provider.models.map(({ id }) => id), ["discovered-model"]);
		assert.deepEqual(runtimeB.providers.at(-1).provider.models.map(({ id }) => id), ["discovered-model"]);

		runtimeA.handlers.get("session_shutdown")();
		runtimeB.handlers.get("session_shutdown")();
	});

	it("rediscovers models when one runner reloads while another survives", async () => {
		const registry = createRuntimeConfigRegistry();
		let discoveryCount = 0;
		const extension = createCodebuddySdkExtension({
			runtimeRegistry: registry,
			providerDispatcher: createProviderDispatcher(registry),
			discoverModels: async () => [{ id: `models-${++discoveryCount}` }],
		});
		const runtimeA = createFakeExtensionApi();
		const runtimeB = createFakeExtensionApi();
		extension(runtimeA.api);
		extension(runtimeB.api);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(discoveryCount, 1);

		runtimeA.handlers.get("session_shutdown")();
		const reloadedRuntime = createFakeExtensionApi();
		extension(reloadedRuntime.api);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(discoveryCount, 3);
		assert.deepEqual(runtimeB.providers.at(-1).provider.models.map(({ id }) => id), ["models-3"]);
		assert.deepEqual(reloadedRuntime.providers.at(-1).provider.models.map(({ id }) => id), ["models-3"]);

		runtimeB.handlers.get("session_shutdown")();
		reloadedRuntime.handlers.get("session_shutdown")();
	});

	it("restarts discovery when its owner exits while another runner survives", async () => {
		const registry = createRuntimeConfigRegistry();
		let finishFirstDiscovery;
		const firstDiscovery = new Promise((resolve) => { finishFirstDiscovery = resolve; });
		let discoveryCount = 0;
		const extension = createCodebuddySdkExtension({
			runtimeRegistry: registry,
			providerDispatcher: createProviderDispatcher(registry),
			discoverModels: async () => {
				discoveryCount++;
				return discoveryCount === 1
					? firstDiscovery
					: [{ id: "surviving-runner-model" }];
			},
		});
		const runtimeA = createFakeExtensionApi();
		const runtimeB = createFakeExtensionApi();
		extension(runtimeA.api);
		extension(runtimeB.api);
		assert.equal(discoveryCount, 1);

		runtimeA.handlers.get("session_shutdown")();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(discoveryCount, 2);
		assert.deepEqual(runtimeB.providers.at(-1).provider.models.map(({ id }) => id), ["surviving-runner-model"]);

		finishFirstDiscovery([{ id: "stale-owner-model" }]);
		await firstDiscovery;
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(runtimeB.providers.at(-1).provider.models.map(({ id }) => id), ["surviving-runner-model"]);
		runtimeB.handlers.get("session_shutdown")();
	});

	it("lets a replacement factory supersede survivor discovery", async () => {
		const registry = createRuntimeConfigRegistry();
		const dispatcher = createProviderDispatcher(registry);
		let finishA;
		const discoveryA = new Promise((resolve) => { finishA = resolve; });
		const calls = { A: 0, B: 0, C: 0 };
		const factory = (name, discoverModels) => createCodebuddySdkExtension({
			runtimeRegistry: registry,
			providerDispatcher: dispatcher,
			discoverModels: async () => {
				calls[name]++;
				return discoverModels();
			},
		});
		const extensionA = factory("A", () => discoveryA);
		const extensionB = factory("B", () => [{ id: "models-b" }]);
		const extensionC = factory("C", () => [{ id: "models-c" }]);
		const runtimeA = createFakeExtensionApi();
		const runtimeB = createFakeExtensionApi();
		const runtimeC = createFakeExtensionApi();
		extensionA(runtimeA.api);
		extensionB(runtimeB.api);
		assert.deepEqual(calls, { A: 1, B: 0, C: 0 });

		runtimeA.handlers.get("session_shutdown")();
		extensionC(runtimeC.api);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(calls, { A: 1, B: 1, C: 1 });
		assert.deepEqual(runtimeB.providers.at(-1).provider.models.map(({ id }) => id), ["models-c"]);
		assert.deepEqual(runtimeC.providers.at(-1).provider.models.map(({ id }) => id), ["models-c"]);

		finishA([{ id: "stale-models-a" }]);
		await discoveryA;
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(runtimeB.providers.at(-1).provider.models.map(({ id }) => id), ["models-c"]);
		runtimeB.handlers.get("session_shutdown")();
		runtimeC.handlers.get("session_shutdown")();
	});

	it("applies a lower disk calibration to every active runner", async () => {
		const registry = createRuntimeConfigRegistry();
		const dispatcher = createProviderDispatcher(registry);
		const environment = buildCalibrationEnvironment();
		const cacheWithFloor = (floor) => {
			const cache = { version: 1, records: {} };
			recordObservedContextWindow(cache, "hy3", environment, floor);
			return cache;
		};
		const extensionA = createCodebuddySdkExtension({
			runtimeRegistry: registry,
			providerDispatcher: dispatcher,
			loadCalibrationCache: () => cacheWithFloor(120_000),
			discoverModels: async () => {},
		});
		const extensionB = createCodebuddySdkExtension({
			runtimeRegistry: registry,
			providerDispatcher: dispatcher,
			loadCalibrationCache: () => cacheWithFloor(80_000),
			discoverModels: async () => {},
		});
		const runtimeA = createFakeExtensionApi();
		const runtimeB = createFakeExtensionApi();
		extensionA(runtimeA.api);
		await new Promise((resolve) => setImmediate(resolve));
		extensionB(runtimeB.api);
		await new Promise((resolve) => setImmediate(resolve));

		for (const runtime of [runtimeA, runtimeB]) {
			const model = runtime.providers.at(-1).provider.models.find(({ id }) => id === "hy3");
			assert.equal(model.contextWindow, 80_000);
		}
		runtimeA.handlers.get("session_shutdown")();
		runtimeB.handlers.get("session_shutdown")();
	});

	it("does not let stale discovery raise a shared calibration floor", async () => {
		const registry = createRuntimeConfigRegistry();
		const dispatcher = createProviderDispatcher(registry);
		const environment = buildCalibrationEnvironment();
		const cacheWithFloor = (floor) => {
			const cache = { version: 1, records: {} };
			recordObservedContextWindow(cache, "hy3", environment, floor);
			return cache;
		};
		let finishDiscovery;
		const discovery = new Promise((resolve) => { finishDiscovery = resolve; });
		const extensionA = createCodebuddySdkExtension({
			runtimeRegistry: registry,
			providerDispatcher: dispatcher,
			loadCalibrationCache: () => cacheWithFloor(120_000),
			discoverModels: async () => discovery,
		});
		const extensionB = createCodebuddySdkExtension({
			runtimeRegistry: registry,
			providerDispatcher: dispatcher,
			loadCalibrationCache: () => cacheWithFloor(80_000),
			discoverModels: async () => {},
		});
		const runtimeA = createFakeExtensionApi();
		const runtimeB = createFakeExtensionApi();
		extensionA(runtimeA.api);
		extensionB(runtimeB.api);
		finishDiscovery([{ id: "hy3", contextWindow: 120_000 }]);
		await discovery;
		await new Promise((resolve) => setImmediate(resolve));

		for (const runtime of [runtimeA, runtimeB]) {
			const model = runtime.providers.at(-1).provider.models.find(({ id }) => id === "hy3");
			assert.equal(model.contextWindow, 80_000);
		}
		runtimeA.handlers.get("session_shutdown")();
		runtimeB.handlers.get("session_shutdown")();
	});
});
