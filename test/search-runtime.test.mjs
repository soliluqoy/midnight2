import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createEmbeddingRuntime, EMBEDDING_DTYPE, EMBEDDING_MODEL, EMBEDDING_REVISION, onnxDevice } from "../src/search/runtime.mjs";
import { downloadModel, MODEL_FILES, modelDir } from "../src/search/model-files.mjs";
import { embeddingSettings } from "../src/search/config.mjs";
import { createNativeEmbeddingAssets } from "../src/search/native-assets.mjs";

const unit = (dimensions) => Array.from({ length: dimensions }, (_, index) => index === 0 ? 1 : 0);

function fixture(t, { prepared = true, reply, timeoutMs, idleMs, setupError, loadError, decodeMedia } = {}) {
	const dataDir = mkdtempSync(path.join(os.tmpdir(), "midnight-search-runtime-"));
	const runtimeDir = path.join(dataDir, "search-runtime");
	let configuration = { embedding: { dimensions: 128, device: "cpu" } };
	const workers = [], requests = [];
	if (prepared) {
		mkdirSync(path.join(runtimeDir, "models"), { recursive: true });
		writeFileSync(path.join(runtimeDir, "prepared.json"), JSON.stringify({ model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, dtype: EMBEDDING_DTYPE }));
	}
	const workerFactory = (data) => {
		const w = new EventEmitter();
		w.data = data;
		w.terminated = false;
		w.terminate = () => { w.terminated = true; queueMicrotask(() => w.emit("exit", 1)); };
		w.postMessage = (m) => {
			requests.push(m);
			queueMicrotask(() => {
				if (w.terminated) return;
				if (m.op === "load") {
					if (loadError) return w.emit("message", { id: m.id, ok: false, error: loadError });
					w.dimensions = m.dimensions;
					return w.emit("message", { id: m.id, ok: true, result: { model: EMBEDDING_MODEL, dimensions: m.dimensions, device: m.device, modalities: ["text", "image", "audio"] } });
				}
				if (reply) return reply(m, w);
				const vector = unit(w.dimensions);
				w.emit("message", { id: m.id, ok: true, result: m.op === "text" ? m.texts.map(() => vector) : vector });
			});
		};
		workers.push(w);
		return w;
	};
	const downloads = [];
	const download = async (o) => {
		downloads.push(o);
		o.onProgress?.({ phase: "downloading", message: "Downloading EmbeddingGemma 2", bytesDone: 50, bytesTotal: 100 });
		if (setupError) throw Object.assign(new Error(setupError.message), { code: setupError.code });
	};
	const runtime = createEmbeddingRuntime({ paths: { dataDir }, settings: () => configuration, workerFactory, download, timeoutMs, idleMs, decodeMedia });
	t.after(() => { runtime.close(); rmSync(dataDir, { recursive: true, force: true }); });
	return { runtime, workers, requests, runtimeDir, downloads, configure: value => { configuration = value; } };
}

test("missing local setup fails before starting a worker or downloading", async t => {
	const { runtime, workers } = fixture(t, { prepared: false });
	assert.equal(runtime.status().available, false);
	await assert.rejects(runtime.embedText(["cat"], { query: true }), { code: "SEARCH_SETUP_REQUIRED" });
	assert.equal(workers.length, 0);
});

test("setup downloads the pinned files, then verifies every encoder offline before reporting installed; no Python", async t => {
	const { runtime, workers, requests, downloads, runtimeDir } = fixture(t, { prepared: false });
	const progress = [];
	const status = await runtime.setup({ onProgress: value => progress.push(value) });
	assert.equal(status.available, true);
	assert.equal(status.revision, EMBEDDING_REVISION);
	assert.equal(downloads[0].cacheDir, path.join(runtimeDir, "models"));
	assert.deepEqual(requests.map(r => [r.op, r.verify]), [["load", true]], "one offline load checks text, image and audio");
	assert.equal(workers[0].data.dtype, EMBEDDING_DTYPE);
	assert.equal(workers[0].terminated, true, "the verification worker exits");
	assert.ok(progress.some(value => value.phase === "downloading" && value.bytesDone === 50 && value.bytesTotal === 100));
	assert.equal(JSON.parse(readFileSync(path.join(runtimeDir, "prepared.json"), "utf8")).revision, EMBEDDING_REVISION);
});

