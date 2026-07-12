import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
	existsSync,
	mkdirSync,
	realpathSync,
} from "node:fs";
import {
	open,
	readFile,
	rename,
	rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_BASENAME } from "./config.js";

const TRUST_STORE_BASENAME = "codebuddy-sdk-project-trust.json";
const TRUST_STORE_VERSION = 1;

export const PROJECT_CONFIG_TRUST_CHOICES = {
	allow: "Allow and remember",
	ignoreRuntime: "Ignore for this runtime",
	deny: "Deny and remember",
} as const;

export type ProjectConfigDecision =
	| "allow"
	| "deny"
	| "ignore-runtime"
	| "no-project-config";

export interface ProjectConfigTrustDiagnostic {
	code: "trust-store-error" | "project-config-unapproved";
	message: string;
}

export interface ProjectConfigAuthorization {
	canonicalCwd: string;
	authorized: boolean;
	decision: ProjectConfigDecision;
	diagnostics: ProjectConfigTrustDiagnostic[];
}

export interface ResolveProjectConfigAuthorizationOptions {
	cwd: string;
	hasUI: boolean;
	select?: (title: string, options: string[]) => Promise<string | undefined>;
}

interface ProjectConfigTrustData {
	version: 1;
	projects: Record<string, boolean>;
}

interface TrustLockTiming {
	stale?: number;
	update?: number;
}

type AssertLockHealthy = () => void;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function trustStorePath(): string {
	return join(homedir(), ".pi", "agent", TRUST_STORE_BASENAME);
}

function safeErrorCode(error: unknown): string {
	if (!error || typeof error !== "object" || !("code" in error)) return "";
	const code = error.code;
	return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : "";
}

function emptyTrustData(): ProjectConfigTrustData {
	return { version: TRUST_STORE_VERSION, projects: {} };
}

async function readTrustData(path: string): Promise<ProjectConfigTrustData> {
	if (!existsSync(path)) return emptyTrustData();
	const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!isPlainObject(parsed) || parsed.version !== TRUST_STORE_VERSION || !isPlainObject(parsed.projects)) {
		throw new Error("expected a version 1 object with a projects object");
	}
	const projects: Record<string, boolean> = {};
	for (const [cwd, decision] of Object.entries(parsed.projects)) {
		if (typeof decision !== "boolean") {
			throw new Error("expected boolean project trust decisions");
		}
		projects[cwd] = decision;
	}
	return { version: TRUST_STORE_VERSION, projects };
}

