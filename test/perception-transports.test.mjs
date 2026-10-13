// Real loopback HTTP/SSE and WebSocket connections, synthetic media and fake credentials only.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { createGeminiPerception } from "../src/perception/gemini.mjs";
import { createOpenAiPerception } from "../src/perception/openai-realtime.mjs";
import { perceptionFixtures } from "../src/perception/fixtures.mjs";
import { validateMediaPacket } from "../src/perception/contracts.mjs";
const audio = () => ({ id: "utterance", kind: "audio", startMs: 0, samples: new Float32Array(3200).fill(0.1) });
const image = () => perceptionFixtures().find(item => item.id === "image-bars").media[0];
const packet = media => ({ requestId: "synthetic_media", purpose: "observe", instruction: "Observe only this fixture.", capturedAt: Date.now(), expiresAt: Date.now() + 5000, media });
const text = JSON.stringify({ observation: "3 red bars; café.", instruction: null, confidence: 0.9, evidence: [{ mediaId: "bars", startMs: 0, endMs: 0 }] });
const sse = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const candidate = (part, finishReason) => ({ candidates: [{ content: { role: "model", parts: [part] }, ...(finishReason ? { finishReason } : {}) }] });
async function httpFixture(t, handler) {
	const server = http.createServer(handler); server.listen(0, "127.0.0.1"); await once(server, "listening");
	t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
	const seen = [], fetchImpl = (url, options) => { seen.push({ url, options }); return fetch(`http://127.0.0.1:${server.address().port}/fixture`, options); };
	return { seen, adapter: createGeminiPerception({ fetchImpl }) };
}
test("Gemini sends bounded native WAV/image/video inline bytes and parses fragmented UTF-8 SSE", async t => {
	let headers, body;
	const f = await httpFixture(t, async (req, res) => {
		headers = req.headers; const chunks = []; for await (const chunk of req) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks));
		res.writeHead(200, { "content-type": "text/event-stream" }); const bytes = Buffer.from(sse(candidate({ text: text.slice(0, 22) })) + sse(candidate({ text: text.slice(22) }, "STOP")) + sse({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 11, totalTokenCount: 21, SECRET: "not forwarded" } }));
		for (const byte of bytes) res.write(Buffer.from([byte])); res.end();
	});
	const clip = { id: "clip", kind: "video", mimeType: "video/webm", startMs: 0, durationMs: 1000, data: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...Array(12).fill(0)]) };
	const p = packet([audio(), image(), clip]), deltas = [], result = await f.adapter.observe({ packet: p, coverage: validateMediaPacket(p), model: "gemini-3.8-flash", apiKey: "SYNTHETIC_KEY", signal: AbortSignal.timeout(2000), onDelta: value => deltas.push(value) });
	assert.equal(result.text, text); assert.equal(deltas.join(""), text); assert.deepEqual(result.usage, { input: 10, output: 11, total: 21 });
	assert.equal(headers["x-goog-api-key"], "SYNTHETIC_KEY"); assert.match(f.seen[0].url, /^https:\/\/generativelanguage.googleapis.com\//); assert.doesNotMatch(f.seen[0].url, /KEY/); assert.equal(f.seen[0].options.redirect, "error");
	assert.deepEqual(body.tools, []); assert.equal(body.contents.length, 1); assert.equal(body.generationConfig.maxOutputTokens, 1024); assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "LOW");
	const parts = body.contents[0].parts.filter(part => part.inlineData).map(part => part.inlineData); assert.deepEqual(parts.map(part => part.mimeType), ["audio/wav", "image/png", "video/webm"]); assert.equal(Buffer.from(parts[0].data, "base64").toString("ascii", 0, 4), "RIFF"); assert.deepEqual(Buffer.from(parts[2].data, "base64"), Buffer.from(clip.data));
});
test("Gemini refuses truncation, unknown media/tool output, excess bytes and post-terminal data", async t => {
	const wires = [sse(candidate({ text }, "MAX_TOKENS")), sse(candidate({ text })), sse(candidate({ functionCall: { name: "apply" } }, "STOP")), sse(candidate({ inlineData: { mimeType: "audio/wav", data: "bad" } }, "STOP")), sse(candidate({ text }, "STOP")) + sse(candidate({ text: "late" })), sse(candidate({ text }, "STOP")) + sse(candidate({ text: "" }, "STOP")), sse(candidate({ text: "x".repeat(8193) }, "STOP")), `data: ${"x".repeat(130 * 1024)}`];
	for (const wire of wires) {
		const f = await httpFixture(t, (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(wire); }), p = packet([image()]);
		await assert.rejects(f.adapter.observe({ packet: p, coverage: validateMediaPacket(p), model: "gemini-3.8-flash", apiKey: "FAKE", signal: AbortSignal.timeout(2000) }));
	}
});
test("Gemini never exposes provider error bodies and cancellation closes an incomplete response", async t => {
	const error = await httpFixture(t, (_req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"SECRET_PROVIDER_BODY"}'); }), p = packet([image()]);
	await assert.rejects(error.adapter.observe({ packet: p, coverage: validateMediaPacket(p), model: "gemini-3.8-flash", apiKey: "FAKE" }), err => /401/.test(err.message) && !err.message.includes("SECRET_PROVIDER_BODY"));
	let closed; const ended = new Promise(resolve => closed = resolve);
	const f = await httpFixture(t, (req, res) => { req.resume(); res.on("close", closed); res.writeHead(200, { "content-type": "text/event-stream" }); res.write(sse(candidate({ text: "partial" }))); });
	const controller = new AbortController(), rejected = assert.rejects(f.adapter.observe({ packet: p, coverage: validateMediaPacket(p), model: "gemini-3.8-flash", apiKey: "FAKE", signal: controller.signal, onDelta: () => controller.abort(new Error("Cancelled fixture.")) }), /Cancelled|abort/i); await rejected;
	await Promise.race([ended, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("HTTP response remained open after cancellation.")), 1000); timer.unref(); })]);
});
async function wsFixture(t, { badAck, noItemAck, output = "valid", hold = false } = {}) {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening"); const events = [], original = []; let serverClosed = false;
	t.after(async () => { for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); });
	server.on("connection", socket => {
		socket.on("close", () => serverClosed = true); const send = event => socket.send(JSON.stringify(event)); send({ type: "session.created", session: { type: "realtime" } });
		socket.on("message", bytes => {
			const event = JSON.parse(bytes.toString()); events.push(event);
			if (event.type === "session.update") { const session = structuredClone(event.session); if (badAck) badAck(session); send({ type: "session.updated", session }); }
			else if (event.type === "conversation.item.create" && !noItemAck) send({ type: "conversation.item.done", item: event.item });
			else if (event.type === "input_audio_buffer.commit") send({ type: "input_audio_buffer.committed", item_id: "audio_owned" });
			else if (event.type === "response.create") {
				const response = { id: "response_owned", metadata: event.response.metadata, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 10, output_tokens: 11, total_tokens: 21 } };
				send({ type: "response.created", response }); if (hold) return;
				if (output === "audio") return send({ type: "response.output_audio.delta", response_id: response.id, delta: "bad" });
				if (output === "tools") response.output = [{ type: "function_call", name: "apply" }];
				if (output === "incomplete") response.status = "incomplete";
				if (output === "identity") response.metadata = { midnight_media_request: "other" };
				send({ type: "response.output_text.delta", response_id: response.id, delta: output === "mismatch" ? "different" : text }); send({ type: "response.done", response });
			}
		});
	});
	const socketFactory = (url, options) => { original.push({ url, options }); return new WebSocket(`ws://127.0.0.1:${server.address().port}`, options); };
	return { events, original, closed: () => serverClosed, adapter: createOpenAiPerception({ socketFactory, handshakeMs: 100 }) };
}
test("Realtime acknowledges a text-only manual session before sending audio/images and makes one bounded response", async t => {
	const f = await wsFixture(t), p = packet([image(), audio()]), deltas = [];
	const result = await f.adapter.observe({ packet: p, coverage: validateMediaPacket(p), model: "gpt-realtime-2.1", apiKey: "SYNTHETIC_KEY", signal: AbortSignal.timeout(2000), onDelta: delta => deltas.push(delta) });
	assert.equal(result.text, text); assert.equal(deltas.join(""), text); assert.deepEqual(result.usage, { input: 10, output: 11, total: 21 }); assert.equal(f.original[0].options.headers.Authorization, "Bearer SYNTHETIC_KEY"); assert.match(f.original[0].url, /^wss:\/\/api.openai.com\/v1\/realtime\?model=/);
	assert.equal(f.events[0].type, "session.update"); const session = f.events[0].session; assert.deepEqual(session.tools, []); assert.equal(session.tool_choice, "none"); assert.equal(session.audio.input.turn_detection, null); assert.equal(session.audio.input.format.rate, 24000);
	const request = f.events.find(event => event.type === "response.create"); assert.equal(f.events.filter(event => event.type === "response.create").length, 1); assert.equal(request.response.conversation, "none"); assert.deepEqual(request.response.output_modalities, ["text"]); assert.deepEqual(request.response.input.map(item => item.id).at(-1), "audio_owned"); assert.deepEqual(request.response.tools, []); assert.equal(request.response.max_output_tokens, 1024);
	assert.equal(f.events.filter(event => event.type === "input_audio_buffer.append").reduce((count, event) => count + Buffer.from(event.audio, "base64").length, 0), 3200 * 3); assert.equal(f.adapter.declared.nativeVideo, false);
});
test("Realtime refuses unacknowledged policy and images before any response can start", async t => {
	const ack = await wsFixture(t, { badAck: session => session.audio.input.turn_detection = { type: "server_vad" } }), p = packet([image(), audio()]);
	await assert.rejects(ack.adapter.observe({ packet: p, coverage: validateMediaPacket(p), model: "gpt-realtime-2.1", apiKey: "FAKE", signal: AbortSignal.timeout(2000) }), /acknowledge/); assert.deepEqual(ack.events.map(event => event.type), ["session.update"]);
	const imageAck = await wsFixture(t, { noItemAck: true }); await assert.rejects(imageAck.adapter.observe({ packet: p, coverage: validateMediaPacket(p), model: "gpt-realtime-2.1", apiKey: "FAKE", signal: AbortSignal.timeout(2000) }), /captured images/); assert.equal(imageAck.events.some(event => event.type === "response.create"), false);
});
test("Realtime refuses incomplete, mismatched, tool/audio responses and native-video declarations", async t => {
	for (const output of ["incomplete", "identity", "tools", "audio", "mismatch"]) {
		const f = await wsFixture(t, { output }), p = packet([audio()]); await assert.rejects(f.adapter.observe({ packet: p, coverage: validateMediaPacket(p), model: "gpt-realtime-2.1", apiKey: "FAKE", signal: AbortSignal.timeout(2000) }));
	}
	let created = false; const adapter = createOpenAiPerception({ socketFactory: () => { created = true; } }); await assert.rejects(adapter.observe({ packet: packet([{ kind: "video" }]), apiKey: "FAKE" }), /native video/); assert.equal(created, false);
});
test("Realtime cancellation settles only after its physical client socket closes", async t => {
	const f = await wsFixture(t, { hold: true }), p = packet([audio()]), controller = new AbortController();
	const pending = f.adapter.observe({ packet: p, coverage: validateMediaPacket(p), model: "gpt-realtime-2.1", apiKey: "FAKE", signal: controller.signal }), rejected = assert.rejects(pending, /cancelled fixture/);
	const until = Date.now() + 1000; while (!f.events.some(event => event.type === "response.create")) { if (Date.now() > until) throw new Error("Synthetic request did not start."); await new Promise(resolve => setTimeout(resolve, 5)); }
	controller.abort(new Error("cancelled fixture")); await rejected; const end = Date.now() + 1000; while (!f.closed()) { if (Date.now() > end) throw new Error("Physical WebSocket remained open."); await new Promise(resolve => setTimeout(resolve, 5)); }
});
test("Realtime closes a cancellation arriving during socket creation without waiting for its handshake", async t => {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening"); t.after(async () => { for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); });
	const controller = new AbortController(); let socket;
	const adapter = createOpenAiPerception({ socketFactory: (_url, options) => { socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`, options); controller.abort(new Error("startup cancelled")); return socket; } }), p = packet([audio()]);
	await assert.rejects(adapter.observe({ packet: p, coverage: validateMediaPacket(p), model: "gpt-realtime-2.1", apiKey: "FAKE", signal: controller.signal }), /startup cancelled/); assert.equal(socket.readyState, WebSocket.CLOSED);
});
