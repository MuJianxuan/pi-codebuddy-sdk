import { existsSync, readFileSync } from "fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import lockfile from "proper-lockfile";

export interface CalibrationEnvironment {
	internetEnvironment: string;
	codebuddyConfigDir: string;
	codebuddyExecutable: string;
}

export interface CapabilityMetric {
	floor: number;
	latest: number;
	max: number;
	observedAt: string;
}

export interface ModelCalibrationRecord {
	modelId: string;
	environment: CalibrationEnvironment;
	capabilities: {
		contextWindow?: CapabilityMetric;
	};
}

export interface CalibrationCache {
	version: 1;
	records: Record<string, ModelCalibrationRecord>;
}

const CALIBRATION_CACHE_VERSION = 1;
export const DEFAULT_CALIBRATION_CACHE_PATH = join(homedir(), ".pi", "agent", "codebuddy-sdk-model-calibration.json");

function normalizedValue(value: string | undefined | null): string {
	const trimmed = value?.trim();
	return trimmed ? trimmed : "default";
}

export function buildCalibrationEnvironment(codebuddyExecutable?: string): CalibrationEnvironment {
	return {
		internetEnvironment: normalizedValue(process.env.CODEBUDDY_INTERNET_ENVIRONMENT),
		codebuddyConfigDir: normalizedValue(process.env.CODEBUDDY_CONFIG_DIR),
		codebuddyExecutable: normalizedValue(codebuddyExecutable),
	};
}

export function buildCalibrationKey(modelId: string, environment: CalibrationEnvironment): string {
	return JSON.stringify({ modelId, ...environment });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function parseMetric(value: unknown): CapabilityMetric | undefined {
	if (!isPlainObject(value)) return undefined;
	const { floor, latest, max, observedAt } = value;
	if (
		typeof floor !== "number" || !Number.isFinite(floor) || floor <= 0 ||
		typeof latest !== "number" || !Number.isFinite(latest) || latest <= 0 ||
		typeof max !== "number" || !Number.isFinite(max) || max <= 0 ||
		floor > latest || latest > max ||
		typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))
	) return undefined;
	return { floor, latest, max, observedAt };
}

function parseCalibrationRecord(key: string, value: unknown): ModelCalibrationRecord | undefined {
	if (!isPlainObject(value) || typeof value.modelId !== "string" || !value.modelId.trim()) return undefined;
	if (!isPlainObject(value.environment) || !isPlainObject(value.capabilities)) return undefined;
	const environment = value.environment;
	if (
		typeof environment.internetEnvironment !== "string" || !environment.internetEnvironment.trim() ||
		typeof environment.codebuddyConfigDir !== "string" || !environment.codebuddyConfigDir.trim() ||
		typeof environment.codebuddyExecutable !== "string" || !environment.codebuddyExecutable.trim()
	) return undefined;
	const normalizedEnvironment: CalibrationEnvironment = {
		internetEnvironment: environment.internetEnvironment,
		codebuddyConfigDir: environment.codebuddyConfigDir,
		codebuddyExecutable: environment.codebuddyExecutable,
	};
	if (buildCalibrationKey(value.modelId, normalizedEnvironment) !== key) return undefined;
	const capabilities = value.capabilities;
	const contextWindow = capabilities.contextWindow === undefined
		? undefined
		: parseMetric(capabilities.contextWindow);
	if (capabilities.contextWindow !== undefined && !contextWindow) return undefined;
	return {
		modelId: value.modelId,
		environment: normalizedEnvironment,
		capabilities: {
			...(contextWindow ? { contextWindow } : {}),
		},
	};
}

export function loadCalibrationCache(path = DEFAULT_CALIBRATION_CACHE_PATH): CalibrationCache {
	if (!existsSync(path)) return { version: CALIBRATION_CACHE_VERSION, records: {} };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isPlainObject(parsed) || parsed.version !== CALIBRATION_CACHE_VERSION || !isPlainObject(parsed.records)) {
			return { version: CALIBRATION_CACHE_VERSION, records: {} };
		}
		const records: Record<string, ModelCalibrationRecord> = {};
		for (const [key, value] of Object.entries(parsed.records)) {
			const record = parseCalibrationRecord(key, value);
			if (record) records[key] = record;
		}
		return { version: CALIBRATION_CACHE_VERSION, records };
	} catch {
		return { version: CALIBRATION_CACHE_VERSION, records: {} };
	}
}

