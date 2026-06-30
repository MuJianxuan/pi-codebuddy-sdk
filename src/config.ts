// User-facing extension config. Loaded once at extension registration from
// ~/.pi/agent/codebuddy-sdk.json and the project Pi config directory, project
// overriding global. Missing or unparseable files are ignored.

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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
    pathToCodebuddyExecutable?: string;
    plan?: "pro" | "max";
    longContextExtraUsage?: boolean;
  };
}

export function tryParseJson(path: string): Partial<Config> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    console.error(`codebuddy-sdk: failed to parse ${path}: ${e}`);
    return {};
  }
}

export function loadConfig(cwd: string): Config {
  const global = tryParseJson(join(homedir(), ".pi", "agent", "codebuddy-sdk.json"));
  const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, "codebuddy-sdk.json"));
  return {
    askCodebuddy: { ...global.askCodebuddy, ...project.askCodebuddy },
    provider: { ...global.provider, ...project.provider },
  };
}
