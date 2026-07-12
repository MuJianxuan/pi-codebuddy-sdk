import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");

describe("provider query boundary options", () => {
	it("keeps Pi as the default tool/settings boundary", () => {
		const mcpServers = { custom_tools: { name: "server" } };
		const options = __test.buildProviderQueryOptions({
			providerSettings: {},
			cliModel: "codebuddy-sonnet",
			cwd: "/tmp/project",
			env: { TEST_ENV: "1" },
			systemPrompt: "Pi system prompt",
			mcpServers,
			resumeSessionId: "session-1",
			debugOptions: { debug: true, debugFile: "/tmp/codebuddy.log" },
		});

		assert.deepEqual(options.tools, []);
		assert.equal(options.permissionMode, "bypassPermissions");
		assert.equal(options.includePartialMessages, true);
		assert.equal(options.systemPrompt, "Pi system prompt");
		assert.equal(options.mcpServers, mcpServers);
		assert.equal(options.resume, "session-1");
		assert.deepEqual(options.extraArgs, {
			"strict-mcp-config": null,
			model: "codebuddy-sonnet",
		});
		assert.equal(options.settingSources, undefined);
		assert.equal(options.debug, true);
		assert.equal(options.debugFile, "/tmp/codebuddy.log");
	});

	it("treats appendSystemPrompt=false as the settings compatibility escape hatch", () => {
		const options = __test.buildProviderQueryOptions({
			providerSettings: { appendSystemPrompt: false },
			cliModel: "codebuddy-opus",
			cwd: "/tmp/project",
			env: {},
		});

		assert.deepEqual(options.tools, []);
		assert.deepEqual(options.settingSources, ["user", "project"]);
		assert.deepEqual(options.extraArgs, {
			"strict-mcp-config": null,
			model: "codebuddy-opus",
		});
	});

	it("honors explicit debug/compat escapes without enabling built-in tools", () => {
		const options = __test.buildProviderQueryOptions({
			providerSettings: {
				appendSystemPrompt: false,
				settingSources: ["local"],
				pathToCodebuddyCode: "/opt/codebuddy",
			},
			cliModel: "codebuddy-opus",
			cwd: "/tmp/project",
			env: {},
			codebuddyExecutable: "/opt/codebuddy",
			effort: "high",
		});

		assert.deepEqual(options.tools, []);
		assert.deepEqual(options.settingSources, ["local"]);
		assert.deepEqual(options.extraArgs, {
			"strict-mcp-config": null,
			model: "codebuddy-opus",
		});
		assert.equal(options.pathToCodebuddyCode, "/opt/codebuddy");
		assert.equal(options.effort, "high");
	});

	it("builds model discovery options from the global executable only", () => {
		const options = __test.buildModelDiscoveryOptions(
			{ pathToCodebuddyCode: "/global/codebuddy" },
			"/runtime/project",
		);
		assert.equal(options.pathToCodebuddyCode, "/global/codebuddy");
		assert.equal(options.cwd, "/runtime/project");
		assert.deepEqual(options.tools, []);
		assert.deepEqual(options.settingSources, []);
		assert.equal(options.permissionMode, "bypassPermissions");
	});

	it("excludes every active Ask alias for the invocation cwd", () => {
		const tool = (name) => ({
			name,
			description: `${name} description`,
			parameters: { type: "object", properties: {} },
		});
		const result = __test.resolveMcpTools({
			tools: [tool("AskA"), tool("read"), tool("AskB")],
		}, new Set(["AskA", "AskB"]));

		assert.deepEqual(result.mcpTools.map((entry) => entry.name), ["read"]);
		assert.equal(result.customToolNameToSdk.has("AskA"), false);
		assert.equal(result.customToolNameToSdk.has("AskB"), false);
	});
});
