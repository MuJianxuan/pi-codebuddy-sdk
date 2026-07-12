export type ToolPermission = "pending" | "allow" | "deny";

export interface ToolTurnEvent {
	type: "toolcall_start" | "toolcall_delta" | "toolcall_end";
	toolUseId: string;
	toolName: string;
	contentIndex: number;
	args?: Record<string, unknown>;
	delta?: string;
}

export interface ToolTurnCoordinatorOptions {
	hasRequiredArgs?: (toolName: string) => boolean;
	emit?: (event: ToolTurnEvent) => void;
	/** Production adapters set this so stream facts stay buffered until permission. */
	requirePermission?: boolean;
}

export interface PermissionDecisionResult {
	behavior: "allow" | "deny";
	retryable: boolean;
	reason?: string;
}

export interface ToolTurnSnapshot {
	allowedIds: string[];
	deniedIds: string[];
	pendingIds: string[];
	committedIds: string[];
	pendingDispatches: number;
	nextContentIndex: number;
}

interface ToolRecord {
	id: string;
	name: string;
	sourceOrder: number;
	args: Record<string, unknown>;
	argsComplete: boolean;
	permission: ToolPermission;
	denyReason?: string;
	dispatchMatched: boolean;
	emittedStart: boolean;
	emittedEnd: boolean;
	contentIndex?: number;
}

interface PendingDispatch {
	name: string;
	args: Record<string, unknown>;
	sourceOrder: number;
}

function hasValue(args: Record<string, unknown> | undefined): boolean {
	if (!args || Object.keys(args).length === 0) return false;
	return Object.values(args).some((value) => value !== null && value !== undefined);
}

function cloneArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
	return args ? { ...args } : {};
}

/**
 * Single source of truth for one SDK assistant turn.
 *
 * Stream and assistant events may arrive before permission, while MCP dispatch
 * may arrive without a tool id. The coordinator buffers those facts and only
 * emits a Pi executable tool call after SDK permission or an actual MCP dispatch
 * has authorized the same id. Denied ids never become committed content or
 * pending result keys.
 */
export class ToolTurnCoordinator {
	private readonly records = new Map<string, ToolRecord>();
	private readonly pendingDispatches: PendingDispatch[] = [];
	private readonly options: ToolTurnCoordinatorOptions;
	private sourceOrder = 0;
	private nextContentIndex = 0;
	private serialClaimedId: string | undefined;
	readonly requirePermission: boolean;

	constructor(options: ToolTurnCoordinatorOptions = {}) {
		this.options = options;
		this.requirePermission = options.requirePermission === true;
	}

	reset(): void {
		this.records.clear();
		this.pendingDispatches.length = 0;
		this.sourceOrder = 0;
		this.nextContentIndex = 0;
		this.serialClaimedId = undefined;
	}

	private findByName(name: string, includeDenied = false): ToolRecord | undefined {
		return [...this.records.values()]
			.sort((left, right) => left.sourceOrder - right.sourceOrder)
			.find((record) => record.name === name && !record.dispatchMatched && (includeDenied || record.permission !== "deny"));
	}

	private ensureRecord(id: string, name: string, sourceOrder = this.sourceOrder++): ToolRecord {
		const existing = this.records.get(id);
		if (existing) {
			if (name && existing.name !== name) existing.name = name;
			return existing;
		}
		const record: ToolRecord = {
			id,
			name,
			sourceOrder,
			args: {},
			argsComplete: false,
			permission: "pending",
			dispatchMatched: false,
			emittedStart: false,
			emittedEnd: false,
		};
		this.records.set(id, record);
		return record;
	}

	private bindPendingDispatch(record: ToolRecord): void {
		const index = this.pendingDispatches.findIndex((dispatch) => dispatch.name === record.name);
		if (index < 0) return;
		const dispatch = this.pendingDispatches.splice(index, 1)[0];
		record.dispatchMatched = true;
		if (hasValue(dispatch.args)) {
			record.args = cloneArgs(dispatch.args);
			record.argsComplete = true;
		}
		this.authorizeRecord(record);
	}

	private authorizeRecord(record: ToolRecord): PermissionDecisionResult {
		if (record.permission === "deny") {
			return {
				behavior: "deny",
				retryable: record.denyReason === "empty-required-args",
				reason: record.denyReason,
			};
		}
		if (record.permission === "allow") return { behavior: "allow", retryable: false };
		if (this.options.hasRequiredArgs?.(record.name) && !hasValue(record.args)) {
			record.permission = "deny";
			record.denyReason = "empty-required-args";
			return {
				behavior: "deny",
				retryable: true,
				reason: "empty-required-args",
			};
		}
		if (this.serialClaimedId && this.serialClaimedId !== record.id) {
			record.permission = "deny";
			record.denyReason = "serial-slot-occupied";
			return {
				behavior: "deny",
				retryable: false,
				reason: "serial-slot-occupied",
			};
		}
		this.serialClaimedId = record.id;
		record.permission = "allow";
		record.denyReason = undefined;
		this.maybeEmit(record);
		return { behavior: "allow", retryable: false };
	}

