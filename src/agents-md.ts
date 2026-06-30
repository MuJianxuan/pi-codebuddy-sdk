// AGENTS.md discovery for forwarding to CodeBuddy.

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

const GLOBAL_AGENTS_PATH = join(homedir(), ".pi", "agent", "AGENTS.md");

export function resolveAgentsMdPath(): string | undefined {
  const fromCwd = findAgentsMdInParents(process.cwd());
  if (fromCwd) return fromCwd;
  if (existsSync(GLOBAL_AGENTS_PATH)) return GLOBAL_AGENTS_PATH;
  return undefined;
}

export function findAgentsMdInParents(startDir: string): string | undefined {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, "AGENTS.md");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export function extractAgentsAppend(): string | undefined {
  const agentsPath = resolveAgentsMdPath();
  if (!agentsPath) return undefined;
  try {
    const content = readFileSync(agentsPath, "utf-8").trim();
    if (!content) return undefined;
    const sanitized = content; // keep as-is for CodeBuddy
    return sanitized.length > 0 ? `# CODEBUDDY.md\n\n${sanitized}` : undefined;
  } catch {
    return undefined;
  }
}
