// Skills block extraction + MCP naming constants.
// Extracted from index.ts so tests can import without activating the extension.

export const MCP_SERVER_NAME = "custom_tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

const SKILLS_START_MARKER = "The following skills provide specialized instructions for specific tasks.";
const SKILLS_END_MARKER = "</available_skills>";
const TOOL_GUIDANCE_MARKER = "CodeBuddy guidance:";
const CORE_TOOL_ORDER = ["read", "edit", "write", "bash"] as const;

const BUILTIN_TOOL_GUIDANCE: Record<string, string> = {
	read: "Use this Pi tool to inspect file contents before answering file-specific questions or editing existing files. Prefer it over shelling out to cat/sed when reading files.",
	write: "Use this Pi tool only when creating a new file or replacing a whole file is intended. Prefer edit for targeted changes to existing files.",
	edit: "Use this Pi tool for targeted changes after reading the file. The oldText/old_string value must exactly match existing content; use the Pi schema field names exactly.",
	bash: "Use this Pi tool for shell commands only when file tools are insufficient or command execution is requested. Keep commands scoped and provide a timeout for long-running work.",
};

export interface ToolBridgeInstructionOptions {
	availableToolNames?: Iterable<string>;
	warn?: (message: string) => void;
}

function normalizeToolNames(names: Iterable<string> | undefined, warn?: (message: string) => void): string[] {
	const normalized = new Map<string, string>();
	for (const name of names ?? []) {
		if (typeof name !== "string" || !name) continue;
		const key = name.toLowerCase();
		if (normalized.has(key)) {
			warn?.(`CodeBuddy SDK: duplicate bridged tool name differs only by case; keeping ${JSON.stringify(normalized.get(key))}`);
			continue;
		}
		normalized.set(key, name);
	}
	return [...normalized.values()];
}

function mcpName(name: string): string {
	return `${MCP_TOOL_PREFIX}${name}`;
}

function codeSpan(value: string): string {
	return `\`${value.replaceAll("`", "\\`")}\``;
}

function formatToolList(toolNames: string[]): string {
	const ordered = [
		...CORE_TOOL_ORDER.flatMap((name) => toolNames.find((actual) => actual.toLowerCase() === name) ?? []),
		...toolNames
			.filter((name) => !CORE_TOOL_ORDER.includes(name.toLowerCase() as typeof CORE_TOOL_ORDER[number]))
			.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase())),
	];
	return ordered.map((name) => codeSpan(mcpName(name))).join(", ");
}

export function buildPiToolBridgeInstruction(options: ToolBridgeInstructionOptions = {}): string {
	const toolNames = normalizeToolNames(options.availableToolNames, options.warn);
	const actualName = (name: string) => toolNames.find((toolName) => toolName.toLowerCase() === name);
	const has = (name: string) => actualName(name) !== undefined;
	const ref = (name: string) => codeSpan(mcpName(actualName(name) ?? name));
	const lines = [
		"Pi Tool Bridge:",
		`Pi executes tools; CodeBuddy sees available Pi tools through the MCP server ${codeSpan(MCP_SERVER_NAME)}.`,
	];

	if (toolNames.length === 0) {
		lines.push("No Pi tools are currently available through the bridge. Do not invoke unavailable tools.");
		return lines.join("\n");
	}

	lines.push(`Available bridged Pi tools in this turn: ${formatToolList(toolNames)}.`);
	lines.push("Tool selection rules:");

	if (has("read")) {
		lines.push(`- Use ${ref("read")} to inspect existing repository files before file-specific answers or edits. Prefer it over shelling out to cat/sed for file reads.`);
	} else {
		lines.push("- Use available Pi file tools to inspect existing repository files before editing when such tools are present.");
	}
	if (has("edit")) {
		const prefix = has("read") ? `After reading, use ${ref("edit")}` : `Use ${ref("edit")}`;
		lines.push(`- ${prefix} for targeted changes to existing files. The oldText/old_string value must exactly match existing content.`);
	}
	if (has("write")) {
		const editFallback = has("edit") ? ` prefer ${ref("edit")} for targeted changes to existing files.` : " avoid broad replacement of existing files.";
		lines.push(`- Use ${ref("write")} only for new files or deliberate full-file replacement;${editFallback}`);
	}
	if (has("bash")) {
		lines.push(`- Use ${ref("bash")} only when file tools are insufficient, for search/test/build/git information, or when command execution is requested.`);
	}
	// Force serial tool calls. CodeBuddy's MCP client drops arguments for
	// 2nd+ parallel tool_call blocks in a single response: the
	// content_block_stop for those blocks never arrives, so pi finalizes a
	// dangling toolcall_start with empty {} args and the call fails
	// validation. Instructing one-tool-per-turn avoids the failure at the
	// source. The stream-side backfill defense cannot catch this because it
	// keys off content_block_stop, which never fires for the dropped call.
	lines.push("Call AT MOST ONE tool per turn. Never emit multiple tool_call blocks in a single response. A second tool call in the same turn will be denied. Issue one tool call, wait for its result, then decide the next call in the following turn. Parallel tool calls are unsupported and will fail.");
	lines.push("Tool arguments must match the Pi tool schema exactly. After a tool result, base the next step on that result; if it is an error, correct the call instead of assuming success.");

	return lines.join("\n");
}

