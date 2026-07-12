// Status-line rendering helpers for the AskCodebuddy tool.
//
// While CodeBuddy runs inside an AskCodebuddy call, the pi TUI can't surface
// each tool_use individually — there's only one status row for the whole
// delegation. These helpers shape a tool_use record into a short, path-aware
// label and collapse runs of the same tool so the line doesn't flicker. Shell
// commands are intentionally represented by a fixed verb: action summaries are
// persisted in Pi tool results and must never contain raw command payloads.
// Used only by
// promptAndWait; the provider path exposes tools directly through pi's TUI
// and doesn't need this.

import { stripVTControlCharacters } from "node:util";

export interface ToolCallState {
	name: string;
	status: string;
	rawInput?: unknown;
}

export const ACTION_LABEL_MAX_LENGTH = 80;
export const ACTION_SUMMARY_MAX_LENGTH = 240;

export function sanitizeActionLabel(value: unknown, maxLength = ACTION_LABEL_MAX_LENGTH): string {
	const sanitized = stripVTControlCharacters(String(value ?? ""))
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (sanitized.length <= maxLength) return sanitized;
	return `${sanitized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function extractPath(rawInput: unknown): string | undefined {
	if (!rawInput || typeof rawInput !== "object") return undefined;
	const input = rawInput as Record<string, unknown>;
	if (typeof input.file_path === "string") return input.file_path;
	if (typeof input.path === "string") return input.path;
	return undefined;
}

export function shortPath(p: string): string {
	const cwd = process.cwd();
	if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
	if (p.startsWith("/")) {
		const parts = p.split("/");
		if (parts.length > 3) return parts.slice(-2).join("/");
	}
	return p;
}

export function formatToolAction(tc: ToolCallState): string | undefined {
	const safeName = sanitizeActionLabel(tc.name);
	const path = extractPath(tc.rawInput);
	const verb = safeName.toLowerCase().split(/\s/)[0];
	const safePath = path ? sanitizeActionLabel(shortPath(path)) : "";
	if (verb === "read" || verb === "readfile") {
		return safePath ? sanitizeActionLabel(`Read(${safePath})`) : "Read";
	} else if (verb === "glob") {
		const input = tc.rawInput as Record<string, unknown> | undefined;
		const pat = typeof input?.pattern === "string" ? sanitizeActionLabel(input.pattern, 40) : "";
		return pat ? sanitizeActionLabel(`Glob(${pat})`) : "Glob";
	} else if (verb === "edit" || verb === "write" || verb === "writefile" || verb === "multiedit") {
		return safePath ? sanitizeActionLabel(`Edit(${safePath})`) : "Edit";
	} else if (verb === "bashoutput") {
		return undefined; // redundant with preceding Bash call
	} else if (verb === "bash") {
		return "Bash";
	} else if (verb === "powershell") {
		return "PowerShell";
	} else if (verb === "terminal") {
		return "Terminal";
	} else if (verb === "agent") {
		const input = tc.rawInput as Record<string, unknown> | undefined;
		const description = sanitizeActionLabel(input?.description, 40);
		return description ? sanitizeActionLabel(`Agent(${description})`) : "Agent";
	} else if (verb === "grep") {
		const input = tc.rawInput as Record<string, unknown> | undefined;
		const pat = typeof input?.pattern === "string" ? sanitizeActionLabel(input.pattern, 40) : "";
		return pat ? sanitizeActionLabel(`Grep(${pat})`) : "Grep";
	} else if (verb === "skill") {
		const input = tc.rawInput as Record<string, unknown> | undefined;
		const name = typeof input?.skill === "string" ? sanitizeActionLabel(input.skill, 40) : "";
		return name ? sanitizeActionLabel(`Skill(${name})`) : "Skill";
	} else if (verb === "todowrite" || verb === "taskcreate" || verb === "taskupdate") {
		const todos = Array.isArray((tc.rawInput as any)?.todos) ? (tc.rawInput as any).todos : [];
		const current = todos.find((t: any) => t.status === "in_progress") ?? todos.find((t: any) => t.status === "pending");
		const label = current ? sanitizeActionLabel(current.content, 40) : "";
		return label || undefined;
	} else if (verb === "askcodebuddy" || verb === "askclaude") {
		// Recursive — don't show AskCodebuddy in its own action summary
		return undefined;
	}
	return safeName || "Tool";
}

export function buildActionSummary(calls: Map<string, ToolCallState>): string {
	const parts: string[] = [];
	let prevVerb = "";
	for (const [, tc] of calls) {
		const action = formatToolAction(tc);
		if (!action) continue;
		const verb = tc.name.toLowerCase().split(/\s/)[0];
		// Collapse consecutive calls to the same tool — keep only the latest
		if (verb === prevVerb) {
			parts[parts.length - 1] = action;
		} else {
			parts.push(action);
		}
		prevVerb = verb;
	}
	return sanitizeActionLabel(parts.join("; "), ACTION_SUMMARY_MAX_LENGTH);
}
