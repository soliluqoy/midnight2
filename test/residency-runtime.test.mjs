import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createResidencyBudget, GiB, LOCAL_MODEL_BUDGETS } from "../src/inference/residency.mjs";
import { createInferenceArbiter } from "../src/inference/arbiter.mjs";
import { createSpeechRuntime } from "../src/voice/runtime.mjs";
import { createEmbeddingRuntime, EMBEDDING_MODEL, EMBEDDING_REVISION, EMBEDDING_DTYPE } from "../src/search/runtime.mjs";
import { SPEECH_MODEL_ID, SPEECH_MODEL_REVISION } from "../src/voice/model-files.mjs";
import { tempDir } from "./helpers.mjs";
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
function fixture(t, { available = 7 * GiB } = {}) {
	const dataDir = tempDir("memory-runtime"), arbiter = createInferenceArbiter(), workers = [], exit = deferred();
	for (const [folder, metadata] of [["voice-runtime", { model: SPEECH_MODEL_ID, revision: SPEECH_MODEL_REVISION }], ["search-runtime", { model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, dtype: EMBEDDING_DTYPE }]]) { fs.mkdirSync(path.join(dataDir, folder, "models"), { recursive: true }); fs.writeFileSync(path.join(dataDir, folder, "prepared.json"), JSON.stringify(metadata)); }
	const budget = createResidencyBudget({ intervalMs: 20, readMemory: () => ({ total: 16 * GiB, available: available - workers.filter(worker => worker.alive).reduce((sum, worker) => sum + LOCAL_MODEL_BUDGETS[worker.role].footprint, 0) }), onPressure: () => arbiter.revokeBackground() });
	const factory = role => () => {
		const worker = new EventEmitter(); worker.role = role; worker.alive = true; worker.messages = []; workers.push(worker);
		worker.terminate = async () => { worker.stopping = true; if (worker.delayExit) await exit.promise; worker.alive = false; worker.emit("exit", 0); };
		worker.postMessage = message => { worker.messages.push(message); queueMicrotask(() => { if (message.op === "load") worker.emit("message", { id: message.id, ok: true, result: {} }); else if (role === "speech") worker.emit("message", { id: message.id, ok: true, result: { text: "Make this clearer." } }); else if (!worker.hang) worker.emit("message", { id: message.id, ok: true, result: message.texts.map(() => [1, ...Array(127).fill(0)]) }); }); };
		return worker;
	};
	const speech = createSpeechRuntime({ paths: { dataDir }, arbiter, residencyBudget: budget, workerFactory: factory("speech") }), embedding = createEmbeddingRuntime({ paths: { dataDir }, settings: { embedding: { dimensions: 128 } }, arbiter, residencyBudget: budget, workerFactory: factory("embedding") });
	for (const [role, model] of [["speech", speech], ["embedding", embedding]]) budget.register({ role, ...LOCAL_MODEL_BUDGETS[role], inspect: model.residency, unload: model.unload });
	t.after(async () => { exit.resolve(); arbiter.close(); await budget.close(); await speech.close(); await embedding.close(); });
	return { budget, arbiter, speech, embedding, workers, exit, setAvailable: value => available = value };
}
test("real runtime lifecycle refuses new model startup until idle embedding exit and capacity recovery", async t => {
	const f = fixture(t); await f.embedding.embedText(["Synthetic passage"], { query: true }); const old = f.workers[0]; old.delayExit = true;
	const next = f.speech.prepare(); await tick(); assert.equal(old.stopping, true); assert.equal(old.alive, true); assert.equal(f.workers.length, 1); assert.equal(f.embedding.residency().resident, true); assert.equal(f.embedding.residency().unloading, true);
	f.exit.resolve(); await next; assert.equal(old.alive, false); assert.equal(f.workers.length, 2); assert.equal(f.speech.status().loaded, true); assert.equal(f.budget.status().reservations, 0); assert.equal(f.budget.status().estimatedOwnedBytes, GiB);
});
test("memory denial never loads a local worker and a fresh attempt can run after recovery", async t => {
	const f = fixture(t, { available: 4 * GiB }); await assert.rejects(f.speech.prepare(), { code: "INFERENCE_MEMORY_PRESSURE" }); assert.equal(f.workers.length, 0); assert.equal(f.speech.residency().busy, false);
	f.setAvailable(10 * GiB); await f.speech.prepare(); assert.equal(f.workers.length, 1); assert.equal(f.budget.status().reservations, 0);
});
test("memory waiting background work yields its shared CPU lease to explicit speech without spawning the embedder", async t => {
	const f = fixture(t, { available: 6 * GiB }), pending = f.embedding.embedText(["Background passage"]), rejected = assert.rejects(pending, { code: "INFERENCE_PREEMPTED" }); await tick(); assert.equal(f.budget.status().waiting.length, 1); assert.equal(f.workers.length, 0);
	await f.speech.prepare(); await rejected; assert.equal(f.workers.length, 1); assert.equal(f.workers[0].role, "speech"); assert.equal(f.budget.status().waiting.length, 0);
});
test("pressure cancels an active background model but retains its reservation until physical exit", async t => {
	const f = fixture(t, { available: 10 * GiB }); await f.embedding.embedText(["Warm"], { query: true }); const old = f.workers[0]; old.hang = true; old.delayExit = true;
	const pending = f.embedding.embedText(["Background"]), rejected = assert.rejects(pending, { code: "INFERENCE_MEMORY_PRESSURE" }); await tick(); f.setAvailable(5 * GiB); await f.budget.check(); assert.equal(old.stopping, true); assert.equal(old.alive, true); assert.equal(f.budget.status().reservations, 1); assert.equal(f.arbiter.status().running.length, 1);
	f.exit.resolve(); await rejected; assert.equal(f.budget.status().reservations, 0); assert.equal(f.arbiter.status().running.length, 0); assert.equal(old.alive, false);
});
test("unconfirmed worker termination is retained as resident and prevents another speech load", async t => {
	const f = fixture(t, { available: 10 * GiB }); await f.speech.prepare(); const old = f.workers[0]; old.terminate = () => Promise.reject(new Error("Termination failed.")); await f.speech.unload(); assert.equal(f.speech.residency().resident, true); assert.equal(f.speech.residency().unloading, true); await assert.rejects(f.speech.prepare(), /has not exited/); assert.equal(f.workers.length, 1);
	old.alive = false; old.emit("exit", 0); await f.speech.prepare(); assert.equal(f.workers.length, 2);
});
test("unconfirmed embedding termination keeps the old allocation and never spawns a replacement", async t => {
	const f = fixture(t, { available: 10 * GiB }); await f.embedding.embedText(["Warm"], { query: true }); const old = f.workers[0]; old.terminate = () => Promise.reject(new Error("Termination failed.")); await f.embedding.unload(); assert.equal(f.embedding.residency().resident, true); await assert.rejects(f.embedding.embedText(["Fresh"], { query: true }), /has not exited/); assert.equal(f.workers.length, 1); old.alive = false; old.emit("exit", 0);
});
