import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { openStore } from "../src/storage/db.mjs";
import { createRoots } from "../src/policy/roots.mjs";
import { createFileSearch, normalizeVector } from "../src/search/service.mjs";
import { fileSearchTools } from "../src/tools/file-search.mjs";
import { writeDocx } from "../src/tools/documents/docx.mjs";
import { writeZip } from "../src/tools/documents/zip.mjs";
import { tempDir } from "./helpers.mjs";

const vector = (text) => /rail|station|train|commute|picture|sound|movie/i.test(text) ? [3, 0, 0] : /cake|bake|recipe/i.test(text) ? [0, 4, 0] : [0, 0, 2];
const attributes = async (paths) => new Map(paths.map((p) => [p, 0]));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const waitUntil = async (fn) => {
	const started = Date.now();
	while (!fn()) { if (Date.now() - started > 8000) throw new Error("Timed out waiting for search job."); await new Promise((r) => setTimeout(r, 5)); }
};
const finish = async (search) => { await waitUntil(() => !search.status().busy); return search.status(); };

async function fixture(t, overrides = {}) {
	const base = tempDir("file-search");
	const source = path.join(base, "Selected");
	fs.mkdirSync(source);
	const store = await openStore(path.join(base, "Data"));
	const roots = createRoots(store);
	const root = roots.add(source);
	const config = { embedding: { enabled: true, dimensions: 3, model: "test/model" } };
	const calls = [];
	let fp = "test-model-v1";
	const runtime = {
		fingerprint: () => fp,
		status: () => ({ available: true, ready: false, fingerprint: fp, dimensions: config.embedding.dimensions, model: config.embedding.model, phase: "ready" }),
		setup: async () => {},
		embedText: async (texts, options) => { calls.push({ texts, options }); return texts.map(vector); },
		embedMedia: async (_p, kind) => ({ segments: [{ vector: [3, 0, 0], text: "", locator: kind === "pdf" ? { page: 2, modality: "image" } : kind === "audio" ? { seconds: 4, endSeconds: 8, modality: "audio" } : kind === "video" ? { seconds: 9, endSeconds: 10, modality: "image" } : { modality: "image" } }], truncated: kind === "video" }),
		close: async () => {},
		...overrides.runtime,
	};
	const search = createFileSearch({ store, roots, settings: () => config, paths: { dataDir: path.join(base, "Data") }, runtime, getFileAttributes: overrides.useNativeAttributes ? undefined : overrides.getFileAttributes ?? attributes });
	t.after(async () => { await search.close(); store.close(); });
	const write = (name, content) => { const target = path.join(source, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); return target; };
	return { base, source, store, roots, root, search, config, runtime, calls, write, fingerprint: (next) => { fp = next; } };
}

test("semantic file search persists normalized vectors and ranks passages with evidence locations", async (t) => {
	const f = await fixture(t);
	f.write("railway-notes.txt", "A railway station connects the north district to the central terminal.");
	f.write("baking-notes.txt", "This cake recipe uses flour, eggs and butter.");
	assert.deepEqual(f.search.index(), { started: true });
	assert.equal((await finish(f.search)).state, "ready");
	const out = await f.search.search({ query: "commute" });
	assert.equal(out.mode, "hybrid");
	assert.equal(out.results[0].name, "railway-notes.txt");
	assert.equal(out.results[0].match, "semantic");
	assert.deepEqual(out.results[0].locator, { startChar: 0, endChar: 70, line: 1 });
	assert.match(out.results[0].hash, /^sha256:/);
	assert.deepEqual(JSON.parse(f.store.get("SELECT vector FROM search_segments WHERE id = ?", out.results[0].id).vector), [1, 0, 0]);
	assert.equal((await f.search.resolve(out.results[0].id)).path, path.join(f.source, "railway-notes.txt"));
	assert.equal(f.calls.filter((call) => call.options?.query).length, 1);
});

test("exact words, phrase matches and filename-only fallback remain explicit without embeddings", async (t) => {
	const f = await fixture(t);
	f.write("Q3 final contract.txt", "These are the agreed terms for the final contract.");
	f.write("Q3 final contract.bin", Buffer.from([0, 1, 2]));
	assert.equal(f.search.index().started, true);
	await finish(f.search);
	f.config.embedding.enabled = false;
	const before = f.calls.length;
	const out = await f.search.search({ query: "final contract" });
	assert.equal(out.mode, "words");
	assert.match(out.warning, /disabled/);
	assert.equal(f.calls.length, before);
	assert.equal(out.results[0].match, "words");
	assert.ok(out.results.some((hit) => hit.name.endsWith(".bin") && hit.match === "filename" && hit.note.includes("Unsupported")));
	const fresh = f.write("never indexed.txt", "unread passage contains commute");
	const name = await f.search.search({ query: "never indexed" });
	assert.ok(name.results.some((hit) => hit.path === fresh && hit.match === "filename" && hit.text === ""));
	await assert.rejects(f.search.resolve(fresh), /Choose a file/);
});