export function mergeCapabilityMetric(
	current: CapabilityMetric | undefined,
	incoming: CapabilityMetric | undefined,
): CapabilityMetric | undefined {
	if (!current) return incoming;
	if (!incoming) return current;
	const latest = incoming.observedAt >= current.observedAt ? incoming : current;
	return {
		floor: Math.min(current.floor, incoming.floor),
		latest: latest.latest,
		max: Math.max(current.max, incoming.max),
		observedAt: latest.observedAt,
	};
}

export function mergeCalibrationCaches(current: CalibrationCache, incoming: CalibrationCache): CalibrationCache {
	const records: Record<string, ModelCalibrationRecord> = {};
	for (const [key, value] of Object.entries(current.records)) {
		const record = parseCalibrationRecord(key, value);
		if (record) records[key] = record;
	}
	for (const [key, value] of Object.entries(incoming.records)) {
		const nextRecord = parseCalibrationRecord(key, value);
		if (!nextRecord) continue;
		const previousRecord = records[key];
		if (!previousRecord) {
			records[key] = nextRecord;
			continue;
		}
		records[key] = {
			...nextRecord,
			capabilities: {
				contextWindow: mergeCapabilityMetric(
					previousRecord.capabilities.contextWindow,
					nextRecord.capabilities.contextWindow,
				),
			},
		};
	}
	return { version: CALIBRATION_CACHE_VERSION, records };
}

export function mergeContextWindowMetric(
	cache: CalibrationCache,
	modelId: string,
	environment: CalibrationEnvironment,
	metric: CapabilityMetric,
): ModelCalibrationRecord {
	const key = buildCalibrationKey(modelId, environment);
	const existing = cache.records[key];
	const record: ModelCalibrationRecord = {
		modelId,
		environment,
		capabilities: {
			...existing?.capabilities,
			contextWindow: mergeCapabilityMetric(existing?.capabilities.contextWindow, metric),
		},
	};
	cache.records[key] = record;
	return record;
}

export interface CalibrationTransactionResult {
	cache: CalibrationCache;
	record: ModelCalibrationRecord;
	changed: boolean;
	floorChanged: boolean;
	persisted: boolean;
}

interface CalibrationLockTiming {
	stale?: number;
	update?: number;
}

type AssertCalibrationLockHealthy = () => void;

function cloneCalibrationCache(cache: CalibrationCache): CalibrationCache {
	return {
		version: CALIBRATION_CACHE_VERSION,
		records: Object.fromEntries(
			Object.entries(cache.records).map(([key, record]) => [key, {
				...record,
				environment: { ...record.environment },
				capabilities: {
					...(record.capabilities.contextWindow
						? { contextWindow: { ...record.capabilities.contextWindow } }
						: {}),
				},
			}]),
		),
	};
}