async function writeTrustDataAtomic(
	path: string,
	data: ProjectConfigTrustData,
	assertLockHealthy: AssertLockHealthy = () => {},
): Promise<void> {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true });
	const sortedProjects = Object.fromEntries(
		Object.entries(data.projects).sort(([left], [right]) => left.localeCompare(right)),
	);
	const tempPath = join(
		directory,
		`.${TRUST_STORE_BASENAME}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
	);
	let fileHandle;
	try {
		assertLockHealthy();
		fileHandle = await open(tempPath, "wx", 0o600);
		await fileHandle.writeFile(`${JSON.stringify({ version: TRUST_STORE_VERSION, projects: sortedProjects }, null, 2)}\n`, "utf8");
		await fileHandle.sync();
		await fileHandle.close();
		fileHandle = undefined;
		assertLockHealthy();
		await rename(tempPath, path);
		try {
			const directoryHandle = await open(directory, "r");
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
		} catch {
			// Directory fsync is not supported on every platform; rename remains atomic.
		}
	} finally {
		if (fileHandle) await fileHandle.close().catch(() => undefined);
		await rm(tempPath, { force: true }).catch(() => undefined);
	}
}

async function withTrustStoreLock<T>(
	path: string,
	operation: (assertLockHealthy: AssertLockHealthy) => Promise<T>,
	timing: TrustLockTiming = {},
): Promise<T> {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true });
	let compromisedError: Error | undefined;
	const release = await lockfile.lock(path, {
		realpath: false,
		lockfilePath: `${path}.lock`,
		stale: timing.stale ?? 10_000,
		update: timing.update ?? 5_000,
		retries: {
			retries: 5,
			factor: 1.5,
			minTimeout: 20,
			maxTimeout: 100,
		},
		onCompromised: (error) => {
			compromisedError = error;
		},
	});
	const assertLockHealthy: AssertLockHealthy = () => {
		if (compromisedError) throw compromisedError;
	};
	let result: T;
	let operationError: unknown;
	try {
		result = await operation(assertLockHealthy);
		assertLockHealthy();
	} catch (error) {
		operationError = error;
	}
	try {
		await release();
	} catch (error) {
		if (!operationError && !compromisedError) operationError = error;
	}
	if (compromisedError) throw compromisedError;
	if (operationError) throw operationError;
	return result!;
}

async function readPersistedDecision(canonicalCwd: string): Promise<boolean | undefined> {
	const path = trustStorePath();
	return withTrustStoreLock(path, async (assertLockHealthy) => {
		const data = await readTrustData(path);
		assertLockHealthy();
		return data.projects[canonicalCwd];
	});
}

async function persistDecision(canonicalCwd: string, decision: boolean): Promise<void> {
	const path = trustStorePath();
	await withTrustStoreLock(path, async (assertLockHealthy) => {
		const data = await readTrustData(path);
		assertLockHealthy();
		data.projects[canonicalCwd] = decision;
		await writeTrustDataAtomic(path, data, assertLockHealthy);
	});
}

// @internal - fault-injection seams for lock/atomic-write contract tests.
export const __test = {
	withTrustStoreLock,
	writeTrustDataAtomic,
};

export function canonicalizeProjectCwd(cwd: string): string {
	try {
		return realpathSync.native(cwd);
	} catch {
		return resolve(cwd);
	}
}

function ignoredAuthorization(
	canonicalCwd: string,
	decision: Exclude<ProjectConfigDecision, "allow">,
	diagnostics: ProjectConfigTrustDiagnostic[] = [],
): ProjectConfigAuthorization {
	return { canonicalCwd, authorized: false, decision, diagnostics };
}

export async function resolveProjectConfigAuthorization(
	options: ResolveProjectConfigAuthorizationOptions,
): Promise<ProjectConfigAuthorization> {
	const canonicalCwd = canonicalizeProjectCwd(options.cwd);
	const projectConfigPath = resolve(canonicalCwd, CONFIG_DIR_NAME, CONFIG_BASENAME);
	if (!existsSync(projectConfigPath)) {
		return ignoredAuthorization(canonicalCwd, "no-project-config");
	}

	let persistedDecision: boolean | undefined;
	try {
		persistedDecision = await readPersistedDecision(canonicalCwd);
	} catch (error) {
		return ignoredAuthorization(canonicalCwd, "ignore-runtime", [{
			code: "trust-store-error",
			message: `codebuddy-sdk: failed to read the project config trust store${safeErrorCode(error)}`,
		}]);
	}
	if (persistedDecision === true) {
		return { canonicalCwd, authorized: true, decision: "allow", diagnostics: [] };
	}
	if (persistedDecision === false) {
		return ignoredAuthorization(canonicalCwd, "deny");
	}
	if (!options.hasUI || !options.select) {
		return ignoredAuthorization(canonicalCwd, "ignore-runtime", [{
			code: "project-config-unapproved",
			message: "codebuddy-sdk: ignored project config because this runtime has no UI and the project has not been approved",
		}]);
	}

	const choice = await options.select(
		"Use this project's CodeBuddy SDK config?",
		[
			PROJECT_CONFIG_TRUST_CHOICES.allow,
			PROJECT_CONFIG_TRUST_CHOICES.ignoreRuntime,
			PROJECT_CONFIG_TRUST_CHOICES.deny,
		],
	);
	if (choice === PROJECT_CONFIG_TRUST_CHOICES.ignoreRuntime || choice === undefined) {
		return ignoredAuthorization(canonicalCwd, "ignore-runtime");
	}

	const allow = choice === PROJECT_CONFIG_TRUST_CHOICES.allow;
	try {
		await persistDecision(canonicalCwd, allow);
	} catch (error) {
		return ignoredAuthorization(canonicalCwd, "ignore-runtime", [{
			code: "trust-store-error",
			message: `codebuddy-sdk: failed to persist the project config trust decision${safeErrorCode(error)}`,
		}]);
	}
	return allow
		? { canonicalCwd, authorized: true, decision: "allow", diagnostics: [] }
		: ignoredAuthorization(canonicalCwd, "deny");
}
