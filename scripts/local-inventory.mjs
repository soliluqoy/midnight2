// Explicit qualification command; merely starting Midnight does not hash gigabytes or load a model.
import { createComponentRegistry } from "../src/inference/registry.mjs";

const registry = createComponentRegistry();
const args = process.argv.slice(2);
if (args.includes("--verify-e2b")) {
	const runtime = await registry.verifyRuntime("cpu");
	const model = await registry.verifyModel("model.executor.gemma4-e2b");
	console.log(JSON.stringify({ runtime: { version: runtime.version, backend: runtime.backend, files: runtime.files }, model: { id: model.id, bytes: model.bytes, sha256: model.sha256 }, inventory: registry.inventory() }, null, 2));
} else console.log(JSON.stringify(registry.inventory(), null, 2));
