// EmbeddingGemma 2 in a worker thread of the engine (ONNX Runtime through Transformers.js; no Python). The runtime
// talks to it with { id, op, ... } messages. It never uses the network: setup downloads and verifies the files.
import os from "node:os";
import { parentPort, workerData } from "node:worker_threads";

const { cacheDir, model: MODEL, revision: REVISION, dtype: DTYPE } = workerData;
const send = (m) => parentPort.postMessage(m);
const progress = (phase, message, extra = {}) => send({ event: "progress", phase, message, ...extra });

let tf;
let model;
let processor;
let dims = 768;

async function library() {
	tf ??= await import("@huggingface/transformers");
	tf.env.cacheDir = cacheDir;
	// Loads read the verified files from the private cache. Local-files-only mode requires "local models" on; their
	// folder path is never used, so it points at an empty location inside the cache.
	tf.env.allowLocalModels = true;
	tf.env.localModelPath = `${cacheDir}/.no-local-models/`;
	tf.env.allowRemoteModels = false;
	tf.env.useBrowserCache = false;
	// Leave capacity for the desktop and chat while background indexing runs.
	const threads = Math.min(4, Math.max(1, Math.floor((os.availableParallelism?.() ?? os.cpus().length) / 2)));
	if (tf.env.backends?.onnx) tf.env.backends.onnx.numThreads = threads;
	return tf;
}

// Setup downloaded the pinned, hash-checked files (model-files.mjs) where Transformers.js looks for the default
// revision; loads here are offline-only.
const options = (device) => ({ dtype: DTYPE, device, local_files_only: true, session_options: { intraOpNumThreads: Math.min(4, Math.max(1, Math.floor(os.cpus().length / 2))) } });

async function load(device, dimensions, verify) {
	const t = await library();
	progress("loading", "Loading EmbeddingGemma 2 locally");
	dims = dimensions;
	processor = await t.AutoProcessor.from_pretrained(MODEL, { local_files_only: true });
	try {
		model = await t.AutoModel.from_pretrained(MODEL, options(device));
	} catch (err) {
		if (device === "cpu") throw err;
		progress("loading", "The GPU is unavailable; loading on the CPU");
		model = await t.AutoModel.from_pretrained(MODEL, options("cpu"));
		device = "cpu";
	}
	progress("verifying", "Checking text search");
	await text(["task: search result | query: warm up"]);
	if (verify) {
		// Setup checks every encoder before reporting the model installed.
		await image({ rgb: new Uint8Array(32 * 32 * 3).fill(128), width: 32, height: 32 });
		await audio({ samples: new Float32Array(16000).map((_, i) => 0.2 * Math.sin(i / 8)) });
	}
	return { model: MODEL, revision: REVISION, dtype: DTYPE, dimensions: dims, device, modalities: ["text", "image", "pdf", "audio", "video"] };
}

/** Matryoshka truncation, then L2 normalization (the model card requires re-normalizing). */
function vectors(tensor) {
	const out = [];
	for (const row of tensor.tolist()) {
		const v = row.slice(0, dims);
		const n = Math.hypot(...v);
		if (!Number.isFinite(n) || n <= 0) throw new Error("The model returned an empty vector.");
		out.push(v.map((x) => x / n));
	}
	return out;
}

async function text(texts) {
	const out = [];
	for (let i = 0; i < texts.length; i += 4) {
		const inputs = await processor.tokenizer(texts.slice(i, i + 4), { padding: true, truncation: true, max_length: 2048 });
		out.push(...vectors((await model(inputs)).sentence_embedding));
		if (texts.length > 4) progress("embedding", "Reading document passages", { segments: out.length });
	}
	return out;
}

async function image({ rgb, width, height }) {
	const img = new tf.RawImage(rgb, width, height, 3);
	return vectors((await model(await processor(null, img))).sentence_embedding)[0];
}

async function audio({ samples }) {
	return vectors((await model(await processor(null, null, samples))).sentence_embedding)[0];
}

parentPort.on("message", async (m) => {
	try {
		let result;
		if (m.op === "load") result = await load(m.device, m.dimensions, m.verify);
		else if (!model) throw new Error("The local model is not loaded.");
		else if (m.op === "text") result = await text(m.texts);
		else if (m.op === "image") result = await image(m);
		else if (m.op === "audio") result = await audio(m);
		else throw new Error(`Unsupported worker operation ${m.op}`);
		send({ id: m.id, ok: true, result });
	} catch (err) {
		send({ id: m.id, ok: false, error: { message: String(err?.message ?? err).slice(0, 1200), code: m.op === "load" ? "SEARCH_SETUP_REQUIRED" : "SEARCH_MEDIA_ERROR" } });
	}
});