test("setup surfaces download and verification errors and stays not installed", async t => {
	const setupError = { code: "SEARCH_DOWNLOAD_FAILED", message: "onnx/model_quantized.onnx_data did not match its pinned hash; it was discarded. Try setup again." };
	let f = fixture(t, { prepared: false, setupError });
	await assert.rejects(f.runtime.setup(), { message: setupError.message });
	assert.equal(f.runtime.status().error, setupError.message);
	assert.equal(f.runtime.status().available, false);
	assert.equal(f.workers.length, 0, "nothing loads after a failed download");
	f = fixture(t, { prepared: false, loadError: { code: "SEARCH_SETUP_REQUIRED", message: "Protobuf parsing failed." } });
	await assert.rejects(f.runtime.setup(), /Protobuf parsing failed/);
	assert.equal(f.runtime.status().available, false);
});

test("cached GGUF setup preserves the legacy marker, avoids downloads and records a separate qualified fingerprint", async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "midnight-native-reuse-")), runtimeDir = path.join(directory, "search-runtime"); mkdirSync(runtimeDir);
	const legacy = JSON.stringify({ model: "google/embeddinggemma-2", revision: "legacy-fixture", dtype: "float32", snapshot: "retained previous snapshot" }); writeFileSync(path.join(runtimeDir, "prepared.json"), legacy);
	const identity = createNativeEmbeddingAssets().identity; let downloads = 0, workers = 0, live = false, terminated = false;
	const factory = () => {
		workers++; const worker = new EventEmitter();
		worker.postMessage = message => queueMicrotask(() => {
			if (terminated) return;
			const result = message.op === "load" ? { ...identity, dimensions: message.dimensions, device: "cpu", modalities: ["text", "image", "pdf", "audio", "video"] } : message.texts.map(() => unit(128));
			worker.emit("message", { id: message.id, ok: true, result });
		});
		worker.terminate = async () => { live = true; await new Promise(resolve => setTimeout(resolve, 15)); live = false; terminated = true; }; return worker;
	};
	const options = { paths: { dataDir: directory }, settings: { embedding: { dimensions: 128 } }, nativeAssets: { identity, present: () => true }, nativeWorkerFactory: factory, download: async () => { downloads++; throw new Error("must not download"); } };
	const runtime = createEmbeddingRuntime(options); t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
	assert.equal(runtime.status().available, false); assert.equal(runtime.status().legacyCache, true); assert.equal(runtime.status().cacheReuseAvailable, true); assert.equal(workers, 0);
	await assert.rejects(runtime.embedText(["no implicit setup"]), { code: "SEARCH_SETUP_REQUIRED" }); assert.equal(workers, 0);
	const status = await runtime.setup(); assert.equal(downloads, 0); assert.equal(status.available, true); assert.equal(status.backend, "gguf"); assert.equal(live, false, "setup waits for native verification process exit");
	const saved = JSON.parse(readFileSync(path.join(runtimeDir, "prepared.json"), "utf8")); assert.equal(saved.modelHash, identity.modelHash); assert.equal(saved.qualified, true);
	const backups = readdirSync(runtimeDir).filter(name => name.startsWith("prepared.previous-")); assert.equal(backups.length, 1); assert.equal(readFileSync(path.join(runtimeDir, backups[0]), "utf8"), legacy);
	assert.ok(runtime.fingerprint().includes(identity.transport)); assert.notEqual(runtime.fingerprint(), JSON.stringify({ model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, dtype: EMBEDDING_DTYPE, dimensions: 128, pipeline: saved.pipeline }));
	const reopened = createEmbeddingRuntime(options); assert.equal(reopened.status().available, true); await reopened.close();
});

test("a prepared ONNX cache is retained even when native assets are present", async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "midnight-retain-onnx-")); mkdirSync(path.join(directory, "search-runtime", "models"), { recursive: true });
	writeFileSync(path.join(directory, "search-runtime", "prepared.json"), JSON.stringify({ model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, dtype: EMBEDDING_DTYPE }));
	const runtime = createEmbeddingRuntime({ paths: { dataDir: directory }, nativeAssets: { identity: createNativeEmbeddingAssets().identity, present: () => true }, nativeWorkerFactory: () => { throw new Error("must retain selected backend"); } });
	t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
	assert.equal(runtime.status().available, true); assert.equal(runtime.status().model, EMBEDDING_MODEL); assert.equal(runtime.status().dtype, EMBEDDING_DTYPE);
});

