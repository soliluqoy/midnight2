// Opt-in actual model evaluation; uses synthetic sources, an isolated DB and the installed offline cache.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createEmbeddingRuntime } from "../src/search/runtime.mjs";
import { createContextService } from "../src/context/service.mjs";
import { createMemory } from "../src/memory/store.mjs";
import { createEvidence } from "../src/evidence/store.mjs";
import { createRoots } from "../src/policy/roots.mjs";
import { openStore } from "../src/storage/db.mjs";
import { createJournal } from "../src/storage/journal.mjs";
import { createUnitOfWork } from "../src/storage/uow.mjs";
import { tempDir } from "./helpers.mjs";
import { renderMedia } from "../src/search/media-preview.mjs";
import { execFileSync } from "node:child_process";
import { until } from "./e2e-helpers.mjs";

test("installed Gemma complements chat with relevant memory, history and passage selection offline", {
	skip: !process.env.MIDNIGHT_TEST_SEARCH_DATA, timeout: 180000,
}, async t => {
	const dir = tempDir("context-model"), store = await openStore(dir), journal = createJournal(store);
	const { commit, emit } = createUnitOfWork(store, journal);
	const memory = createMemory(store, emit, commit), roots = createRoots(store);
	const evidence = createEvidence(store, journal, emit, { workspaces: path.join(dir, "workspaces") });
	const settings = { embedding: { enabled: true, assist: true, dimensions: 768, device: "cpu" } };
	const runtime = createEmbeddingRuntime({ settings, paths: { dataDir: path.resolve(process.env.MIDNIGHT_TEST_SEARCH_DATA) } });
	const context = createContextService({ store, journal, memory, roots, evidence, commit, emit, runtime, settings: () => settings,
		skills: { list: () => [] }, recipes: { list: () => [] }, fileSearch: { status: () => ({ busy: false }), search: async () => ({ results: [] }) } });
	t.after(() => { context.close(); runtime.close(); store.close(); });
	const rail = memory.remember("I prefer riding trains from the railway station to the central terminal. Commuters can use the local rail network.");
	memory.remember("Chocolate cake recipes use flour, eggs and butter. Bake the batter in the oven and cover it with sweet icing.");
	store.run("INSERT INTO missions (id,title,goal,status,created_at,updated_at) VALUES ('past','Rail journey','Travel to the central terminal','succeeded','2026-10-01','2026-10-02')");
	commit(() => journal.putPayload("past", "answer", "A railway station connects the north district to the central terminal. Commuters ride trains to work every morning."));
	assert.equal(runtime.status().available, true);
	const warmStarted = Date.now();
	await context.refresh();
	t.diagnostic("Background embedding startup and indexing: " + (Date.now() - warmStarted) + " ms");
	const result = await context.prepare("public transportation", { id: "current", privacy: "cloud", scope: {} });
	t.diagnostic("Warm context: " + JSON.stringify(result.metrics));
	t.diagnostic("Memory relevance: " + JSON.stringify((await context.recall("public transportation", { id: "current", privacy: "cloud", scope: {} })).memories.map(m => ({ text: m.text.slice(0, 20), cosine: m.cosine }))));
	assert.equal(result.metrics.mode, "hybrid");
	assert.equal(result.memories[0], rail.text);
	assert.equal(result.memories.length, 1, "unrelated recipe preferences are excluded");
	assert.match(result.context, /Past task past/);
	const page = { url: "https://fixture.test", title: "Guide", text: "Chocolate cake recipes involve flour and butter.\n\nA railway station connects commuters to the central terminal. Trains run every morning.\n\nSweet desserts are baked in an oven." };
	// Force selection on a synthetic long page; no web access or cloud call.
	page.text = page.text + "\n\n" + "Unrelated cooking recipes. ".repeat(80);
	const selected = await context.focusPages([page], "public transportation", 170);
	t.diagnostic("Passage selection: " + JSON.stringify(selected.metrics));
	assert.equal(selected.metrics.mode, "hybrid");
	assert.match(selected.pages[0].excerpt, /railway station/);
	assert.ok(selected.pages[0].excerpt.length <= 170);
	await until(() => !runtime.status().busy, 10000);
	assert.equal(runtime.status().ready, true, "a passage deadline preserves the loaded worker");
	const python = path.join(runtime.status().runtimeDir, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	execFileSync(python, ["-c", [
		"import sys, av, pypdfium2 as pdfium",
		"from pathlib import Path",
		"from PIL import Image",
		"root=Path(sys.argv[1])",
		"with Image.new('RGB',(64,64),'red') as image: image.save(root/'image.png')",
		"with pdfium.PdfDocument.new() as doc:",
		"    page=doc.new_page(100,100); page.close(); doc.save(root/'page.pdf')",
		"with av.open(str(root/'clip.mp4'),'w') as container:",
		"    stream=container.add_stream('mpeg4',rate=1); stream.width=64; stream.height=64; stream.pix_fmt='yuv420p'",
		"    with Image.new('RGB',(64,64),'blue') as image: frame=av.VideoFrame.from_image(image)",
		"    for packet in stream.encode(frame): container.mux(packet)",
		"    for packet in stream.encode(): container.mux(packet)",
	].join("\n"), dir], { windowsHide: true, timeout: 10000 });
	for (const [filename, kind, locator] of [["image.png", "image", {}], ["page.pdf", "document", { page: 1 }], ["clip.mp4", "video", { seconds: 0 }]]) {
		const preview = await renderMedia(runtime, { path: path.join(dir, filename), kind, locator });
		assert.equal(preview.mimeType, "image/jpeg");
		assert.equal(Buffer.from(preview.data, "base64").subarray(0, 2).toString("hex"), "ffd8");
		t.diagnostic("Actual visual source rendered: " + filename);
	}
	const pdf = await runtime.embedMedia(path.join(dir, "page.pdf"), "pdf", { maxSegments: 1 });
	assert.equal(pdf.segments[0].locator.page, 1);
	assert.equal(pdf.segments[0].vector.length, 768);
	t.diagnostic("Actual PDF embedding preserves the page location.");
});
