import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOcr, OCR_HELPER } from "../src/desktop/ocr.mjs";
import { fileTools } from "../src/tools/files.mjs";
import { buildNative } from "../scripts/build-native.mjs";
import { tempDir } from "./helpers.mjs";

const fixture = fileURLToPath(new URL("./fixtures/ocr-invoice.png", import.meta.url));

test("Windows' built-in OCR reads the words in a picture on this computer", { skip: process.platform !== "win32" }, async () => {
	buildNative({ quiet: true });
	const ocr = createOcr();
	assert.equal(ocr.available(), true, `${OCR_HELPER} is built`);
	const languages = await ocr.languages();
	if (!languages.length) return; // a Windows install without any OCR language; the helper says how to add one
	const r = await ocr.file(fixture);
	assert.match(r.text, /Invoice 4821/);
	assert.match(r.text, /312\.50/);
	assert.ok(r.lines.length >= 2 && r.lines.every((l) => l.w > 0 && l.h > 0), "lines carry their positions");
	const fromBytes = await ocr.image(fs.readFileSync(fixture), { ext: ".png" });
	assert.equal(fromBytes.text, r.text, "bytes go through a private temporary file that is removed");
	await assert.rejects(ocr.file(path.join(tempDir("ocr"), "missing.png")));
});

test("files_read reads PDFs page by page, OCRs scanned pages and pictures, and reads slide text", async () => {
	const dir = tempDir("read-any");
	const roots = { list: () => [{ id: "r1", path: fs.realpathSync.native(dir), purpose: "source", label: "d" }] };
	const recorded = [];
	const evidence = { record: (_m, e) => recorded.push(e) };
	const calls = [];
	const platform = { call: async (op, args) => (calls.push({ op, args }), op === "ocr.file" ? { text: "Invoice 4821\nTotal due 312.50 EUR", language: "en-GB" } : {}) };
	const decodeMedia = async (file, kind) => ({
		info: { pages: 3 },
		text: async ({ page }) => ({ text: page === 2 ? "" : `Page ${page} body text with enough words` }),
		ocr: async ({ page }) => ({ text: page === 2 ? "Scanned signature page" : "" }),
		close: async () => {},
	});
	const { all } = fileTools({ roots, evidence, commit: (fn) => fn(), settings: () => ({}), paths: { backups: path.join(dir, ".b") }, platform, decodeMedia });
	const read = all.find((t) => t.name === "files_read");
	const pdf = path.join(dir, "contract.pdf");
	fs.writeFileSync(pdf, "%PDF-1.4");
	const out = (await read.execute({ path: pdf }, { missionId: "m1" })).content[0].text;
	assert.match(out, /\[PDF, 3 pages; 1 scanned page was read with OCR/);
	assert.match(out, /## Page 2\nScanned signature page/);
	assert.match(out, /## Page 3\nPage 3 body text/);
	const png = path.join(dir, "receipt.png");
	fs.copyFileSync(fixture, png);
	const pic = (await read.execute({ path: png }, { missionId: "m1" })).content[0].text;
	assert.match(pic, /Text recognized on this computer \(OCR, en-GB\)/);
	assert.match(pic, /Total due 312\.50 EUR/);
	assert.equal(calls.find((c) => c.op === "ocr.file").args.path, fs.realpathSync.native(png));
	assert.equal(recorded.length, 2, "both reads are recorded as evidence");
	fs.writeFileSync(path.join(dir, "tool.exe"), Buffer.from([0x4d, 0x5a, 0]));
	await assert.rejects(read.execute({ path: path.join(dir, "tool.exe") }, { missionId: "m1" }), /not readable as text/);
});