test("failed native qualification cannot overwrite a legacy marker or silently download another backend", async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "midnight-reuse-failure-")), runtimeDir = path.join(directory, "search-runtime"); mkdirSync(runtimeDir);
	const legacy = JSON.stringify({ model: "google/embeddinggemma-2", dtype: "float32" }); writeFileSync(path.join(runtimeDir, "prepared.json"), legacy);
	let downloads = 0, stops = 0; const identity = createNativeEmbeddingAssets().identity;
	const runtime = createEmbeddingRuntime({ paths: { dataDir: directory }, nativeAssets: { identity, present: () => true }, nativeWorkerFactory: () => {
		const worker = new EventEmitter(); worker.postMessage = message => queueMicrotask(() => worker.emit("message", { id: message.id, ok: false, error: { message: "cached model hash mismatch", code: "COMPONENT_INVALID" } })); worker.terminate = async () => { stops++; }; return worker;
	}, download: async () => { downloads++; } });
	t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
	await assert.rejects(runtime.setup(), /hash mismatch/); assert.equal(downloads, 0); assert.ok(stops > 0); assert.equal(runtime.status().available, false); assert.equal(readFileSync(path.join(runtimeDir, "prepared.json"), "utf8"), legacy);
});

test("model downloads keep only files whose pinned size and hash match, and reuse verified files", async t => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "midnight-model-files-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const good = Buffer.from('{"model_type":"test"}');
	const big = Buffer.alloc(3000, 7);
	const files = [
		{ path: "config.json", size: good.length, git: createHash("sha1").update(`blob ${good.length}\0`).update(good).digest("hex") },
		{ path: "onnx/model_quantized.onnx_data", size: big.length, sha256: createHash("sha256").update(big).digest("hex") },
	];
	const served = new Map([["config.json", good], ["onnx/model_quantized.onnx_data", big]]);
	const fetched = [];
	const fetchImpl = async (url) => {
		const name = url.split("/resolve/")[1].split("/").slice(1).join("/");
		fetched.push({ url, name });
		const body = served.get(name);
		return { ok: true, status: 200, body: (async function* () { for (let i = 0; i < body.length; i += 1000) yield body.subarray(i, i + 1000); })() };
	};
	const progress = [];
	await downloadModel({ cacheDir: dir, files, fetchImpl, onProgress: p => progress.push(p) });
	assert.ok(fetched.every(f => f.url.includes(`/resolve/${EMBEDDING_REVISION}/`)), "downloads are pinned to the commit");
	assert.deepEqual(readFileSync(path.join(modelDir(dir), "onnx", "model_quantized.onnx_data")), big);
	assert.equal(progress.at(-1).bytesDone, good.length + big.length);
	fetched.length = 0;
	await downloadModel({ cacheDir: dir, files, fetchImpl });
	assert.equal(fetched.length, 0, "verified files are not downloaded again");
	served.set("config.json", Buffer.from('{"model_type":"evil"}'));
	rmSync(path.join(modelDir(dir), "config.json"));
	await assert.rejects(downloadModel({ cacheDir: dir, files, fetchImpl }), { code: "SEARCH_DOWNLOAD_FAILED" });
	assert.throws(() => readFileSync(path.join(modelDir(dir), "config.json")), "a mismatched file never lands");
	assert.ok(MODEL_FILES.every(f => f.size > 0 && (f.sha256?.length === 64 || f.git?.length === 40)), "every shipped file is pinned by hash");
});

test("worker loads offline with explicit task prompts", async t => {
	const { runtime, requests } = fixture(t);
	const vectors = await runtime.embedText(["cat", "title: Notes | text: cat"], { query: true });
	assert.equal(vectors.length, 2); assert.equal(vectors[0].length, 128);
	assert.deepEqual(requests[0], { id: requests[0].id, op: "load", device: "cpu", dimensions: 128 });
	assert.deepEqual(requests[1].texts, ["task: search result | query: cat", "task: search result | query: title: Notes | text: cat"]);
	assert.equal(runtime.status().ready, true);
	await runtime.embedText(["passage"]);
	assert.deepEqual(requests[2].texts, ["title: none | text: passage"]);
	await assert.rejects(runtime.embedMedia(path.resolve("deck.pptx"), "slides"), { code: "SEARCH_MEDIA_UNSUPPORTED" });
});

