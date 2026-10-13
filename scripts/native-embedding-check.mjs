// Synthetic inputs only, no download and no production profile changes.
import assert from "node:assert/strict";
import { createNativeEmbeddingAssets } from "../src/search/native-assets.mjs";
import { createNativeEmbeddingWorker } from "../src/search/native-worker.mjs";

const assets = createNativeEmbeddingAssets(); assert.equal(assets.present(), true, "cached embedding pair and CPU runtime required");
const worker = createNativeEmbeddingWorker({ assets }); let sequence = 0; const pending = new Map();
worker.on("error", error => { for (const value of pending.values()) value.reject(error); pending.clear(); });
worker.on("message", message => { if (message.event) { console.log(message.phase, message.message); return; } const value = pending.get(message.id); if (!value) return; pending.delete(message.id); message.ok ? value.resolve(message.result) : value.reject(new Error(message.error.message)); });
const send = message => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); worker.postMessage({ id, ...message }); });
try {
	const began = Date.now(), info = await send({ op: "load", dimensions: 768, verify: true });
	console.log(JSON.stringify({ phase: "qualified", coldMs: Date.now() - began, ...info }));
	const inputs = ["task: search result | query: public transportation", "title: none | text: A railway station connects commuters to work by train.", "title: none | text: Chocolate cake ingredients include butter, flour and eggs."];
	const start = Date.now(), vectors = await send({ op: "text", texts: inputs });
	const cosine = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
	assert.equal(vectors.length, 3); for (const vector of vectors) assert.ok(Math.abs(Math.hypot(...vector) - 1) < 0.001);
	assert.ok(cosine(vectors[0], vectors[1]) > cosine(vectors[0], vectors[2]));
	console.log(JSON.stringify({ phase: "retrieval", warmMs: Date.now() - start, positive: cosine(vectors[0], vectors[1]), negative: cosine(vectors[0], vectors[2]) }));
} finally { await worker.terminate(); console.log("native child exited"); }
