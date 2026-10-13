import { utilityProcess } from "electron";
import { fileURLToPath } from "node:url";
const ENTRY = fileURLToPath(new URL("../builder/process.mjs", import.meta.url));

export function createBuilderRunner({ maintenance, entry = ENTRY, timeoutMs = 10 * 60_000, sourceTimeoutMs = 20 * 60_000 }) {
	const active = new Set(); let closed = false;
	return {
		isBusy: () => active.size > 0,
		run(job, { signal } = {}) {
			if (closed) return Promise.reject(new Error("The builder runner is closed."));
			signal?.throwIfAborted();
			return new Promise((resolve, reject) => {
				const child = utilityProcess.fork(entry, [], { serviceName: "Midnight builder", stdio: "pipe" }); active.add(child);
				let result, failure, stopping = false, forceStop;
				const send = message => { if (!active.has(child)) return; try { child.postMessage(message); } catch {} };
				const stop = error => { if (stopping || !active.has(child)) return; stopping = true; failure = error; send({ kind: "stop" }); forceStop = setTimeout(() => { if (active.has(child)) child.kill(); }, 1000); forceStop.unref?.(); };
				const cancel = () => stop(signal.reason ?? new Error("Builder cancelled."));
				const timeout = setTimeout(() => stop(new Error("Builder exceeded its job deadline.")), job.kind === "core" ? sourceTimeoutMs : timeoutMs);
				signal?.addEventListener("abort", cancel, { once: true });
				child.stdout?.on("data", () => {}); child.stderr?.on("data", () => {});
				child.on("message", async message => {
					if (!active.has(child) || stopping) return;
					if (message.kind === "maintenance") {
						try { const value = await maintenance({ jobId: job.jobId, op: message.op, args: message.args }); send({ kind: "maintenance-result", id: message.id, ok: true, result: value }); }
						catch (error) { send({ kind: "maintenance-result", id: message.id, ok: false, error: error.message }); }
					} else if (message.kind === "done") { result = message.result; child.kill(); }
				});
				child.once("exit", () => { active.delete(child); clearTimeout(timeout); clearTimeout(forceStop); signal?.removeEventListener("abort", cancel); failure ? reject(failure) : result ? resolve(result) : reject(new Error("The builder process stopped before producing a result.")); });
				send({ kind: "init", job });
			});
		},
		close() { closed = true; for (const child of active) child.kill(); },
	};
}