test("cache invalidation checks source hashes, deletion, selected-root revocation and model identity", async (t) => {
	const f = await fixture(t);
	const p = f.write("note.txt", "the railway goes north");
	f.search.index(); await finish(f.search);
	const hit = (await f.search.search({ query: "railway" })).results[0];
	f.fingerprint("test-model-v2");
	const out = await f.search.search({ query: "railway" });
	assert.equal(out.mode, "words");
	assert.match(out.warning, /this model/);
	const st = fs.statSync(p);
	fs.writeFileSync(p, "the cookbook is ready");
	fs.utimesSync(p, st.atime, st.mtime);
	assert.equal((await f.search.search({ query: "railway" })).results.length, 0);
	await assert.rejects(f.search.resolve(hit.id), /no longer available|changed/);
	f.write("note.txt", "the railway goes south"); f.search.index(); await finish(f.search);
	fs.unlinkSync(p);
	assert.equal((await f.search.search({ query: "railway" })).results.length, 0);
	f.write("again.txt", "railway station"); f.search.index(); await finish(f.search);
	f.roots.remove(f.root.id);
	assert.equal((await f.search.search({ query: "railway" })).results.length, 0);
	assert.equal(f.search.status().counts.segments, 0);
});

test("indexing preserves PDF pages, audio/video timestamps, images and Office text", async (t) => {
	const f = await fixture(t);
	for (const name of ["photo.jpg", "document.pdf", "recording.wav", "clip.mp4"]) f.write(name, "local media bytes");
	f.write("brief.docx", writeDocx({ title: "Railway brief", blocks: [{ type: "p", text: "The railway station is open." }] }));
	f.write("slides.pptx", writeZip([{ name: "ppt/slides/slide1.xml", data: '<p:sld><a:t>Railway station diagram</a:t></p:sld>' }]));
	f.search.index();
	const indexed = await finish(f.search);
	assert.equal(indexed.state, "ready");
	assert.equal(indexed.counts.files, 6);
	assert.equal(indexed.truncated, 1);
	const out = await f.search.search({ query: "commute", limit: 20 });
	assert.ok(out.results.some((hit) => hit.name === "document.pdf" && hit.locator.page === 2));
	assert.ok(out.results.some((hit) => hit.kind === "audio" && hit.locator.seconds === 4 && hit.locator.endSeconds === 8));
	assert.ok(out.results.some((hit) => hit.kind === "video" && hit.locator.seconds === 9));
	assert.ok(out.results.some((hit) => hit.kind === "image" && hit.locator.modality === "image"));
	assert.ok(out.results.some((hit) => hit.name === "slides.pptx" && hit.locator.slide === 1));
	assert.ok(out.results.some((hit) => hit.name === "brief.docx" && hit.text.includes("railway station")));
	assert.ok((await f.search.search({ query: "commute", kind: "document" })).results.every((hit) => hit.kind === "document"));
});

test("secrets, hidden/cache folders and OneDrive placeholder attributes never reach the embedding model", async (t) => {
	const media = [];
	const f = await fixture(t, {
		getFileAttributes: async (paths) => new Map(paths.map((p) => [p, p.endsWith("cloud.png") ? 0x400000 : p.endsWith("Hidden") ? 2 : 0])),
		runtime: { embedMedia: async (p) => { media.push(p); return { segments: [] }; } },
	});
	f.write("cloud.png", "cloud only");
	f.write("Hidden/hidden.txt", "railway hidden");
	f.write("cache/cached.txt", "railway cached");
	f.write(".env", "API_KEY=secret");
	f.write("credentials.json", "secret material");
	f.write("notes.txt", "api_key=abcdefghijklmnopqrstuv0123456789");
	f.write("safe.txt", "a railway station");
	f.search.index();
	const status = await finish(f.search);
	assert.equal(status.state, "ready");
	assert.equal(status.counts.files, 1);
	assert.equal(media.length, 0);
	assert.doesNotMatch(f.calls.flatMap((call) => call.texts).join(" "), /api_key|hidden|cached/);
	assert.match(status.warnings.join(" "), /OneDrive.*not downloaded/);
	assert.match(status.warnings.join(" "), /credentials/);
	assert.equal((await f.search.search({ query: "cloud" })).results.length, 0);
});

