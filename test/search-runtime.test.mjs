import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createEmbeddingRuntime, EMBEDDING_MODEL } from "../src/search/runtime.mjs";

function fixture(t, { prepared = true, reply, timeoutMs, idleMs, setupError } = {}) {
	const dataDir = mkdtempSync(path.join(os.tmpdir(), "midnight-search-runtime-"));
	const runtimeDir = path.join(dataDir, "search-runtime");
	const python = path.join(runtimeDir, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	let configuration = { embedding: { dimensions: 128, device: "cpu" } };
	const calls = [], requests = [], children = [];
	if (prepared) {
		mkdirSync(path.dirname(python), { recursive: true }); writeFileSync(python, "");
		writeFileSync(path.join(runtimeDir, "prepared.json"), JSON.stringify({ model: EMBEDDING_MODEL, revision: "pinned-snapshot", packages: { torch: "test-version" } }));
	}
	const spawnImpl = (executable, args, options) => {
		calls.push({ executable, args, options });
		const child = new EventEmitter();
		child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
		child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", 0)); return true; };
		child.stdin = new Writable({ write(chunk, _encoding, done) {
			const request = JSON.parse(chunk.toString()); requests.push(request);
			queueMicrotask(() => {
				if (reply) return reply(request, child);
				const dimensions = Number(args[args.indexOf("--dimensions") + 1]);
				const vector = Array.from({ length: dimensions }, (_, index) => index === 0 ? 1 : 0);
				const result = request.op === "text" ? request.texts.map(() => vector) : { segments: [{ vector, text: "", locator: { seconds: 25, endSeconds: 55, modality: "audio" } }], truncated: true };
				child.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
			});
			done();
		} });
		children.push(child);
		queueMicrotask(() => {
			if (args.includes("pip")) { child.stdout.write("Requirement already satisfied: torch\n"); child.emit("close", 0); return; }
			if (args.includes("--prepare")) {
				child.stdout.write(JSON.stringify({ event: "progress", phase: "downloading", message: "Downloading model", bytesDone: 50, bytesTotal: 100 }) + "\n");
				if (setupError) {
					child.stderr.write("Loading weights: 100% -- a noisy library progress bar\n");
					const line = JSON.stringify({ ready: false, error: setupError });
					child.stdout.write(line.slice(0, 16)); child.stdout.write(line.slice(16));
				}
				child.emit("close", setupError ? 1 : 0); return;
			}
			child.stdout.write(JSON.stringify({ ready: true, info: { model: EMBEDDING_MODEL } }) + "\n");
		});
		return child;
	};
	const runtime = createEmbeddingRuntime({ paths: { dataDir }, settings: () => configuration, spawnImpl, timeoutMs, idleMs });
	t.after(() => { runtime.close(); rmSync(dataDir, { recursive: true, force: true }); });
	return { runtime, calls, requests, children, configure: value => { configuration = value; } };
}

test("missing local setup fails before spawning or downloading", async t => {
	const { runtime, calls } = fixture(t, { prepared: false });
	assert.equal(runtime.status().available, false);
	await assert.rejects(runtime.embedText(["cat"], { query: true }), { code: "SEARCH_SETUP_REQUIRED" });
	assert.equal(calls.length, 0);
});

test("repair installs a matching CPU vision wheel when the Python runtime already exists", async t => {
	const { runtime, calls } = fixture(t);
	const progress = [];
	const status = await runtime.setup({ onProgress: value => progress.push(value) });
	assert.equal(status.available, true);
	const cpu = calls.find(call => call.args.includes("https://download.pytorch.org/whl/cpu"));
	assert.ok(cpu, "repair resolves CPU dependencies even with an existing torch installation");
	assert.ok(cpu.args.some(arg => arg.startsWith("torchvision==")), "Gemma's image processor dependency is installed");
	assert.equal(cpu.options.env.HF_HUB_OFFLINE, "0");
	assert.ok(progress.some(value => value.message === "Downloading model" && value.bytesDone === 50 && value.bytesTotal === 100));
});

test("setup surfaces the worker's actual error ahead of library stderr and handles partial final lines", async t => {
	const setupError = { code: "SEARCH_SETUP_REQUIRED", message: "ModuleNotFoundError: No module named 'torchvision'" };
	const { runtime } = fixture(t, { setupError });
	await assert.rejects(runtime.setup(), setupError);
	assert.equal(runtime.status().error, setupError.message);
});

test("worker loads offline with explicit task prompts, and preserves media locations", async t => {
	const { runtime, calls, requests } = fixture(t);
	const vectors = await runtime.embedText(["cat", "title: Notes | text: cat"], { query: true });
	assert.equal(vectors.length, 2); assert.equal(vectors[0].length, 128);
	assert.deepEqual(requests[0].texts, ["task: search result | query: cat", "task: search result | query: title: Notes | text: cat"]);
	assert.equal(calls[0].options.windowsHide, true);
	assert.equal(calls[0].options.env.HF_HUB_OFFLINE, "1");
	assert.equal(calls[0].options.env.TRANSFORMERS_OFFLINE, "1");
	assert.equal(runtime.status().ready, true);
	const media = await runtime.embedMedia(path.resolve("clip.mp4"), "video", { maxSegments: 900 });
	assert.equal(requests[1].maxSegments, 500);
	assert.equal(media.truncated, true);
	assert.deepEqual(media.segments[0].locator, { seconds: 25, endSeconds: 55, modality: "audio" });
	await assert.rejects(runtime.embedMedia(path.resolve("deck.pptx"), "slides"), { code: "SEARCH_MEDIA_UNSUPPORTED" });
});

test("dimensions change invalidates fingerprint and restarts the old worker", async t => {
	const { runtime, calls, children, configure } = fixture(t);
	await runtime.embedText(["hello"]);
	const before = runtime.fingerprint();
	configure({ embedding: { dimensions: 256, device: "cpu" } });
	assert.notEqual(runtime.fingerprint(), before);
	assert.equal(runtime.status().ready, false);
	assert.equal((await runtime.embedText(["hello"]))[0].length, 256);
	assert.equal(children[0].killed, true); assert.equal(calls.length, 2);
});

test("a foreground deadline returns promptly while preserving the loaded worker and finishing its active batch", async t => {
	let answer, began;
	const ready = new Promise(resolve => { began = resolve; });
	const { runtime, children } = fixture(t, { reply: (request, child) => {
		answer = () => child.stdout.write(JSON.stringify({ id: request.id, ok: true, result: request.texts.map(() => [1, ...Array(127).fill(0)]) }) + "\n");
		began();
	} });
	const ac = new AbortController();
	const work = runtime.embedText(["foreground"], { signal: ac.signal, keepWorkerOnAbort: true });
	await ready;
	ac.abort();
	await assert.rejects(work, { name: "AbortError" });
	assert.equal(children[0].killed, false);
	assert.equal(runtime.status().busy, true);
	answer();
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(runtime.status().ready, true);
	assert.equal(runtime.status().busy, false);
});

test("abort kills active inference and promptly rejects queued inference", async t => {
	let started;
	const waiting = new Promise(resolve => { started = resolve; });
	const { runtime, children, requests } = fixture(t, { reply: () => started() });
	const firstController = new AbortController(), queuedController = new AbortController();
	const first = runtime.embedText(["active"], { signal: firstController.signal });
	await waiting;
	const queued = runtime.embedText(["queued"], { signal: queuedController.signal });
	queuedController.abort();
	await assert.rejects(queued, { name: "AbortError" });
	assert.equal(children[0].killed, false);
	firstController.abort();
	await assert.rejects(first, { name: "AbortError" });
	assert.equal(children[0].killed, true); assert.equal(requests.length, 1);
});

test("invalid worker JSON fails the request instead of hanging", async t => {
	const { runtime, children } = fixture(t, { reply: (_request, child) => child.stdout.write("not json\n") });
	await assert.rejects(runtime.embedText(["cat"]), /invalid response/);
	assert.equal(children[0].killed, true);
});

test("inference timeout terminates the local worker", async t => {
	const { runtime, children } = fixture(t, { reply: () => {}, timeoutMs: 30 });
	await assert.rejects(runtime.embedText(["cat"]), { code: "SEARCH_TIMEOUT" });
	assert.equal(children[0].killed, true);
});

test("idle model memory is released and closed runtimes cannot restart", async t => {
	const { runtime, children } = fixture(t, { idleMs: 20 });
	await runtime.embedText(["cat"]);
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.equal(children[0].killed, true);
	assert.equal(runtime.status().available, true);
	assert.equal(runtime.status().ready, false);
	runtime.close();
	await assert.rejects(runtime.embedText(["cat"]), { code: "SEARCH_RUNTIME_CLOSED" });
});

test("Python media segmentation preserves overlapping audio, caps and video soundtrack locations", t => {
	const candidates = [process.env.MIDNIGHT_TEST_PYTHON, process.platform === "win32" && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Python", "Python312", "python.exe") : undefined, "python3", "python"].filter(Boolean);
	let interpreter;
	for (const candidate of candidates) {
		try { execFileSync(candidate, ["-c", "import numpy"], { windowsHide: true, timeout: 10_000, stdio: "pipe" }); interpreter = candidate; break; } catch {}
	}
	if (!interpreter) { t.skip("Python with NumPy is unavailable; model dependencies are installed only by explicit setup."); return; }
	const script = `
import importlib.util, sys, types
sys.dont_write_bytecode = True
import numpy as np
spec = importlib.util.spec_from_file_location('search_worker', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
class AudioFrame:
    def to_ndarray(self): return np.full((1, 55 * 16000), 0.1, dtype=np.float32)
class Image:
    def close(self): pass
    def convert(self, mode): return self
    def thumbnail(self, size): pass
class VideoFrame:
    def __init__(self, time): self.time = time
    def to_image(self): return Image()
class Container:
    streams = types.SimpleNamespace(audio=[1], video=[1])
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def decode(self, **kind):
        return iter([VideoFrame(0), VideoFrame(1), VideoFrame(5), VideoFrame(10)]) if 'video' in kind else iter([AudioFrame()])
class Resampler:
    def __init__(self, **options): assert options == {'format':'fltp','layout':'mono','rate':16000}
    def resample(self, frame): return [frame] if frame else []
sys.modules['av'] = types.SimpleNamespace(open=lambda _: Container(), AudioResampler=Resampler)
sys.modules['PIL'] = types.SimpleNamespace(Image=Image, ImageOps=types.SimpleNamespace(exif_transpose=lambda image: image))
worker = module.Worker.__new__(module.Worker)
worker.encode = lambda inputs: [[1,0] for _ in inputs]
module.progress = lambda *args, **kwargs: None
segments=[]
assert worker.audio_segments('fake.wav', 10, segments) is False
assert [(s['locator']['seconds'],s['locator']['endSeconds']) for s in segments] == [(0,30),(25,55)]
segments=[]
assert worker.audio_segments('fake.wav', 1, segments) is True and len(segments)==1
class File:
    def is_file(self): return True
module.Path = lambda _: File()
result = worker.media('fake.mp4','video',4)
assert len(result['segments'])==4 and result['truncated'] is True
assert [s['locator']['modality'] for s in result['segments']] == ['image','image','audio','audio']
assert [s['locator']['seconds'] for s in result['segments']] == [0,5,0,25]
print('synthetic media extraction passed')
`;
	assert.match(execFileSync(interpreter, ["-c", script, path.resolve("src/search/worker.py")], { windowsHide: true, timeout: 10_000, encoding: "utf8", stdio: "pipe" }), /synthetic media extraction passed/);
});
