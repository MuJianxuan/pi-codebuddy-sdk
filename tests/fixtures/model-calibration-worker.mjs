import { existsSync, writeFileSync } from "node:fs";
import { updateObservedContextWindow } from "../../src/model-calibration.js";

const [cachePath, modelId, observed, readyPath, startPath] = process.argv.slice(2);
if (!cachePath || !modelId || !observed || !readyPath || !startPath) throw new Error("calibration worker requires cache, model, observation, and barriers");
const environment = { internetEnvironment: "default", codebuddyConfigDir: "default", codebuddyExecutable: "default" };
writeFileSync(readyPath, `${process.pid}\n`);
const deadline = Date.now() + 60_000;
while (!existsSync(startPath)) {
	if (Date.now() > deadline) throw new Error("calibration worker timed out");
	await new Promise((resolve) => setTimeout(resolve, 10));
}
const result = await updateObservedContextWindow(cachePath, modelId, environment, Number(observed));
if (!result.persisted) throw new Error("calibration transaction was not persisted");
