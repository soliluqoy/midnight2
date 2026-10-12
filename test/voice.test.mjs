import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
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

test("voice input downloads pinned Whisper, verifies it loads, then transcribes in midnight's language", async () => {
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
	assert.deepEqual(await f.runtime.transcribe(new Float32Array(32000), { language: "id" }), { text: "heard 32000 samples in id" });
	assert.deepEqual(await f.runtime.transcribe(new Float32Array(16000), { language: "fr" }), { text: "heard 16000 samples in en" }, "unsupported interface languages use English");
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
