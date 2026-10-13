// Whisper speech recognition in a worker thread of the engine (ONNX Runtime through Transformers.js). Loads only
// the pinned files voice setup downloaded; never uses the network. Messages: { id, op: "load" | "transcribe" }.
import { parentPort, workerData } from "node:worker_threads";

const { cacheDir, model: MODEL, dtype: DTYPE } = workerData;
let asr;

async function load() {
	const tf = await import("@huggingface/transformers");
	tf.env.cacheDir = cacheDir;
	tf.env.allowLocalModels = true; // required by local-files-only loads; the folder path itself is never used
	tf.env.localModelPath = `${cacheDir}/.no-local-models/`;
	tf.env.allowRemoteModels = false;
	tf.env.useBrowserCache = false;
	asr = await tf.pipeline("automatic-speech-recognition", MODEL, { dtype: DTYPE, device: "cpu", local_files_only: true, session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } });
	return { model: MODEL, dtype: DTYPE };
}

async function transcribe({ samples, language }) {
	if (!(samples instanceof Float32Array) || samples.length < 1600) return { text: "" };
	const out = await asr(samples, { language: language || null, task: "transcribe", chunk_length_s: samples.length > 30 * 16000 ? 30 : undefined, stride_length_s: samples.length > 30 * 16000 ? 5 : undefined });
	return { text: String(out?.text ?? "").trim() };
}

parentPort.on("message", async (m) => {
	try {
		const result = m.op === "load" ? await load() : m.op === "transcribe" ? (asr ? await transcribe(m) : Promise.reject(new Error("The speech model is not loaded."))) : Promise.reject(new Error(`unknown op ${m.op}`));
		parentPort.postMessage({ id: m.id, ok: true, result: await result });
	} catch (err) {
		parentPort.postMessage({ id: m.id, ok: false, error: String(err?.message ?? err).slice(0, 800) });
	} finally { m.samples?.fill(0); }
});
