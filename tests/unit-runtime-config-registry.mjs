import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createProviderDispatcher,
	createRuntimeConfigRegistry,
	getProviderInvocationRoute,
} from "../src/runtime-config-registry.js";

describe("runtime config registry", () => {
	it("routes sessions to owners while sharing the latest provider generation per cwd", () => {
		const registry = createRuntimeConfigRegistry();
		const streamA = () => "stream-a";
		const streamB = () => "stream-b";

		assert.equal(registry.publishProviderConfig("/project", {
			appendSystemPrompt: false,
		}), 1);
		registry.registerOwner({
			ownerId: "owner-a",
			canonicalCwd: "/project",
			sessionId: "session-a",
			askAliases: ["AskA"],
			streamSimple: streamA,
		});

		assert.equal(registry.publishProviderConfig("/project", {
			appendSystemPrompt: true,
		}), 2);
		registry.registerOwner({
			ownerId: "owner-b",
			canonicalCwd: "/project",
			sessionId: "session-b",
			askAliases: ["AskB"],
			streamSimple: streamB,
		});

		assert.equal(registry.hasOwners(), true);

		const routeA = registry.resolveSession("session-a");
		const routeB = registry.resolveSession("session-b");
		assert.equal(routeA.streamSimple, streamA);
		assert.equal(routeB.streamSimple, streamB);
		assert.equal(routeA.generation, 2);
		assert.equal(routeB.generation, 2);
		assert.equal(routeA.provider.appendSystemPrompt, true);
		assert.deepEqual([...routeA.askAliases].sort(), ["AskA", "AskB"]);

		registry.removeOwner("owner-a");
		assert.equal(registry.resolveSession("session-a"), undefined);
		assert.deepEqual([...registry.resolveSession("session-b").askAliases], ["AskB"]);
		registry.removeOwner("owner-b");
		assert.equal(registry.hasOwners(), false);
	});

	it("dispatches through the Pi session id and fails closed for unknown sessions", () => {
		const registry = createRuntimeConfigRegistry();
		const calls = [];
		const stream = (...args) => {
			calls.push(args);
			return "stream-result";
		};
		registry.publishProviderConfig("/project", { appendSystemPrompt: true });
		registry.registerOwner({
			ownerId: "owner",
			canonicalCwd: "/project",
			sessionId: "pi-session",
			askAliases: ["AskCodebuddy"],
			streamSimple: stream,
		});

		const dispatch = createProviderDispatcher(registry);
		assert.equal(dispatch("model", "context", { sessionId: "pi-session" }), "stream-result");
		assert.equal(calls.length, 1);
		const route = getProviderInvocationRoute(calls[0][2]);
		assert.equal(route.canonicalCwd, "/project");
		assert.equal(route.provider.appendSystemPrompt, true);
		assert.deepEqual([...route.askAliases], ["AskCodebuddy"]);
		assert.throws(
			() => dispatch("model", "context", { sessionId: "unknown" }),
			/does not belong to an active CodeBuddy runtime/,
		);
		assert.throws(
			() => dispatch("model", "context", {}),
			/requires a Pi session id/,
		);
	});

	it("resolves direct Pi callbacks from sessionId when no dispatcher envelope exists", () => {
		const registry = createRuntimeConfigRegistry();
		registry.publishProviderConfig("/project", { appendSystemPrompt: true });
		registry.registerOwner({
			ownerId: "owner",
			canonicalCwd: "/project",
			sessionId: "pi-session",
			askAliases: [],
			streamSimple: () => "stream",
		});

		const route = getProviderInvocationRoute({ sessionId: "pi-session" }, registry);
		assert.equal(route.canonicalCwd, "/project");
		assert.equal(route.provider.appendSystemPrompt, true);
	});
});
