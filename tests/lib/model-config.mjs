import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BRIDGE_MODEL = "codebuddy/hy3";

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENV_FILE = resolve(REPO_DIR, ".env.test");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export function resolveBridgeModel(env = process.env) {
	return env.CODEBUDDY_SDK_TEST_MODEL?.trim() || DEFAULT_BRIDGE_MODEL;
}

export const BRIDGE_MODEL = resolveBridgeModel();

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.stdout.write(`${BRIDGE_MODEL}\n`);
}
