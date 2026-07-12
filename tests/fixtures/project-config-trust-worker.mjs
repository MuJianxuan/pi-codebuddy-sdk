import { PROJECT_CONFIG_TRUST_CHOICES, resolveProjectConfigAuthorization } from "../../src/project-config-trust.js";
import { existsSync, writeFileSync } from "node:fs";

const cwd = process.argv[2];
const readyPath = process.argv[3];
const startPath = process.argv[4];
if (!cwd || !readyPath || !startPath) throw new Error("worker requires cwd and barrier paths");

writeFileSync(readyPath, `${process.pid}\n`);
const deadline = Date.now() + 60_000;
while (!existsSync(startPath)) {
	if (Date.now() > deadline) throw new Error("worker timed out waiting for start barrier");
	await new Promise((resolve) => setTimeout(resolve, 10));
}
const result = await resolveProjectConfigAuthorization({
	cwd,
	hasUI: true,
	select: async () => PROJECT_CONFIG_TRUST_CHOICES.allow,
});
if (!result.authorized) {
	throw new Error(`worker failed to authorize project config: ${JSON.stringify(result.diagnostics)}`);
}
