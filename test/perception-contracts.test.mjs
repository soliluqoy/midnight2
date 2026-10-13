import assert from "node:assert/strict";
import test from "node:test";
import { MEDIA_LIMITS, validateMediaPacket, validateObservation } from "../src/perception/contracts.mjs";
import { perceptionFixtures, fixtureDigest } from "../src/perception/fixtures.mjs";
import { perceptionSettings } from "../src/perception/config.mjs";
import { pcm24 } from "../src/perception/openai-realtime.mjs";
const packet = () => ({ requestId: "media_test", purpose: "audio.intent", instruction: "Identify the request.", capturedAt: Date.now(), expiresAt: Date.now() + 10_000, media: [{ id: "utterance", kind: "audio", startMs: 0, samples: new Float32Array(16000).fill(0.1) }] });
const result = () => ({ observation: "The user spoke a request.", instruction: "Do not change the numbers.", confidence: 0.9, evidence: [{ mediaId: "utterance", startMs: 0, endMs: 1000 }] });
test("native media has closed bounded source/time contracts and preserves spoken negation", () => {
	const p = packet(), coverage = validateMediaPacket(p); assert.equal(coverage[0].endMs, 1000); assert.equal(validateObservation(JSON.stringify(result()), p, coverage).instruction, "Do not change the numbers.");
	for (const change of [p => p.document = "PRIVATE", p => p.media[0].url = "https://private.test", p => p.media[0].startMs = -1, p => p.media[0].samples[1] = NaN, p => p.media[0].samples[1] = 1.1, p => p.media[0].samples = new Float32Array(480001), p => p.expiresAt = Date.now() - 1, p => p.expiresAt = p.capturedAt + 60_001, p => p.media.push(structuredClone(p.media[0])), p => p.media[0] = null]) { const value = packet(); change(value); assert.throws(() => validateMediaPacket(value)); }
	for (const change of [r => r.tool = "apply", r => r.instruction = null, r => r.confidence = 0.69, r => r.evidence[0].endMs = 1001, r => r.evidence[0].mediaId = "elsewhere", r => r.evidence[0] = null, r => r.observation = "x".repeat(3001)]) { const value = result(); change(value); assert.throws(() => validateObservation(JSON.stringify(value), p, coverage)); }
	assert.throws(() => validateObservation('{"observation":', p, coverage)); assert.throws(() => validateObservation("x".repeat(MEDIA_LIMITS.outputChars + 1), p, coverage));
});
test("fixed synthetic fixtures validate and frame count/dimensions/order/rate stay bounded", () => {
	const fixtures = perceptionFixtures(); assert.equal(fixtures.length, 5); assert.match(fixtureDigest(), /^[a-f0-9]{64}$/);
	for (const fixture of fixtures) { const p = { ...packet(), purpose: fixture.purpose, instruction: fixture.instruction, media: fixture.media }; assert.doesNotThrow(() => validateMediaPacket(p)); }
	const p = { ...packet(), purpose: "observe", media: fixtures.at(-1).media };
	const unordered = structuredClone(p); unordered.media.reverse(); assert.throws(() => validateMediaPacket(unordered), /ordering/);
	const rapid = structuredClone(p); rapid.media[1].timeMs = 999; assert.throws(() => validateMediaPacket(rapid), /ordering/);
	const oversized = structuredClone(p); new DataView(oversized.media[0].data.buffer).setUint32(16, 1601); assert.throws(() => validateMediaPacket(oversized), /dimensions/);
	const tooMany = structuredClone(p); for (let i = 3; i < 5; i++) tooMany.media.push({ ...structuredClone(p.media[0]), id: `extra${i}`, timeMs: i * 1000 }); assert.throws(() => validateMediaPacket(tooMany), /bounds/);
	const mismatched = structuredClone(p); mismatched.media[0].mimeType = "image/jpeg"; assert.throws(() => validateMediaPacket(mismatched), /format/);
});
test("media route normalization has no local model requirement and PCM conversion is bounded 24 kHz", () => {
	assert.deepEqual(perceptionSettings({}), { enabled: false, provider: "google", model: "gemini-3.8-flash" });
	assert.equal(perceptionSettings({ provider: "openai", model: "../../secret" }).model, "gpt-realtime-2.1");
	const pcm = pcm24(Float32Array.of(-1, 0, 1, 0)); assert.equal(pcm.length, 12); assert.equal(pcm.readInt16LE(0), -32767); assert.equal(pcm.readInt16LE(6), 32767);
});
