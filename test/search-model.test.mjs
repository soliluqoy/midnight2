// Opt in against an already installed model; this test never downloads or reads personal files.
// MIDNIGHT_TEST_SEARCH_DATA=<app data>/missions node --test --test-timeout=180000 test/search-model.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createEmbeddingRuntime } from "../src/search/runtime.mjs";
import { createFileSearch } from "../src/search/service.mjs";
import { createRoots } from "../src/policy/roots.mjs";
import { openStore } from "../src/storage/db.mjs";

test("installed Gemma indexes and retrieves by meaning offline, including image and audio inputs", {
	skip: !process.env.MIDNIGHT_TEST_SEARCH_DATA,
	timeout: 180_000,
}, async t => {
	const dataDir = path.resolve(process.env.MIDNIGHT_TEST_SEARCH_DATA);
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "midnight-search-model-"));
	const source = path.join(base, "Selected");
	fs.mkdirSync(source);
	const settings = { embedding: { enabled: true, dimensions: 768, device: "cpu" } };
	const runtime = createEmbeddingRuntime({ paths: { dataDir }, settings });
	const store = await openStore(path.join(base, "Data"));
	const roots = createRoots(store);
	roots.add(source);
	const search = createFileSearch({ store, roots, settings, paths: { dataDir: base }, runtime });
	t.after(async () => {
		await search.close(); store.close();
		assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
		assert.ok(path.basename(base).startsWith("midnight-search-model-"));
		fs.rmSync(base, { recursive: true, force: true });
	});
	assert.equal(runtime.status().available, true, "run local search setup before opting into this test");
	fs.writeFileSync(path.join(source, "railway.txt"), "A railway station connects the north district to the central terminal. Commuters ride trains to work every morning.");
	fs.writeFileSync(path.join(source, "baking.txt"), "This chocolate cake recipe uses flour, eggs and butter. Mix the batter, bake it in the oven, then cover it with sweet icing.");
	const python = path.join(dataDir, "search-runtime", "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	execFileSync(python, ["-c", `
import sys, wave
from pathlib import Path
import numpy as np
from PIL import Image
root = Path(sys.argv[1])
with Image.new('RGB', (64,64), 'red') as image: image.save(root / 'red.png')
samples = (3000 * np.sin(2 * np.pi * 440 * np.arange(16000) / 16000)).astype('<i2')
with wave.open(str(root / 'tone.wav'), 'wb') as audio:
    audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000); audio.writeframes(samples.tobytes())
`, source], { windowsHide: true, stdio: "pipe", timeout: 10_000 });
	assert.equal(search.index().started, true);
	const deadline = Date.now() + 150_000;
	while (search.status().busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
	const status = search.status();
	assert.equal(status.busy, false, "indexing completes");
	assert.equal(status.state, "ready", JSON.stringify({ error: status.error, warnings: status.warnings }));
	assert.equal(status.counts.files, 4);
	assert.equal(status.counts.segments, 4);
	for (const row of store.all("SELECT vector FROM search_segments")) {
		const values = JSON.parse(row.vector);
		assert.equal(values.length, 768);
		assert.ok(values.every(Number.isFinite));
		assert.ok(Math.abs(Math.hypot(...values) - 1) < 0.0001);
	}
	for (const [query, expected] of [["public transportation", "railway.txt"], ["ingredients for dessert", "baking.txt"]]) {
		const result = await search.search({ query, kind: "document" });
		assert.equal(result.mode, "hybrid", result.warning);
		assert.equal(result.results[0]?.name, expected);
		assert.equal(result.results[0].match, "semantic", "retrieval succeeds without shared words");
	}
	const audio = store.all("SELECT locator FROM search_segments WHERE locator LIKE '%audio%'");
	assert.equal(audio.length, 1);
	assert.equal(JSON.parse(audio[0].locator).seconds, 0);
});
