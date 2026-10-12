// Draws the tray icon (midnight's four-square mark) at every display scale, with anti-aliasing, and writes PNGs to
// src/assets/tray: tray.png, tray@1.25x.png … tray@3x.png for Windows and Linux, and a black-and-alpha
// trayTemplate.png (+@2x) that macOS recolors for light and dark menu bars. Run after changing the design:
//   node scripts/build-icons.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const out = path.join(root, "src", "assets", "tray");

const CRC = new Uint32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc32 = (buf) => {
	let c = 0xffffffff;
	for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
function png(size, rgba) {
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(td));
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	const raw = Buffer.alloc(size * (size * 4 + 1));
	for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Coverage (0–1) of the mark at pixel (x, y) for an icon of `size`, from 8×8 supersampling. */
function coverage(size, x, y) {
	// Four rounded squares in a 2×2 grid, on a 16-unit canvas with a 1-unit margin and a 2-unit gap.
	const unit = size / 16;
	const squares = [[1, 1], [9, 1], [1, 9], [9, 9]].map(([sx, sy]) => ({ x: sx * unit, y: sy * unit, w: 6 * unit, r: 1.6 * unit }));
	let hits = 0;
	const n = 8;
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < n; j++) {
			const px = x + (i + 0.5) / n;
			const py = y + (j + 0.5) / n;
			for (const s of squares) {
				const dx = Math.max(s.x + s.r - px, 0, px - (s.x + s.w - s.r));
				const dy = Math.max(s.y + s.r - py, 0, py - (s.y + s.w - s.r));
				if (px >= s.x && px <= s.x + s.w && py >= s.y && py <= s.y + s.w && dx * dx + dy * dy <= s.r * s.r) {
					hits++;
					break;
				}
			}
		}
	}
	return hits / (n * n);
}

function draw(size, [r, g, b]) {
	const buf = Buffer.alloc(size * size * 4);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const a = coverage(size, x, y);
			const i = (y * size + x) * 4;
			[buf[i], buf[i + 1], buf[i + 2], buf[i + 3]] = [r, g, b, Math.round(a * 255)];
		}
	}
	return png(size, buf);
}

export function buildIcons() {
	fs.mkdirSync(out, { recursive: true });
	const violet = [0x8b, 0x74, 0xd6]; // reads on both light and dark taskbars
	const files = [];
	for (const [suffix, size] of [["", 16], ["@1.25x", 20], ["@1.5x", 24], ["@2x", 32], ["@2.5x", 40], ["@3x", 48]]) {
		fs.writeFileSync(path.join(out, `tray${suffix}.png`), draw(size, violet));
		files.push(`tray${suffix}.png`);
	}
	for (const [suffix, size] of [["", 16], ["@2x", 32]]) {
		fs.writeFileSync(path.join(out, `trayTemplate${suffix}.png`), draw(size, [0, 0, 0]));
		files.push(`trayTemplate${suffix}.png`);
	}
	return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`wrote ${buildIcons().join(", ")}`);
