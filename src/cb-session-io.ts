// CodeBuddy session JSONL read/write for pi session sync (replaces cc-session-io).
// CodeBuddy stores sessions at ~/.codebuddy/projects/<sanitized-path>/<sessionId>.jsonl

import { randomUUID } from "crypto";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve, sep } from "path";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import { convertPiMessages } from "./convert.js";

export interface CbMessage {
	role: "user" | "assistant";
	content: string;
}

export function getCodebuddyDir(codebuddyDir?: string): string {
	return codebuddyDir ?? process.env.CODEBUDDY_CONFIG_DIR ?? join(homedir(), ".codebuddy");
}

export function normalizeProjectPath(projectPath: string): string {
	return projectPath.replace(/\/+$/, "") || projectPath;
}

export function projectPathToHash(projectPath: string): string {
	return normalizeProjectPath(projectPath).replace(/^\//, "").replace(/\//g, "-");
}

export function getProjectDir(projectPath: string, codebuddyDir?: string): string {
	return join(getCodebuddyDir(codebuddyDir), "projects", projectPathToHash(projectPath));
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:-]*$/;
const SESSION_ID_MAX_LENGTH = 256;

export function assertSessionIdSegment(sessionId: string): string {
	if (
		typeof sessionId !== "string" ||
		sessionId.length === 0 ||
		sessionId.length > SESSION_ID_MAX_LENGTH ||
		!SESSION_ID_PATTERN.test(sessionId) ||
		isAbsolute(sessionId)
	) {
		throw new Error("Invalid CodeBuddy session id");
	}
	return sessionId;
}

function containedPath(base: string, candidate: string): string {
	const resolvedBase = resolve(base);
	const resolvedCandidate = resolve(candidate);
	const remainder = relative(resolvedBase, resolvedCandidate);
	if (remainder === "" || remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
		throw new Error("Session path escaped its project directory");
	}
	return resolvedCandidate;
}

export function getSessionPath(sessionId: string, projectPath: string, codebuddyDir?: string): string {
	assertSessionIdSegment(sessionId);
	const projectDir = getProjectDir(projectPath, codebuddyDir);
	return containedPath(projectDir, join(projectDir, `${sessionId}.jsonl`));
}

export function deleteSession(sessionId: string, projectPath: string, codebuddyDir?: string): void {
	assertSessionIdSegment(sessionId);
	const jsonlPath = getSessionPath(sessionId, projectPath, codebuddyDir);
	const projectDir = getProjectDir(projectPath, codebuddyDir);
	const dir = containedPath(projectDir, join(projectDir, sessionId));
	try { rmSync(jsonlPath, { force: true }); } catch { /* ignore */ }
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function piToCbMessages(messages: PiMessage[]): CbMessage[] {
	const { anthropicMessages } = convertPiMessages(messages);
	const out: CbMessage[] = [];
	for (const msg of anthropicMessages) {
		if (msg.role === "user") {
			const text = typeof msg.content === "string"
				? msg.content
				: msg.content.map((b: any) => b.type === "text" ? b.text : b.type === "tool_result" ? `[tool_result:${b.tool_use_id}]` : `[${b.type}]`).join("\n");
			out.push({ role: "user", content: text });
		} else if (msg.role === "assistant") {
			const text = typeof msg.content === "string"
				? msg.content
				: msg.content.map((b: any) => b.type === "text" ? b.text : b.type === "tool_use" ? `[tool:${b.name}]` : `[${b.type}]`).join("\n");
			out.push({ role: "assistant", content: text });
		}
	}
	return out;
}

function writeCbJsonl(sessionId: string, cwd: string, messages: CbMessage[], codebuddyDir?: string): string {
	const jsonlPath = getSessionPath(sessionId, cwd, codebuddyDir);
	mkdirSync(join(jsonlPath, ".."), { recursive: true });
	const lines: string[] = [];
	let parentId: string | undefined;
	const ts = Date.now();
	for (const msg of messages) {
		const id = randomUUID();
		if (msg.role === "user") {
			lines.push(JSON.stringify({
				id, timestamp: ts, type: "message", role: "user",
				content: [{ type: "input_text", text: msg.content }],
				providerData: { agent: "sdk" }, sessionId, cwd,
			}));
			parentId = id;
		} else {
			lines.push(JSON.stringify({
				id, parentId, timestamp: ts, type: "message", role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: msg.content }],
				providerData: { agent: "sdk" }, sessionId, cwd,
			}));
			parentId = id;
		}
	}
	writeFileSync(jsonlPath, lines.join("\n") + (lines.length ? "\n" : ""));
	return jsonlPath;
}

export class Session {
	readonly sessionId: string;
	readonly projectPath: string;
	readonly codebuddyDir?: string;
	readonly jsonlPath: string;
	messages: CbMessage[] = [];

	constructor(sessionId: string, projectPath: string, codebuddyDir?: string) {
		this.sessionId = assertSessionIdSegment(sessionId);
		this.projectPath = projectPath;
		this.codebuddyDir = codebuddyDir;
		this.jsonlPath = getSessionPath(sessionId, projectPath, codebuddyDir);
	}

	importPiMessages(messages: PiMessage[]): void {
		this.messages = piToCbMessages(messages);
	}

	save(): void {
		writeCbJsonl(this.sessionId, this.projectPath, this.messages, this.codebuddyDir);
	}
}

export interface CreateSessionOptions {
	projectPath: string;
	sessionId?: string;
	model?: string;
	codebuddyDir?: string;
}

export function createSession(opts: CreateSessionOptions): Session {
	const sessionId = opts.sessionId ?? randomUUID();
	return new Session(sessionId, opts.projectPath, opts.codebuddyDir);
}
