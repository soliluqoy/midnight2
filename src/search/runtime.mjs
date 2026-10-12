import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EMBEDDING_MODEL = "google/embeddinggemma-2";
export const SEARCH_PACKAGES = ["sentence-transformers==6.1.0", "transformers==5.19.0", "torchvision==0.29.1", "av==16.1.0", "pypdfium2==5.14.0", "Pillow==11.3.0", "soundfile==0.13.1", "librosa==0.11.0"];
const WORKER = fileURLToPath(new URL("./worker.py", import.meta.url));
const PROMPTS = "task: search result | query: ;title: none | text: ";
const abortError = () => Object.assign(new Error("Local search was cancelled."), { name: "AbortError", code: "SEARCH_CANCELLED" });
const failure = (message, code = "SEARCH_RUNTIME_ERROR") => Object.assign(new Error(message), { code });

/** The full multimodal model stays in a private Python process. Only setup may use the network. */
export function createEmbeddingRuntime({ settings, paths, spawnImpl = spawn, workerPath = WORKER, timeoutMs = 20 * 60_000, idleMs = 60_000 }) {
	const getSettings = typeof settings === "function" ? settings : () => settings ?? {};
	const runtimeDir = path.join(paths.dataDir, "search-runtime");
	const python = path.join(runtimeDir, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	const manifestPath = path.join(runtimeDir, "prepared.json");
	let child, pending, startup, sequence = 0, chain = Promise.resolve(), phase = "missing", lastError, workerInfo, workerFingerprint;
	let setupPromise, setupController;
	let idleTimer, closed = false;
	function configuration() {
		const embedding = getSettings().embedding ?? {};
		const dimensions = embedding.dimensions ?? 768;
		if (![128, 256, 512, 768].includes(dimensions)) throw failure("Embedding dimensions must be 128, 256, 512 or 768.", "SEARCH_CONFIG_INVALID");
		const device = embedding.device ?? "cpu";
		if (!["cpu", "cuda", "mps"].includes(device)) throw failure("Embedding device must be cpu, cuda or mps.", "SEARCH_CONFIG_INVALID");
		return { dimensions, device, pythonPath: embedding.pythonPath };
	}
	function manifest() {
		try { const info = JSON.parse(readFileSync(manifestPath, "utf8")); return info.model === EMBEDDING_MODEL && typeof info.revision === "string" ? info : null; } catch { return null; }
	}
	function fingerprint() {
		const info = manifest(), config = configuration();
		return JSON.stringify({ model: EMBEDDING_MODEL, revision: info?.revision ?? "unprepared", packages: SEARCH_PACKAGES, installed: info?.packages ?? {}, dtype: "float32", dimensions: config.dimensions, device: config.device, prompts: PROMPTS, pipeline: "midnight-multimodal-v1-pdf1600-audio30-hop25-video5" });
	}
	function status() {
		const info = manifest(), config = configuration();
		const available = existsSync(python) && !!info;
		return { ...(workerInfo ?? {}), model: EMBEDDING_MODEL, ...config, runtimeDir, available, ready: !!child && phase === "ready" && workerFingerprint === fingerprint(), phase: phase === "missing" && available ? "available" : phase, fingerprint: fingerprint(), revision: info?.revision, modalities: ["text", "image", "pdf", "audio", "video"], ...(lastError ? { error: lastError } : {}) };
	}
	function environment(online = false) {
		return { ...process.env, HF_HOME: path.join(runtimeDir, "cache"), HF_HUB_CACHE: path.join(runtimeDir, "cache", "hub"), HF_HUB_OFFLINE: online ? "0" : "1", TRANSFORMERS_OFFLINE: online ? "0" : "1", HF_HUB_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", TOKENIZERS_PARALLELISM: "false", PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" };
	}
	function stop(error = failure("Local search runtime closed.", "SEARCH_RUNTIME_CLOSED")) {
		clearTimeout(idleTimer); idleTimer = undefined;
		const running = child;
		child = undefined; startup = undefined; workerInfo = undefined; workerFingerprint = undefined;
		if (pending) { const request = pending; pending = undefined; request.reject(error); }
		running?.kill();
		if (phase !== "setting-up") phase = existsSync(python) && manifest() ? "available" : "missing";
	}
	function releaseWhenIdle() {
		clearTimeout(idleTimer);
		if (!child || pending || phase !== "ready") return;
		idleTimer = setTimeout(() => stop(), idleMs);
		idleTimer.unref?.();
	}
	function run(executable, args, { signal, onProgress, online = false, timeout = timeoutMs } = {}) {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) return reject(abortError());
			let proc, done = false, output = "", tail = "", buffered = "", workerError;
			const finish = (error) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel); error ? reject(error) : resolve(output); };
			const cancel = () => { proc?.kill(); finish(abortError()); };
			const timer = setTimeout(() => { proc?.kill(); finish(failure("Local search setup timed out. Retry setup to resume cached downloads.", "SEARCH_TIMEOUT")); }, timeout);
			try { proc = spawnImpl(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: environment(online) }); } catch (error) { finish(error); return; }
			proc.stdout.setEncoding("utf8"); proc.stderr.setEncoding("utf8");
			signal?.addEventListener("abort", cancel, { once: true });
			const lineReceived = line => {
				if (!line) return;
				let message;
				try { message = JSON.parse(line); } catch { onProgress?.({ phase: "installing", message: "Installing local search libraries", detail: line.slice(0, 500) }); return; }
				if (message.event === "progress") onProgress?.(message);
				if (message.ready === false) workerError = failure(message.error?.message ?? "Local model failed to load.", message.error?.code);
			};
			proc.stdout.on("data", chunk => {
				output = (output + chunk.toString()).slice(-32_000); buffered += chunk.toString();
				let end; while ((end = buffered.indexOf("\n")) >= 0) {
					const line = buffered.slice(0, end).trim(); buffered = buffered.slice(end + 1);
					lineReceived(line);
				}
			});
			proc.stderr.on("data", chunk => { tail = (tail + chunk.toString()).slice(-4_000); });
			proc.once("error", finish);
			proc.once("close", code => { lineReceived(buffered.trim()); finish(workerError ?? (code === 0 ? undefined : failure(`Local search setup failed (${code}). ${tail || output}`))); });
		});
	}
	async function findPython(signal) {
		const configured = configuration().pythonPath;
		const installed = process.env.LOCALAPPDATA ? ["312", "313", "311", "310"].map(version => [path.join(process.env.LOCALAPPDATA, "Programs", "Python", `Python${version}`, "python.exe"), []]) : [];
		const candidates = configured ? [[configured, []]] : process.platform === "win32" ? [["py", ["-3.12"]], ["py", ["-3.13"]], ["py", ["-3.11"]], ["py", ["-3.10"]], ["python", []], ["python3", []], ...installed] : [["python3", []], ["python", []]];
		for (const [executable, prefix] of candidates) {
			try {
				const output = await run(executable, [...prefix, "-c", "import sys,json; print(json.dumps(list(sys.version_info[:2])))"], { signal, timeout: 15_000 });
				const [major, minor] = JSON.parse(output.trim());
				if (major === 3 && minor >= 10 && minor <= 13) return { executable, prefix };
			} catch (error) { if (error.name === "AbortError") throw error; }
		}
		throw failure("Install 64-bit Python 3.10–3.13 (3.12 recommended), add it to PATH, then run Set up local search again. A custom interpreter can be set in embedding.pythonPath.", "SEARCH_PYTHON_MISSING");
	}
	async function setup({ signal, onProgress } = {}) {
		if (closed) throw failure("Local search runtime is closed.", "SEARCH_RUNTIME_CLOSED");
		if (setupPromise) return setupPromise;
		stop(); phase = "setting-up"; lastError = undefined;
		setupController = new AbortController();
		const combined = signal ? AbortSignal.any([signal, setupController.signal]) : setupController.signal;
		setupPromise = (async () => {
			try {
				await mkdir(runtimeDir, { recursive: true });
				onProgress?.({ phase: "python", message: "Checking local Python" });
				if (!existsSync(python)) {
					const interpreter = await findPython(combined);
					await run(interpreter.executable, [...interpreter.prefix, "-m", "venv", path.join(runtimeDir, "venv")], { signal: combined, onProgress });
				}
				onProgress?.({ phase: "installing", message: "Installing local search libraries" });
				if (configuration().device === "cpu") {
					// Resolve the matching CPU vision wheel even when torch is already installed.
					await run(python, ["-m", "pip", "install", "--disable-pip-version-check", "--only-binary=:all:", "--index-url", "https://download.pytorch.org/whl/cpu", "torch>=2.2", "torchvision==0.29.1"], { signal: combined, onProgress, online: true, timeout: 60 * 60_000 });
				}
				await run(python, ["-m", "pip", "install", "--disable-pip-version-check", "--only-binary=:all:", ...SEARCH_PACKAGES], { signal: combined, onProgress, online: true, timeout: 60 * 60_000 });
				onProgress?.({ phase: "downloading", message: "Downloading the full EmbeddingGemma 2 model" });
				await run(python, ["-u", workerPath, "--prepare", "--runtime-dir", runtimeDir, "--device", configuration().device, "--dimensions", String(configuration().dimensions)], { signal: combined, onProgress, online: true, timeout: 60 * 60_000 });
				if (!manifest()) throw failure("Setup did not produce a verified model manifest. Retry local search setup.");
				phase = "available";
				return status();
			} catch (error) { phase = error.name === "AbortError" ? "missing" : "error"; lastError = error.message; throw error; }
			finally { setupPromise = undefined; setupController = undefined; }
		})();
		return setupPromise;
	}
	function startWorker(signal, onProgress) {
		clearTimeout(idleTimer); idleTimer = undefined;
		if (child && workerFingerprint !== fingerprint()) stop();
		if (child && phase === "ready") return Promise.resolve();
		if (startup) return startup;
		if (!status().available) return Promise.reject(failure("Local search is not set up. Open Settings → Local search and choose Set up local search.", "SEARCH_SETUP_REQUIRED"));
		if (signal?.aborted) return Promise.reject(abortError());
		phase = "loading"; lastError = undefined;
		startup = new Promise((resolve, reject) => {
			let buffered = "", tail = "", settled = false;
			const config = configuration();
			const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel); startup = undefined; error ? reject(error) : resolve(); };
			const cancel = () => { stop(abortError()); finish(abortError()); };
			const timer = setTimeout(() => { const error = failure("Loading the local model timed out.", "SEARCH_TIMEOUT"); stop(error); finish(error); }, timeoutMs);
			let proc;
			try { proc = spawnImpl(python, ["-u", workerPath, "--runtime-dir", runtimeDir, "--device", config.device, "--dimensions", String(config.dimensions)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: environment(false) }); }
			catch (error) { finish(error); return; }
			child = proc;
			workerFingerprint = fingerprint();
			proc.stdout.setEncoding("utf8"); proc.stderr.setEncoding("utf8");
			signal?.addEventListener("abort", cancel, { once: true });
			proc.stdout.on("data", chunk => {
				if (child !== proc) return;
				buffered += chunk.toString();
				if (buffered.length > 32 * 1024 * 1024) { const error = failure("Local model reply exceeded the size limit."); stop(error); finish(error); return; }
				let end; while ((end = buffered.indexOf("\n")) >= 0) {
					const line = buffered.slice(0, end).trim(); buffered = buffered.slice(end + 1);
					if (!line) continue;
					let message; try { message = JSON.parse(line); } catch { const error = failure("Local model returned an invalid response."); stop(error); finish(error); return; }
					if (message.event === "progress") { (pending?.onProgress ?? onProgress)?.(message); continue; }
					if (message.ready === true) { workerInfo = message.info; phase = "ready"; finish(); continue; }
					if (message.ready === false) { const error = failure(message.error?.message ?? message.error ?? "Local model failed to load.", message.error?.code); lastError = error.message; stop(error); phase = "error"; finish(error); continue; }
					if (pending && message.id === pending.id) {
						const request = pending; pending = undefined;
						message.ok ? request.resolve(message.result) : request.reject(failure(message.error?.message ?? "Local embedding failed.", message.error?.code));
					}
				}
			});
			proc.stderr.on("data", chunk => { tail = (tail + chunk.toString()).slice(-4_000); });
			const died = (error) => { if (child !== proc) { finish(error); return; } lastError = error.message; stop(error); phase = "error"; finish(error); };
			proc.once("error", error => died(failure(`Could not start the local model: ${error.message}. Run setup again.`, "SEARCH_SETUP_REQUIRED")));
			proc.once("close", code => died(failure(`Local model stopped (${code}). ${tail}`, "SEARCH_WORKER_STOPPED")));
		});
		return startup;
	}
	function request(op, input, { signal, onProgress } = {}) {
		const task = async () => {
			if (closed) throw failure("Local search runtime is closed.", "SEARCH_RUNTIME_CLOSED");
			if (signal?.aborted) throw abortError();
			if (setupPromise) throw failure("Local search setup is still running.", "SEARCH_SETUP_RUNNING");
			await startWorker(signal, onProgress);
			if (signal?.aborted) throw abortError();
			return new Promise((resolve, reject) => {
				const id = ++sequence;
				const finish = (error, result) => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); releaseWhenIdle(); error ? reject(error) : resolve(result); };
				const cancel = () => stop(abortError());
				const timer = setTimeout(() => stop(failure("Local embedding timed out.", "SEARCH_TIMEOUT")), timeoutMs);
				pending = { id, resolve: result => finish(undefined, result), reject: error => finish(error), onProgress };
				signal?.addEventListener("abort", cancel, { once: true });
				child.stdin.write(JSON.stringify({ id, op, ...input }) + "\n", error => { if (error) stop(failure(`Could not contact the local model: ${error.message}`)); });
			});
		};
		const result = chain.then(task, task); chain = result.catch(() => {});
		if (!signal) return result;
		// A cancelled queued request returns immediately without interrupting another caller's work.
		return new Promise((resolve, reject) => {
			const cancel = () => reject(abortError());
			if (signal.aborted) return cancel();
			signal.addEventListener("abort", cancel, { once: true });
			result.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
		});
	}
	async function embedText(texts, { query = false, signal, onProgress } = {}) {
		if (!Array.isArray(texts) || texts.some(text => typeof text !== "string")) throw failure("Embedding text must be an array of strings.");
		if (!texts.length) return [];
		const prompted = texts.map(text => query ? `task: search result | query: ${text}` : `title: none | text: ${text}`);
		return request("text", { texts: prompted }, { signal, onProgress });
	}
	function embedMedia(filePath, kind, { signal, maxSegments = 120, onProgress } = {}) {
		if (!["image", "pdf", "audio", "video"].includes(kind)) return Promise.reject(failure(`Visual rendering for ${kind} is unavailable. Export slides to PDF to search their visual content.`, "SEARCH_MEDIA_UNSUPPORTED"));
		if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return Promise.reject(failure("Media search requires an absolute local file path."));
		return request("media", { filePath, kind, maxSegments: Math.min(500, Math.max(1, Math.trunc(maxSegments) || 120)) }, { signal, onProgress });
	}
	return { fingerprint, status, setup, embedText, embedMedia, close() { closed = true; setupController?.abort(); stop(); } };
}
