// Local EmbeddingGemma 2 for file search and context, with no Python: ONNX Runtime through Transformers.js runs in a
// worker thread of the engine, and media (images, PDF pages, video frames, audio) is decoded by the shell's hidden
// Chromium decoder (src/desktop/media-decoder.mjs). Only setup may use the network; the model revision is pinned.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { downloadModel, MODEL_BYTES, MODEL_ID, MODEL_REVISION } from "./model-files.mjs";

export const EMBEDDING_MODEL = MODEL_ID;
export const EMBEDDING_REVISION = MODEL_REVISION;
// q8 keeps quality within 0.9997 cosine of fp32 for every modality at about 850 MB (the model card's table).
export const EMBEDDING_DTYPE = "q8";
const WORKER = new URL("./embed-worker.mjs", import.meta.url);
const PIPELINE = "midnight-multimodal-v2-pdf1600-audio30-hop25-video5";
const RATE = 16000;
const WINDOW_S = 30;
const HOP_S = 25;
const VIDEO_STEP_S = 5;
const abortError = () => Object.assign(new Error("Local search was cancelled."), { name: "AbortError", code: "SEARCH_CANCELLED" });
const failure = (message, code = "SEARCH_RUNTIME_ERROR") => Object.assign(new Error(message), { code });

/** The GPU choice maps to the platform's ONNX Runtime provider; anything unavailable falls back to the CPU. */
export const onnxDevice = (device, platform = process.platform) => device !== "gpu" ? "cpu" : platform === "win32" ? "dml" : platform === "darwin" ? "coreml" : "cuda";

/**
 * @param {{ settings: object | (() => object), paths: { dataDir: string }, decodeMedia?: (filePath: string, kind: string, o?: object) => Promise<object>, workerFactory?: (data: object) => object, download?: typeof downloadModel, timeoutMs?: number, idleMs?: number }} o
 */
