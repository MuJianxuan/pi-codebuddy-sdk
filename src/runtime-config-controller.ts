import {
	loadEffectiveConfig,
	type Config,
	type ConfigDiagnostic,
	type ConfigLoadResult,
} from "./config.js";
import {
	canonicalizeProjectCwd,
	resolveProjectConfigAuthorization,
	type ProjectConfigTrustDiagnostic,
	type ProjectConfigAuthorization,
} from "./project-config-trust.js";
import type {
	RuntimeConfigRegistry,
	RuntimeProviderStream,
} from "./runtime-config-registry.js";

export interface RuntimeConfigControllerOptions {
	ownerId: string;
	globalConfig: ConfigLoadResult;
	registry: RuntimeConfigRegistry;
	streamSimple: RuntimeProviderStream;
}

export interface RuntimeConfigStartOptions {
	cwd: string;
	sessionId: string;
	hasUI: boolean;
	/** Re-evaluate project authorization and effective config for /reload. */
	forceReload?: boolean;
	select?: (title: string, options: string[]) => Promise<string | undefined>;
	registerAsk: (config: Readonly<Config>, canonicalCwd: string) => string | undefined | Promise<string | undefined>;
}

export interface RuntimeConfigSnapshot {
	canonicalCwd: string;
	config: Readonly<Config>;
	projectAuthorized: boolean;
	askAlias?: string;
	diagnostics: Array<ConfigDiagnostic | ProjectConfigTrustDiagnostic>;
}

export interface RuntimeConfigController {
	start(options: RuntimeConfigStartOptions): Promise<RuntimeConfigSnapshot>;
		rebindSession(snapshot: RuntimeConfigSnapshot, sessionId: string): RuntimeConfigSnapshot;
	shutdown(): void;
}

function freezeConfig(config: Config): Readonly<Config> {
	const askCodebuddy = config.askCodebuddy
		? Object.freeze({ ...config.askCodebuddy })
		: undefined;
	const provider = config.provider
		? Object.freeze({
			...config.provider,
			...(config.provider.settingSources
				? { settingSources: Object.freeze([...config.provider.settingSources]) as Config["provider"]["settingSources"] }
				: {}),
		})
		: undefined;
	return Object.freeze({ ...config, askCodebuddy, provider });
}

export function createRuntimeConfigController(
	controllerOptions: RuntimeConfigControllerOptions,
): RuntimeConfigController {
	const ignoredProjectCwds = new Set<string>();
	return {
		async start(options) {
			const requestedCwd = canonicalizeProjectCwd(options.cwd);
			if (options.forceReload) ignoredProjectCwds.delete(requestedCwd);
			let ownerClaimed = false;
			let askAlias: string | undefined;
			try {
				// Claim the owner synchronously before project authorization can await
				// trust-store I/O or UI input. Publishing the safe global config follows
				// immediately, so a successful claim has a route before the first await;
				// a failed takeover cannot pollute the existing owner's config.
				controllerOptions.registry.registerOwner({
					ownerId: controllerOptions.ownerId,
					canonicalCwd: requestedCwd,
					sessionId: options.sessionId,
					askAliases: [],
					streamSimple: controllerOptions.streamSimple,
				});
				ownerClaimed = true;
				controllerOptions.registry.publishProviderConfig(
					requestedCwd,
					controllerOptions.globalConfig.config.provider ?? {},
				);

				const authorization: ProjectConfigAuthorization = ignoredProjectCwds.has(requestedCwd)
					? {
						canonicalCwd: requestedCwd,
						authorized: false,
						decision: "ignore-runtime",
						diagnostics: [],
					}
					: await resolveProjectConfigAuthorization({
						cwd: requestedCwd,
						hasUI: options.hasUI,
						select: options.select,
					});
				if (authorization.decision === "ignore-runtime") {
					ignoredProjectCwds.add(authorization.canonicalCwd);
				}
				const canonicalCwd = authorization.canonicalCwd;
				const effective = loadEffectiveConfig(
					controllerOptions.globalConfig,
					canonicalCwd,
					authorization.authorized,
				);
				const config = freezeConfig(effective.config);
				if (config.askCodebuddy?.enabled !== false) {
					askAlias = await options.registerAsk(config, canonicalCwd);
				}
				controllerOptions.registry.publishProviderConfig(
					canonicalCwd,
					config.provider ?? {},
				);
				if (askAlias !== undefined) {
					controllerOptions.registry.registerOwner({
						ownerId: controllerOptions.ownerId,
						canonicalCwd,
						sessionId: options.sessionId,
						askAliases: [askAlias],
						streamSimple: controllerOptions.streamSimple,
					});
				}
				return {
					canonicalCwd,
					config,
					projectAuthorized: authorization.authorized,
					...(askAlias !== undefined ? { askAlias } : {}),
					diagnostics: [
						...authorization.diagnostics,
						...effective.diagnostics,
					],
				};
			} catch (error) {
				if (ownerClaimed) controllerOptions.registry.removeOwner(controllerOptions.ownerId);
				throw error;
			}
		},

		rebindSession(snapshot, sessionId) {
			controllerOptions.registry.registerOwner({
				ownerId: controllerOptions.ownerId,
				canonicalCwd: snapshot.canonicalCwd,
				sessionId,
				askAliases: snapshot.askAlias !== undefined ? [snapshot.askAlias] : [],
				streamSimple: controllerOptions.streamSimple,
			});
			return snapshot;
		},

		shutdown() {
			controllerOptions.registry.removeOwner(controllerOptions.ownerId);
			ignoredProjectCwds.clear();
		},
	};
}