test("junctions and linked source replacements cannot reveal cached passages or open outside selected folders", { skip: process.platform !== "win32" }, async (t) => {
	const f = await fixture(t);
	const external = path.join(f.base, "External"); fs.mkdirSync(external);
	fs.writeFileSync(path.join(external, "private.txt"), "railway private data");
	fs.symlinkSync(external, path.join(f.source, "link"), "junction");
	f.write("Local/readme.txt", "railway selected data");
	f.search.index(); await finish(f.search);
	const hit = (await f.search.search({ query: "railway" })).results[0];
	assert.equal(hit.name, "readme.txt");
	fs.renameSync(path.join(f.source, "Local"), path.join(f.source, "Saved"));
	fs.symlinkSync(external, path.join(f.source, "Local"), "junction");
	await assert.rejects(f.search.resolve(hit.id), /changed|outside/);
	assert.ok((await f.search.search({ query: "railway" })).results.every((result) => !result.path.includes("link") && !result.path.includes("Local")));
});

test("cancel discards the current file, returns promptly, and prevents late embedding commits", async (t) => {
	const started = deferred();
	const release = deferred();
	const f = await fixture(t, { runtime: { embedText: async (_texts, { signal }) => { started.resolve(signal); await release.promise; return [[1, 0, 0]]; } } });
	f.write("long.txt", "railway passage");
	assert.deepEqual(f.search.index(), { started: true });
	const signal = await started.promise;
	assert.equal(f.search.index().started, false);
	assert.deepEqual(f.search.cancel(), { cancelled: true });
	assert.equal(signal.aborted, true);
	release.resolve();
	const status = await finish(f.search);
	assert.equal(status.state, "cancelled");
	assert.equal(status.counts.files, 0);
	assert.equal(status.counts.segments, 0);
});

test("setup runs in background and close blocks late results before store shutdown", async (t) => {
	const release = deferred();
	const started = deferred();
	let closed = false;
	const f = await fixture(t, { runtime: { setup: async ({ signal }) => { started.resolve(signal); await release.promise; }, close: async () => { closed = true; release.resolve(); } } });
	assert.deepEqual(f.search.setup(), { started: true });
	const signal = await started.promise;
	assert.equal(f.search.status().state, "setting-up");
	await f.search.close();
	assert.equal(signal.aborted, true);
	assert.equal(closed, true);
	assert.throws(() => f.search.search({ query: "test" }), /closed/);
	assert.throws(() => f.search.index(), /closed/);
});

test("setup and indexing retain meaningful progress, download counts and the current file", async (t) => {
	const release = deferred(), started = deferred();
	let report;
	const f = await fixture(t, { runtime: {
		setup: async ({ onProgress }) => { report = onProgress; started.resolve(); await release.promise; },
		embedText: async (texts, { onProgress }) => {
			onProgress({ phase: "loading", message: "Loading EmbeddingGemma 2 locally" });
			assert.equal(f.search.status().progress.message, "Loading EmbeddingGemma 2 locally");
			onProgress({ phase: "embedding", message: "Reading document passages", segments: 1 });
			const status = f.search.status();
			assert.equal(status.progress.file, "notes.txt");
			assert.equal(status.progress.fileSegments, 1);
			assert.equal(status.progress.total, 1);
			return texts.map(vector);
		},
	} });
	f.search.setup(); await started.promise;
	report({ phase: "downloading", message: "Downloading model", bytesDone: 250, bytesTotal: 1000 });
	assert.equal(f.search.status().progress.bytesDone, 250);
	assert.equal(f.search.status().progress.bytesTotal, 1000);
	assert.equal(f.search.status().progress.message, "Downloading model");
	assert.ok(f.search.status().progress.startedAt <= Date.now());
	report({ phase: "loading", message: "Loading model" });
	assert.equal(f.search.status().progress.bytesTotal, 0, "download progress clears when loading starts");
	release.resolve(); await finish(f.search);
	f.write("notes.txt", "The train stops at the station.");
	f.search.index();
	assert.equal((await finish(f.search)).state, "ready");
});

test("mutating a file or revoking its root during embedding never commits or exposes its passages", async (t) => {
	let f;
	f = await fixture(t, { runtime: { embedText: async (texts, options) => {
		if (options?.query) { f.roots.remove(f.root.id); return texts.map(vector); }
		fs.writeFileSync(path.join(f.source, "note.txt"), "another edited passage");
		return texts.map(vector);
	} } });
	f.write("note.txt", "railway passage");
	f.search.index();
	assert.equal((await finish(f.search)).counts.segments, 0);
	assert.match(f.search.status().warnings.join(" "), /changed during indexing/);
	f.runtime.embedText = async (texts, options) => { if (options?.query) f.roots.remove(f.root.id); return texts.map(vector); };
	f.write("note.txt", "railway passage"); f.search.index(); await finish(f.search);
	assert.equal((await f.search.search({ query: "commute" })).results.length, 0);
});

