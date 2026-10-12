// Real-model check for local search, run in Electron so media goes through the real hidden decoder window:
//   npm run test:search-model
// Downloads EmbeddingGemma 2 (pinned revision, about 850 MB) into MIDNIGHT_TEST_SEARCH_DATA (default: a cache folder
// in your home directory) on first use, then indexes synthetic text, image, audio and PDF fixtures in a throwaway
// folder and checks retrieval by meaning, previews and agent context. Never reads personal files.
import { app, nativeImage } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMediaDecoder } from "../src/desktop/media-decoder.mjs";
import { createContextService } from "../src/context/service.mjs";
import { createEvidence } from "../src/evidence/store.mjs";
import { createMemory } from "../src/memory/store.mjs";
import { createRoots } from "../src/policy/roots.mjs";
import { renderMedia } from "../src/search/media-preview.mjs";
import { createEmbeddingRuntime } from "../src/search/runtime.mjs";
import { createFileSearch } from "../src/search/service.mjs";
import { openStore } from "../src/storage/db.mjs";
import { createJournal } from "../src/storage/journal.mjs";
import { createUnitOfWork } from "../src/storage/uow.mjs";

app.disableHardwareAcceleration();
const results = [];
const check = async (name, fn) => {
	const t0 = Date.now();
	try {
		await fn();
		results.push(true);
		console.log(`[search-model] PASS ${name} (${Date.now() - t0} ms)`);
	} catch (err) {
		results.push(false);
		console.log(`[search-model] FAIL ${name}: ${err.stack ?? err}`);
	}
};

function wav(seconds, freq) {
	const rate = 16000, n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
	buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
	for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * freq * i) / rate)), 44 + i * 2);
	return buf;
}

