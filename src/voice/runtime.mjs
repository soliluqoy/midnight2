// Voice input: local Whisper (base, multilingual, 8-bit) transcribes what the user dictates into Ask. The model is
// downloaded once, pinned and hash-checked; audio never leaves the computer. The worker unloads after a quiet spell.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { downloadModel } from "../search/model-files.mjs";
import { SPEECH_BYTES, SPEECH_DTYPE, SPEECH_FILES, SPEECH_MODEL_ID, SPEECH_MODEL_REVISION } from "./model-files.mjs";

const WORKER = new URL("./speech-worker.mjs", import.meta.url);

export function createSpeechRuntime({ paths, workerFactory = (data) => new Worker(WORKER, { workerData: data }), download = downloadModel, timeoutMs = 120_000, idleMs = 120_000, arbiter, residencyBudget }) {
	const dir = path.join(paths.dataDir, "voice-runtime");
	const cacheDir = path.join(dir, "models");
	const manifestPath = path.join(dir, "prepared.json");
	let worker, loading, idle, seq = 0, setupPromise, lastError;
	let loaded = false, retainMs = idleMs, idleUntil;
	let activeOperations = 0; const retiring = new Set();
	let closed = false, chain = Promise.resolve(), terminating = Promise.resolve();
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
		idleUntil = undefined; loaded = false;
		const w = worker;
		worker = undefined;
		loading = undefined;
		for (const p of pending.values()) p.reject(error);
		pending.clear();
		if (w) { retiring.add(w); let result; try { result = w.terminate(); } catch (error) { result = Promise.reject(error); } terminating = Promise.resolve(result).then(() => retiring.delete(w), () => {}); }
		return terminating;
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
		w.on("exit", (code) => { retiring.delete(w); fail(new Error(`The speech model stopped (${code}).`)); });
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
			try { w.postMessage({ id, ...message }); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); if (worker === w) stop(error); }
		});
	}
	async function ready(signal) {
		await terminating; signal?.throwIfAborted();
		if (retiring.size) throw new Error("The previous speech worker did not exit. Restart Midnight before loading another model.");
		if (closed) throw new Error("Voice input is closed.");
		if (!available()) throw new Error("Voice input is not installed. Install it in Settings → General → Voice input.");
		if (!worker) {
			worker = spawn();
			const w = worker;
			loading = send(w, { op: "load" }).catch((err) => {
				if (worker === w) stop(err);
				throw err;
			});
		}
		const currentWorker = worker; await loading; signal?.throwIfAborted();
		if (closed || worker !== currentWorker) throw new Error("Voice preparation was revoked.");
		loaded = true; lastError = undefined;
		clearTimeout(idle);
		idleUntil = undefined;
		return worker;
	}
	function retain() {
		clearTimeout(idle);
		if (!worker || pending.size) return;
		idleUntil = Date.now() + retainMs;
		idle = setTimeout(() => stop(), retainMs); idle.unref?.();
	}
	function work({ signal, priority = 0, deadline = Infinity } = {}, task) {
		const run = async (admittedSignal = signal) => {
			if (closed) throw new Error("Voice input is closed.");
			activeOperations++; let memoryLease;
			const cancel = () => stop(admittedSignal.reason ?? Object.assign(new Error("Voice input cancelled."), { name: "AbortError" }));
			admittedSignal?.addEventListener("abort", cancel, { once: true });
			try { admittedSignal?.throwIfAborted(); clearTimeout(idle); idleUntil = undefined; await terminating; admittedSignal?.throwIfAborted(); if (retiring.size) throw new Error("The previous speech worker has not exited."); memoryLease = await residencyBudget?.acquire("speech", { signal: admittedSignal, priority, deadline }); admittedSignal?.throwIfAborted(); return await task(admittedSignal); }
			finally {
				admittedSignal?.removeEventListener("abort", cancel);
				await terminating;
				memoryLease?.release(); activeOperations--;
				retain();
			}
		};
		if (arbiter) return arbiter.run({ role: "speech", priority, signal, deadline, preemptible: priority >= 2 }, run);
		const result = chain.then(() => run(), () => run());
		chain = result.catch(() => {});
		return result;
	}
	return {
		status: () => ({ model: SPEECH_MODEL_ID, revision: SPEECH_MODEL_REVISION, bytes: SPEECH_BYTES, available: available(), loaded, loading: !!worker && !loaded, idleUntil, retentionMs: retainMs, setup: !!setupPromise, ...(lastError ? { error: lastError } : {}) }),
		residency: () => ({ resident: !!worker || retiring.size > 0, busy: activeOperations > 0, unloading: retiring.size > 0 }),
		setResidencyBudget(value) { if (activeOperations || residencyBudget && residencyBudget !== value) throw new Error("Speech already has an active memory owner."); residencyBudget = value; },
		/** Warm only the existing offline model for an explicit gesture. No microphone, inference or download. */
		prepare({ signal, priority = 0, deadline = Infinity } = {}) {
			if (!available()) return Promise.reject(new Error("Voice input is not installed. Install it in Settings → General → Voice input."));
			return work({ signal, priority, deadline }, async admittedSignal => { await ready(admittedSignal); admittedSignal?.throwIfAborted(); return { loaded: true }; });
		},
		setIdleRetention(milliseconds) {
			if (!Number.isFinite(milliseconds) || milliseconds < 10 || milliseconds > 120_000) throw new Error("Invalid speech retention budget.");
			const previous = retainMs; retainMs = milliseconds;
			if (idleUntil) { // tightening policy never extends a previously scheduled unload
				const sampledNow = Date.now(), deadline = Math.min(idleUntil, sampledNow + retainMs); clearTimeout(idle);
				if (deadline <= sampledNow) stop();
				else { idleUntil = deadline; idle = setTimeout(() => stop(), deadline - sampledNow); idle.unref?.(); }
			}
			return { retentionMs: retainMs, changed: previous !== retainMs };
		},
		/** Download the pinned files, then load once to check them, before reporting voice input installed. */
		setup({ onProgress, signal } = {}) {
			if (closed) return Promise.reject(new Error("Voice input is closed."));
			setupPromise ??= (async () => {
				try {
					lastError = undefined;
					await mkdir(cacheDir, { recursive: true });
					await download({ cacheDir, files: SPEECH_FILES, id: SPEECH_MODEL_ID, revision: SPEECH_MODEL_REVISION, label: "Whisper", onProgress, signal });
					await work({ signal, priority: 0 }, async admittedSignal => {
						await stop();
						admittedSignal?.throwIfAborted(); if (closed || retiring.size) throw new Error("Voice setup was revoked or its previous worker has not exited.");
						worker = spawn();
						try { await send(worker, { op: "load" }); }
						finally { await stop(); }
					});
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
		/** Mono 16 kHz samples in. Null language asks Whisper to detect it; dictation defaults to English. */
		async transcribe(samples, { language = "en", signal, priority = 0, deadline = Infinity, maxSeconds = 300 } = {}) {
			if (!(samples instanceof Float32Array)) throw new Error("Voice input needs audio samples.");
			if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 300) throw new Error("Invalid voice duration limit.");
			if (samples.length > maxSeconds * 16000) throw new Error(maxSeconds === 300 ? "Dictate up to five minutes at a time." : `Speak for up to ${maxSeconds} seconds at a time.`);
			if (samples.some(value => !Number.isFinite(value))) throw new Error("Voice input contains invalid audio samples.");
			if (language !== null && (typeof language !== "string" || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language))) throw new Error("Invalid voice language.");
			if (!available()) throw new Error("Voice input is not installed. Install it in Settings → General → Voice input.");
			return work({ signal, priority, deadline }, async admittedSignal => {
				const w = await ready(admittedSignal); admittedSignal?.throwIfAborted();
				return send(w, { op: "transcribe", samples, language });
			});
		},
		unload: () => stop(),
		close() { closed = true; return stop(); },
	};
}