async function writeCalibrationCacheAtomic(
	cache: CalibrationCache,
	path: string,
	assertLockHealthy: AssertCalibrationLockHealthy = () => {},
): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	const tempPath = join(
		directory,
		`.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
	);
	let tempHandle;
	try {
		assertLockHealthy();
		tempHandle = await open(tempPath, "wx", 0o600);
		await tempHandle.writeFile(`${JSON.stringify(cache, null, 2)}\n`, "utf8");
		await tempHandle.sync();
		await tempHandle.close();
		tempHandle = undefined;
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
			// Directory fsync is not available on every supported platform.
		}
	} finally {
		if (tempHandle) await tempHandle.close().catch(() => undefined);
		await rm(tempPath, { force: true }).catch(() => undefined);
	}
}

async function withCalibrationLock<T>(
	path: string,
	operation: (assertLockHealthy: AssertCalibrationLockHealthy) => Promise<T>,
	timing: CalibrationLockTiming = {},
): Promise<T> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
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
	const assertLockHealthy: AssertCalibrationLockHealthy = () => {
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

/**
 * Atomically record one served context-window observation. The lock is acquired
 * before reading the target, so concurrent writers merge against the newest
 * complete cache rather than a stale in-memory snapshot.
 */
export async function updateObservedContextWindow(
	path: string,
	modelId: string,
	environment: CalibrationEnvironment,
	observed: number,
	fallbackCache: CalibrationCache = loadCalibrationCache(path),
	options: { timing?: CalibrationLockTiming; pendingMetric?: CapabilityMetric } = {},
): Promise<CalibrationTransactionResult> {
	const fallback = cloneCalibrationCache(fallbackCache);
	if (options.pendingMetric) mergeContextWindowMetric(fallback, modelId, environment, options.pendingMetric);
	const fallbackObservation = recordObservedContextWindow(fallback, modelId, environment, observed);
	try {
		const committed = await withCalibrationLock(path, async (assertLockHealthy) => {
			const latest = loadCalibrationCache(path);
			if (options.pendingMetric) mergeContextWindowMetric(latest, modelId, environment, options.pendingMetric);
			const observation = recordObservedContextWindow(latest, modelId, environment, observed);
			await writeCalibrationCacheAtomic(latest, path, assertLockHealthy);
			return { cache: latest, ...observation, persisted: true };
		}, options.timing);
		return committed;
	} catch {
		// Persistence faults must not make the runtime increase its advertised
		// window. The caller can keep the downward fallback in memory and retry a
		// later observation against the disk's newest complete cache.
		return { cache: fallback, ...fallbackObservation, persisted: false };
	}
}

export async function saveCalibrationCache(
	cache: CalibrationCache,
	path = DEFAULT_CALIBRATION_CACHE_PATH,
): Promise<void> {
	const merged = await withCalibrationLock(path, async (assertLockHealthy) => {
		const next = mergeCalibrationCaches(loadCalibrationCache(path), cache);
		await writeCalibrationCacheAtomic(next, path, assertLockHealthy);
		return next;
	});
	cache.version = merged.version;
	cache.records = merged.records;
}

export const __test = {
	withCalibrationLock,
	writeCalibrationCacheAtomic,
};

export function getCalibrationRecord(
	cache: CalibrationCache,
	modelId: string,
	environment: CalibrationEnvironment,
): ModelCalibrationRecord | undefined {
	return cache.records[buildCalibrationKey(modelId, environment)];
}

export function getContextWindowCalibration(
	cache: CalibrationCache,
	modelId: string,
	environment: CalibrationEnvironment,
): CapabilityMetric | undefined {
	return getCalibrationRecord(cache, modelId, environment)?.capabilities.contextWindow;
}

export function applyContextWindowCalibrations<T extends { id: string; contextWindow: number }>(
	models: T[],
	cache: CalibrationCache,
	environment: CalibrationEnvironment,
): T[] {
	return models.map((model) => {
		const metric = getContextWindowCalibration(cache, model.id, environment);
		if (!metric?.floor) return model;
		return { ...model, contextWindow: metric.floor };
	});
}

export function recordObservedContextWindow(
	cache: CalibrationCache,
	modelId: string,
	environment: CalibrationEnvironment,
	observed: number,
): { changed: boolean; floorChanged: boolean; record: ModelCalibrationRecord } {
	if (!Number.isFinite(observed) || observed <= 0) throw new RangeError("observed context window must be a finite positive number");
	const key = buildCalibrationKey(modelId, environment);
	const existing = cache.records[key];
	const previous = existing?.capabilities.contextWindow;
	const nextMetric: CapabilityMetric = {
		floor: previous ? Math.min(previous.floor, observed) : observed,
		latest: observed,
		max: previous ? Math.max(previous.max, observed) : observed,
		observedAt: new Date().toISOString(),
	};
	const nextRecord: ModelCalibrationRecord = {
		modelId,
		environment,
		capabilities: {
			...existing?.capabilities,
			contextWindow: nextMetric,
		},
	};
	cache.records[key] = nextRecord;
	const changed =
		!previous ||
		previous.floor !== nextMetric.floor ||
		previous.latest !== nextMetric.latest ||
		previous.max !== nextMetric.max;
	const floorChanged = !previous || previous.floor !== nextMetric.floor;
	return { changed, floorChanged, record: nextRecord };
}
