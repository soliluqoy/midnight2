// A job owns one bounded worker for public source operations. Cancellation settles only after thread exit.
import { Worker } from "node:worker_threads";
const ENTRY = new URL("./source-worker.mjs", import.meta.url);

export function createSourceWorkspaceWorker({ directory, sourceRoot, baseDigest, signal, timeoutMs = 120_000, workerFactory = options => new Worker(ENTRY, options) }) {
	signal?.throwIfAborted();
	const worker = workerFactory({ workerData: { directory, sourceRoot, baseDigest }, env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
	const pending = new Map(); let sequence = 0, closed = false, exited = false, failure, serial = Promise.resolve(), closing;
	let exitedResolve; const exit = new Promise(resolve => { exitedResolve = resolve; });
	function stop(reason = new Error("Source workspace stopped.")) {
		if (closing) return closing;
		closed = true; failure ??= reason;
		if (!exited) { try { void Promise.resolve(worker.terminate()).catch(() => {}); } catch {} }
		return closing = exit;
	}
	const aborted = () => { void stop(signal.reason ?? new Error("Source workspace cancelled.")); };
	signal?.addEventListener("abort", aborted, { once: true });
	worker.on("message", message => {
		if (closed || signal?.aborted) return;
		const request = pending.get(message?.id); if (!request) return;
		pending.delete(message.id); clearTimeout(request.timer);
		message.ok ? request.resolve(message.result) : request.reject(new Error(message.error));
	});
	worker.on("error", error => { failure ??= error; void stop(error); });
	worker.once("exit", code => {
		exited = true; closed = true; signal?.removeEventListener("abort", aborted);
		failure ??= new Error(`Source workspace exited before completing its operation (${code}).`);
		for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failure); } pending.clear(); exitedResolve();
	});
	return {
		call(op, args = {}) {
			const operation = serial.then(() => {
				signal?.throwIfAborted(); if (closed) throw failure;
				return new Promise((resolve, reject) => {
					const id = ++sequence, timer = setTimeout(() => { void stop(new Error("Source workspace exceeded its operation deadline.")); }, timeoutMs);
					pending.set(id, { resolve, reject, timer });
					try { worker.postMessage({ id, op, args }); } catch (error) { void stop(error); }
				});
			});
			serial = operation.catch(() => {}); return operation;
		},
		close: stop,
		status: () => ({ threadId: worker.threadId, exited, closing: closed, busy: pending.size > 0 }),
	};
}
