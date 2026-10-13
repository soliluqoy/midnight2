import assert from "node:assert/strict";
import test from "node:test";
import { createPushToTalk } from "../src/voice/ptt.mjs";
import { createCaptureEpoch } from "../src/voice/capture-epoch.mjs";
import { createQuickAssist } from "../src/desktop/quick-assist.mjs";
import { sha256 } from "../src/policy/canonical.mjs";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const foreground = { windowId: "52", processId: 41 };
function fixture(t) {
	const calls = [], shows = [], record = [], transcript = [], fence = createCaptureEpoch();
	const snapshot = { kind: "paragraph", documentId: "PRIVATE_DOCUMENT", handle: "PRIVATE_HANDLE", processId: 41, windowId: "52", text: "Revenue rose by 12%.", metadata: { supported: true, scope: "paragraph" }, structureHash: sha256("original"), connector: { id: "word", api: 1, artifact: sha256("native") } };
	let config = { voice: true, pushToTalk: true, voiceLanguage: "en", privacy: "cloud" };
	const word = { capture: async options => { calls.push({ kind: "capture", options }); return structuredClone(snapshot); }, inspect: async () => structuredClone(snapshot), release: async () => {} };
	const quick = createQuickAssist({ word, request: async (method, params) => { calls.push({ kind: method, params }); return method === "query.mission" ? { status: "running" } : { missionId: "m1" }; }, settings: () => config, blocked: () => fence.blocked(), present: options => shows.push(options) });
	const samples = new Float32Array(16000).fill(0.1);
	const recorder = { begin: async args => { record.push({ op: "begin", ...args }); }, end: async args => { record.push({ op: "end", ...args }); return { samples }; }, cancel: async args => { record.push({ op: "cancel", ...args }); } };
	const options = { quick, recorder, fence, settings: () => config, transcribe: async args => { transcript.push(args); return { text: "Make this paragraph clearer" }; } };
	let ptt = createPushToTalk(options);
	t.after(() => { ptt.close(); quick.close(); });
	return { get ptt() { return ptt; }, replace(overrides) { ptt.close(); ptt = createPushToTalk({ ...options, ...overrides }); }, quick, word, recorder, samples, calls, shows, transcript, fence, config };
}
test("a held voice gesture captures the original window before audio, stays passive and submits only on release", async t => {
	const f = fixture(t); await f.ptt.down(foreground);
	assert.equal(f.calls[0].kind, "capture"); assert.equal(f.calls[0].options.expectedWindowId, "52"); assert.equal(f.calls[0].options.expectedProcessId, 41);
	assert.equal(f.quick.state().voicePhase, "listening"); assert.equal(f.transcript.length, 0); assert.equal(f.shows.some(show => show.focus), false);
	await f.ptt.down(foreground); // repeat cannot create another capture
	assert.equal(f.calls.filter(call => call.kind === "capture").length, 1);
	await f.ptt.up(); await f.ptt.up();
	assert.equal(f.transcript.length, 1); assert.equal(f.transcript[0].language, "en"); assert.ok(f.transcript[0].deadline <= Date.now() + 30_000);
	assert.equal(f.calls.filter(call => call.kind === "mission.targetAssist").length, 1); assert.equal(f.calls.some(call => call.kind === "mission.targetApply"), false);
	assert.equal(f.samples.every(value => value === 0), true); assert.equal(f.shows.some(show => show.focus), false);
});
test("release before microphone permission discards the late start and never transcribes", async t => {
	const f = fixture(t), permission = deferred(); f.recorder.begin = () => permission.promise;
	const down = f.ptt.down(foreground); await f.ptt.up(); permission.resolve(); await down;
	assert.equal(f.quick.state().phase, "closed"); assert.equal(f.transcript.length, 0); assert.equal(f.ptt.canRecord(), false);
});
test("a late transcript after lock and unlock cannot submit a model request or restore its target", async t => {
	const f = fixture(t), reply = deferred(); f.replace({ transcribe: () => reply.promise }); await f.ptt.down(foreground); const up = f.ptt.up();
	await new Promise(resolve => setImmediate(resolve)); f.fence.setReason("lock", "Locked"); f.ptt.cancel(); f.quick.invalidate(); f.fence.setReason("lock", undefined);
	reply.resolve({ text: "Make a late change" }); await up;
	assert.equal(f.quick.state().phase, "closed"); assert.equal(f.calls.some(call => call.kind === "mission.targetAssist"), false); assert.equal(f.samples.every(value => value === 0), true);
});
test("another voice gesture cannot dismiss an existing typed quick edit", async t => {
	const f = fixture(t); await f.quick.open(); const before = f.quick.state().panelId;
	await f.ptt.down(foreground); assert.equal(f.quick.state().panelId, before); assert.equal(f.quick.state().phase, "input"); assert.equal(f.transcript.length, 0);
});
test("silence, excessive audio and a changed target never reach cloud generation", async t => {
	for (const invalid of [new Float32Array(16000), new Float32Array(480001), Float32Array.of(NaN)]) {
		const f = fixture(t); f.recorder.end = async () => ({ samples: invalid }); await f.ptt.down(foreground); await f.ptt.up();
		assert.equal(f.transcript.length, 0); assert.equal(f.quick.state().phase, "error"); assert.equal(f.calls.some(call => call.kind === "mission.targetAssist"), false);
	}
	const f = fixture(t); await f.ptt.down(foreground); f.word.inspect = async () => ({ text: "Another target" }); await f.ptt.up();
	assert.equal(f.calls.some(call => call.kind === "mission.targetAssist"), false);
});
test("language and privacy changes require a fresh voice gesture", async t => {
	const f = fixture(t); f.config.voiceLanguage = "auto"; await f.ptt.down(foreground); await f.ptt.up(); assert.equal(f.transcript[0].language, null);
	const privacy = fixture(t); await privacy.ptt.down(foreground); privacy.config.privacy = "local"; await privacy.ptt.up(); assert.equal(privacy.transcript.length, 0);
	const language = fixture(t); await language.ptt.down(foreground); language.config.voiceLanguage = "ms"; await language.ptt.up(); assert.equal(language.transcript.length, 0);
	const g = fixture(t); await g.ptt.down(foreground); g.config.pushToTalk = false; await g.ptt.up(); assert.equal(g.transcript.length, 0);
});
test("native hearing has explicit cloud status and any media-route change revokes a held gesture", async t => {
	const f = fixture(t); f.config.perception = { enabled: true, provider: "google", model: "gemini-3.8-flash" }; let status;
	f.replace({ transcribe: async () => { status = f.quick.state().message; return { text: "Do not change the numbers." }; } }); await f.ptt.down(foreground); await f.ptt.up();
	assert.match(status, /cloud media provider/); assert.equal(f.calls.find(call => call.kind === "mission.targetAssist").params.text, "Do not change the numbers.");
	const g = fixture(t); g.config.perception = { enabled: true, provider: "google", model: "gemini-3.8-flash" }; await g.ptt.down(foreground); g.config.perception.provider = "openai"; await g.ptt.up(); assert.equal(g.transcript.length, 0);
});
test("one successful local preparation overlaps recording and final transcription waits for it", async t => {
	const f = fixture(t), preparing = deferred(), order = []; let signal;
	f.replace({ prepareSpeech: (args, options) => { order.push("prepare"); signal = options.signal; assert.equal(args.captureId, f.ptt.currentId()); assert.ok(args.deadline <= Date.now() + 30000); return preparing.promise; }, transcribe: async () => { order.push("transcribe"); return { text: "Make this paragraph clearer" }; } });
	await f.ptt.down(foreground); assert.equal(f.quick.state().voicePhase, "listening"); assert.deepEqual(order, ["prepare"]); assert.equal(signal.aborted, false);
	const up = f.ptt.up(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(order, ["prepare"]); preparing.resolve({ loaded: true }); await up; assert.deepEqual(order, ["prepare", "transcribe"]); assert.equal(f.calls.some(call => call.kind === "mission.targetApply"), false);
});
test("cancelled or failed warming never submits speech, and native hearing does not warm Whisper", async t => {
	const f = fixture(t), preparing = deferred(); let signal;
	f.replace({ prepareSpeech: (_args, options) => { signal = options.signal; return preparing.promise; } }); await f.ptt.down(foreground); const up = f.ptt.up(); await new Promise(resolve => setImmediate(resolve)); f.ptt.cancel(); assert.equal(signal.aborted, true); preparing.resolve(); await up; assert.equal(f.transcript.length, 0); assert.equal(f.samples.every(value => value === 0), true);
	const missing = fixture(t); missing.replace({ prepareSpeech: async () => { throw new Error("Voice input is not installed."); } }); await missing.ptt.down(foreground); await new Promise(resolve => setImmediate(resolve)); assert.equal(missing.ptt.canRecord(), false); assert.equal(missing.quick.state().phase, "error"); assert.equal(missing.transcript.length, 0);
	const native = fixture(t); let loads = 0; native.config.perception = { enabled: true, provider: "google" }; native.replace({ prepareSpeech: async () => loads++ }); await native.ptt.down(foreground); await native.ptt.up(); assert.equal(loads, 0);
});