test("GPU choice maps to each platform's ONNX Runtime provider; Python-era choices migrate", () => {
	assert.equal(onnxDevice("cpu", "win32"), "cpu");
	assert.equal(onnxDevice("gpu", "win32"), "dml");
	assert.equal(onnxDevice("gpu", "darwin"), "coreml");
	assert.equal(onnxDevice("gpu", "linux"), "cuda");
	assert.equal(embeddingSettings({ device: "mps" }).device, "gpu");
	assert.equal(embeddingSettings({ device: "cuda" }).device, "gpu");
	assert.equal(embeddingSettings({ device: "tpu" }).device, "cpu");
	assert.equal("pythonPath" in embeddingSettings({ pythonPath: "C:/python.exe" }), false);
});

test("dimensions change invalidates fingerprint and restarts the old worker", async t => {
	const { runtime, workers, configure } = fixture(t);
	await runtime.embedText(["hello"]);
	const before = runtime.fingerprint();
	configure({ embedding: { dimensions: 256, device: "cpu" } });
	assert.notEqual(runtime.fingerprint(), before);
	assert.equal(runtime.status().ready, false);
	assert.equal((await runtime.embedText(["hello"]))[0].length, 256);
	assert.equal(workers[0].terminated, true); assert.equal(workers.length, 2);
});

test("device change keeps the fingerprint: vectors do not depend on where they were computed", async t => {
	const { runtime, configure } = fixture(t);
	const before = runtime.fingerprint();
	configure({ embedding: { dimensions: 128, device: "gpu" } });
	assert.equal(runtime.fingerprint(), before);
});

test("a foreground deadline returns promptly while preserving the loaded worker and finishing its active batch", async t => {
	let answer, began;
	const ready = new Promise(resolve => { began = resolve; });
	const { runtime, workers } = fixture(t, { reply: (m, w) => {
		answer = () => w.emit("message", { id: m.id, ok: true, result: m.texts.map(() => unit(128)) });
		began();
	} });
	const ac = new AbortController();
	const work = runtime.embedText(["foreground"], { signal: ac.signal, keepWorkerOnAbort: true });
	await ready;
	ac.abort();
	await assert.rejects(work, { name: "AbortError" });
	assert.equal(workers[0].terminated, false);
	assert.equal(runtime.status().busy, true);
	answer();
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(runtime.status().ready, true);
	assert.equal(runtime.status().busy, false);
});

test("abort terminates active inference and promptly rejects queued inference", async t => {
	let started;
	const waiting = new Promise(resolve => { started = resolve; });
	const { runtime, workers, requests } = fixture(t, { reply: () => started() });
	const firstController = new AbortController(), queuedController = new AbortController();
	const first = runtime.embedText(["active"], { signal: firstController.signal });
	await waiting;
	const queued = runtime.embedText(["queued"], { signal: queuedController.signal });
	queuedController.abort();
	await assert.rejects(queued, { name: "AbortError" });
	assert.equal(workers[0].terminated, false);
	firstController.abort();
	await assert.rejects(first, { name: "AbortError" });
	assert.equal(workers[0].terminated, true); assert.equal(requests.filter(r => r.op === "text").length, 1);
});

test("a crashed worker fails the request instead of hanging", async t => {
	const { runtime } = fixture(t, { reply: (_m, w) => w.emit("error", new Error("onnxruntime: bad allocation")) });
	await assert.rejects(runtime.embedText(["cat"]), { code: "SEARCH_WORKER_STOPPED" });
	assert.equal(runtime.status().ready, false);
	assert.match(runtime.status().error, /bad allocation/);
});

test("inference timeout terminates the local worker", async t => {
	const { runtime, workers } = fixture(t, { reply: () => {}, timeoutMs: 30 });
	await assert.rejects(runtime.embedText(["cat"]), { code: "SEARCH_TIMEOUT" });
	assert.equal(workers[0].terminated, true);
});

