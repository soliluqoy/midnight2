import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createSpeechRuntime } from "../src/voice/runtime.mjs";
import { SPEECH_FILES, SPEECH_MODEL_ID, SPEECH_MODEL_REVISION } from "../src/voice/model-files.mjs";
import { tempDir } from "./helpers.mjs";

function fixture({ loadError } = {}) {
	const dataDir = tempDir("voice");
	const workers = [];
	const downloads = [];
	const runtime = createSpeechRuntime({
		paths: { dataDir },
		download: async (o) => downloads.push(o),
		workerFactory: (data) => {
			const w = new EventEmitter();
			w.data = data;
			w.terminate = () => (w.terminated = true);
			w.postMessage = (m) => queueMicrotask(() => {
				if (m.op === "load") return w.emit("message", loadError ? { id: m.id, ok: false, error: loadError } : { id: m.id, ok: true, result: {} });
				w.emit("message", { id: m.id, ok: true, result: { text: `heard ${m.samples.length} samples in ${m.language}` } });
			});
			workers.push(w);
			return w;
		},
	});
	return { runtime, workers, downloads, dataDir };
}

test("voice input downloads pinned Whisper, verifies it loads, then transcribes in English", async () => {
	const f = fixture();
	assert.equal(f.runtime.status().available, false);
	await assert.rejects(f.runtime.transcribe(new Float32Array(16000)), /not installed/);
	await f.runtime.setup();
	assert.equal(f.downloads[0].id, SPEECH_MODEL_ID);
	assert.equal(f.downloads[0].revision, SPEECH_MODEL_REVISION);
	assert.equal(f.downloads[0].files, SPEECH_FILES);
	assert.equal(f.workers[0].terminated, true, "the verification worker exits");
	assert.equal(JSON.parse(readFileSync(path.join(f.dataDir, "voice-runtime", "prepared.json"), "utf8")).revision, SPEECH_MODEL_REVISION);
	assert.equal(f.runtime.status().available, true);
	assert.deepEqual(await f.runtime.transcribe(new Float32Array(32000)), { text: "heard 32000 samples in en" });
	await assert.rejects(f.runtime.transcribe(new Float32Array(301 * 16000)), /five minutes/);
	f.runtime.close();
	assert.ok(SPEECH_FILES.every((x) => x.size > 0 && (x.sha256?.length === 64 || x.git?.length === 40)), "every Whisper file is pinned by hash");
});

test("a speech model that does not load leaves voice input not installed", async () => {
	const f = fixture({ loadError: "Protobuf parsing failed." });
	await assert.rejects(f.runtime.setup(), /Protobuf parsing failed/);
	assert.equal(f.runtime.status().available, false);
	assert.match(f.runtime.status().error, /Protobuf/);
});
function preparedRuntime(t, options = {}) {
	const dataDir = tempDir("voice-prepared"), workers = [];
	mkdirSync(path.join(dataDir, "voice-runtime", "models"), { recursive: true }); writeFileSync(path.join(dataDir, "voice-runtime", "prepared.json"), JSON.stringify({ model: SPEECH_MODEL_ID, revision: SPEECH_MODEL_REVISION }));
	const runtime = createSpeechRuntime({ paths: { dataDir }, download: async () => { throw new Error("Preparation must not download."); }, workerFactory: () => {
		const w = new EventEmitter(); w.messages = []; w.terminate = () => { w.terminated = true; return Promise.resolve(); }; w.postMessage = message => { w.messages.push(message); queueMicrotask(() => w.emit("message", { id: message.id, ok: true, result: message.op === "load" ? {} : { text: "A request." } })); }; workers.push(w); return w;
	}, ...options }); t.after(() => runtime.close()); return { runtime, workers };
}
test("explicit speech preparation loads once without audio/inference/download and the transcript reuses it", async t => {
	const f = preparedRuntime(t); assert.equal(f.runtime.status().loaded, false); await f.runtime.prepare(); assert.equal(f.runtime.status().loaded, true);
	await f.runtime.prepare(); assert.equal(f.workers.length, 1); assert.deepEqual(f.workers[0].messages.map(m => m.op), ["load"]);
	assert.deepEqual(await f.runtime.transcribe(new Float32Array(16000)), { text: "A request." }); assert.equal(f.workers.length, 1); assert.equal(f.runtime.status().retentionMs, 120000); assert.ok(f.runtime.status().idleUntil > Date.now());
});
test("speech loading is distinct from loaded and a revoked warmup cannot send PCM or return readiness", async t => {
	const controller = new AbortController(), messages = []; let worker, finish;
	const terminated = new Promise(resolve => finish = resolve), f = preparedRuntime(t, { workerFactory: () => {
		worker = new EventEmitter(); worker.postMessage = message => messages.push(message); worker.terminate = () => { worker.terminated = true; return terminated; }; return worker;
	} });
	const pending = f.runtime.prepare({ signal: controller.signal }), rejected = assert.rejects(pending, /cancelled/); await new Promise(resolve => setImmediate(resolve));
	assert.equal(f.runtime.status().loading, true); assert.equal(f.runtime.status().loaded, false); assert.equal(messages.length, 1);
	controller.abort(new Error("cancelled")); assert.equal(worker.terminated, true); worker.emit("message", { id: messages[0].id, ok: true, result: {} });
	assert.equal(f.runtime.status().loaded, false); finish(); await rejected; assert.equal(messages.some(message => message.op === "transcribe"), false);
});
test("idle unload and explicit unload await old worker termination before a new warmup can spawn", async t => {
	const f = preparedRuntime(t, { idleMs: 20 }); await f.runtime.prepare(); const old = f.workers[0]; let finish;
	old.terminate = () => { old.terminated = true; return new Promise(resolve => finish = resolve); };
	const until = Date.now() + 1000; while (!old.terminated) { if (Date.now() > until) throw new Error("Speech failed to unload while idle."); await new Promise(resolve => setTimeout(resolve, 5)); }
	assert.equal(f.runtime.status().loaded, false); const next = f.runtime.prepare(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.workers.length, 1); finish(); await next; assert.equal(f.workers.length, 2);
});
test("tightening an idle budget expires an existing warm model and longer budgets never extend its timer", async t => {
	const f = preparedRuntime(t); await f.runtime.prepare(); const before = f.runtime.status().idleUntil;
	let sample = Date.now(); t.mock.method(Date, "now", () => sample++); // Reproduces a clock tick between successive reads.
	f.runtime.setIdleRetention(20); const shorter = f.runtime.status().idleUntil; assert.ok(shorter < before); f.runtime.setIdleRetention(120000); assert.ok(f.runtime.status().idleUntil <= shorter); t.mock.restoreAll();
	await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(f.workers[0].terminated, true); assert.equal(f.runtime.status().loaded, false); await assert.rejects(f.runtime.prepare({ signal: AbortSignal.abort(new Error("revoked")) }), /revoked/); assert.equal(f.workers.length, 1);
});
test("an already due speech unload cannot be revived by a retention update", async t => {
	const f = preparedRuntime(t); await f.runtime.prepare(); const deadline = f.runtime.status().idleUntil;
	t.mock.method(Date, "now", () => deadline + 1); f.runtime.setIdleRetention(120000);
	assert.equal(f.runtime.status().loaded, false); assert.equal(f.runtime.status().idleUntil, undefined); assert.equal(f.workers[0].terminated, true); assert.equal(f.workers.length, 1); t.mock.restoreAll();
});
