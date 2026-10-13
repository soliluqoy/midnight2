import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createInferenceArbiter } from "../src/inference/arbiter.mjs";
import { admittedStream } from "../src/inference/stream.mjs";
import { createSpeechRuntime } from "../src/voice/runtime.mjs";
import { createEmbeddingRuntime, EMBEDDING_MODEL, EMBEDDING_REVISION, EMBEDDING_DTYPE } from "../src/search/runtime.mjs";
import { SPEECH_MODEL_ID, SPEECH_MODEL_REVISION } from "../src/voice/model-files.mjs";
import { createQueue, PRIORITY } from "../src/scheduler/queue.mjs";
import { createResources } from "../src/resources/profiles.mjs";
import { createStopControl } from "../src/policy/stop.mjs";
import { tempDir } from "./helpers.mjs";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("interactive inference revokes background work but waits for physical cleanup before admission", async () => {
	const arbiter = createInferenceArbiter();
	const background = await arbiter.acquire({ id: "index", role: "embedding", priority: 2, preemptible: true });
	let started = false;
	const foreground = arbiter.run({ id: "voice", role: "speech", priority: 0 }, async () => { started = true; return "heard"; });
	await tick();
	assert.equal(background.signal.reason.code, "INFERENCE_PREEMPTED");
	assert.equal(arbiter.status().running.length, 1);
	assert.equal(started, false, "revocation does not release a worker's slot");
	background.release();
	assert.equal(await foreground, "heard");
	assert.equal(started, true);
	background.release();
	assert.deepEqual(arbiter.status().running, []);
	arbiter.close();
});

test("waiting cancellation, expiry, and bounded queue never start obsolete jobs", async () => {
	const arbiter = createInferenceArbiter({ maxWaiting: 1 });
	const active = await arbiter.acquire();
	const ac = new AbortController();
	const waiting = arbiter.acquire({ id: "cancel", signal: ac.signal });
	await assert.rejects(arbiter.acquire({ id: "excess" }), { code: "INFERENCE_QUEUE_FULL" });
	const rejected = assert.rejects(waiting, { name: "AbortError" });
	ac.abort();
	await rejected;
	const expired = arbiter.acquire({ id: "expired", deadline: Date.now() - 1 });
	await assert.rejects(expired, { code: "INFERENCE_EXPIRED" });
	assert.equal(arbiter.status().waiting.length, 0);
	active.release();
	arbiter.close();
});

test("suspend/lock and emergency pause all local roles and block action authority", async () => {
	const arbiter = createInferenceArbiter(), stop = createStopControl();
	const queue = createQueue({ start() {} });
	const resources = createResources({ queue, arbiter, stop, settings: () => ({ profile: "balanced" }) });
	resources.apply();
	const lease = await arbiter.acquire({ role: "speech" });
	resources.signal({ type: "lock-screen" });
	assert.ok(lease.signal.aborted);
	assert.match(stop.blocked("mission"), /locked/);
	await assert.rejects(arbiter.acquire({ role: "embedding" }), { code: "INFERENCE_PAUSED" });
	queue.enqueue({ missionId: "mission", priority: PRIORITY.user });
	assert.match(queue.why("mission"), /unlock/);
	resources.signal({ type: "suspend" });
	resources.signal({ type: "unlock-screen" });
	assert.match(stop.blocked("mission"), /suspended/);
	resources.signal({ type: "resume" });
	assert.equal(stop.blocked("mission"), undefined);
	lease.release();
	stop.emergencyStop();
	await assert.rejects(arbiter.acquire(), { code: "INFERENCE_PAUSED" });
	stop.clearEmergency();
	(await arbiter.acquire()).release();
	resources.close(); arbiter.close();
});

test("battery gates embeddings/build work without delaying explicit speech", async () => {
	const arbiter = createInferenceArbiter();
	const resources = createResources({ queue: createQueue({ start() {} }), arbiter, settings: () => ({ profile: "balanced" }) });
	resources.signal({ type: "on-battery" });
	let indexed = false;
	const index = arbiter.run({ role: "embedding", priority: 2 }, async () => { indexed = true; });
	assert.match(arbiter.status().waiting[0].why, /power/);
	await arbiter.run({ role: "speech", priority: 0 }, async () => {});
	assert.equal(indexed, false);
	resources.signal({ type: "on-ac" });
	await index;
	assert.equal(indexed, true);
	resources.close(); arbiter.close();
});

