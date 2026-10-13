// Manual-turn Realtime: native PCM and image input, text-only bounded observation, no tools or VAD response.
// Ordered images remain images; this adapter never declares native video support.
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { MEDIA_LIMITS, mediaPrompt, boundedUsage } from "./contracts.mjs";
export const OPENAI_TRANSPORT = "openai-realtime-manual-1";
export function pcm24(samples) {
	const count = Math.floor(samples.length * 1.5), out = Buffer.alloc(count * 2);
	for (let i = 0; i < count; i++) { const position = i / 1.5, left = Math.floor(position), mix = position - left, value = samples[left] * (1 - mix) + samples[Math.min(left + 1, samples.length - 1)] * mix; out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2); }
	return out;
}
export function createOpenAiPerception({ socketFactory = (url, options) => new WebSocket(url, options), handshakeMs = 5000 } = {}) {
	return {
		transport: OPENAI_TRANSPORT,
		declared: { audio: true, image: true, nativeVideo: false, orderedFrames: true, streamInput: true, streamOutput: true },
		async observe({ packet, coverage, model, apiKey, signal, onDelta = () => {} }) {
			if (packet.media.some(item => item.kind === "video")) throw new Error("This Realtime adapter accepts audio/images, not native video. Select the native-video provider.");
			signal?.throwIfAborted();
			const socket = socketFactory(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${apiKey}` }, followRedirects: false, perMessageDeflate: false, maxPayload: 128 * 1024, handshakeTimeout: handshakeMs });
			let readyResolve, readyReject, doneResolve, doneReject, disposed = false, created = false, configured = false, requested = false, finished = false, committing = false, failure, responseId, text = "", wireBytes = 0, audioItemId;
			const acknowledged = new Set(), itemIds = [], ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }), done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; }); done.catch(() => {});
			const closed = new Promise(resolve => socket.once("close", resolve));
			const fail = message => { const error = message instanceof Error ? message : new Error(message); failure ??= error; readyReject(error); doneReject(error); };
			const abort = () => { fail(signal.reason ?? new Error("Cloud perception cancelled.")); socket.terminate(); };
			signal?.addEventListener("abort", abort, { once: true });
			const timeout = setTimeout(() => { fail("The Realtime media handshake timed out."); socket.terminate(); }, handshakeMs);
			const send = event => new Promise((resolve, reject) => {
				if (disposed || signal?.aborted || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256 * 1024) return reject(new Error("The bounded Realtime media connection is no longer writable."));
				socket.send(JSON.stringify(event), error => error ? reject(new Error("Cloud media transport could not send its request.")) : resolve());
			});
			const waitFor = async (predicate, message) => { const until = Date.now() + handshakeMs; while (!predicate()) { signal?.throwIfAborted(); if (failure) throw failure; if (Date.now() >= until || socket.readyState !== WebSocket.OPEN) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 5)); } };
			socket.on("error", () => fail("The Realtime media connection failed."));
			socket.on("close", () => { if (!disposed) fail("The Realtime media connection closed before completion."); });
			socket.on("message", bytes => {
				try {
					wireBytes += bytes.byteLength; if (wireBytes > 256 * 1024) throw new Error("Realtime media exceeded its response wire budget.");
					let event; try { event = JSON.parse(bytes.toString()); } catch { throw new Error("The Realtime media stream contained an invalid event."); }
					if (event.type === "session.created") {
						if (created) throw new Error("The media service duplicated its session."); created = true;
						void send({ type: "session.update", session: { type: "realtime", instructions: mediaPrompt(packet, coverage), output_modalities: ["text"], tools: [], tool_choice: "none", max_output_tokens: MEDIA_LIMITS.outputTokens, audio: { input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: null, noise_reduction: null } } } }).catch(fail);
					} else if (event.type === "session.updated") {
						const session = event.session;
						if (!created || configured || session?.type !== "realtime" || JSON.stringify(session.output_modalities) !== '["text"]' || JSON.stringify(session.tools) !== "[]" || session.tool_choice !== "none" || !Number.isInteger(session.max_output_tokens) || session.max_output_tokens > MEDIA_LIMITS.outputTokens || session.max_output_tokens < 1 || session.audio?.input?.format?.type !== "audio/pcm" || session.audio.input.format.rate !== 24000 || session.audio.input.turn_detection !== null || session.instructions !== mediaPrompt(packet, coverage)) throw new Error("The media service did not acknowledge the bounded manual-turn configuration.");
						configured = true; clearTimeout(timeout); readyResolve();
					} else if (event.type === "conversation.item.done" && itemIds.includes(event.item?.id)) { if (event.item.role !== "user" || event.item.type !== "message" || acknowledged.has(event.item.id)) throw new Error("The media service acknowledged an invalid captured item."); acknowledged.add(event.item.id); }
					else if (event.type === "input_audio_buffer.committed") { if (!committing || audioItemId || typeof event.item_id !== "string" || !event.item_id || event.item_id.length > 80) throw new Error("The media service committed an unsolicited utterance."); audioItemId = event.item_id; }
					else if (event.type === "response.created") {
						if (!requested || responseId || typeof event.response?.id !== "string" || !event.response.id || event.response.metadata?.midnight_media_request !== packet.requestId) throw new Error("The media service created an unsolicited or mismatched response."); responseId = event.response.id;
					} else if (event.type === "response.output_text.delta") {
						if (finished || !responseId || event.response_id !== responseId || typeof event.delta !== "string") throw new Error("The media stream used an unknown response identity."); text += event.delta; if (text.length > MEDIA_LIMITS.outputChars) throw new Error("Realtime media output exceeded its budget."); onDelta(event.delta);
					} else if (event.type === "response.done") {
						const response = event.response;
						if (finished || !responseId || response?.id !== responseId || response.status !== "completed" || response.metadata?.midnight_media_request !== packet.requestId || !Array.isArray(response.output) || response.output.some(item => item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content) || item.content.some(part => part.type !== "output_text" || typeof part.text !== "string"))) throw new Error("The Realtime observation was incomplete or contained an unauthorized output kind.");
						const complete = response.output.flatMap(item => item.content ?? []).map(part => part.text ?? "").join(""); if (!complete || complete.length > MEDIA_LIMITS.outputChars || (text && text !== complete)) throw new Error("The Realtime observation did not match its final text.");
						finished = true; doneResolve({ text: complete, usage: boundedUsage({ input: response.usage?.input_tokens, output: response.usage?.output_tokens, total: response.usage?.total_tokens }) });
					} else if (typeof event.type !== "string" || event.type === "error" || event.type.startsWith("response.output_audio") || event.type.includes("function_call")) throw new Error("The Realtime media service refused the request or returned an unauthorized output kind.");
				} catch (error) { fail(error); socket.terminate(); }
			});
			try {
				if (signal?.aborted) abort();
				await ready;
				for (const item of packet.media.filter(item => item.kind === "image")) {
					const itemId = `item_${randomUUID().replaceAll("-", "").slice(0, 20)}`; itemIds.push(itemId);
					await send({ type: "conversation.item.create", item: { id: itemId, type: "message", role: "user", content: [{ type: "input_text", text: `Captured image ${item.id} at ${item.timeMs} ms` }, { type: "input_image", image_url: `data:${item.mimeType};base64,${Buffer.from(item.data).toString("base64")}`, detail: "low" }] } });
				}
				await waitFor(() => itemIds.every(id => acknowledged.has(id)), "The media service did not acknowledge its captured images.");
				const audio = packet.media.filter(item => item.kind === "audio");
				if (audio.length > 1) throw new Error("The Realtime prototype uses one request-owned utterance.");
				if (audio.length) {
					for (let offset = 0; offset < audio[0].samples.length; offset += 1600) await send({ type: "input_audio_buffer.append", audio: pcm24(audio[0].samples.subarray(offset, offset + 1600)).toString("base64") });
					committing = true; await send({ type: "input_audio_buffer.commit" });
					await waitFor(() => !!audioItemId, "The media service did not acknowledge the final utterance."); itemIds.push(audioItemId);
				}
				requested = true;
				await send({ type: "response.create", response: { conversation: "none", input: itemIds.map(id => ({ type: "item_reference", id })), instructions: mediaPrompt(packet, coverage), tools: [], tool_choice: "none", output_modalities: ["text"], max_output_tokens: MEDIA_LIMITS.outputTokens, metadata: { midnight_media_request: packet.requestId } } });
				return await done;
			} finally {
				disposed = true; clearTimeout(timeout); signal?.removeEventListener("abort", abort);
				if (socket.readyState === WebSocket.OPEN) socket.close(); else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
				const force = setTimeout(() => socket.terminate(), 250); try { await closed; } finally { clearTimeout(force); }
			}
		},
	};
}
