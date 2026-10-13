// The signed component catalog is imported unchanged from the sibling Midnight runtime. Cache markers and
// declared modalities are not qualification: check actual bytes before loading, including extracted DLLs.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readZip } from "../tools/documents/zip.mjs";

const HEX = /^[a-f0-9]{64}$/;
const safeName = value => typeof value === "string" && /^[a-zA-Z0-9._-]+$/.test(value) && !value.includes("..");
const invalid = message => Object.assign(new Error(message), { code: "COMPONENT_INVALID" });
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;

export function loadComponentCatalog({ manifest = new URL("./components.json", import.meta.url), publicKey = new URL("./components-public-key.pem", import.meta.url) } = {}) {
	const catalog = JSON.parse(fs.readFileSync(manifest, "utf8"));
	if (catalog?.schema !== "midnight.runtime-manifest.v1" || !Array.isArray(catalog.components) || catalog.components.length > 32 || !/^ed25519:[A-Za-z0-9+/]+={0,2}$/.test(catalog.signature ?? "")) throw invalid("The local component catalog is malformed.");
	const { signature, ...payload } = catalog;
	if (!verify(null, Buffer.from(canonical(payload)), createPublicKey(fs.readFileSync(publicKey)), Buffer.from(signature.slice(8), "base64"))) throw invalid("The local component catalog signature does not match.");
	const ids = new Set();
	for (const component of catalog.components) {
		if (!safeName(component.id) || ids.has(component.id) || !["model", "llama.cpp"].includes(component.kind)) throw invalid("Invalid component identity.");
		ids.add(component.id);
		if (component.kind === "model") {
			if (!HEX.test(component.sha256) || !Number.isSafeInteger(component.bytes) || component.bytes <= 0 || !safeName(component.source?.file) || !/^[a-f0-9]{40}$/.test(component.source?.revision ?? "")) throw invalid("Invalid model artifact declaration.");
		} else {
			if (!safeName(component.version) || !Array.isArray(component.variants) || component.variants.length > 4 || component.variants.some(v => !["cpu", "vulkan"].includes(v.id) || !safeName(v.file) || !HEX.test(v.sha256) || !Number.isSafeInteger(v.bytes) || v.bytes <= 0)) throw invalid("Invalid native runtime declaration.");
		}
	}
	return structuredClone(catalog);
}

export const defaultComponentRoot = () => process.env.MIDNIGHT_COMPONENTS_DIR ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "midnight", "components");

async function contained(root, file) {
	const actual = await fsp.realpath(file), actualRoot = await fsp.realpath(root);
	const relative = path.relative(actualRoot, actual);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw invalid("A cached component links outside its owned store.");
	return actual;
}

export async function verifyComponentFile(file, expected, { signal } = {}) {
	signal?.throwIfAborted();
	const before = await fsp.stat(file);
	if (!before.isFile() || before.size !== expected.bytes) throw invalid("A cached component has the wrong size.");
	const hash = createHash("sha256");
	for await (const bytes of fs.createReadStream(file, { signal })) hash.update(bytes);
	const after = await fsp.stat(file);
	if (hash.digest("hex") !== expected.sha256 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw invalid("A cached component changed or does not match its pinned hash.");
	return { bytes: after.size, sha256: expected.sha256, checkedAt: new Date().toISOString(), mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, inode: after.ino };
}

export function createComponentRegistry({ root = defaultComponentRoot(), catalog = loadComponentCatalog() } = {}) {
	const checked = new Map();
	const get = id => { const value = catalog.components.find(c => c.id === id); if (!value) throw invalid("This model is absent from the signed catalog."); return value; };
	const modelFile = component => path.join(root, "models", component.id, component.sha256, component.source.file);
	return {
		inventory() {
			return catalog.components.filter(c => c.kind === "model").map(c => {
				let present = false, current;
				try { current = fs.statSync(modelFile(c)); present = current.isFile() && current.size === c.bytes; } catch {}
				const check = checked.get(c.id);
				const valid = present && check && check.mtimeMs === current.mtimeMs && check.ctimeMs === current.ctimeMs && check.inode === current.ino;
				return { id: c.id, family: c.family, role: c.role, revision: c.source.revision, bytes: c.bytes, present, integrity: valid ? "verified" : "unchecked", checkedAt: check?.checkedAt, qualifiedModalities: [] };
			});
		},
		async verifyModel(id, { signal } = {}) {
			const component = get(id);
			if (component.kind !== "model") throw invalid("A model component is required.");
			checked.delete(id);
			const file = await contained(root, modelFile(component));
			const result = await verifyComponentFile(file, component, { signal });
			checked.set(id, result);
			return { ...result, id, file, revision: component.source.revision, family: component.family };
		},
		async verifyRuntime(backend = "cpu", { signal } = {}) {
			const runtime = get("llama.cpp"), variant = runtime.variants.find(v => v.id === backend);
			if (!variant) throw invalid("This runtime backend is absent from the signed catalog.");
			const archivePath = await contained(root, path.join(root, "downloads", variant.file));
			await verifyComponentFile(archivePath, variant, { signal });
			const archive = readZip(await fsp.readFile(archivePath));
			const entries = [...archive.entries.keys()].filter(name => /\.(exe|dll)$/i.test(name));
			const server = entries.find(name => path.posix.basename(name) === "llama-server.exe");
			if (!server) throw invalid("The verified runtime archive has no server.");
			const prefix = path.posix.dirname(server), dir = path.join(root, "llama", `${runtime.version}-${backend}`);
			const expectedNames = new Set(entries.filter(name => path.posix.dirname(name) === prefix).map(name => path.posix.basename(name).toLowerCase()));
			for (const name of await fsp.readdir(dir)) if (/\.(exe|dll)$/i.test(name) && !expectedNames.has(name.toLowerCase())) throw invalid("The native runtime contains an undeclared executable or DLL.");
			let files = 0;
			for (const name of entries.filter(name => path.posix.dirname(name) === prefix)) {
				signal?.throwIfAborted();
				const expected = archive.read(name);
				const file = await contained(root, path.join(dir, path.posix.basename(name)));
				await verifyComponentFile(file, { bytes: expected.length, sha256: createHash("sha256").update(expected).digest("hex") }, { signal });
				files++;
			}
			return { backend, version: runtime.version, dir, exe: path.join(dir, "llama-server.exe"), files, checkedAt: new Date().toISOString() };
		},
	};
}
