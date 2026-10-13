// Local EmbeddingGemma 2 reuses the verified native cache when ONNX is not prepared. Both routes are Python-free;
// media decoding stays in the shell. Only explicit ONNX setup may download. Each backend has its own fingerprint.
import { existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { downloadModel, MODEL_BYTES, MODEL_ID, MODEL_REVISION } from "./model-files.mjs";
import { createNativeEmbeddingAssets } from "./native-assets.mjs";
import { createNativeEmbeddingWorker } from "./native-worker.mjs";

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
const defaultWorkerFactory = data => new Worker(WORKER, { workerData: data });

/** The GPU choice maps to the platform's ONNX Runtime provider; anything unavailable falls back to the CPU. */
export const onnxDevice = (device, platform = process.platform) => device !== "gpu" ? "cpu" : platform === "win32" ? "dml" : platform === "darwin" ? "coreml" : "cuda";

/**
 * @param {{ settings: object | (() => object), paths: { dataDir: string }, decodeMedia?: (filePath: string, kind: string, o?: object) => Promise<object>, workerFactory?: (data: object) => object, download?: typeof downloadModel, timeoutMs?: number, idleMs?: number }} o
 */
export function createEmbeddingRuntime({ settings, paths, decodeMedia, workerFactory = defaultWorkerFactory, nativeAssets, nativeWorkerFactory = createNativeEmbeddingWorker, download = downloadModel, timeoutMs = 20 * 60_000, idleMs = 60_000, arbiter, residencyBudget }) {
	const getSettings = typeof settings === "function" ? settings : () => settings ?? {};
	const runtimeDir = path.join(paths.dataDir, "search-runtime");
	const cacheDir = path.join(runtimeDir, "models");
	const manifestPath = path.join(runtimeDir, "prepared.json");
	nativeAssets ??= workerFactory === defaultWorkerFactory ? createNativeEmbeddingAssets() : undefined;
	// Setup's worker must not read the "prepared" manifest it is about to write, so loads never depend on it.
	let worker, pending = new Map(), startup, sequence = 0, chain = Promise.resolve(), phase = "missing", lastError, workerInfo, workerFingerprint, progressSink;
	let setupPromise, setupController;
	let idleTimer, closed = false, queued = 0;
	let terminating = Promise.resolve();
	let activeOperations = 0; const retiring = new Set();
	function configuration() {
		const embedding = getSettings().embedding ?? {};
		const dimensions = embedding.dimensions ?? 768;
		if (![128, 256, 512, 768].includes(dimensions)) throw failure("Embedding dimensions must be 128, 256, 512 or 768.", "SEARCH_CONFIG_INVALID");
		const device = embedding.device ?? "cpu";
		if (!["cpu", "gpu"].includes(device)) throw failure("Embedding device must be cpu or gpu.", "SEARCH_CONFIG_INVALID");
		return { dimensions, device };
	}
	const prepared = () => { try { return JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return null; } };
	function onnxPrepared(info) { return info?.model === EMBEDDING_MODEL && info.revision === EMBEDDING_REVISION && info.dtype === EMBEDDING_DTYPE && existsSync(cacheDir); }
	function backend() { const info = prepared(); return info?.backend === "gguf" || (!onnxPrepared(info) && nativeAssets?.present()) ? "gguf" : "onnx"; }
	const identity = () => backend() === "gguf" ? nativeAssets?.identity : { model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, dtype: EMBEDDING_DTYPE };
	function manifest() {
		const info = prepared();
		if (backend() === "gguf") return nativeAssets?.present() && info?.pipeline === PIPELINE && info.qualified === true && Object.keys(nativeAssets.identity).every(key => info[key] === nativeAssets.identity[key]) ? info : null;
		return onnxPrepared(info) ? info : null;
	}
	function savePrepared(info) {
		if (existsSync(manifestPath)) {
			const original = readFileSync(manifestPath), old = prepared();
			if (old?.model !== info.model || old?.revision !== info.revision || old?.dtype !== info.dtype || old?.backend !== info.backend) {
				const backup = path.join(runtimeDir, `prepared.previous-${createHash("sha256").update(original).digest("hex")}.json`);
				if (!existsSync(backup)) writeFileSync(backup, original, { flag: "wx" });
			}
		}
		const temporary = `${manifestPath}.${randomUUID()}.tmp`, fd = openSync(temporary, "wx");
		try { writeFileSync(fd, JSON.stringify(info, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
		renameSync(temporary, manifestPath);
	}
	function fingerprint() {
		const config = configuration();
		// Vectors depend on the model, quantization, output size and pipeline; the device does not change them.
		return JSON.stringify({ ...identity(), dimensions: config.dimensions, pipeline: PIPELINE });
	}
	function status() {
		const config = configuration();
		const available = !!manifest();
		const ready = !!worker && phase === "ready" && workerFingerprint === fingerprint();
		const liveInfo = ready ? workerInfo ?? {} : {};
		return { ...liveInfo, ...identity(), ...config, device: liveInfo.device ?? config.device, requestedDevice: config.device, runtimeDir, available, cacheReuseAvailable: !!nativeAssets?.present(), legacyCache: prepared()?.model === "google/embeddinggemma-2", busy: queued > 0 || !!setupPromise, ready, phase: phase === "missing" && available ? "available" : phase, fingerprint: fingerprint(), modalities: ["text", "image", "pdf", "audio", "video"], ...(lastError ? { error: lastError } : {}) };
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
		if (running) { retiring.add(running); let result; try { result = running.terminate(); } catch (error) { result = Promise.reject(error); } terminating = Promise.resolve(result).then(() => retiring.delete(running), () => {}); }
		if (phase !== "setting-up") phase = manifest() ? "available" : "missing";
		return terminating;
	}
	function releaseWhenIdle() {
		clearTimeout(idleTimer);
		if (!worker || pending.size || phase !== "ready") return;
		idleTimer = setTimeout(() => stop(), idleMs);
		idleTimer.unref?.();
	}
	function spawn(onProgress) {
		const w = backend() === "gguf" ? nativeWorkerFactory({ assets: nativeAssets, timeoutMs: Math.min(timeoutMs, 180_000) }) : workerFactory({ cacheDir, model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, dtype: EMBEDDING_DTYPE });
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
		w.on("exit", (code) => { retiring.delete(w); fail(failure(`The local model stopped (${code}).`, "SEARCH_WORKER_STOPPED")); });
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
		phase = "setting-up";
		lastError = undefined;
		setupController = new AbortController();
		const combined = signal ? AbortSignal.any([signal, setupController.signal]) : setupController.signal;
		setupPromise = (async () => {
			let w;
			const cancel = () => { if (w && worker === w) stop(abortError()); };
			try {
				await mkdir(cacheDir, { recursive: true });
				if (backend() === "gguf") onProgress?.({ phase: "verifying", message: "Reusing the existing Gemma embeddings; no model download" });
				else {
					onProgress?.({ phase: "downloading", message: `Downloading EmbeddingGemma 2 (about ${Math.round(MODEL_BYTES / 1e6)} MB, once)` });
					// Pinned files, each checked against its hash before it is kept; already-verified files are reused.
					await download({ cacheDir, signal: combined, onProgress });
				}
				if (combined.aborted) throw abortError();
				// Load once offline (text, then the image and audio encoders) before reporting the model installed.
				onProgress?.({ phase: "verifying", message: "Checking the local model" });
				combined.addEventListener("abort", cancel, { once: true });
				const abort = new Promise((_, reject) => combined.addEventListener("abort", () => reject(abortError()), { once: true }));
				const verify = async admittedSignal => {
					activeOperations++; let memoryLease;
					try {
					admittedSignal?.throwIfAborted();
					await stop();
					admittedSignal?.throwIfAborted();
					if (retiring.size) throw failure("The previous embedding worker has not exited.", "SEARCH_WORKER_STOPPED");
					memoryLease = await residencyBudget?.acquire("embedding", { signal: admittedSignal, priority: 0 });
					admittedSignal?.throwIfAborted();
					w = spawn(onProgress);
					worker = w;
					const terminate = () => stop(admittedSignal.reason ?? abortError());
					let rejectAbort;
					const abortVerification = () => rejectAbort(admittedSignal.reason ?? abortError());
					admittedSignal?.addEventListener("abort", terminate, { once: true });
					try {
						admittedSignal?.throwIfAborted();
						const admittedAbort = new Promise((_, reject) => { rejectAbort = reject; admittedSignal?.addEventListener("abort", abortVerification, { once: true }); });
						return await Promise.race([send(w, { op: "load", device: "cpu", dimensions: 768, verify: true }, timeoutMs), abort, admittedAbort]);
					} finally { admittedSignal?.removeEventListener("abort", terminate); admittedSignal?.removeEventListener("abort", abortVerification); await stop(); }
					} finally { await terminating; memoryLease?.release(); activeOperations--; }
				};
				const info = arbiter ? await arbiter.run({ role: "embedding", priority: 0, signal: combined }, verify) : await verify(combined);
				if (combined.aborted || closed) throw abortError();
				savePrepared({ ...identity(), qualified: true, pipeline: PIPELINE, preparedAt: new Date().toISOString(), modalities: info?.modalities });
				phase = "available";
				return status();
			} catch (error) {
				phase = error.name === "AbortError" ? "missing" : "error";
				lastError = error.message;
				throw error;
			} finally {
				combined.removeEventListener("abort", cancel);
				await w?.terminate();
				setupPromise = undefined;
				setupController = undefined;
			}
		})();
		return setupPromise;
	}
	async function startWorker(signal, onProgress) {
		await terminating; signal?.throwIfAborted();
		if (closed || retiring.size) throw failure("The embedding runtime is closed or its previous worker has not exited.", "SEARCH_WORKER_STOPPED");
		clearTimeout(idleTimer);
		idleTimer = undefined;
		if (worker && workerFingerprint !== fingerprint()) await stop();
		if (worker && phase === "ready") return Promise.resolve();
		if (startup) return startup;
		if (worker) await stop();
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
	function request(op, input, { signal, onProgress, keepWorkerOnAbort = false, priority = 2, deadline = Infinity } = {}) {
		if (queued >= 32) return Promise.reject(failure("Local search queue is full.", "SEARCH_QUEUE_FULL"));
		const task = async (admittedSignal = signal) => {
			const callerSignal = signal;
			signal = admittedSignal;
			if (closed) throw failure("Local search runtime is closed.", "SEARCH_RUNTIME_CLOSED");
			if (signal?.aborted) throw abortError();
			if (setupPromise) throw failure("Local search setup is still running.", "SEARCH_SETUP_RUNNING");
			if (!status().available) throw failure("Local search is not set up. Open Files → Manage search and choose Install local search.", "SEARCH_SETUP_REQUIRED");
			activeOperations++; let memoryLease;
			const cancel = () => { if (!keepWorkerOnAbort || arbiter) stop(signal.reason ?? abortError()); };
			signal?.addEventListener("abort", cancel, { once: true });
			try {
				await terminating; signal?.throwIfAborted(); if (retiring.size) throw failure("The previous embedding worker has not exited.", "SEARCH_WORKER_STOPPED"); memoryLease = await residencyBudget?.acquire("embedding", { signal, priority, deadline }); signal?.throwIfAborted();
				await startWorker(signal, onProgress);
				if (signal?.aborted) throw signal.reason ?? abortError();
				progressSink = onProgress;
				return await send(worker, { op, ...input });
			} finally {
				progressSink = undefined;
				signal?.removeEventListener("abort", cancel);
				await terminating;
				memoryLease?.release(); activeOperations--;
				signal = callerSignal;
				releaseWhenIdle();
			}
		};
		queued++;
		const result = (arbiter ? arbiter.run({ role: "embedding", signal, priority, deadline, preemptible: priority >= 2 }, task) : chain.then(() => task(), () => task())).finally(() => queued--);
		if (!arbiter) chain = result.catch(() => {});
		if (!signal) return result;
		return new Promise((resolve, reject) => {
			const cancel = () => reject(abortError());
			if (signal.aborted) return cancel();
			signal.addEventListener("abort", cancel, { once: true });
			result.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
		});
	}
	async function embedText(texts, { query = false, signal, onProgress, keepWorkerOnAbort = false, priority = query ? 0 : 2, deadline = Infinity } = {}) {
		if (!Array.isArray(texts) || texts.some((text) => typeof text !== "string")) throw failure("Embedding text must be an array of strings.");
		if (!texts.length) return [];
		const prompted = texts.map((text) => (query ? `task: search result | query: ${text}` : `title: none | text: ${text}`));
		return request("text", { texts: prompted }, { signal, onProgress, keepWorkerOnAbort, priority, deadline });
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
	return { fingerprint, status, setup, embedText, embedMedia, residency: () => ({ resident: !!worker || retiring.size > 0, busy: activeOperations > 0, unloading: retiring.size > 0 }), setResidencyBudget(value) { if (activeOperations || residencyBudget && residencyBudget !== value) throw new Error("Embeddings already have an active memory owner."); residencyBudget = value; }, unload: () => stop(), close() { closed = true; setupController?.abort(); return stop(); } };
}
