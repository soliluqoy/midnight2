// Separate supervised Pi session. Candidate JavaScript is never imported or executed in this process.
import { runBuilderTurn } from "./turn.mjs";
import { corePaths } from "../runtime/paths.mjs";
const port = process.parentPort, pending = new Map(); let sequence = 0; const controller = new AbortController();
const maintenance = (op, args) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); port.postMessage({ kind: "maintenance", id, op, args }); });
port.on("message", async ({ data: message }) => {
	if (message.kind === "init") {
		try { const result = await runBuilderTurn({ job: message.job, core: corePaths(), maintenance, signal: controller.signal, live: event => port.postMessage({ kind: "progress", event: { type: event.type } }) }); port.postMessage({ kind: "done", result }); }
		catch (error) { port.postMessage({ kind: "done", result: { error: error.message } }); }
	} else if (message.kind === "maintenance-result") { const request = pending.get(message.id); pending.delete(message.id); if (request) message.ok ? request.resolve(message.result) : request.reject(new Error(message.error)); }
	else if (message.kind === "stop") controller.abort(new Error("Builder stopped."));
});