test("idle model memory is released and closed runtimes cannot restart", async t => {
	const { runtime, workers } = fixture(t, { idleMs: 20 });
	await runtime.embedText(["cat"]);
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.equal(workers[0].terminated, true);
	assert.equal(runtime.status().available, true);
	assert.equal(runtime.status().ready, false);
	runtime.close();
	await assert.rejects(runtime.embedText(["cat"]), { code: "SEARCH_RUNTIME_CLOSED" });
});

function fakeMedia({ seconds = 0, pages = 0, rms = 0.2, audio = true } = {}) {
	const calls = [];
	const decodeMedia = async (filePath, kind) => {
		calls.push({ op: "open", filePath, kind });
		return {
			info: kind === "pdf" ? { pages } : { duration: seconds },
			frame: async (o) => (calls.push({ op: "frame", ...o }), { width: 2, height: 2, rgb: new Uint8Array(12) }),
			text: async ({ page }) => ({ text: `page ${page} text` }),
			audio: async ({ start, seconds: length }) => {
				calls.push({ op: "audio", start, seconds: length });
				if (!audio) throw new Error("This file has no readable audio track.");
				const n = Math.max(0, Math.min(length, seconds - start)) * 16000;
				return { samples: new Float32Array(n).fill(rms), rate: 16000, total: seconds };
			},
			close: async () => calls.push({ op: "close" }),
		};
	};
	return { decodeMedia, calls };
}

test("media segmentation preserves overlapping audio, caps and video soundtrack locations", async t => {
	const audioOnly = fakeMedia({ seconds: 55 });
	let f = fixture(t, { decodeMedia: audioOnly.decodeMedia });
	const audio = await f.runtime.embedMedia(path.resolve("talk.wav"), "audio");
	assert.equal(audio.truncated, false);
	assert.deepEqual(audio.segments.map(s => [s.locator.seconds, s.locator.endSeconds]), [[0, 30], [25, 55]]);
	assert.ok(audio.segments.every(s => s.locator.modality === "audio"));
	assert.equal(audioOnly.calls.at(-1).op, "close", "the decoder session closes");
	const capped = await f.runtime.embedMedia(path.resolve("talk.wav"), "audio", { maxSegments: 1 });
	assert.equal(capped.truncated, true); assert.equal(capped.segments.length, 1);

	const clip = fakeMedia({ seconds: 60 });
	f = fixture(t, { decodeMedia: clip.decodeMedia });
	const video = await f.runtime.embedMedia(path.resolve("clip.mp4"), "video", { maxSegments: 4 });
	assert.equal(video.segments.length, 4);
	assert.equal(video.truncated, true);
	assert.deepEqual(video.segments.map(s => s.locator.modality), ["image", "image", "audio", "audio"]);
	assert.deepEqual(video.segments.map(s => s.locator.seconds), [0, 5, 0, 25]);

	const silent = fakeMedia({ seconds: 10, audio: false });
	f = fixture(t, { decodeMedia: silent.decodeMedia });
	const mute = await f.runtime.embedMedia(path.resolve("mute.mp4"), "video", { maxSegments: 4 });
	assert.deepEqual(mute.segments.map(s => s.locator.seconds), [0, 5], "a silent video uses its whole budget for frames");

	const quiet = fakeMedia({ seconds: 30, rms: 0.0001 });
	f = fixture(t, { decodeMedia: quiet.decodeMedia });
	assert.equal((await f.runtime.embedMedia(path.resolve("room.wav"), "audio")).segments.length, 0, "silence is skipped");
});

test("PDF pages carry their text and page numbers; oversized documents are truncated", async t => {
	const doc = fakeMedia({ pages: 3 });
	const f = fixture(t, { decodeMedia: doc.decodeMedia });
	const pdf = await f.runtime.embedMedia(path.resolve("report.pdf"), "pdf", { maxSegments: 2 });
	assert.equal(pdf.truncated, true);
	assert.deepEqual(pdf.segments.map(s => [s.locator.page, s.text]), [[1, "page 1 text"], [2, "page 2 text"]]);
	assert.ok(f.requests.filter(r => r.op === "image").every(r => r.rgb instanceof Uint8Array && r.width === 2));
});