function pdf(pages) {
	const objs = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`];
	const font = 3 + pages.length * 2;
	pages.forEach((text, i) => {
		const stream = `BT /F1 16 Tf 20 100 Td (${text}) Tj ET`;
		objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
		objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
	});
	objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	let out = "%PDF-1.4\n";
	const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

async function run() {
	const dataDir = path.resolve(process.env.MIDNIGHT_TEST_SEARCH_DATA ?? path.join(os.homedir(), ".cache", "midnight-search-model"));
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "midnight-search-model-"));
	const source = path.join(base, "Selected");
	fs.mkdirSync(source);
	const decoder = createMediaDecoder({ log: (...a) => console.log("[decoder]", ...a) });
	const decodeMedia = async (filePath, kind) => decoder.session(filePath, kind);
	const settings = { embedding: { enabled: true, assist: true, dimensions: 768, device: "cpu" } };
	const runtime = createEmbeddingRuntime({ paths: { dataDir }, settings, decodeMedia });
	const store = await openStore(path.join(base, "Data"));
	const roots = createRoots(store);
	roots.add(source);
	const search = createFileSearch({ store, roots, settings, paths: { dataDir: base }, runtime });
	try {
		await check("setup (pinned model, no Python)", async () => {
			if (runtime.status().available) return;
			let last = 0;
			await runtime.setup({ onProgress: (p) => { if (p.bytesTotal && Date.now() - last > 5000) { last = Date.now(); console.log(`[search-model] downloading ${(p.bytesDone / 1e6).toFixed(0)} / ${(p.bytesTotal / 1e6).toFixed(0)} MB`); } } });
			assert.equal(runtime.status().available, true);
		});
		fs.writeFileSync(path.join(source, "railway.txt"), "A railway station connects the north district to the central terminal. Commuters ride trains to work every morning.");
		fs.writeFileSync(path.join(source, "baking.txt"), "This chocolate cake recipe uses flour, eggs and butter. Mix the batter, bake it in the oven, then cover it with sweet icing.");
		const red = Buffer.alloc(64 * 64 * 4);
		for (let i = 0; i < red.length; i += 4) [red[i], red[i + 1], red[i + 2], red[i + 3]] = [0, 0, 230, 255]; // BGRA
		fs.writeFileSync(path.join(source, "red.png"), nativeImage.createFromBuffer(red, { width: 64, height: 64 }).toPNG());
		fs.writeFileSync(path.join(source, "tone.wav"), wav(2, 440));
		fs.writeFileSync(path.join(source, "minutes.pdf"), pdf(["Board minutes: the budget was approved", "Appendix about penguins in Antarctica"]));

		await check("indexes text, image, audio and PDF pages with normalized vectors", async () => {
			assert.equal(search.index().started, true);
			const deadline = Date.now() + 600_000;
			while (search.status().busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
			const status = search.status();
			assert.equal(status.state, "ready", JSON.stringify({ error: status.error, warnings: status.warnings }));
			assert.equal(status.counts.files, 5);
			assert.equal(status.counts.segments, 6);
			for (const row of store.all("SELECT embedding FROM search_segments")) {
				const v = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
				assert.equal(v.length, 768);
				assert.ok(Math.abs(Math.hypot(...v) - 1) < 0.001);
			}
			assert.equal(store.vector, true, "sqlite-vec loaded");
			assert.equal(Number(store.get("SELECT COUNT(*) AS n FROM search_vec_768").n), 6);
		});
		await check("retrieves by meaning without shared words", async () => {
			for (const [query, expected, kind] of [["public transportation", "railway.txt", "document"], ["ingredients for dessert", "baking.txt", "document"], ["antarctic birds", "minutes.pdf", "document"]]) {
				const result = await search.search({ query, kind });
				assert.equal(result.mode, "hybrid", result.warning);
				assert.equal(result.results[0]?.name, expected, `${query}: ${JSON.stringify(result.results.map((r) => [r.name, r.score]))}`);
			}
			const pdfHit = (await search.search({ query: "antarctic birds" })).results.find((r) => r.name === "minutes.pdf");
			assert.equal(pdfHit.locator.page, 2, "the matching PDF page is located");
			const audio = store.all("SELECT locator FROM search_segments WHERE locator LIKE '%audio%'");
			assert.equal(audio.length, 1);
			assert.equal(JSON.parse(audio[0].locator).seconds, 0);
		});
		await check("previews render real JPEGs from the decoder", async () => {
			for (const [file, kind, locator] of [["red.png", "image", {}], ["minutes.pdf", "document", { page: 2 }]]) {
				const preview = await renderMedia(decodeMedia, { path: path.join(source, file), kind, locator });
				assert.equal(preview.mimeType, "image/jpeg");
				assert.equal(Buffer.from(preview.data, "base64").subarray(0, 2).toString("hex"), "ffd8");
			}
		});
		await check("agent context recalls related memory and history offline", async () => {
			const journal = createJournal(store);
			const { commit, emit } = createUnitOfWork(store, journal);
			const memory = createMemory(store, emit, commit);
			const evidence = createEvidence(store, journal, emit, { workspaces: path.join(base, "workspaces") });
			const context = createContextService({ store, journal, memory, roots, evidence, commit, emit, runtime, settings: () => settings, skills: { list: () => [] }, recipes: { list: () => [] }, fileSearch: { status: () => ({ busy: false }), search: async () => ({ results: [] }) } });
			try {
				const rail = memory.remember("I prefer riding trains from the railway station to the central terminal. Commuters can use the local rail network.");
				memory.remember("Chocolate cake recipes use flour, eggs and butter. Bake the batter in the oven and cover it with sweet icing.");
				store.run("INSERT INTO missions (id,title,goal,status,created_at,updated_at) VALUES ('past','Rail journey','Travel to the central terminal','succeeded','2026-10-01','2026-10-02')");
				commit(() => journal.putPayload("past", "answer", "A railway station connects the north district to the central terminal. Commuters ride trains to work every morning."));
				await context.refresh();
				const result = await context.prepare("public transportation", { id: "current", privacy: "cloud", scope: {} });
				assert.equal(result.metrics.mode, "hybrid");
				assert.equal(result.memories[0], rail.text);
				assert.equal(result.memories.length, 1, "unrelated recipe preferences are excluded");
				assert.match(result.context, /Past task past/);
				const page = { url: "https://fixture.test", title: "Guide", text: `Chocolate cake recipes involve flour and butter.\n\nA railway station connects commuters to the central terminal. Trains run every morning.\n\nSweet desserts are baked in an oven.\n\n${"Unrelated cooking recipes. ".repeat(80)}` };
				const selected = await context.focusPages([page], "public transportation", 170);
				assert.equal(selected.metrics.mode, "hybrid");
				assert.match(selected.pages[0].excerpt, /railway station/);
			} finally {
				context.close();
			}
		});
	} finally {
		await search.close();
		runtime.close();
		store.close();
		decoder.dispose();
		fs.rmSync(base, { recursive: true, force: true });
	}
	const failed = results.filter((ok) => !ok).length;
	console.log(`[search-model] ${results.length - failed}/${results.length} passed`);
	app.exit(failed ? 1 : 0);
}

app.whenReady().then(() => run().catch((err) => { console.log(`[search-model] FAIL ${err.stack}`); app.exit(1); }));
