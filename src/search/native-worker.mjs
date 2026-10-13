// Worker protocol compatible with embed-worker, owning one verified, hidden, loopback-only native process.
// Cancellation settles only after its child exits. No configured external endpoint or model download exists.
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { rgbPng, pcmWav } from "./media-bytes.mjs";

const aborted = () => Object.assign(new Error("Native embeddings cancelled."), { name: "AbortError" });
const delay = (ms, signal) => new Promise((resolve, reject) => { const timer = setTimeout(done, ms); const cancel = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(signal.reason ?? aborted()); }; function done() { signal.removeEventListener("abort", cancel); resolve(); } signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel(); });
async function freePort(signal) {
	signal.throwIfAborted(); const server = net.createServer();
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const port = server.address().port; await new Promise(resolve => server.close(resolve)); signal.throwIfAborted(); return port;
}
export function validateNativeVectors(body, count, dimensions) {
	if (![128, 256, 512, 768].includes(dimensions) || !Array.isArray(body?.data) || body.data.length !== count) throw new Error("Native embeddings returned the wrong batch or dimensions.");
	const result = new Array(count), seen = new Set();
	for (const row of body.data) {
		if (!Number.isInteger(row.index) || row.index < 0 || row.index >= count || seen.has(row.index) || !Array.isArray(row.embedding) || row.embedding.length !== 768 || row.embedding.some(value => typeof value !== "number" || !Number.isFinite(value))) throw new Error("Native embeddings returned invalid indices or vectors.");
		seen.add(row.index); const fullNorm = Math.hypot(...row.embedding);
		if (Math.abs(fullNorm - 1) >= 0.001) throw new Error("Native embeddings returned a non-normalized vector.");
		const vector = row.embedding.slice(0, dimensions), norm = Math.hypot(...vector);
		if (!Number.isFinite(norm) || norm <= 0) throw new Error("Native embeddings returned an empty truncated vector.");
		result[row.index] = vector.map(value => value / norm);
	}
	return result;
}
export function createNativeEmbeddingWorker({ assets, timeoutMs = 180_000, fetchImpl = fetch, spawnImpl = spawn }) {
	const worker = new EventEmitter(), controller = new AbortController(), key = randomBytes(32).toString("hex");
	let child, childExit, start, baseUrl, modelAlias, dimensions = 768, terminated = false, stopping, identity;
	const progress = (phase, message) => worker.emit("message", { event: "progress", phase, message });
	async function json(route, input) {
		controller.signal.throwIfAborted();
		const response = await fetchImpl(`${baseUrl}${route}`, { method: input ? "POST" : "GET", headers: { authorization: `Bearer ${key}`, ...(input ? { "content-type": "application/json" } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}), redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]) });
		if (!response.ok) throw new Error(`Native embeddings ${route} failed (${response.status}).`);
		const bytes = await response.text(); if (bytes.length > 4 * 1024 * 1024) throw new Error("Native embedding response exceeded its budget."); return JSON.parse(bytes);
	}
	async function load() {
		progress("verifying", "Checking the cached Gemma model and native runtime");
		identity = await assets.verify({ signal: controller.signal }); controller.signal.throwIfAborted();
		const port = await freePort(controller.signal), alias = `midnight-embed-${randomBytes(12).toString("hex")}`;
		baseUrl = `http://127.0.0.1:${port}`; modelAlias = alias;
		const env = { ...process.env }; for (const name of Object.keys(env)) if (name.startsWith("LLAMA_ARG_")) delete env[name];
		const threads = Math.min(4, Math.max(1, Math.floor((os.availableParallelism?.() ?? os.cpus().length) / 2)));
		const args = ["--model", identity.modelFile, "--mmproj", identity.projectorFile, "--alias", alias, "--embeddings", "--pooling", "mean", "--embd-normalize", "2", "--ctx-size", "2048", "--batch-size", "2048", "--ubatch-size", "2048", "--parallel", "1", "--threads", String(threads), "--threads-batch", String(threads), "--device", "none", "--n-gpu-layers", "0", "--no-mmproj-offload", "--host", "127.0.0.1", "--port", String(port), "--api-key", key, "--offline", "--no-webui", "--no-ui-mcp-proxy", "--no-slots", "--log-disable"];
		progress("loading", "Loading the existing Gemma embeddings locally");
		controller.signal.throwIfAborted();
		child = spawnImpl(identity.exe, args, { cwd: identity.dir, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		childExit = new Promise(resolve => { child.once("close", (code, signal) => { resolve({ code, signal }); if (!terminated) worker.emit("exit", code ?? 1); }); child.once("error", error => { if (!terminated) worker.emit("error", new Error(`The cached native embedder could not start (${error.code ?? "error"}).`)); }); });
		child.stdout?.on("data", () => {}); child.stderr?.on("data", () => {});
		const end = Date.now() + timeoutMs;
		for (;;) {
			controller.signal.throwIfAborted(); if (child.exitCode !== null || child.signalCode !== null) throw new Error("The cached native embedder stopped during loading.");
			try {
				const props = await json("/props");
				const models = await json("/v1/models");
				if (!models.data?.some(model => model.id === alias) || path.resolve(props.model_path ?? "") !== path.resolve(identity.modelFile)) throw Object.assign(new Error("Native embedding endpoint does not belong to this process/model."), { identityMismatch: true });
				break;
			} catch (err) { if (err.identityMismatch || controller.signal.aborted || Date.now() >= end) throw err; await delay(100, controller.signal); }
		}
		await text(["task: search result | query: warm up"]);
		return { ...assets.identity, dimensions, device: "cpu", threads, pid: child.pid, modalities: ["text", "image", "pdf", "audio", "video"] };
	}
	async function embeddings(input) { const body = await json("/v1/embeddings", { model: modelAlias, input, encoding_format: "float" }); return validateNativeVectors(body, input.length, dimensions); }
	async function text(texts) {
		if (!Array.isArray(texts) || texts.length > 120 || texts.some(value => typeof value !== "string" || value.length > 16000)) throw new Error("Native embedding text exceeded its batch budget.");
		const result = []; for (const value of texts) result.push(...await embeddings([value])); return result;
	}
	async function image(input) { return (await embeddings([{ content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${rgbPng(input).toString("base64")}` } }] }]))[0]; }
	async function audio(input) { return (await embeddings([{ content: [{ type: "input_audio", input_audio: { data: pcmWav(input.samples).toString("base64"), format: "wav" } }] }]))[0]; }
	worker.postMessage = message => {
		void (async () => {
			try {
				controller.signal.throwIfAborted(); let result;
				if (message.op === "load") {
					if (![128, 256, 512, 768].includes(message.dimensions)) throw new Error("Unsupported native embedding dimensions.");
					dimensions = message.dimensions; start ??= load(); result = await start;
					if (message.verify) {
						const empty = (await text([""]))[0], visual = await image({ rgb: new Uint8Array(32 * 32 * 3).fill(128), width: 32, height: 32 }), acoustic = await audio({ samples: Float32Array.from({ length: 16000 }, (_, i) => 0.2 * Math.sin(i / 8)) });
						for (const vector of [visual, acoustic]) if (vector.every((value, i) => Math.abs(value - empty[i]) < 1e-7)) throw new Error("The native model ignored a required media encoder.");
					}
				} else {
					if (!start) throw new Error("The cached native embedder is not loaded."); await start;
					if (message.op === "text") result = await text(message.texts);
					else if (message.op === "image") result = await image(message);
					else if (message.op === "audio") result = await audio(message);
					else throw new Error("Unsupported native embedding operation.");
				}
				if (!terminated) worker.emit("message", { id: message.id, ok: true, result });
			} catch (error) { if (!terminated) worker.emit("message", { id: message.id, ok: false, error: { message: error.message, code: "SEARCH_NATIVE_ERROR" } }); }
		})();
	};
	worker.terminate = () => {
		if (stopping) return stopping; terminated = true; controller.abort(aborted());
		stopping = (async () => { if (child) { child.kill(); await childExit; } worker.emit("exit", 0); })(); return stopping;
	};
	return worker;
}
