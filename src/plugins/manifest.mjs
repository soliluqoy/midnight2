import { createHash } from "node:crypto";
import { stableStringify } from "../policy/canonical.mjs";
import { componentFor } from "./catalog.mjs";

export const PLUGIN_API = 1;
export const PLUGIN_FILES = ["manifest.json", "renderer.js"];
export const hash = data => `sha256:${createHash("sha256").update(data).digest("hex")}`;
export function validateManifest(manifest) {
	const allowed = ["id", "name", "version", "api", "schema", "entry", "contributions", "permissions", "dependencies", "state"];
	if (!manifest || Object.keys(manifest).some(key => !allowed.includes(key)) || !/^[a-z][a-z0-9.-]{2,63}$/.test(manifest.id ?? "") || typeof manifest.name !== "string" || manifest.name.length > 100 || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(manifest.version ?? "")) throw new Error("The plugin manifest has invalid identity or fields.");
	if (manifest.api !== PLUGIN_API || manifest.schema !== 1 || manifest.entry !== "renderer.js" || JSON.stringify(manifest.permissions) !== "[]" || JSON.stringify(manifest.dependencies) !== "[]" || stableStringify(manifest.state) !== stableStringify({ schema: 1, migration: "none" })) throw new Error("This plugin needs an unsupported API, dependency, permission or state migration.");
	const component = componentFor(manifest.id);
	if (stableStringify(manifest.contributions) !== stableStringify([component.contribution])) throw new Error("The plugin contribution does not match its registered host contract.");
	return structuredClone(manifest);
}
export function packageIdentity(manifest, source) {
	validateManifest(manifest);
	if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 128 * 1024 || !source.trim()) throw new Error("The renderer source is missing or exceeds its package budget.");
	const files = { "manifest.json": hash(stableStringify(manifest)), "renderer.js": hash(source) };
	return { digest: hash(stableStringify({ manifest, files })), files };
}