export function createEmbeddingRuntime({ settings, paths, decodeMedia, workerFactory = (data) => new Worker(WORKER, { workerData: data }), download = downloadModel, timeoutMs = 20 * 60_000, idleMs = 60_000 }) {
	const getSettings = typeof settings === "function" ? settings : () => settings ?? {};
	const runtimeDir = path.join(paths.dataDir, "search-runtime");
	const cacheDir = path.join(runtimeDir, "models");
	const manifestPath = path.join(runtimeDir, "prepared.json");
	// Setup's worker must not read the "prepared" manifest it is about to write, so loads never depend on it.
	let worker, pending = new Map(), startup, sequence = 0, chain = Promise.resolve(), phase = "missing", lastError, workerInfo, workerFingerprint, progressSink;
	let setupPromise, setupController;
	let idleTimer, closed = false, queued = 0;
	function configuration() {
		const embedding = getSettings().embedding ?? {};
		const dimensions = embedding.dimensions ?? 768;
		if (![128, 256, 512, 768].includes(dimensions)) throw failure("Embedding dimensions must be 128, 256, 512 or 768.", "SEARCH_CONFIG_INVALID");
		const device = embedding.device ?? "cpu";
		if (!["cpu", "gpu"].includes(device)) throw failure("Embedding device must be cpu or gpu.", "SEARCH_CONFIG_INVALID");
		return { dimensions, device };
	}
	function manifest() {
		try {
			const info = JSON.parse(readFileSync(manifestPath, "utf8"));
			return info.model === EMBEDDING_MODEL && info.revision === EMBEDDING_REVISION && info.dtype === EMBEDDING_DTYPE && existsSync(cacheDir) ? info : null;
		} catch {
			return null;
		}
	}
	function fingerprint() {
		const config = configuration();
		// Vectors depend on the model, quantization, output size and pipeline; the device does not change them.
		return JSON.stringify({ model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, dtype: EMBEDDING_DTYPE, dimensions: config.dimensions, pipeline: PIPELINE });
	}
	function status() {
		const config = configuration();
		const available = !!manifest();
		return { ...(workerInfo ?? {}), model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, dtype: EMBEDDING_DTYPE, ...config, runtimeDir, available, busy: queued > 0 || !!setupPromise, ready: !!worker && phase === "ready" && workerFingerprint === fingerprint(), phase: phase === "missing" && available ? "available" : phase, fingerprint: fingerprint(), modalities: ["text", "image", "pdf", "audio", "video"], ...(lastError ? { error: lastError } : {}) };
	}
	function stop(error = failure("Local search runtime closed.", "SEARCH_RUNTIME_CLOSED")) {
		clearTimeout(idleTimer);
		idleTimer = undefined;
		const running = worker;
		worker = undefined;
		startup = undefined;
		workerInfo = undefined;
		workerFingerprint = undefined;
		for (const p of pending.values()) p.reject(error);
		pending = new Map();
		running?.terminate();
		if (phase !== "setting-up") phase = manifest() ? "available" : "missing";
	}
	function releaseWhenIdle() {
		clearTimeout(idleTimer);
		if (!worker || pending.size || phase !== "ready") return;
		idleTimer = setTimeout(() => stop(), idleMs);
		idleTimer.unref?.();
	}
	function spawn(onProgress) {
		const w = workerFactory({ cacheDir, model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, dtype: EMBEDDING_DTYPE });
		const fail = (error) => {
			if (worker !== w) return;
			lastError = error.message;
			stop(error);
			phase = "error";
		};
		w.on("message", (m) => {
			if (m?.event === "progress") return (progressSink ?? onProgress)?.(m);
			const p = pending.get(m?.id);
			if (!p) return;
			pending.delete(m.id);
			m.ok ? p.resolve(m.result) : p.reject(failure(m.error?.message ?? "Local embedding failed.", m.error?.code));
		});
		w.on("error", (err) => fail(failure(`The local model stopped: ${err.message}`, "SEARCH_WORKER_STOPPED")));
		w.on("exit", (code) => fail(failure(`The local model stopped (${code}).`, "SEARCH_WORKER_STOPPED")));
		return w;
	}
	function send(w, message, timeout = timeoutMs) {
		return new Promise((resolve, reject) => {
			const id = ++sequence;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(failure("Local embedding timed out.", "SEARCH_TIMEOUT"));
				if (worker === w) stop(failure("Local embedding timed out.", "SEARCH_TIMEOUT"));
				else w.terminate();
			}, timeout);
			pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
			w.postMessage({ id, ...message });
		});
	}
	async function setup({ signal, onProgress } = {}) {
		if (closed) throw failure("Local search runtime is closed.", "SEARCH_RUNTIME_CLOSED");
		if (setupPromise) return setupPromise;
		stop();
		phase = "setting-up";
		lastError = undefined;
		setupController = new AbortController();
		const combined = signal ? AbortSignal.any([signal, setupController.signal]) : setupController.signal;
		setupPromise = (async () => {
			let w;
			const cancel = () => w?.terminate();
			try {
				await mkdir(cacheDir, { recursive: true });
				onProgress?.({ phase: "downloading", message: `Downloading EmbeddingGemma 2 (about ${Math.round(MODEL_BYTES / 1e6)} MB, once)` });
				// Pinned files, each checked against its hash before it is kept; already-verified files are reused.
				await download({ cacheDir, signal: combined, onProgress });
				if (combined.aborted) throw abortError();
				// Load once offline (text, then the image and audio encoders) before reporting the model installed.
				onProgress?.({ phase: "verifying", message: "Checking the local model" });
				w = spawn(onProgress);
				combined.addEventListener("abort", cancel, { once: true });
				const abort = new Promise((_, reject) => combined.addEventListener("abort", () => reject(abortError()), { once: true }));
				const info = await Promise.race([send(w, { op: "load", device: "cpu", dimensions: 768, verify: true }, timeoutMs), abort]);
				writeFileSync(manifestPath, JSON.stringify({ model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, dtype: EMBEDDING_DTYPE, pipeline: PIPELINE, preparedAt: new Date().toISOString(), modalities: info?.modalities }, null, 2));
				phase = "available";
				return status();
			} catch (error) {
				phase = error.name === "AbortError" ? "missing" : "error";
				lastError = error.message;
				throw error;
			} finally {
				combined.removeEventListener("abort", cancel);
				w?.terminate();
				setupPromise = undefined;
				setupController = undefined;
			}
		})();
		return setupPromise;
	}
	function startWorker(signal, onProgress) {
		clearTimeout(idleTimer);
		idleTimer = undefined;
		if (worker && workerFingerprint !== fingerprint()) stop();
		if (worker && phase === "ready") return Promise.resolve();
		if (startup) return startup;
		if (!status().available) return Promise.reject(failure("Local search is not set up. Open Files → Manage search and choose Install local search.", "SEARCH_SETUP_REQUIRED"));
		if (signal?.aborted) return Promise.reject(abortError());
		phase = "loading";
		lastError = undefined;
		const config = configuration();
		const w = spawn(onProgress);
		worker = w;
		workerFingerprint = fingerprint();
		startup = send(w, { op: "load", device: onnxDevice(config.device), dimensions: config.dimensions }, timeoutMs).then(
			(info) => {
				if (worker !== w) throw failure("Local search runtime restarted.", "SEARCH_WORKER_STOPPED");
				workerInfo = info;
				phase = "ready";
				startup = undefined;
			},
			(error) => {
				if (worker === w) {
					lastError = error.message;
					stop(error);
					phase = "error";
				}
				startup = undefined;
				throw error;
			},
		);
		return startup;
	}
	/** Serialized worker operation; a cancelled caller stops waiting without disturbing another caller's work. */
	function request(op, input, { signal, onProgress, keepWorkerOnAbort = false } = {}) {
		const task = async () => {
			if (closed) throw failure("Local search runtime is closed.", "SEARCH_RUNTIME_CLOSED");
			if (signal?.aborted) throw abortError();
			if (setupPromise) throw failure("Local search setup is still running.", "SEARCH_SETUP_RUNNING");
			await startWorker(signal, onProgress);
			if (signal?.aborted) throw abortError();
			const cancel = () => { if (!keepWorkerOnAbort) stop(abortError()); };
			signal?.addEventListener("abort", cancel, { once: true });
			progressSink = onProgress;
			try {
				return await send(worker, { op, ...input });
			} finally {
				progressSink = undefined;
				signal?.removeEventListener("abort", cancel);
				releaseWhenIdle();
			}
		};
		queued++;
		const result = chain.then(task, task).finally(() => queued--);
		chain = result.catch(() => {});
		if (!signal) return result;
		return new Promise((resolve, reject) => {
			const cancel = () => reject(abortError());
			if (signal.aborted) return cancel();
			signal.addEventListener("abort", cancel, { once: true });
			result.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
		});
	}
	async function embedText(texts, { query = false, signal, onProgress, keepWorkerOnAbort = false } = {}) {
		if (!Array.isArray(texts) || texts.some((text) => typeof text !== "string")) throw failure("Embedding text must be an array of strings.");
		if (!texts.length) return [];
		const prompted = texts.map((text) => (query ? `task: search result | query: ${text}` : `title: none | text: ${text}`));
		return request("text", { texts: prompted }, { signal, onProgress, keepWorkerOnAbort });
	}
	const checkSignal = (signal) => { if (signal?.aborted) throw abortError(); };
	async function embedMedia(filePath, kind, { signal, maxSegments = 120, onProgress } = {}) {
		if (!["image", "pdf", "audio", "video"].includes(kind)) throw failure(`Visual rendering for ${kind} is unavailable. Export slides to PDF to search their visual content.`, "SEARCH_MEDIA_UNSUPPORTED");
		if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw failure("Media search requires an absolute local file path.");
		if (!decodeMedia) throw failure("Media decoding is unavailable in this process.", "SEARCH_MEDIA_UNSUPPORTED");
		const maximum = Math.min(500, Math.max(1, Math.trunc(maxSegments) || 120));
		const segments = [];
		let truncated = false;
		const media = await decodeMedia(filePath, kind, { signal });
		try {
			const imageSegment = async (frame, locator, text = "") => {
				const vector = await request("image", { rgb: frame.rgb, width: frame.width, height: frame.height }, { signal });
				segments.push({ vector, text: text.slice(0, 6000), locator: { ...locator, modality: "image" } });
				onProgress?.({ phase: "embedding", message: "Reading media", segments: segments.length, locator });
			};
			// Words in pictures and scanned pages: Windows OCR text joins the passage, so exact words find them too.
			const ocrText = async (o) => (media.ocr ? (await media.ocr(o).catch(() => null))?.text ?? "" : "");
			if (kind === "image") await imageSegment(await media.frame({ max: 1600 }), {}, await ocrText({}));
			else if (kind === "pdf") {
				const pages = media.info.pages ?? 0;
				truncated = pages > maximum;
				for (let page = 1; page <= Math.min(pages, maximum); page++) {
					checkSignal(signal);
					let { text } = await media.text({ page });
					if (text.trim().length < 20) text = [text, await ocrText({ page })].filter(Boolean).join("\n");
					await imageSegment(await media.frame({ page, max: 1600 }), { page }, text);
				}
			} else if (kind === "audio") truncated = await audioSegments(media, maximum, segments, { signal, onProgress });
			else {
				const duration = media.info.duration ?? 0;
				let hasAudio = true;
				try { await media.audio({ start: 0, seconds: 0.1 }); } catch { hasAudio = false; }
				// Reserve soundtrack capacity so frame-heavy clips never hide all their spoken content.
				const visualLimit = hasAudio && maximum > 1 ? Math.max(1, Math.floor(maximum / 2)) : maximum;
				for (let t = 0; t < Math.max(duration, 0.001); t += VIDEO_STEP_S) {
					checkSignal(signal);
					if (segments.length >= visualLimit) { truncated = true; break; }
					await imageSegment(await media.frame({ seconds: t, max: 1600 }), { seconds: t, endSeconds: t + VIDEO_STEP_S });
				}
				if (hasAudio) {
					const remaining = maximum - segments.length;
					if (remaining) truncated = (await audioSegments(media, remaining, segments, { signal, onProgress })) || truncated;
					else truncated = true;
				}
			}
		} finally {
			await media.close();
		}
		return { segments, truncated };
	}
	async function audioSegments(media, maximum, segments, { signal, onProgress }) {
		let produced = 0;
		for (let start = 0; ; start += HOP_S) {
			checkSignal(signal);
			const { samples, total } = await media.audio({ start, seconds: WINDOW_S });
			const last = start + WINDOW_S >= total;
			// Skip silence and fragments under a second (the tail is covered by the previous window's overlap).
			let energy = 0;
			for (let i = 0; i < samples.length; i += 4) energy += samples[i] * samples[i];
			const rms = Math.sqrt(energy / Math.max(1, Math.ceil(samples.length / 4)));
			const covered = start > 0 && samples.length <= (WINDOW_S - HOP_S) * RATE;
			if (samples.length >= RATE && rms > 0.003 && !covered) {
				if (produced >= maximum) return true;
				const vector = await request("audio", { samples }, { signal });
				const locator = { seconds: start, endSeconds: start + samples.length / RATE, modality: "audio" };
				segments.push({ vector, text: "", locator });
				produced++;
				onProgress?.({ phase: "embedding", message: "Listening to media", segments: segments.length, locator });
			}
			if (last) return false;
		}
	}
	return { fingerprint, status, setup, embedText, embedMedia, close() { closed = true; setupController?.abort(); stop(); } };
}
