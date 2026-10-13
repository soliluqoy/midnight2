// Native audio, image and video bytes through the documented Gemini GenerateContent SSE transport.
// No remote file URLs, uploads, tools, conversation history or retries. Live input is a separate adapter.
import { pcmWav } from "../search/media-bytes.mjs";
import { MEDIA_LIMITS, mediaPrompt, boundedUsage } from "./contracts.mjs";
export const GEMINI_TRANSPORT = "gemini-generate-content-sse-1";
export function createGeminiPerception({ fetchImpl = fetch } = {}) {
	return {
		transport: GEMINI_TRANSPORT,
		declared: { audio: true, image: true, nativeVideo: true, orderedFrames: true, streamInput: false, streamOutput: true },
		async observe({ packet, coverage, model, apiKey, signal, onDelta = () => {} }) {
			signal?.throwIfAborted();
			const parts = packet.media.flatMap(item => [{ text: `Captured media ${item.id}, ${item.kind}, relative time ${JSON.stringify(coverage.find(source => source.id === item.id))}` }, { inlineData: { mimeType: item.kind === "audio" ? "audio/wav" : item.mimeType, data: Buffer.from(item.kind === "audio" ? pcmWav(item.samples) : item.data).toString("base64") } }]);
			const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify({ systemInstruction: { parts: [{ text: mediaPrompt(packet, coverage) }] }, contents: [{ role: "user", parts }], tools: [], generationConfig: { candidateCount: 1, maxOutputTokens: MEDIA_LIMITS.outputTokens, responseMimeType: "application/json", ...(model.startsWith("gemini-3") ? { thinkingConfig: { thinkingLevel: "LOW", includeThoughts: false } } : {}) } }), signal, redirect: "error" });
			if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) { await response.body?.cancel().catch(() => {}); throw new Error(`Cloud media request failed (${response.status}).`); }
			const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "", event = [], text = "", bytes = 0, terminal = false, usage;
			function dispatch() {
				if (!event.length) return; const wire = event.join("\n"); event = []; if (wire.length > 64 * 1024) throw new Error("Cloud media event exceeded its budget.");
				let value; try { value = JSON.parse(wire); } catch { throw new Error("The cloud media stream contained an invalid event."); }
				if (value.error || value.promptFeedback?.blockReason || (value.candidates?.length ?? 0) > 1) throw new Error("The cloud media request was refused or ambiguous.");
				const candidate = value.candidates?.[0];
				for (const part of candidate?.content?.parts ?? []) {
					if (part.functionCall || part.functionResponse || part.executableCode || part.codeExecutionResult || part.inlineData || part.fileData) throw new Error("A media observation cannot contain tools, code or generated media.");
					if (typeof part.text === "string" && !part.thought) { if (terminal) throw new Error("The cloud media stream continued after its terminal event."); text += part.text; if (text.length > MEDIA_LIMITS.outputChars) throw new Error("Cloud media output exceeded its budget."); onDelta(part.text); }
				}
				if (candidate?.finishReason) { if (terminal || candidate.finishReason !== "STOP") throw new Error("The cloud media response was incomplete or duplicated."); terminal = true; }
				if (value.usageMetadata) usage = boundedUsage({ input: value.usageMetadata.promptTokenCount, output: value.usageMetadata.candidatesTokenCount, total: value.usageMetadata.totalTokenCount });
			}
			try {
				for (;;) {
					signal?.throwIfAborted(); const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 128 * 1024) throw new Error("Cloud media stream exceeded its wire budget.");
					buffer += decoder.decode(next.value, { stream: true }); if (buffer.length > 64 * 1024) throw new Error("Cloud media event exceeded its budget.");
					let at; while ((at = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, at).replace(/\r$/, ""); buffer = buffer.slice(at + 1); if (!line) dispatch(); else if (line.startsWith("data:")) event.push(line.slice(5).trimStart()); }
				}
				if (!terminal || buffer.trim() || event.length || !text) throw new Error("The cloud media stream ended before a complete observation.");
				return { text, usage };
			} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
		},
	};
}