export function enhancePiToolForCodebuddy<T extends { name: string; description?: string }>(tool: T): T {
	const guidance = BUILTIN_TOOL_GUIDANCE[tool.name.toLowerCase()];
	if (!guidance) return tool;
	if (tool.description?.includes(TOOL_GUIDANCE_MARKER)) return tool;
	const description = tool.description
		? `${tool.description}\n\n${TOOL_GUIDANCE_MARKER} ${guidance}`
		: `${TOOL_GUIDANCE_MARKER} ${guidance}`;
	return { ...tool, description };
}

// Extract skills block from pi's system prompt for forwarding to CodeBuddy.
export function extractSkillsBlock(systemPrompt?: string): string | undefined {
	if (!systemPrompt) return undefined;
	const startMarker = SKILLS_START_MARKER;
	const endMarker = SKILLS_END_MARKER;
	const start = systemPrompt.indexOf(startMarker);
	if (start === -1) return undefined;
	const end = systemPrompt.indexOf(endMarker, start);
	if (end === -1) return undefined;
	return rewriteSkillsBlock(systemPrompt.slice(start, end + endMarker.length).trim());
}

export function rewriteSkillsBlock(skillsBlock: string): string {
	return skillsBlock.replace(
		"Use the read tool to load a skill's file",
		`Use the read tool (mcp__${MCP_SERVER_NAME}__read) to load a skill's file`,
	);
}

function stripSkillsBlock(systemPrompt: string): string {
	const start = systemPrompt.indexOf(SKILLS_START_MARKER);
	if (start === -1) return systemPrompt;
	const end = systemPrompt.indexOf(SKILLS_END_MARKER, start);
	if (end === -1) return systemPrompt;
	return (systemPrompt.slice(0, start) + systemPrompt.slice(end + SKILLS_END_MARKER.length))
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function applySkillsRewrite(systemPrompt: string): string {
	const rewritten = extractSkillsBlock(systemPrompt);
	if (!rewritten) return systemPrompt;
	const start = systemPrompt.indexOf(SKILLS_START_MARKER);
	const end = systemPrompt.indexOf(SKILLS_END_MARKER, start);
	if (start === -1 || end === -1) return systemPrompt;
	return systemPrompt.slice(0, start) + rewritten + systemPrompt.slice(end + SKILLS_END_MARKER.length);
}

/** Pi system prompt as CodeBuddy override (replaces default "CodeBuddy Code" identity). */
export function buildCodebuddySystemPrompt(
	piSystemPrompt: string | undefined,
	options?: { includeSkills?: boolean; includeToolBridge?: boolean; availableToolNames?: Iterable<string> },
): string | undefined {
	const parts: string[] = [];
	const includeToolBridge = options?.includeToolBridge !== false;

	if (includeToolBridge) {
		parts.push(buildPiToolBridgeInstruction({ availableToolNames: options?.availableToolNames }));
	}

	if (piSystemPrompt) {
		let prompt = piSystemPrompt;
		if (options?.includeSkills === false) {
			prompt = stripSkillsBlock(prompt);
		} else {
			prompt = includeToolBridge ? applySkillsRewrite(prompt) : prompt;
		}
		if (prompt) parts.push(prompt);
	}

	return parts.length > 0 ? parts.join("\n\n") : undefined;
}
