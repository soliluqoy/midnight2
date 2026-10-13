import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createHost } from "../src/runtime/host.mjs";
import { METHODS, validateRequest } from "../src/contracts/ipc.mjs";
import { makeModel, fakePlatform, fauxAssistantMessage, fauxText, settled } from "./e2e-helpers.mjs";
import { tempDir } from "./helpers.mjs";
test("native audio interpretation reaches an isolated paragraph preview without tools, document upload or Whisper", async t => {
	const model = await makeModel(); await model.rt.setRuntimeApiKey("google", "SYNTHETIC_MEDIA_KEY"); const mediaCalls = []; let modelPacket, localSpeech = 0;
	model.faux.setResponses([ctx => { modelPacket = ctx; return fauxAssistantMessage([fauxText(JSON.stringify({ kind: "paragraph.replace", text: "Revenue grew by 12%." }))]); }]);
	const adapter = { transport: "scripted-media", declared: { audio: true, image: true, nativeVideo: true, orderedFrames: true }, async observe({ packet, coverage }) {
		mediaCalls.push(structuredClone(packet)); const silence = packet.requestId.endsWith("silence"), instruction = packet.requestId.endsWith("spoken-negation") ? "Do not change the numbers." : "Make this paragraph clearer.";
		return { text: JSON.stringify({ observation: packet.requestId.endsWith("frame-order") ? "Red blue green." : "3 red bars.", instruction: packet.purpose === "audio.intent" ? instruction : null, confidence: silence ? 0.1 : 0.95, evidence: coverage.map(item => ({ mediaId: item.id, startMs: item.startMs, endMs: item.endMs })) }) };
	} };
	const dataDir = tempDir("media-host"), platform = fakePlatform(), host = await createHost({ dataDir, core: model.core, modelRuntime: model.rt, platform, perceptionAdapters: { google: adapter, openai: adapter }, speechRuntime: { status: () => ({ available: false }), close: async () => {}, transcribe: async () => { localSpeech++; throw new Error("Local speech must not run in the native route."); } }, settings: { provider: "faux", model: "m1", privacy: "cloud", voice: true, pushToTalk: true, instructions: "PRIVATE_STANDING_INSTRUCTIONS", perception: { enabled: true, provider: "google", model: "gemini-3.8-flash" } } }); t.after(() => host.close());
	assert.equal((await host.handle("perception.status")).qualification, "unqualified"); await host.handle("perception.qualify");
	const samples = new Float32Array(16000).fill(0.1), packet = { requestId: "synthetic_utterance", purpose: "audio.intent", instruction: "Identify the utterance.", capturedAt: Date.now(), expiresAt: Date.now() + 5000, media: [{ id: "utterance", kind: "audio", startMs: 0, samples }] };
	const observation = await host.handle("perception.observe", packet); assert.equal(samples.every(value => value === 0), true); assert.equal(observation.instruction, "Make this paragraph clearer."); assert.equal(localSpeech, 0);
	const target = { kind: "paragraph", documentId: "PRIVATE_DOCUMENT", handle: "PRIVATE_HANDLE", processId: 43, windowId: "6789", connector: { id: "word", api: 1, artifact: `sha256:${"a".repeat(64)}` }, text: "Revenue increased by 12%.", structureHash: `sha256:${"b".repeat(64)}`, metadata: { supported: true } };
	const { missionId } = await host.handle("mission.targetAssist", { text: observation.instruction, requestId: host.newRequestId(), target }); assert.equal((await settled(host, missionId)).status, "succeeded"); const proposal = await host.handle("mission.targetProposal", { missionId }); assert.equal(proposal.text, "Revenue grew by 12%.");
	assert.doesNotMatch(JSON.stringify(mediaCalls), /Revenue|PRIVATE_DOCUMENT|PRIVATE_HANDLE|PRIVATE_STANDING_INSTRUCTIONS|SYNTHETIC_MEDIA_KEY/);
	assert.doesNotMatch(JSON.stringify(modelPacket), /samples|Float32|utterance|PRIVATE_DOCUMENT|PRIVATE_HANDLE|PRIVATE_STANDING_INSTRUCTIONS|SYNTHETIC_MEDIA_KEY/); assert.deepEqual(modelPacket.tools ?? [], []); assert.match(JSON.stringify(modelPacket), /Revenue increased by 12/);
	assert.equal(platform.calls.some(item => item.op === "word.apply"), false); assert.doesNotMatch(fs.readFileSync(path.join(dataDir, "media-qualification.json"), "utf8"), /Revenue|SYNTHETIC_MEDIA_KEY|samples/);
	host.setSettings({ privacy: "offline" }); const refused = { ...packet, media: [{ ...packet.media[0], samples: new Float32Array(16000).fill(0.1) }] }; await assert.rejects(host.handle("perception.observe", refused), /privacy/); assert.equal(refused.media[0].samples.every(value => value === 0), true);
});
test("renderer can inspect status or invoke fixed synthetic checks but cannot send arbitrary media, keys or context", () => {
	for (const method of ["perception.status", "perception.qualify"]) { assert.equal(METHODS[method].route, "host"); assert.equal(validateRequest({ v: 1, seq: 1, method, params: {} }).ok, true); assert.equal(validateRequest({ v: 1, seq: 1, method, params: { document: "PRIVATE", media: [], apiKey: "KEY" } }).ok, false); }
	for (const method of ["perception.observe", "perception.cancel"]) assert.equal(validateRequest({ v: 1, seq: 1, method, params: {} }).ok, false);
});
