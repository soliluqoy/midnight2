import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createHost } from "../src/runtime/host.mjs";
import { validateRequest } from "../src/contracts/ipc.mjs";
import { makeModel, fakePlatform } from "./e2e-helpers.mjs";
import { tempDir } from "./helpers.mjs";

test("bounded PTT ASR stays shell-only, honors scoped cancellation and clears its owned PCM", async t => {
	const model = await makeModel(), calls = [];
	const speechRuntime = { status: () => ({ available: true }), unload: async () => {}, close: async () => {}, transcribe(samples, options) { calls.push({ samples, options }); return new Promise((_resolve, reject) => { options.signal.addEventListener("abort", () => reject(new Error("Speech cancelled.")), { once: true }); }); } };
	const host = await createHost({ dataDir: tempDir("ptt-host"), core: model.core, modelRuntime: model.rt, speechRuntime, platform: fakePlatform(), settings: { voice: true, pushToTalk: true } }); t.after(() => host.close());
	const params = { captureId: `ptt_${randomUUID()}`, samples: new Float32Array(16000).fill(0.1), language: "en", deadline: Date.now() + 20_000 };
	assert.equal(validateRequest({ v: 1, seq: 1, method: "voice.quickTranscribe", params }).ok, false);
	await assert.rejects(host.handle("voice.quickTranscribe", { ...params, samples: new Float32Array(480001) }), /bounded/);
	const pending = host.handle("voice.quickTranscribe", params), rejected = assert.rejects(pending, /cancelled/);
	await host.handle("voice.quickCancel", { captureId: `ptt_${randomUUID()}` }); assert.equal(calls[0].options.signal.aborted, false);
	await host.handle("voice.quickCancel", { captureId: params.captureId }); await rejected; assert.equal(calls[0].options.maxSeconds, 30); assert.equal(calls[0].options.priority, 0); assert.equal(params.samples.every(value => value === 0), true);
	const expiring = { ...params, captureId: `ptt_${randomUUID()}`, samples: new Float32Array(16000).fill(0.1), deadline: Date.now() + 100 };
	await assert.rejects(host.handle("voice.quickTranscribe", expiring), /cancelled/); assert.equal(expiring.samples.every(value => value === 0), true);
	const second = { ...params, captureId: `ptt_${randomUUID()}`, samples: new Float32Array(16000).fill(0.1), deadline: Date.now() + 20_000 };
	const secondRejected = assert.rejects(host.handle("voice.quickTranscribe", second), /cancelled/); host.setSettings({ pushToTalk: false }); await secondRejected;
	await assert.rejects(host.handle("voice.quickTranscribe", { ...second, captureId: `ptt_${randomUUID()}` }), /disabled/);
});
test("gesture-owned preparation accepts no audio, honors stop/deadline and releases its scope before transcription", async t => {
	const model = await makeModel(), calls = [];
	const speechRuntime = { status: () => ({ available: true }), unload: async () => {}, close: async () => {}, prepare(options) { calls.push(options); return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Preparation cancelled.")), { once: true })); } };
	const host = await createHost({ dataDir: tempDir("ptt-prepare"), core: model.core, modelRuntime: model.rt, speechRuntime, platform: fakePlatform(), settings: { voice: true, pushToTalk: true } }); t.after(() => host.close());
	const p = { captureId: `ptt_${randomUUID()}`, deadline: Date.now() + 20_000 };
	assert.equal(validateRequest({ v: 1, seq: 1, method: "voice.quickPrepare", params: p }).ok, false); await assert.rejects(host.handle("voice.quickPrepare", { ...p, samples: new Float32Array(16000) }), /bounded/); assert.equal(calls.length, 0);
	const pending = host.handle("voice.quickPrepare", p), rejected = assert.rejects(pending, /cancelled/); await host.handle("voice.quickCancel", { captureId: `ptt_${randomUUID()}` }); assert.equal(calls[0].signal.aborted, false);
	await assert.rejects(host.handle("voice.quickPrepare", p), /bounded/); await host.handle("voice.quickCancel", p); await rejected;
	const expiring = { ...p, deadline: Date.now() + 25 }; await assert.rejects(host.handle("voice.quickPrepare", expiring), /cancelled/);
	const locked = assert.rejects(host.handle("voice.quickPrepare", { ...p, deadline: Date.now() + 20_000 }), /cancelled/); host.signal({ type: "lock-screen" }); host.signal({ type: "unlock-screen" }); await locked; assert.equal(calls[0].priority, 0);
	host.setSettings({ perception: { enabled: true } }); await assert.rejects(host.handle("voice.quickPrepare", p), /disabled/);
});
test("speech retention follows power/profile and disabling voice or emergency stop unloads its model", async t => {
	const model = await makeModel(), budgets = []; let unloads = 0;
	const speechRuntime = { status: () => ({ available: true }), unload: async () => { unloads++; }, close: async () => {}, setIdleRetention: value => budgets.push(value) };
	const host = await createHost({ dataDir: tempDir("voice-retention"), core: model.core, modelRuntime: model.rt, speechRuntime, platform: fakePlatform(), settings: { voice: true, pushToTalk: true } }); t.after(() => host.close()); await host.start();
	assert.equal(budgets.at(-1), 120000); host.signal({ type: "on-battery" }); assert.equal(budgets.at(-1), 30000); host.signal({ type: "on-ac" }); assert.equal(budgets.at(-1), 120000); host.setSettings({ profile: "quiet" }); assert.equal(budgets.at(-1), 30000); host.setSettings({ voice: false }); assert.equal(unloads, 1); await host.handle("stop.emergency"); assert.equal(unloads, 2);
});
test("held-speech memory protection is private, bounded and revoked on scoped cancellation or settings changes", async t => {
	const model = await makeModel(), speechRuntime = { status: () => ({ available: true }), prepare: async () => ({ loaded: true }), transcribe: async () => ({ text: "A request." }), unload: async () => {}, close: async () => {} };
	const host = await createHost({ dataDir: tempDir("speech-hold"), core: model.core, modelRuntime: model.rt, speechRuntime, platform: fakePlatform(), settings: { voice: true, pushToTalk: true } }); t.after(() => host.close());
	const p = { captureId: `ptt_${randomUUID()}`, deadline: Date.now() + 20_000 }; await host.handle("voice.quickPrepare", p); let memory = (await host.handle("resources.status")).memory; assert.equal(memory.pins.length, 1); assert.equal(memory.pins[0].role, "speech"); assert.doesNotMatch(JSON.stringify(memory), new RegExp(p.captureId));
	await assert.rejects(host.handle("voice.quickPrepare", p), /bounded/); await host.handle("voice.quickCancel", { captureId: `ptt_${randomUUID()}` }); assert.equal((await host.handle("resources.status")).memory.pins.length, 1); await host.handle("voice.quickCancel", p); assert.equal((await host.handle("resources.status")).memory.pins.length, 0);
	await host.handle("voice.quickPrepare", p); host.setSettings({ voiceLanguage: "ms" }); assert.equal((await host.handle("resources.status")).memory.pins.length, 0);
	await host.handle("voice.quickPrepare", { ...p, deadline: Date.now() + 25 }); await new Promise(resolve => setTimeout(resolve, 40)); assert.equal((await host.handle("resources.status")).memory.pins.length, 0);
});
