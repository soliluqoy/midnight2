// Fixed public test media. No microphone, screen, app document, local index or history is consulted.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { rgbPng } from "../search/media-bytes.mjs";
export const FIXTURE_VERSION = "native-media-en-1";
const wavNames = ["clearer", "negation"];
function speech(name) {
	const bytes = fs.readFileSync(new URL(`./fixtures/${name}.wav`, import.meta.url));
	if (bytes.length > 1024 * 1024 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("The synthetic voice fixture is invalid.");
	let samples, format = false;
	for (let at = 12; at + 8 <= bytes.length;) {
		const size = bytes.readUInt32LE(at + 4), start = at + 8; if (start + size > bytes.length) throw new Error("Synthetic voice fixture is truncated.");
		const kind = bytes.toString("ascii", at, at + 4);
		if (kind === "fmt ") format = size >= 16 && bytes.readUInt16LE(start) === 1 && bytes.readUInt16LE(start + 2) === 1 && bytes.readUInt32LE(start + 4) === 16000 && bytes.readUInt16LE(start + 14) === 16;
		if (kind === "data") { if (size % 2 || size < 3200 || size > 960000) throw new Error("Synthetic voice PCM exceeds its budget."); samples = Float32Array.from({ length: size / 2 }, (_, i) => bytes.readInt16LE(start + i * 2) / 32768); }
		at = start + size + size % 2;
	}
	if (!format || !samples) throw new Error("The synthetic fixture must be mono 16 kHz PCM.");
	return samples;
}
function image(color, bars = false) {
	const width = 240, height = 160, rgb = new Uint8Array(width * height * 3).fill(255);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		if (bars && !(y >= 40 && y < 145 && [35, 100, 165].some(left => x >= left && x < left + 40))) continue;
		rgb.set(color, (y * width + x) * 3);
	}
	return new Uint8Array(rgbPng({ rgb, width, height }));
}
let digestValue;
export function fixtureDigest() {
	if (digestValue) return digestValue;
	const digest = createHash("sha256").update(FIXTURE_VERSION).update(fs.readFileSync(new URL("./fixtures.mjs", import.meta.url)));
	for (const name of wavNames) digest.update(fs.readFileSync(new URL(`./fixtures/${name}.wav`, import.meta.url)));
	return digestValue = digest.digest("hex");
}
const normalize = value => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function perceptionFixtures() {
	const audio = name => ({ id: "utterance", kind: "audio", startMs: 0, samples: speech(name) });
	return [
		{ id: "spoken-request", capability: "audio", purpose: "audio.intent", instruction: "Identify the spoken request.", media: [audio("clearer")], accepts: result => normalize(result.instruction ?? "") === "make this paragraph clearer" },
		{ id: "spoken-negation", capability: "audio", purpose: "audio.intent", instruction: "Identify the spoken request, preserving negation.", media: [audio("negation")], accepts: result => /^(?:do not|don t) change the numbers$/.test(normalize(result.instruction ?? "")) },
		{ id: "silence", capability: "audio", purpose: "observe", instruction: "Is a spoken request audible?", media: [{ id: "utterance", kind: "audio", startMs: 0, samples: new Float32Array(16000) }], accepts: result => result.instruction === null && result.confidence < 0.7 },
		{ id: "image-bars", capability: "image", purpose: "observe", instruction: "Count the colored bars and identify their color. Say the count and color in the observation.", media: [{ id: "bars", kind: "image", data: image([230, 0, 0], true), mimeType: "image/png", timeMs: 0 }], accepts: result => /\b(?:three|3)\b/i.test(result.observation) && /\bred\b/i.test(result.observation) },
		{ id: "frame-order", capability: "orderedFrames", purpose: "observe", instruction: "Name the solid colors in chronological order in the observation.", media: [["first", [230, 0, 0], 0], ["second", [0, 0, 230], 1000], ["third", [0, 180, 0], 2000]].map(([id, color, timeMs]) => ({ id, kind: "image", data: image(color), mimeType: "image/png", timeMs })), accepts: result => /\bred\b[\s\S]*\bblue\b[\s\S]*\bgreen\b/i.test(result.observation) && ["first", "second", "third"].every(id => result.evidence.some(item => item.mediaId === id)) },
	];
}
