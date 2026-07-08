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
				strictMcpConfig: false,
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
		assert.deepEqual(options.extraArgs, { model: "codebuddy-opus" });
		assert.equal(options.pathToCodebuddyCode, "/opt/codebuddy");
		assert.equal(options.effort, "high");
	});
});