	private maybeEmit(record: ToolRecord): void {
		if (record.permission !== "allow") return;
		if (!record.emittedStart) {
			record.emittedStart = true;
			record.contentIndex = this.nextContentIndex++;
			this.options.emit?.({
				type: "toolcall_start",
				toolUseId: record.id,
				toolName: record.name,
				contentIndex: record.contentIndex,
			});
		}
		if (record.argsComplete && !record.emittedEnd) {
			record.emittedEnd = true;
			this.options.emit?.({
				type: "toolcall_end",
				toolUseId: record.id,
				toolName: record.name,
				contentIndex: record.contentIndex!,
				args: cloneArgs(record.args),
			});
		}
	}

	observeStreamStart(
		id: string,
		name: string,
		args: Record<string, unknown> = {},
		sourceOrder = this.sourceOrder++,
	): ToolPermission {
		const pending = this.findByName(name);
		const pendingDispatch = this.pendingDispatches.some((dispatch) => dispatch.name === name);
		const record = pendingDispatch && pending && pending.id !== id
			? (() => {
				this.records.delete(pending.id);
				pending.id = id;
				this.records.set(id, pending);
				return pending;
			})()
			: this.ensureRecord(id, name, sourceOrder);
		record.name = name;
		record.sourceOrder = Math.min(record.sourceOrder, sourceOrder);
		if (hasValue(args)) record.args = { ...record.args, ...args };
		this.bindPendingDispatch(record);
		this.maybeEmit(record);
		return record.permission;
	}

	observeStreamArgs(id: string, args: Record<string, unknown> | undefined, complete = false, delta?: string): ToolPermission {
		const record = this.ensureRecord(id, "");
		if (hasValue(args)) record.args = { ...record.args, ...args };
		record.argsComplete ||= complete;
		if (delta && record.permission === "allow" && record.emittedStart) {
			this.options.emit?.({
				type: "toolcall_delta",
				toolUseId: record.id,
				toolName: record.name,
				contentIndex: record.contentIndex!,
				delta,
			});
		}
		this.maybeEmit(record);
		return record.permission;
	}

	observeAssistantBlock(id: string, name: string, args: Record<string, unknown> | undefined): ToolPermission {
		const record = this.ensureRecord(id, name);
		record.name = name;
		if (hasValue(args)) record.args = { ...record.args, ...args };
		record.argsComplete = true;
		this.bindPendingDispatch(record);
		this.maybeEmit(record);
		return record.permission;
	}

	recordPermissionDecision(
		id: string,
		name: string,
		decision: "allow" | "deny",
		reason?: string,
		input: Record<string, unknown> | undefined = undefined,
	): PermissionDecisionResult {
		const record = this.ensureRecord(id, name);
		if (hasValue(input)) {
			record.args = { ...record.args, ...input };
			record.argsComplete = true;
		}
		if (decision === "deny") {
			record.permission = "deny";
			record.denyReason = reason;
			return { behavior: "deny", retryable: reason === "empty-required-args", reason };
		}
		if (record.permission === "deny" && record.denyReason === "empty-required-args") {
			record.permission = "pending";
			record.denyReason = undefined;
		}
		return this.authorizeRecord(record);
	}

	observeDispatch(name: string, args: Record<string, unknown> = {}): string | undefined {
		const record = this.findByName(name) ?? this.findByName(name, true);
		if (!record) {
			this.pendingDispatches.push({ name, args: cloneArgs(args), sourceOrder: this.sourceOrder++ });
			return undefined;
		}
		// Reaching the MCP handler is the provider's actual execution boundary.
		// Treat that dispatch as implicit permission, while keeping explicit or
		// validation/serial denials terminal.
		record.dispatchMatched = true;
		if (hasValue(args)) {
			record.args = { ...record.args, ...args };
			record.argsComplete = true;
		}
		this.authorizeRecord(record);
		return record.id;
	}

	finishTurn(): ToolTurnSnapshot {
		for (const record of this.records.values()) {
			if (record.permission === "pending") {
				record.permission = "deny";
				record.denyReason = "permission-pending-at-turn-end";
			}
		}
		return this.snapshot();
	}

	abort(): ToolTurnSnapshot {
		for (const record of this.records.values()) {
			if (record.permission === "pending") {
				record.permission = "deny";
				record.denyReason = "aborted";
			}
		}
		this.pendingDispatches.length = 0;
		return this.snapshot();
	}

	allocateContentIndex(): number {
		return this.nextContentIndex++;
	}

	isAllowed(id: string): boolean {
		return this.records.get(id)?.permission === "allow";
	}

	getArgs(id: string): Record<string, unknown> {
		return cloneArgs(this.records.get(id)?.args);
	}

	getToolIdForDispatch(name: string): string | undefined {
		return this.findByName(name)?.id;
	}

	cancelPendingDispatch(name: string): boolean {
		const index = this.pendingDispatches.findIndex((dispatch) => dispatch.name === name);
		if (index < 0) return false;
		this.pendingDispatches.splice(index, 1);
		return true;
	}

	snapshot(): ToolTurnSnapshot {
		const records = [...this.records.values()].sort((left, right) => left.sourceOrder - right.sourceOrder);
		return {
			allowedIds: records.filter((record) => record.permission === "allow").map((record) => record.id),
			deniedIds: records.filter((record) => record.permission === "deny").map((record) => record.id),
			pendingIds: records.filter((record) => record.permission === "pending").map((record) => record.id),
			committedIds: records.filter((record) => record.emittedStart).map((record) => record.id),
			pendingDispatches: this.pendingDispatches.length,
			nextContentIndex: this.nextContentIndex,
		};
	}
}
