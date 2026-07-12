import type { SettingSource } from "./index-types.js";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface ConfigSystemBoundary {
	homeDir(): string;
	exists(path: string): boolean;
	read(path: string): string;
}

const DEFAULT_CONFIG_SYSTEM: ConfigSystemBoundary = {
	homeDir: homedir,
	exists: existsSync,
	read: (path) => readFileSync(path, "utf8"),
};

function redactHome(value: string, home: string): string {
	return home ? value.split(home).join("~") : value;
}

export const CONFIG_BASENAME = "codebuddy-sdk.json";

export interface Config {
	askCodebuddy?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: "full" | "read" | "none";
		defaultIsolated?: boolean;
		allowFullMode?: boolean;
		appendSkills?: boolean;
	};
	provider?: {
		appendSystemPrompt?: boolean;
		settingSources?: SettingSource[];
		pathToCodebuddyCode?: string;
	};
}

export interface ConfigDiagnostic {
	code: "invalid-top-level" | "invalid-section" | "invalid-field" | "parse-error" | "project-executable-ignored";
	source: "global" | "project";
	message: string;
}

export interface ConfigLoadResult {
	config: Config;
	diagnostics: ConfigDiagnostic[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

type FieldValidator = (value: unknown) => boolean;

const ASK_FIELD_VALIDATORS: Record<string, FieldValidator> = {
	enabled: (value) => typeof value === "boolean",
	name: (value) => typeof value === "string",
	label: (value) => typeof value === "string",
	description: (value) => typeof value === "string",
	defaultMode: (value) => value === "full" || value === "read" || value === "none",
	defaultIsolated: (value) => typeof value === "boolean",
	allowFullMode: (value) => typeof value === "boolean",
	appendSkills: (value) => typeof value === "boolean",
};

const PROVIDER_FIELD_VALIDATORS: Record<string, FieldValidator> = {
	appendSystemPrompt: (value) => typeof value === "boolean",
	settingSources: (value) => Array.isArray(value) && value.every((source) => (
		source === "user" || source === "project" || source === "local"
	)),
	pathToCodebuddyCode: (value) => typeof value === "string",
};

function sanitizeConfig(
	parsed: Record<string, unknown>,
	source: "global" | "project",
	path: string,
	home: string,
): ConfigLoadResult {
	const config: Record<string, unknown> = { ...parsed };
	const diagnostics: ConfigDiagnostic[] = [];
	for (const section of ["askCodebuddy", "provider"] as const) {
		if (!Object.prototype.hasOwnProperty.call(parsed, section)) continue;
		const value = parsed[section];
		if (!isPlainObject(value)) {
			delete config[section];
			diagnostics.push({
				code: "invalid-section",
				source,
				message: `codebuddy-sdk: ignored ${source} config section ${section} in ${redactHome(path, home)} because it must be an object`,
			});
			continue;
		}
		const sectionConfig: Record<string, unknown> = { ...value };
		const validators = section === "askCodebuddy"
			? ASK_FIELD_VALIDATORS
			: PROVIDER_FIELD_VALIDATORS;
		for (const [field, validate] of Object.entries(validators)) {
			if (!Object.prototype.hasOwnProperty.call(sectionConfig, field)) continue;
			if (validate(sectionConfig[field])) continue;
			delete sectionConfig[field];
			diagnostics.push({
				code: "invalid-field",
				source,
				message: `codebuddy-sdk: ignored invalid ${source} config field ${section}.${field} in ${redactHome(path, home)}`,
			});
		}
		config[section] = sectionConfig;
	}
	return { config: config as Config, diagnostics };
}

function parseConfigFile(
	path: string,
	source: "global" | "project",
	system: ConfigSystemBoundary,
): ConfigLoadResult {
	if (!system.exists(path)) return { config: {}, diagnostics: [] };
	let text: string;
	try {
		text = system.read(path);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
			? ` (${error.code})`
			: "";
		return {
			config: {},
			diagnostics: [{
				code: "parse-error",
				source,
				message: redactHome(`codebuddy-sdk: failed to read ${source} config ${path}${code}`, system.homeDir()),
			}],
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			config: {},
			diagnostics: [{
				code: "parse-error",
				source,
				message: `codebuddy-sdk: ignored ${source} config ${redactHome(path, system.homeDir())} because it contains invalid JSON`,
			}],
		};
	}
	if (!isPlainObject(parsed)) {
		return {
			config: {},
			diagnostics: [{
				code: "invalid-top-level",
				source,
				message: `codebuddy-sdk: ignored ${source} config ${redactHome(path, system.homeDir())} because the top-level value must be an object`,
			}],
		};
	}
	return sanitizeConfig(parsed, source, path, system.homeDir());
}

export function loadGlobalConfig(
	system: ConfigSystemBoundary = DEFAULT_CONFIG_SYSTEM,
): ConfigLoadResult {
	return parseConfigFile(join(system.homeDir(), ".pi", "agent", CONFIG_BASENAME), "global", system);
}

export function loadProjectConfig(
	cwd: string,
	system: ConfigSystemBoundary = DEFAULT_CONFIG_SYSTEM,
): ConfigLoadResult {
	return parseConfigFile(join(cwd, CONFIG_DIR_NAME, CONFIG_BASENAME), "project", system);
}

export function mergeConfig(globalConfig: Config, projectConfig: Config): ConfigLoadResult {
	const diagnostics: ConfigDiagnostic[] = [];
	const projectProvider = { ...projectConfig.provider };
	if (Object.prototype.hasOwnProperty.call(projectProvider, "pathToCodebuddyCode")) {
		delete projectProvider.pathToCodebuddyCode;
		diagnostics.push({
			code: "project-executable-ignored",
			source: "project",
			message: "codebuddy-sdk: ignored project provider.pathToCodebuddyCode because the executable may only be configured globally",
		});
	}
	return {
		config: {
			askCodebuddy: { ...globalConfig.askCodebuddy, ...projectConfig.askCodebuddy },
			provider: { ...globalConfig.provider, ...projectProvider },
		},
		diagnostics,
	};
}

export function loadEffectiveConfig(
	globalResult: ConfigLoadResult,
	cwd: string,
	projectAuthorized: boolean,
	system: ConfigSystemBoundary = DEFAULT_CONFIG_SYSTEM,
): ConfigLoadResult {
	if (!projectAuthorized) return globalResult;
	const projectResult = loadProjectConfig(cwd, system);
	const merged = mergeConfig(globalResult.config, projectResult.config);
	return {
		config: merged.config,
		diagnostics: [
			...globalResult.diagnostics,
			...projectResult.diagnostics,
			...merged.diagnostics,
		],
	};
}

export function tryParseJson(path: string): Partial<Config> {
	const result = parseConfigFile(path, "global", DEFAULT_CONFIG_SYSTEM);
	for (const diagnostic of result.diagnostics) console.error(diagnostic.message);
	return result.config;
}

export function loadConfig(cwd: string, projectAuthorized = false): Config {
	const result = loadEffectiveConfig(loadGlobalConfig(), cwd, projectAuthorized);
	for (const diagnostic of result.diagnostics) console.error(diagnostic.message);
	return result.config;
}
