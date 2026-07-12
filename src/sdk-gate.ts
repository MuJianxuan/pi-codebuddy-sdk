// Serialize CodeBuddy SDK query() subprocesses — only one CLI at a time.

let chain: Promise<void> = Promise.resolve();

export function withSdkGate<T>(fn: () => Promise<T>): Promise<T> {
	const run = chain.then(fn);
	chain = run.then(() => undefined, () => undefined);
	return run;
}
