// Voice input: local Whisper (base, multilingual, 8-bit) transcribes what the user dictates into Ask. The model is
// downloaded once, pinned and hash-checked; audio never leaves the computer. The worker unloads after a quiet spell.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { downloadModel } from "../search/model-files.mjs";
import { SPEECH_BYTES, SPEECH_DTYPE, SPEECH_FILES, SPEECH_MODEL_ID, SPEECH_MODEL_REVISION } from "./model-files.mjs";

const WORKER = new URL("./speech-worker.mjs", import.meta.url);

export function createSpeechRuntime({ paths, workerFactory = (data) => new Worker(WORKER, { workerData: data }), download = downloadModel, timeoutMs = 120_000, idleMs = 120_000 }) {
	const dir = path.join(paths.dataDir, "voice-runtime");
	const cacheDir = path.join(dir, "models");
	const manifestPath = path.join(dir, "prepared.json");
	let worker, loading, idle, seq = 0, setupPromise, lastError;
	const pending = new Map();
	const available = () => {
		try {
			const m = JSON.parse(readFileSync(manifestPath, "utf8"));
			return m.model === SPEECH_MODEL_ID && m.revision === SPEECH_MODEL_REVISION && existsSync(cacheDir);
		} catch {
			return false;
		}
	};
	function stop(error = new Error("Voice input stopped.")) {
		clearTimeout(idle);
		const w = worker;
		worker = undefined;
		loading = undefined;
		for (const p of pending.values()) p.reject(error);
		pending.clear();
		w?.terminate();
	}
	function spawn() {
		const w = workerFactory({ cacheDir, model: SPEECH_MODEL_ID, dtype: SPEECH_DTYPE });
		w.on("message", (m) => {
			const p = pending.get(m?.id);
			if (!p) return;
			pending.delete(m.id);
			m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
		});
		const fail = (err) => worker === w && ((lastError = err.message), stop(err));
		w.on("error", (err) => fail(new Error(`The speech model stopped: ${err.message}`)));
		w.on("exit", (code) => fail(new Error(`The speech model stopped (${code}).`)));
		return w;
	}
	function send(w, message) {
		return new Promise((resolve, reject) => {
			const id = ++seq;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error("Transcription timed out."));
				if (worker === w) stop(new Error("Transcription timed out."));
			}, timeoutMs);
			pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
			w.postMessage({ id, ...message });
		});
	}
	async function ready() {
		if (!available()) throw new Error("Voice input is not installed. Install it in Settings → General → Voice input.");
		if (!worker) {
			worker = spawn();
			const w = worker;
			loading = send(w, { op: "load" }).catch((err) => {
				if (worker === w) stop(err);
				throw err;
			});
		}
		await loading;
		clearTimeout(idle);
		idle = setTimeout(() => stop(), idleMs);
		idle.unref?.();
		return worker;
	}
	return {
		status: () => ({ model: SPEECH_MODEL_ID, revision: SPEECH_MODEL_REVISION, bytes: SPEECH_BYTES, available: available(), loaded: !!worker, setup: !!setupPromise, ...(lastError ? { error: lastError } : {}) }),
		/** Download the pinned files, then load once to check them, before reporting voice input installed. */
		setup({ onProgress, signal } = {}) {
			setupPromise ??= (async () => {
				try {
					lastError = undefined;
					await mkdir(cacheDir, { recursive: true });
					await download({ cacheDir, files: SPEECH_FILES, id: SPEECH_MODEL_ID, revision: SPEECH_MODEL_REVISION, label: "Whisper", onProgress, signal });
					stop();
					const w = spawn();
					try {
						await send(w, { op: "load" });
					} finally {
						w.terminate();
					}
					writeFileSync(manifestPath, JSON.stringify({ model: SPEECH_MODEL_ID, revision: SPEECH_MODEL_REVISION, dtype: SPEECH_DTYPE, preparedAt: new Date().toISOString() }));
					return { available: true };
				} catch (err) {
					lastError = err.message;
					throw err;
				} finally {
					setupPromise = undefined;
				}
			})();
			return setupPromise;
		},
		/** Mono 16 kHz samples in, English text out. */
		async transcribe(samples) {
			if (!(samples instanceof Float32Array)) throw new Error("Voice input needs audio samples.");
			if (samples.length > 300 * 16000) throw new Error("Dictate up to five minutes at a time.");
			const w = await ready();
			const r = await send(w, { op: "transcribe", samples, language: "en" });
			idle?.refresh?.();
			return r;
		},
		close: () => stop(),
	};
}
