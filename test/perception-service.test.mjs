import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createPerceptionService } from "../src/perception/service.mjs";
import { createStopControl } from "../src/policy/stop.mjs";
import { resolveMediaApiKey } from "../src/runtime/adapter.mjs";
import { createQualificationStore, qualificationIdentity } from "../src/perception/qualification.mjs";
import { perceptionFixtures } from "../src/perception/fixtures.mjs";
import { tempDir } from "./helpers.mjs";
const packet = () => ({ requestId: "owned_audio", purpose: "audio.intent", instruction: "Identify the request.", capturedAt: Date.now(), expiresAt: Date.now() + 5000, media: [{ id: "utterance", kind: "audio", startMs: 0, samples: new Float32Array(16000).fill(0.1) }] });
function answer({ packet, coverage }) {
	const instruction = packet.requestId.endsWith("spoken-negation") ? "Do not change the numbers." : "Make this paragraph clearer.";
	const silence = packet.requestId.endsWith("silence"), observation = packet.requestId.endsWith("image-bars") ? "3 red bars." : packet.requestId.endsWith("frame-order") ? "Red, blue, green." : "A spoken request.";
	return { text: JSON.stringify({ observation, instruction: packet.purpose === "audio.intent" ? instruction : null, confidence: silence ? 0.1 : 0.95, evidence: coverage.map(item => ({ mediaId: item.id, startMs: item.startMs, endMs: item.endMs })) }) };
}
function fixture(t, { file = path.join(tempDir("media-policy"), "qualification.json") } = {}) {
	const settings = { privacy: "cloud", perception: { enabled: true, provider: "google", model: "gemini-3.8-flash" } }, stop = createStopControl(), calls = [], owned = []; let key = "SYNTHETIC_KEY";
	const adapter = { transport: "test-only", declared: { audio: true, image: true, nativeVideo: true, orderedFrames: true }, async observe(args) { calls.push(args); owned.push(...args.packet.media); args.onDelta("partial"); return answer(args); } };
	const options = { settings: () => settings, stop, qualificationFile: file, credential: async () => key, credentialStatus: async () => true, adapters: { google: adapter, openai: adapter } };
	const service = createPerceptionService(options); t.after(() => service.close());
	return { service, adapter, options, settings, stop, calls, owned, file, changeKey(value) { key = value; } };
}
test("cloud consent/privacy/session gates make zero transport calls; readiness is distinct from qualification", async t => {
	const f = fixture(t); assert.equal((await f.service.status()).available, true); assert.equal((await f.service.status()).qualification, "unqualified");
	await assert.rejects(f.service.observe(packet()), /not passed/); assert.equal(f.calls.length, 0);
	for (const privacy of ["local", "offline"]) { f.settings.privacy = privacy; await assert.rejects(f.service.observe(packet()), /privacy/); await assert.rejects(f.service.qualify(), /privacy/); }
	f.settings.privacy = "cloud"; f.settings.perception.enabled = false; await assert.rejects(f.service.observe(packet()), /disabled/); f.settings.perception.enabled = true; f.stop.setSessionBlocked("Locked"); await assert.rejects(f.service.qualify(), /blocked/); assert.equal(f.calls.length, 0);
});
test("synthetic checks persist only bounded outcomes, qualify the exact route and gate user media", async t => {
	const f = fixture(t); const qualified = await f.service.qualify(); assert.deepEqual(qualified.qualified, ["audio", "image", "orderedFrames"]); assert.equal(f.calls.length, 5);
	assert.equal(f.owned.every(item => (item.samples ?? item.data).every(value => value === 0)), true);
	const stored = fs.readFileSync(f.file, "utf8"); assert.doesNotMatch(stored, /SYNTHETIC_KEY|samples|base64|instruction|observation|utterance/);
	const result = await f.service.observe(packet()); assert.equal(result.instruction, "Make this paragraph clearer."); assert.equal(result.qualification, "fixtures-passed"); assert.deepEqual((await f.service.status()).qualified, ["audio", "image", "orderedFrames"]);
	const restarted = createPerceptionService(f.options); t.after(() => restarted.close()); assert.equal((await restarted.status()).qualification, "fixtures-passed");
	f.settings.perception.model = "other-model"; assert.equal((await f.service.status()).qualification, "unqualified"); await assert.rejects(f.service.observe(packet()), /not passed/);
	f.settings.perception.model = "gemini-3.8-flash"; f.changeKey("DIFFERENT_SYNTHETIC_KEY"); assert.equal((await f.service.status()).qualification, "unqualified"); await assert.rejects(f.service.observe(packet()), /not passed/);
});
test("a failed repeated check revokes qualification and video/combined-media remain unqualified", async t => {
	const f = fixture(t); await f.service.qualify();
	const video = { ...packet(), purpose: "observe", media: [{ id: "clip", kind: "video", data: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...Array(12).fill(0)]), mimeType: "video/webm", startMs: 0, durationMs: 1000 }] };
	await assert.rejects(f.service.observe(video), /not passed/); assert.equal(f.calls.length, 5);
	const mixed = packet(); mixed.purpose = "observe"; mixed.media.push(perceptionFixtures().find(item => item.id === "image-bars").media[0]); await assert.rejects(f.service.observe(mixed), /not passed/); assert.equal(f.calls.length, 5);
	f.adapter.observe = async args => ({ ...answer(args), text: answer(args).text.replace("3 red bars", "2 blue bars") });
	await assert.rejects(f.service.qualify(), /did not pass/); assert.equal((await f.service.status()).qualification, "unqualified"); await assert.rejects(f.service.observe(packet()), /not passed/);
});
test("lock/unlock and route changes during a late credential lookup discard its reply", async t => {
	for (const revoke of [f => { f.stop.setSessionBlocked("Locked"); f.stop.setSessionBlocked(undefined); }, f => { f.settings.perception.provider = "openai"; f.service.settingsChanged(); }]) {
		const f = fixture(t); let release; f.options.credential = () => new Promise(resolve => release = resolve); const service = createPerceptionService(f.options); t.after(() => service.close()); f.service = service;
		const rejected = assert.rejects(service.qualify(), /did not pass/); await new Promise(resolve => setImmediate(resolve)); revoke(f); release("LATE_KEY"); await rejected; assert.equal(f.calls.length, 0); assert.equal(service.isBusy(), false);
	}
});
test("cancellation retains the busy slot until transport exit and clears owned buffers before readmission", async t => {
	const f = fixture(t); await f.service.qualify(); let release, signal, owned;
	f.adapter.observe = args => { signal = args.signal; owned = args.packet.media[0].samples; return new Promise(resolve => release = () => resolve(answer(args))); };
	const pending = f.service.observe(packet()), rejected = assert.rejects(pending, /revoked/); await new Promise(resolve => setImmediate(resolve));
	f.service.cancel("someone_else"); assert.equal(signal.aborted, false); f.service.cancel("owned_audio"); assert.equal(signal.aborted, true); assert.equal(f.service.isBusy(), true); await assert.rejects(f.service.observe(packet()), /already running/);
	release(); await rejected; assert.equal(owned.every(value => value === 0), true); assert.equal(f.service.isBusy(), false);
});
test("expired/truncated observations, forged evidence and deadlines never become a spoken request", async t => {
	const f = fixture(t); await f.service.qualify();
	for (const text of ['{"observation":', JSON.stringify({ observation: "private", instruction: "Apply", confidence: 1, evidence: [{ mediaId: "other", startMs: 0, endMs: 1000 }] })]) { f.adapter.observe = async () => ({ text }); await assert.rejects(f.service.observe(packet())); }
	f.adapter.observe = args => new Promise((_resolve, reject) => args.signal.addEventListener("abort", () => reject(args.signal.reason), { once: true }));
	const p = packet(); p.expiresAt = Date.now() + 30; await assert.rejects(f.service.observe(p), /expired/); assert.equal(f.service.isBusy(), false);
});
test("qualification records reject malformed/stale outcomes and identities change with account/model/transport", () => {
	const route = { provider: "google", model: "gemini-3.8-flash" }, id = qualificationIdentity(route, "a", "KEY");
	assert.notEqual(id, qualificationIdentity(route, "a", "OTHER")); assert.notEqual(id, qualificationIdentity(route, "b", "KEY")); assert.notEqual(id, qualificationIdentity({ ...route, model: "other" }, "a", "KEY"));
	const store = createQualificationStore(); const checks = ["spoken-request", "spoken-negation", "silence", "image-bars", "frame-order"].map(id => ({ id, passed: true, elapsedMs: 10 }));
	assert.equal(store.pass(id, checks).capabilities.includes("nativeVideo"), false); assert.equal(store.get(id, Date.now() + 8 * 24 * 60 * 60_000), undefined); store.pass(id, [1, 2, 3, 4, 5]); assert.equal(store.get(id), undefined);
});
test("native credentials reject OAuth, proxies and secret-bearing errors without exposing the key", async () => {
	const rt = { checkAuth: async () => ({ type: "api_key" }), getAuth: async () => ({ auth: { apiKey: "TEST_KEY", baseUrl: "https://api.openai.com/v1" } }) };
	assert.equal(await resolveMediaApiKey(rt, "openai"), "TEST_KEY");
	for (const baseUrl of ["http://api.openai.com", "https://proxy.test/v1", "https://api.openai.com:444/v1", "https://user:pass@api.openai.com/v1", "https://api.openai.com/v1?key=SECRET", "https://api.openai.com/other"]) await assert.rejects(resolveMediaApiKey({ ...rt, getRegisteredProviderConfig: () => ({ baseUrl }) }, "openai"), /direct API/);
	await assert.rejects(resolveMediaApiKey({ ...rt, checkAuth: async () => ({ type: "oauth" }) }, "openai"), /OAuth/);
	await assert.rejects(resolveMediaApiKey({ ...rt, getAuth: async () => { throw new Error("SECRET_KEY"); } }, "openai"), error => !error.message.includes("SECRET_KEY"));
});
