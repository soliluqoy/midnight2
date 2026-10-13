// Actual cached Whisper and native embeddings; controlled pressure, no download, user document or real API call.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createHost } from "../src/runtime/host.mjs";
import { createInferenceArbiter } from "../src/inference/arbiter.mjs";
import { createResidencyBudget, readAvailableMemory, GiB } from "../src/inference/residency.mjs";
import { createSpeechRuntime } from "../src/voice/runtime.mjs";
import { createEmbeddingRuntime } from "../src/search/runtime.mjs";
import { createNativeEmbeddingAssets } from "../src/search/native-assets.mjs";
import { makeModel, fakePlatform } from "../test/e2e-helpers.mjs";

const voiceData = process.env.MIDNIGHT_TEST_VOICE_DATA;
if (!voiceData) throw new Error("Set MIDNIGHT_TEST_VOICE_DATA to an existing prepared voice cache. No downloads are permitted.");
const assets = createNativeEmbeddingAssets(); assert.equal(assets.present(), true, "existing signed embedding pair and CPU runtime required");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "midnight-residency-check-")), arbiter = createInferenceArbiter(); let forced = false, embedding, host;
const budget = createResidencyBudget({ readMemory: () => forced ? { total: readAvailableMemory().total, available: embedding.residency().resident ? 3 * GiB : 6 * GiB } : readAvailableMemory(), onPressure: () => arbiter.revokeBackground() });
const speech = createSpeechRuntime({ paths: { dataDir: voiceData }, arbiter, residencyBudget: budget, download: async () => { throw new Error("This qualification must not download Whisper."); } }); assert.equal(speech.status().available, true);
const settings = { provider: "faux", model: "m1", voice: true, pushToTalk: true, voiceLanguage: "en", privacy: "cloud", embedding: { enabled: true, dimensions: 128, device: "cpu" } };
embedding = createEmbeddingRuntime({ paths: { dataDir }, settings, arbiter, residencyBudget: budget, nativeAssets: assets, download: async () => { throw new Error("This qualification must reuse cached Gemma."); } });
try {
	const model = await makeModel(); host = await createHost({ dataDir, core: model.core, modelRuntime: model.rt, platform: fakePlatform(), settings, inferenceArbiter: arbiter, residencyBudget: budget, speechRuntime: speech, searchRuntime: embedding });
	const began = Date.now(); await embedding.setup(); console.log("PASS cached native setup under memory admission; no download");
	await embedding.embedText(["A synthetic railway passage."], { query: true }); const pid = embedding.status().pid; assert.ok(Number.isInteger(pid) && pid > 0); process.kill(pid, 0);
	const p = { captureId: `ptt_${randomUUID()}`, deadline: Date.now() + 30_000 }; await host.handle("voice.quickPrepare", p); assert.equal(speech.status().loaded, true); assert.equal(embedding.status().ready, true); const both = budget.status(); assert.equal(both.estimatedOwnedBytes, 3.5 * GiB); assert.equal(both.pins.length, 1); console.log("PASS both real local models resident; held speech protected");
	const marker = path.join(dataDir, "search-runtime", "prepared.json"), prepared = fs.readFileSync(marker), fingerprint = embedding.fingerprint(), before = readAvailableMemory(), pressureAt = Date.now(); forced = true; await budget.check(); const pressureMs = Date.now() - pressureAt;
	assert.equal(speech.status().loaded, true); assert.equal(embedding.status().ready, false); assert.equal(embedding.residency().resident, false); assert.equal(budget.status().estimatedOwnedBytes, GiB); assert.deepEqual(budget.status().evictions.map(value => value.role), ["embedding"]);
	let exists = true; try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") exists = false; else throw error; } assert.equal(exists, false, "the native PID must have exited before pressure handling returns"); const after = readAvailableMemory();
	assert.deepEqual(fs.readFileSync(marker), prepared); assert.equal(embedding.fingerprint(), fingerprint); assert.equal(embedding.status().available, true); console.log("PASS controlled pressure awaits actual native PID exit and retains warm Whisper/cache identity");
	await host.handle("voice.quickCancel", p); assert.equal(budget.status().pins.length, 0); forced = false;
	const report = { at: new Date().toISOString(), passed: true, elapsedMs: Date.now() - began, models: { speech: speech.status().model, embedding: embedding.status().model }, before: { realAvailableBytes: before.available, estimatedOwnedBytes: both.estimatedOwnedBytes }, after: { realAvailableBytes: after.available, estimatedOwnedBytes: budget.status().estimatedOwnedBytes }, controlledPressure: { injectedAvailableBytes: 3 * GiB, handlerMs: pressureMs, evictedRole: "embedding", nativeProcessExited: !exists, speechRetained: true, heldPinRevoked: true, cacheUnchanged: true, fingerprintUnchanged: true }, limits: { ...budget.status(), pins: [] }, limitations: ["Pressure availability is injected; this is not a real OS exhaustion or battery/soak test.", "Model budgets are conservative estimates, not OS-enforced memory limits or complete process-tree measurement.", "The existing cached models are read-only; setup metadata belongs to a disposable profile. No app effect or real cloud API call occurs."] };
	if (process.env.MIDNIGHT_TEST_REPORT) { const file = path.resolve(process.env.MIDNIGHT_TEST_REPORT); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2)); }
	console.log(JSON.stringify(report));
} finally { arbiter.close(); await budget.close(); if (host) await host.close(); else { await speech.close(); await embedding.close(); } }
