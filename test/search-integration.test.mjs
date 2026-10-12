import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { validateRequest } from "../src/contracts/ipc.mjs";
import { embeddingSettings } from "../src/search/config.mjs";
import { createHost } from "../src/runtime/host.mjs";
import { openStore } from "../src/storage/db.mjs";
import { MIGRATIONS, LATEST_SCHEMA } from "../src/storage/migrations.mjs";
import { makeModel, fakePlatform } from "./e2e-helpers.mjs";
import { tempDir } from "./helpers.mjs";

test("existing mission databases gain the search index without losing selected sources", async (t) => {
	const dir = tempDir("search-migration");
	const old = new DatabaseSync(path.join(dir, "midnight.db"));
	old.exec(MIGRATIONS[0].sql);
	old.exec("PRAGMA user_version = 1");
	old.prepare("INSERT INTO roots (id,path,purpose,label,created_at) VALUES (?,?,?,?,?)").run("root_legacy", dir, "source", "Existing source", "2026-10-01T00:00:00Z");
	old.close();
	const store = await openStore(dir);
	t.after(() => store.close());
	assert.equal(store.schema, LATEST_SCHEMA);
	assert.equal(store.get("SELECT label FROM roots WHERE id = ?", "root_legacy").label, "Existing source");
	assert.equal(store.get("SELECT COUNT(*) AS n FROM search_files").n, 0);
	assert.ok(fs.readdirSync(path.join(dir, "backups")).some((name) => name.startsWith("midnight-v1-")));
});

test("search IPC accepts result IDs and bounded queries, never renderer-supplied paths", () => {
	const request = (method, params) => validateRequest({ v: 1, seq: 1, method, params });
	assert.equal(request("files.search", { query: "where they discuss the budget", kind: "audio", limit: 10 }).ok, true);
	assert.equal(request("files.search", { query: "x", limit: 51 }).ok, false);
	assert.equal(request("files.search", { query: "x".repeat(1001) }).ok, false);
	assert.equal(request("files.open", { id: "segment:123", reveal: true }).ok, true);
	assert.equal(request("files.open", { id: "segment:123", path: "C:\\private\\secret.pdf" }).ok, false);
	assert.equal(request("files.open", { path: "C:\\private\\secret.pdf" }).ok, false);
});

test("embedding settings keep the local model fixed and normalize persisted values", () => {
	assert.deepEqual(embeddingSettings({ enabled: "yes", model: "remote-cloud", dimensions: 3, pythonPath: null, device: "unknown" }), {
		enabled: false, model: "google/embeddinggemma-2", dimensions: 768, pythonPath: "", device: "cpu",
	});
	assert.equal(embeddingSettings({ dimensions: 256, pythonPath: " C:\\Python312\\python.exe " }).pythonPath, "C:\\Python312\\python.exe");
});

test("host file search works without embeddings and rechecks a result before opening after revocation", async (t) => {
	const model = await makeModel();
	const platform = fakePlatform();
	const host = await createHost({ dataDir: tempDir("search-host"), platform, modelRuntime: model.rt, core: model.core });
	t.after(() => host.close());
	const source = fs.realpathSync.native(tempDir("search-source"));
	const file = path.join(source, "invoice-AB42.pdf");
	fs.writeFileSync(file, "%PDF-test filename only");
	const root = await host.handle("sources.add", { path: source, purpose: "source" });
	const found = await host.handle("files.search", { query: "invoice-AB42" });
	assert.equal(found.mode, "words");
	assert.equal(found.results.length, 1);
	await host.handle("files.open", { id: found.results[0].id });
	assert.equal(platform.calls.at(-1).op, "open.searchResult");
	assert.equal(platform.calls.at(-1).args.path, file);
	assert.equal(platform.calls.at(-1).args.kind, "pdf");
	await host.handle("sources.remove", { rootId: root.id });
	const calls = platform.calls.length;
	await assert.rejects(host.handle("files.open", { id: found.results[0].id }));
	assert.equal(platform.calls.length, calls);
});
