import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

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
		maxTokens?: CapabilityMetric;
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

export function loadCalibrationCache(path = DEFAULT_CALIBRATION_CACHE_PATH): CalibrationCache {
	if (!existsSync(path)) return { version: CALIBRATION_CACHE_VERSION, records: {} };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CalibrationCache>;
		if (parsed.version !== CALIBRATION_CACHE_VERSION || !parsed.records || typeof parsed.records !== "object") {
			return { version: CALIBRATION_CACHE_VERSION, records: {} };
		}
		return { version: CALIBRATION_CACHE_VERSION, records: parsed.records };
	} catch {
		return { version: CALIBRATION_CACHE_VERSION, records: {} };
	}
}

export function saveCalibrationCache(cache: CalibrationCache, path = DEFAULT_CALIBRATION_CACHE_PATH): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(cache, null, 2) + "\n");
}

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
