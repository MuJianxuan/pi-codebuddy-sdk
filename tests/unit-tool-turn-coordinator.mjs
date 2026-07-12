import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolTurnCoordinator } from "../src/tool-turn-coordinator.js";

function createCoordinator(events = [], options = {}) {
	return new ToolTurnCoordinator({ ...options, emit: (event) => events.push(event) });
}

describe("ToolTurnCoordinator", () => {
	it("buffers stream facts until permission and emits one start/end pair", () => {
		const events = [];
		const coordinator = createCoordinator(events);
		coordinator.observeStreamStart("id-1", "read", {});
		coordinator.observeStreamArgs("id-1", { path: "README.md" }, true);
		assert.deepEqual(events, []);
		assert.deepEqual(coordinator.recordPermissionDecision("id-1", "read", "allow"), {
			behavior: "allow", retryable: false,
		});
		assert.deepEqual(events.map(({ type, toolUseId }) => [type, toolUseId]), [
			["toolcall_start", "id-1"],
			["toolcall_end", "id-1"],
		]);
		assert.deepEqual(coordinator.finishTurn().committedIds, ["id-1"]);
	});

	it("is order-independent when permission arrives before stream", () => {
		const events = [];
		const coordinator = createCoordinator(events);
		coordinator.recordPermissionDecision("id-1", "read", "allow", undefined, { path: "a" });
		coordinator.observeStreamStart("id-1", "read", {});
		assert.deepEqual(events.map(({ type }) => type), ["toolcall_start", "toolcall_end"]);
	});

	it("binds an MCP dispatch that arrived before the stream", () => {
		const events = [];
		const coordinator = createCoordinator(events);
		assert.equal(coordinator.observeDispatch("bash", { command: "ls" }), undefined);
		assert.equal(coordinator.observeStreamStart("id-1", "bash", {}), "allow");
		assert.equal(coordinator.getToolIdForDispatch("bash"), undefined);
		assert.deepEqual(events.map(({ type }) => type), ["toolcall_start", "toolcall_end"]);
	});

	it("uses FIFO matching for same-name dispatches", () => {
		const coordinator = createCoordinator();
		coordinator.observeStreamStart("id-1", "read", {});
		coordinator.observeStreamStart("id-2", "read", {});
		assert.equal(coordinator.observeDispatch("read", { path: "a" }), "id-1");
		assert.equal(coordinator.observeDispatch("read", { path: "b" }), "id-2");
	});

	it("denies empty required args without consuming the serial slot", () => {
		const coordinator = createCoordinator([], { hasRequiredArgs: (name) => name === "bash" });
		const empty = coordinator.recordPermissionDecision("bad", "bash", "allow", undefined, {});
		assert.deepEqual(empty, { behavior: "deny", retryable: true, reason: "empty-required-args" });
		const valid = coordinator.recordPermissionDecision("good", "bash", "allow", undefined, { command: "ls" });
		assert.deepEqual(valid, { behavior: "allow", retryable: false });
		assert.deepEqual(coordinator.snapshot().allowedIds, ["good"]);
	});

	it("can reauthorize a retryable empty-args denial for the same id", () => {
		const events = [];
		const coordinator = createCoordinator(events, { hasRequiredArgs: (name) => name === "bash" });
		const empty = coordinator.recordPermissionDecision("retry-id", "bash", "deny", "empty-required-args", {});
		assert.deepEqual(empty, { behavior: "deny", retryable: true, reason: "empty-required-args" });

		const valid = coordinator.recordPermissionDecision("retry-id", "bash", "allow", undefined, { command: "ls" });
		assert.deepEqual(valid, { behavior: "allow", retryable: false });
		assert.deepEqual(coordinator.snapshot().allowedIds, ["retry-id"]);
		assert.deepEqual(events.map(({ type, toolUseId }) => [type, toolUseId]), [
			["toolcall_start", "retry-id"],
			["toolcall_end", "retry-id"],
		]);
	});

	it("applies required-args and serial gates to implicit dispatch permission", () => {
		const coordinator = createCoordinator([], { hasRequiredArgs: (name) => name === "bash" });
		coordinator.observeStreamStart("read-id", "read", {});
		coordinator.observeStreamStart("bash-id", "bash", {});

		assert.equal(coordinator.observeDispatch("bash", { command: "ls" }), "bash-id");
		assert.equal(coordinator.observeDispatch("read", { path: "a.txt" }), "read-id");
		assert.deepEqual(coordinator.snapshot().allowedIds, ["bash-id"]);
		assert.deepEqual(coordinator.snapshot().deniedIds, ["read-id"]);

		const required = createCoordinator([], { hasRequiredArgs: (name) => name === "bash" });
		required.observeStreamStart("empty-bash", "bash", {});
		required.observeDispatch("bash", {});
		assert.deepEqual(required.snapshot().deniedIds, ["empty-bash"]);
	});

	it("allows exactly one valid tool and denies the other id", () => {
		const coordinator = createCoordinator();
		assert.equal(coordinator.recordPermissionDecision("id-1", "read", "allow").behavior, "allow");
		assert.deepEqual(coordinator.recordPermissionDecision("id-2", "bash", "allow"), {
			behavior: "deny", retryable: false, reason: "serial-slot-occupied",
		});
		assert.deepEqual(coordinator.snapshot().deniedIds, ["id-2"]);
	});

	it("does not commit denied-only turns and finishes deterministically", () => {
		const coordinator = createCoordinator();
		coordinator.observeStreamStart("id-1", "read", {});
		coordinator.recordPermissionDecision("id-1", "read", "deny", "user-denied");
		const snapshot = coordinator.finishTurn();
		assert.deepEqual(snapshot.committedIds, []);
		assert.deepEqual(snapshot.deniedIds, ["id-1"]);
		assert.deepEqual(snapshot.pendingIds, []);
	});

	it("keeps content indexes contiguous across text and tool content", () => {
		const events = [];
		const coordinator = createCoordinator(events);
		assert.equal(coordinator.allocateContentIndex(), 0);
		coordinator.observeStreamStart("id-1", "read", { path: "a" });
		coordinator.recordPermissionDecision("id-1", "read", "allow");
		coordinator.observeStreamArgs("id-1", { path: "a" }, true);
		assert.deepEqual(events.map((event) => event.contentIndex), [1, 1]);
		assert.equal(coordinator.allocateContentIndex(), 2);
	});

	it("clears pending state on abort", () => {
		const coordinator = createCoordinator();
		coordinator.observeDispatch("read", { path: "a" });
		coordinator.observeStreamStart("id-1", "read", {});
		const snapshot = coordinator.abort();
		assert.equal(snapshot.pendingDispatches, 0);
		assert.deepEqual(snapshot.pendingIds, []);
		assert.deepEqual(snapshot.allowedIds, ["id-1"]);
		assert.deepEqual(snapshot.deniedIds, []);
	});
});
