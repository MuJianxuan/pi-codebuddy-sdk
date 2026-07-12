import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RESULT_LENGTH = 24_280;
const PREFIX = "FAST-LARGE-RESULT-BEGIN\n";
const SUFFIX = "\nFAST-LARGE-RESULT-END";
const RESULT = PREFIX + "x".repeat(RESULT_LENGTH - PREFIX.length - SUFFIX.length) + SUFFIX;

export default function (pi: ExtensionAPI) {
	const params = Type.Object({});
	pi.registerTool<typeof params>({
		name: "ImmediateLargeResult",
		label: "Immediate large result",
		description: "Returns a deterministic large text result immediately.",
		parameters: params,
		async execute() {
			return { content: [{ type: "text" as const, text: RESULT }], details: {} };
		},
	});
}
