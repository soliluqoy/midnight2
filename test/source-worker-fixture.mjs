// Owned lifecycle fixture. It performs no filesystem work and is never packaged.
import { parentPort, workerData, threadId } from "node:worker_threads";
parentPort.on("message", message => {
	parentPort.postMessage({ kind: "entered", threadId, op: message.op });
	Atomics.wait(new Int32Array(workerData.wait), 0, 0, 30_000);
	parentPort.postMessage({ id: message.id, ok: false, error: "Owned waiting fixture finished." });
});
