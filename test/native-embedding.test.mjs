import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { EventEmitter } from "node:events";
import { rgbPng, pcmWav } from "../src/search/media-bytes.mjs";
import { createNativeEmbeddingWorker, validateNativeVectors } from "../src/search/native-worker.mjs";

test("native media transport encodes exact pixels and bounded mono samples", () => {
	const pixels = Uint8Array.of(255, 0, 0, 0, 255, 0), png = rgbPng({ rgb: pixels, width: 2, height: 1 });
	assert.equal(png.readUInt32BE(16), 2); assert.equal(png.readUInt32BE(20), 1);
	const dataStart = 33, size = png.readUInt32BE(dataStart); assert.equal(png.toString("ascii", dataStart + 4, dataStart + 8), "IDAT");
	assert.deepEqual([...inflateSync(png.subarray(dataStart + 8, dataStart + 8 + size))], [0, ...pixels]);
	assert.throws(() => rgbPng({ rgb: pixels, width: 1601, height: 1 }), /bounds/); assert.throws(() => rgbPng({ rgb: pixels, width: 1, height: 1 }), /bounds/);
	const wav = pcmWav(Float32Array.of(-1, 0, 1)); assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readInt16LE(44), -32767); assert.equal(wav.readInt16LE(46), 0); assert.equal(wav.readInt16LE(48), 32767);
	assert.throws(() => pcmWav(Float32Array.of(NaN)), /non-finite/); assert.throws(() => pcmWav(new Float32Array(480001)), /bounds/);
});
test("native vector transport refuses bad indices, non-finite/full-size/norm data and normalizes truncation", () => {
	const a = Array.from({ length: 768 }, (_, i) => i === 0 || i === 767 ? Math.SQRT1_2 : 0), b = Array.from({ length: 768 }, (_, i) => i === 1 ? 1 : 0);
	const body = { data: [{ index: 1, embedding: b }, { index: 0, embedding: a }] }, result = validateNativeVectors(body, 2, 128);
	assert.equal(result[0][0], 1); assert.equal(result[1][1], 1); assert.equal(result[0].length, 128);
	for (const data of [[{ index: 0, embedding: b }, { index: 0, embedding: a }], [{ index: 2, embedding: b }], [{ index: 0, embedding: b.slice(0, 128) }], [{ index: 0, embedding: b.map(() => 0) }], [{ index: 0, embedding: b.map((value, i) => i === 3 ? NaN : value) }]]) assert.throws(() => validateNativeVectors({ data }, data.length, 128));
});
test("native worker cannot spawn after cancellation during cache verification", async () => {
	let resolveVerification, spawns = 0;
	const worker = createNativeEmbeddingWorker({ assets: { verify: () => new Promise(resolve => { resolveVerification = resolve; }) }, spawnImpl: () => { spawns++; throw new Error("late spawn"); } });
	worker.postMessage({ id: 1, op: "load", dimensions: 768 }); await worker.terminate(); resolveVerification({});
	await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(spawns, 0);
});
test("native cancellation keeps ownership until the process actually closes", async () => {
	const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.signalCode = null;
	let launched = false, killed = false, alias;
	child.kill = () => { killed = true; };
	const worker = createNativeEmbeddingWorker({ assets: { identity: {}, verify: async () => ({ exe: "owned.exe", dir: ".", modelFile: "owned.gguf", projectorFile: "media.gguf" }) }, spawnImpl: (_exe, args, options) => { launched = true; alias = args[args.indexOf("--alias") + 1]; assert.equal(options.windowsHide, true); assert.equal(options.shell, false); assert.ok(args.includes("--offline") && args.includes("--no-webui")); return child; }, fetchImpl: async () => new Promise(() => {}) });
	worker.postMessage({ id: 1, op: "load", dimensions: 768 });
	for (let i = 0; !launched && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(launched, true); assert.ok(alias);
	let settled = false; const stopping = worker.terminate().then(() => { settled = true; }); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(killed, true); assert.equal(settled, false);
	child.emit("close", 1, "SIGTERM"); await stopping; assert.equal(settled, true);
});
