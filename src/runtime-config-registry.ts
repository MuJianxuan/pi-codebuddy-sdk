import type { Config } from "./config.js";
import type {
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const RUNTIME_CONFIG_REGISTRY_KEY = Symbol.for("codebuddy-sdk:runtime-config-registry:v1");
const PROVIDER_INVOCATION_ROUTE_KEY = Symbol.for("codebuddy-sdk:provider-invocation-route:v1");
const PROVIDER_DISPATCHER_KEY = Symbol.for("codebuddy-sdk:provider-dispatcher:v1");

export type ProviderSettings = Readonly<NonNullable<Config["provider"]>>;
export type RuntimeProviderStream = (
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface RuntimeOwnerRegistration {
	ownerId: string;
	canonicalCwd: string;
	sessionId: string;
	askAliases: Iterable<string>;
	streamSimple: RuntimeProviderStream;
}

export interface ProviderInvocationRoute {
	ownerId: string;
	canonicalCwd: string;
	generation: number;
	provider: ProviderSettings;
	askAliases: ReadonlySet<string>;
	streamSimple: RuntimeProviderStream;
}

interface RuntimeOwner {
	ownerId: string;
	canonicalCwd: string;
	sessionIds: Set<string>;
	askAliases: Set<string>;
	streamSimple: RuntimeProviderStream;
}

interface ProviderGeneration {
	generation: number;
	provider: ProviderSettings;
}

export interface RuntimeConfigRegistry {
	publishProviderConfig(canonicalCwd: string, provider: NonNullable<Config["provider"]>): number;
	registerOwner(registration: RuntimeOwnerRegistration): void;
	resolveSession(sessionId: string): ProviderInvocationRoute | undefined;
	getAskAliases(canonicalCwd: string): ReadonlySet<string>;
	removeOwner(ownerId: string): void;
	hasOwners(): boolean;
}

function freezeProviderSettings(provider: NonNullable<Config["provider"]>): ProviderSettings {
	return Object.freeze({
		...provider,
		...(provider.settingSources
			? { settingSources: Object.freeze([...provider.settingSources]) as Config["provider"]["settingSources"] }
			: {}),
	});
}

export function createRuntimeConfigRegistry(): RuntimeConfigRegistry {
	const owners = new Map<string, RuntimeOwner>();
	const sessionOwners = new Map<string, string>();
	const providerByCwd = new Map<string, ProviderGeneration>();

	const removeOwner = (ownerId: string): void => {
		const owner = owners.get(ownerId);
		if (!owner) return;
		for (const sessionId of owner.sessionIds) {
			if (sessionOwners.get(sessionId) === ownerId) sessionOwners.delete(sessionId);
		}
		owners.delete(ownerId);
	};

	const getAskAliases = (canonicalCwd: string): ReadonlySet<string> => {
		const aliases = new Set<string>();
		for (const owner of owners.values()) {
			if (owner.canonicalCwd !== canonicalCwd) continue;
			for (const alias of owner.askAliases) aliases.add(alias);
		}
		return aliases;
	};

	return {
		publishProviderConfig(canonicalCwd, provider) {
			const generation = (providerByCwd.get(canonicalCwd)?.generation ?? 0) + 1;
			providerByCwd.set(canonicalCwd, {
				generation,
				provider: freezeProviderSettings(provider),
			});
			return generation;
		},

		registerOwner(registration) {
			const existingOwnerId = sessionOwners.get(registration.sessionId);
			if (existingOwnerId && existingOwnerId !== registration.ownerId) {
				throw new Error(`CodeBuddy runtime session ${registration.sessionId} is already owned by another extension runtime`);
			}
			// Validate the new session before replacing an existing owner. A failed
			// takeover must not silently remove the old route.
			removeOwner(registration.ownerId);
			const owner: RuntimeOwner = {
				ownerId: registration.ownerId,
				canonicalCwd: registration.canonicalCwd,
				sessionIds: new Set([registration.sessionId]),
				askAliases: new Set(registration.askAliases),
				streamSimple: registration.streamSimple,
			};
			owners.set(owner.ownerId, owner);
			sessionOwners.set(registration.sessionId, owner.ownerId);
		},

		resolveSession(sessionId) {
			const ownerId = sessionOwners.get(sessionId);
			if (!ownerId) return undefined;
			const owner = owners.get(ownerId);
			if (!owner) return undefined;
			const providerGeneration = providerByCwd.get(owner.canonicalCwd);
			if (!providerGeneration) return undefined;
			return {
				ownerId,
				canonicalCwd: owner.canonicalCwd,
				generation: providerGeneration.generation,
				provider: providerGeneration.provider,
				askAliases: getAskAliases(owner.canonicalCwd),
				streamSimple: owner.streamSimple,
			};
		},

		getAskAliases,
		removeOwner,
		hasOwners() {
			return owners.size > 0;
		},
	};
}

export function getGlobalRuntimeConfigRegistry(): RuntimeConfigRegistry {
	const globals = globalThis as Record<symbol, RuntimeConfigRegistry | undefined>;
	globals[RUNTIME_CONFIG_REGISTRY_KEY] ??= createRuntimeConfigRegistry();
	return globals[RUNTIME_CONFIG_REGISTRY_KEY];
}

export function getProviderInvocationRoute(
	options: unknown,
	registry: RuntimeConfigRegistry = getGlobalRuntimeConfigRegistry(),
): ProviderInvocationRoute | undefined {
	if (!options || typeof options !== "object") return undefined;
	const routedOptions = options as Record<symbol, ProviderInvocationRoute | undefined> & { sessionId?: string };
	const directRoute = routedOptions[PROVIDER_INVOCATION_ROUTE_KEY];
	if (directRoute) return directRoute;
	return routedOptions.sessionId ? registry.resolveSession(routedOptions.sessionId) : undefined;
}

export function withProviderInvocationRoute(
	options: SimpleStreamOptions | undefined,
	route: ProviderInvocationRoute,
): SimpleStreamOptions {
	return {
		...(options ?? {}),
		[PROVIDER_INVOCATION_ROUTE_KEY]: route,
	} as SimpleStreamOptions;
}

export function createProviderDispatcher(registry: RuntimeConfigRegistry): RuntimeProviderStream {
	return (model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
		const sessionId = options?.sessionId;
		if (!sessionId) {
			throw new Error("CodeBuddy provider requires a Pi session id for runtime routing");
		}
		const route = registry.resolveSession(sessionId);
		if (!route) {
			throw new Error(`Pi session ${sessionId} does not belong to an active CodeBuddy runtime`);
		}
		return route.streamSimple(model, context, withProviderInvocationRoute(options, route));
	};
}

export function getGlobalProviderDispatcher(): RuntimeProviderStream {
	const globals = globalThis as Record<symbol, RuntimeProviderStream | undefined>;
	globals[PROVIDER_DISPATCHER_KEY] ??= createProviderDispatcher(getGlobalRuntimeConfigRegistry());
	return globals[PROVIDER_DISPATCHER_KEY];
}
