import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	assertSessionIdSegment,
	createSession,
	deleteSession,
	getSessionPath,
} from "../src/cb-session-io.js";

describe("CodeBuddy session path containment", () => {
	it("accepts the SDK-compatible segment grammar", () => {
		for (const id of ["a", "A1", "abc-def", "abc_def", "abc:def", "abc-def_1:2"]) {
			assert.equal(assertSessionIdSegment(id), id);
		}
	});

	it("rejects traversal, absolute, NUL, and overlong ids before filesystem mutation", () => {
		const root = mkdtempSync(join(tmpdir(), "codebuddy-session-path-"));
		const codebuddyDir = join(root, "state");
		try {
			for (const id of ["../escape", "/absolute", "\\\\escape", ".", "..", "a/b", "a\\\\b", "nul\u0000id", "a".repeat(257)]) {
				assert.throws(() => getSessionPath(id, "/project", codebuddyDir), /Invalid CodeBuddy session id/);
				assert.throws(() => deleteSession(id, "/project", codebuddyDir), /Invalid CodeBuddy session id/);
			}
			assert.equal(existsSync(join(root, "escape.jsonl")), false);
			assert.equal(relative(root, codebuddyDir).startsWith(".."), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps JSONL and companion paths below the project directory", () => {
		const root = mkdtempSync(join(tmpdir(), "codebuddy-session-path-"));
		try {
			const session = createSession({ projectPath: "/project", sessionId: "safe:session", codebuddyDir: root });
			session.messages = [{ role: "user", content: "hello" }];
			session.save();
			const projectDir = join(root, "projects", "project");
			assert.equal(session.jsonlPath.startsWith(projectDir), true);
			deleteSession(session.sessionId, "/project", root);
			assert.equal(existsSync(session.jsonlPath), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
