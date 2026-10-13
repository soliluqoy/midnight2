// Reuse only the embedding pair and CPU runtime in Midnight's signed cache. This path never downloads.
import fs from "node:fs";
import path from "node:path";
import { createComponentRegistry, defaultComponentRoot, loadComponentCatalog } from "../inference/registry.mjs";

export function createNativeEmbeddingAssets({ root = defaultComponentRoot(), catalog = loadComponentCatalog() } = {}) {
	const registry = createComponentRegistry({ root, catalog });
	const text = catalog.components.find(c => c.id === "model.embedder.text"), projector = catalog.components.find(c => c.id === "model.embedder.mmproj"), runtime = catalog.components.find(c => c.id === "llama.cpp");
	if (!text || !projector || projector.pairsWith !== text.id || projector.source.revision !== text.source.revision || text.family !== "embeddinggemma-2" || !runtime?.variants.some(v => v.id === "cpu")) throw new Error("The signed embedding cache has no compatible model/runtime pair.");
	const identity = Object.freeze({ backend: "gguf", model: text.source.hf, revision: text.source.revision, dtype: "Q8_0", modelHash: text.sha256, projectorHash: projector.sha256, runtime: runtime.version, runtimeHash: runtime.variants.find(v => v.id === "cpu").sha256, transport: "midnight-gguf-embedding-1" });
	return {
		identity,
		present() {
			if (runtime.platform !== `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`) return false;
			const inventory = registry.inventory();
			return inventory.find(c => c.id === text.id)?.present === true && inventory.find(c => c.id === projector.id)?.present === true && fs.existsSync(path.join(root, "llama", `${runtime.version}-cpu`, "llama-server.exe")) && fs.existsSync(path.join(root, "downloads", runtime.variants.find(v => v.id === "cpu").file));
		},
		async verify({ signal } = {}) {
			if (runtime.platform !== `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`) throw new Error("This cached native embedding runtime does not support this platform.");
			const native = await registry.verifyRuntime("cpu", { signal });
			const model = await registry.verifyModel(text.id, { signal }), media = await registry.verifyModel(projector.id, { signal });
			return { ...identity, ...native, modelFile: model.file, projectorFile: media.file };
		},
	};
}