test("invalid vectors and model failures are visible errors with explicit word fallback", async (t) => {
	assert.throws(() => normalizeVector([NaN, 0, 1], 3), /invalid/);
	assert.throws(() => normalizeVector([1, 0], 3), /dimensions/);
	assert.throws(() => normalizeVector([0, 0, 0], 3), /empty/);
	const f = await fixture(t, { runtime: { embedText: async () => [[NaN, 0, 1]] } });
	f.write("note.txt", "railway station"); f.search.index();
	const failed = await finish(f.search);
	assert.equal(failed.state, "error");
	assert.match(failed.warnings.join(" "), /invalid/);
	assert.equal(failed.counts.segments, 0);
	f.runtime.embedText = async (texts) => texts.map(vector); f.search.index(); await finish(f.search);
	f.runtime.embedText = async () => { throw new Error("model unavailable"); };
	const out = await f.search.search({ query: "railway" });
	assert.equal(out.mode, "words");
	assert.match(out.warning, /Semantic search failed.*model unavailable/);
	assert.ok(out.results.some((hit) => hit.text === "railway station"));
});

test("clear and source removal purge persisted content and resolve ids", async (t) => {
	const f = await fixture(t);
	f.write("note.txt", "railway station"); f.search.index(); await finish(f.search);
	const hit = (await f.search.search({ query: "commute" })).results[0];
	assert.deepEqual(f.search.removeRoot(f.root.id), { removed: true });
	assert.equal(f.search.status().counts.files, 0);
	await assert.rejects(f.search.resolve(hit.id), /no longer available/);
	f.search.index(); await finish(f.search);
	assert.deepEqual(f.search.clear(), { cleared: true });
	assert.equal(f.search.status().lastIndexedAt, null);
	assert.equal(f.search.status().counts.segments, 0);
});

test("files_search exposes only retrieval and records PDF/timestamp evidence", async (t) => {
	const f = await fixture(t);
	f.write("document.pdf", "local media"); f.write("recording.wav", "local sound");
	f.search.index(); await finish(f.search);
	const records = [];
	const tools = fileSearchTools({ search: f.search, roots: f.roots, commit: (fn) => fn(), evidence: { record: (missionId, record) => { records.push({ missionId, ...record }); return `ev_${records.length}`; } } });
	assert.deepEqual(tools.all.map((tool) => tool.name), ["files_search"]);
	const tool = tools.all[0];
	const cls = tool.classify({ query: "commute" });
	assert.equal(cls.effect, "read.local"); assert.ok(!cls.network); assert.deepEqual(cls.paths, [f.source]);
	const out = await tool.execute({ query: "commute" }, { missionId: "m1" });
	assert.match(out.content[0].text, /page 2/); assert.match(out.content[0].text, /4s–8s/);
	assert.match(out.content[0].text, /Audio embedding match.*no transcript/);
	assert.match(out.content[0].text, /Visual embedding match.*PDF page/);
	assert.doesNotMatch(out.content[0].text, /Filename only; file content has not been indexed/);
	assert.ok(records.some((record) => record.locator.page === 2 && record.hash.startsWith("sha256:")));
	assert.ok(records.some((record) => record.locator.seconds === 4 && record.sourceVersion));
});

test("Windows cloud-file metadata bridge can index ordinary local files without hydration", { skip: process.platform !== "win32" }, async (t) => {
	const f = await fixture(t, { useNativeAttributes: true });
	f.write("local.txt", "railway station");
	f.write("résumé 日本語/铁路.txt", "railway station");
	f.search.index();
	const status = await finish(f.search);
	assert.equal(status.state, "ready", status.error ?? status.warnings.join(" "));
	assert.equal(status.counts.segments, 2);
	const results = (await f.search.search({ query: "commute" })).results;
	assert.ok(results.some((hit) => hit.name === "local.txt"));
	assert.ok(results.some((hit) => hit.name === "铁路.txt" && hit.path.includes("résumé 日本語")));
});

test("closing an in-flight search aborts metadata work and does not access a closed database", async (t) => {
	const started = deferred();
	let gate = false;
	const f = await fixture(t, { getFileAttributes: async (paths, { signal } = {}) => {
		if (gate) {
			started.resolve();
			await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
		}
		return new Map(paths.map((p) => [p, 0]));
	} });
	f.write("note.txt", "railway station"); f.search.index(); await finish(f.search);
	gate = true;
	const pending = f.search.search({ query: "commute" });
	const rejection = assert.rejects(pending, /cancelled|closed/);
	await started.promise;
	await f.search.close();
	await rejection;
	assert.equal(f.search.status().busy, false);
});
