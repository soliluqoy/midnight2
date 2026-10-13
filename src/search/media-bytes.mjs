// Fixed in-memory encoders for the shell's bounded RGB and mono PCM. No file or URL is accepted here.
import { deflateSync } from "node:zlib";

const table = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function chunk(type, bytes) {
	const data = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
	for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
	const out = Buffer.alloc(data.length + 8); out.writeUInt32BE(bytes.length); data.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
}
export function rgbPng({ rgb, width, height }) {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1600 || height > 1600 || !(rgb instanceof Uint8Array) || rgb.length !== width * height * 3) throw new Error("Embedding image exceeds its RGB bounds.");
	const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
	const scan = Buffer.alloc((width * 3 + 1) * height), data = Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength);
	for (let y = 0; y < height; y++) data.copy(scan, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(scan, { level: 4 })), chunk("IEND", Buffer.alloc(0))]);
}
export function pcmWav(samples) {
	if (!(samples instanceof Float32Array) || samples.length < 1 || samples.length > 30 * 16000) throw new Error("Embedding audio exceeds its PCM bounds.");
	const out = Buffer.alloc(44 + samples.length * 2);
	out.write("RIFF"); out.writeUInt32LE(out.length - 8, 4); out.write("WAVEfmt ", 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(samples.length * 2, 40);
	for (let i = 0; i < samples.length; i++) { const value = samples[i]; if (!Number.isFinite(value)) throw new Error("Embedding audio contains a non-finite sample."); out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2); }
	return out;
}
