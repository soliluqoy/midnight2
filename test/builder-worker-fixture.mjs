// Test-only scripted provider in an actual separate utility process. Production runner never loads this entry.
import { makeModel, fauxAssistantMessage, fauxText, fauxToolCall } from "./e2e-helpers.mjs";
import { runBuilderTurn } from "../src/builder/turn.mjs";
const port = process.parentPort, pending = new Map(); let sequence = 0; const controller = new AbortController();
const maintenance = (op, args) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); port.postMessage({ kind: "maintenance", id, op, args }); });
port.on("message", async ({ data: message }) => {
	if (message.kind === "init") {
		if (message.job.fixture === "wait-for-rpc") {
			await maintenance("fixture.wait", { pid: process.pid }); port.postMessage({ kind: "done", result: { ok: true } }); return;
		}
		const model = await makeModel();
		model.faux.setResponses([
			() => fauxAssistantMessage([fauxToolCall("builder_read", { filename: "renderer.js" }, { id: "read" })]),
			ctx => { const reply = ctx.messages.findLast(value => value.role === "toolResult"); const source = JSON.parse(reply.content[0].text).text; const next = message.job.pluginId === "midnight.theme" ? source.replace("#7662b7", "#176b65").replace("#7c66c0", "#176b65").replace("#322d43", "#173530").replace("#c4b5f3", "#a0e8d0") : message.job.scope === "user" ? source.replace("#8068e8", "#1177aa") : source.replace("const L = 64", "const L = 80"); return fauxAssistantMessage([fauxToolCall("builder_write", { filename: "renderer.js", text: next }, { id: "write" })]); },
			() => fauxAssistantMessage([fauxText("Candidate renderer source updated.")]),
		]);
		try { const result = await runBuilderTurn({ job: message.job, core: model.core, modelRuntime: model.rt, maintenance, signal: controller.signal }); port.postMessage({ kind: "done", result }); }
		catch (error) { port.postMessage({ kind: "done", result: { error: error.message } }); }
	} else if (message.kind === "maintenance-result") { const request = pending.get(message.id); pending.delete(message.id); message.ok ? request?.resolve(message.result) : request?.reject(new Error(message.error)); }
	else if (message.kind === "stop") controller.abort();
});