test("resource profiles admit builder work in Balanced/Burst and explicit local work in Quiet", async t => {
	const arbiter = createInferenceArbiter(), queue = createQueue({ start() {} });
	let profile = "balanced";
	const resources = createResources({ queue, arbiter, settings: () => ({ profile }) });
	t.after(() => { resources.close(); queue.close(); arbiter.close(); });
	for (const value of ["balanced", "burst", "quiet"]) {
		profile = value; resources.apply();
		const pending = arbiter.acquire({ role: value === "quiet" ? "text" : "builder-validation", priority: value === "quiet" ? 1 : 4 });
		pending.catch(() => {}); await tick();
		assert.equal(arbiter.status().running.length, 1, `${value} must admit its authorized local work`);
		(await pending).release();
	}
});

test("builder admission respects Quiet/Focused and battery while retaining its low compute priority", async t => {
	const arbiter = createInferenceArbiter(), queue = createQueue({ start() {} });
	let profile = "quiet";
	const resources = createResources({ queue, arbiter, settings: () => ({ profile }) });
	t.after(() => { resources.close(); queue.close(); arbiter.close(); });
	resources.apply();
	const pending = arbiter.acquire({ role: "builder-validation", priority: 4 }); pending.catch(() => {});
	assert.match(arbiter.status().waiting[0].why, /Quiet/);
	profile = "focused"; resources.apply(); assert.match(arbiter.status().waiting[0].why, /Focused/);
	profile = "balanced"; resources.signal({ type: "on-battery" }); assert.match(arbiter.status().waiting[0].why, /power/);
	const speech = await arbiter.acquire({ role: "speech", priority: 0 }); speech.release();
	resources.signal({ type: "on-ac" }); const builder = await pending;
	assert.equal(arbiter.status().running[0].priority, 4);
	builder.release();
});

test("provider leases end at stream completion, letting subsequent tool embeddings run", async () => {
	const arbiter = createInferenceArbiter(), completion = deferred();
	const provider = admittedStream((_model, _context, options) => ({ signal: options.signal, result: () => completion.promise }), arbiter, { priority: 0 });
	const stream = await provider({}, {});
	assert.equal(arbiter.status().running[0].role, "text");
	completion.resolve({ role: "assistant" });
	await stream.result();
	await arbiter.run({ role: "embedding", priority: 0 }, async () => {});
	assert.equal(arbiter.status().running.length, 0);
	arbiter.close();
});

test("speech and embedding runtimes share admission and await termination before another model starts", async t => {
	const dataDir = tempDir("admission"), arbiter = createInferenceArbiter();
	for (const [folder, metadata] of [["voice-runtime", { model: SPEECH_MODEL_ID, revision: SPEECH_MODEL_REVISION }], ["search-runtime", { model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, dtype: EMBEDDING_DTYPE }]]) {
		fs.mkdirSync(path.join(dataDir, folder, "models"), { recursive: true });
		fs.writeFileSync(path.join(dataDir, folder, "prepared.json"), JSON.stringify(metadata));
	}
	const termination = deferred(), workers = [];
	const workerFactory = data => {
		const w = new EventEmitter(); workers.push(w); w.data = data;
		w.terminate = () => { w.terminated = true; return w.hanging ? termination.promise : Promise.resolve(); };
		w.postMessage = message => {
			w.last = message;
			queueMicrotask(() => {
				if (message.op === "load") w.emit("message", { id: message.id, ok: true, result: {} });
				else if (message.op === "text") w.hanging = true;
				else w.emit("message", { id: message.id, ok: true, result: { text: `heard ${message.language}` } });
			});
		};
		return w;
	};
	const speech = createSpeechRuntime({ paths: { dataDir }, arbiter, workerFactory });
	const embedding = createEmbeddingRuntime({ paths: { dataDir }, settings: { embedding: {} }, arbiter, workerFactory });
	t.after(async () => { termination.resolve(); arbiter.close(); await speech.close(); await embedding.close(); });
	const background = embedding.embedText(["index passage"]);
	const backgroundRejected = assert.rejects(background, { code: "INFERENCE_PREEMPTED" });
	while (!workers[0]?.hanging) await tick();
	const foreground = speech.transcribe(new Float32Array(16000), { language: null });
	await tick();
	assert.equal(workers.length, 1, "speech cannot load during an embedding's asynchronous termination");
	assert.equal(workers[0].terminated, true);
	termination.resolve();
	await backgroundRejected;
	assert.deepEqual(await foreground, { text: "heard null" });
	assert.equal(workers.length, 2);
	assert.equal(arbiter.status().running.length, 0);
});
