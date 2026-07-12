// Pure session-file integrity check. Returns an array of warning strings;
// callers decide how to surface them (debug log, piUI, diagDump, etc.).
// Extracted from index.ts so tests can import without activating the extension.

import { statSync, readFileSync } from "fs";

export function verifyWrittenSession(jsonlPath: string, expectedSessionId: string, expectedRecordCount: number): string[] {
	const warnings: string[] = [];
	let st: { size: number };
	try {
		st = statSync(jsonlPath);
	} catch (e) {
		warnings.push(`file missing after save — path=${jsonlPath} err=${errorMessage(e)}`);
		return warnings;
	}
	let content: string;
	try {
		content = readFileSync(jsonlPath, "utf8");
	} catch (e) {
		warnings.push(`file unreadable — path=${jsonlPath} size=${st.size} err=${errorMessage(e)}`);
		return warnings;
	}
	const lines = content.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length !== expectedRecordCount) {
		warnings.push(`record count mismatch — expected=${expectedRecordCount} actual=${lines.length} path=${jsonlPath} bytes=${Buffer.byteLength(content, "utf8")}`);
	}
	let malformed = false;
	const sessionIds = new Set<unknown>();
	for (let index = 0; index < lines.length; index++) {
		try {
			const record = JSON.parse(lines[index]) as { sessionId?: unknown };
			sessionIds.add(record.sessionId);
			if (record.sessionId !== expectedSessionId) {
				warnings.push(`sessionId drift — expected=${expectedSessionId} line=${index + 1} actual=${String(record.sessionId)}`);
			}
		} catch (e) {
			malformed = true;
			warnings.push(`malformed JSONL — path=${jsonlPath} line=${index + 1} err=${errorMessage(e)}`);
		}
	}
	if (malformed && sessionIds.size === 0) return warnings;
	return warnings;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
	return String(error);
}
