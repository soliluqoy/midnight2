import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createComponentRegistry, loadComponentCatalog } from "../src/inference/registry.mjs";
import { writeZip } from "../src/tools/documents/zip.mjs";
import { tempDir } from "./helpers.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture() {
	const root = tempDir("components"), bytes = Buffer.from("test model");
	const model = { id: "model.executor.test", kind: "model", role: "executor", family: "test", sha256: hash(bytes), bytes: bytes.length, source: { revision: "a".repeat(40), file: "model.gguf" } };
	const modelFile = path.join(root, "models", model.id, model.sha256, model.source.file);
	fs.mkdirSync(path.dirname(modelFile), { recursive: true }); fs.writeFileSync(modelFile, bytes);
	const files = [{ name: "bin/llama-server.exe", data: "test executable" }, { name: "bin/ggml.dll", data: "test DLL" }];
	const zip = writeZip(files), variant = { id: "cpu", file: "runtime.zip", sha256: hash(zip), bytes: zip.length };
	const runtime = { id: "llama.cpp", kind: "llama.cpp", version: "test", variants: [variant] };
	fs.mkdirSync(path.join(root, "downloads")); fs.writeFileSync(path.join(root, "downloads", variant.file), zip);
	const dir = path.join(root, "llama", "test-cpu"); fs.mkdirSync(dir, { recursive: true });
	for (const file of files) fs.writeFileSync(path.join(dir, path.posix.basename(file.name)), file.data);
	const registry = createComponentRegistry({ root, catalog: { components: [model, runtime] } });
	return { root, registry, model, modelFile, dir };
}

test("signed shipped catalog rejects edited component declarations", () => {
	const catalog = loadComponentCatalog();
	assert.ok(catalog.components.some(c => c.id === "model.executor.gemma4-e2b"));
	catalog.components[0].version = "substituted";
	const manifest = path.join(tempDir("catalog"), "manifest.json");
	fs.writeFileSync(manifest, JSON.stringify(catalog));
	assert.throws(() => loadComponentCatalog({ manifest }), { code: "COMPONENT_INVALID" });
});

test("verified cache identity invalidates after modification and never claims model modality qualification", async () => {
	const f = fixture();
	assert.equal(f.registry.inventory()[0].integrity, "unchecked");
	await f.registry.verifyModel(f.model.id);
	assert.equal(f.registry.inventory()[0].integrity, "verified");
	assert.deepEqual(f.registry.inventory()[0].qualifiedModalities, []);
	fs.writeFileSync(f.modelFile, "changed and longer");
	assert.equal(f.registry.inventory()[0].integrity, "unchecked");
	await assert.rejects(f.registry.verifyModel(f.model.id), { code: "COMPONENT_INVALID" });
});

test("runtime verification checks actual DLLs and rejects files absent from its release archive", async () => {
	const f = fixture();
	assert.equal((await f.registry.verifyRuntime()).files, 2);
	fs.writeFileSync(path.join(f.dir, "ggml.dll"), "tampered");
	await assert.rejects(f.registry.verifyRuntime(), { code: "COMPONENT_INVALID" });
	fs.writeFileSync(path.join(f.dir, "ggml.dll"), "test DLL");
	fs.writeFileSync(path.join(f.dir, "undeclared.dll"), "extra executable code");
	await assert.rejects(f.registry.verifyRuntime(), /undeclared/);
});
