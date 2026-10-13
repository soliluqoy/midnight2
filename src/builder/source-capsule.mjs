// Exact, local source bases for wider official repairs. Candidate writes never touch the originating checkout.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT_FILES = ["package.json", "package-lock.json"];
const ROOT_DIRS = ["src", "scripts", "test", "vendor"];
const TEXT_SOURCE = /\.(?:mjs|js|cjs|json|html|css|cs|svg)$/;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => JSON.stringify(value);
function lineEndings(text, before) {
	// Retain the existing file's consistent line endings when a model supplies replacement text.
	if (before.includes("\r\n") && !/(?<!\r)\n/.test(before)) return text.replace(/\r?\n/g, "\r\n");
	if (!before.includes("\r")) return text.replace(/\r\n/g, "\n");
	return text;
}
function relativeName(value) {
	if (typeof value !== "string" || value.length > 240 || !value || value.includes("\\") || value.includes(":") || /[\x00-\x1f\x7f]/.test(value) || value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Invalid source-capsule path.");
	return value;
}
function inside(root, file) {
	const relative = path.relative(root, file);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("The source path escaped its capsule.");
}
function safeFile(root, name, { missing = false } = {}) {
	relativeName(name); const file = path.join(root, ...name.split("/")); inside(root, file);
	let current = root;
	for (const part of name.split("/")) {
		current = path.join(current, part);
		if (!fs.existsSync(current)) { if (missing) continue; throw new Error("A source-capsule file is missing."); }
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new Error("Source capsules refuse linked files and directories.");
		inside(root, fs.realpathSync(current));
	}
	return file;
}
function inventory(root, { all = false } = {}) {
	const names = [];
	function walk(name) {
		const file = safeFile(root, name), stat = fs.lstatSync(file);
		if (stat.isDirectory()) for (const child of fs.readdirSync(file).sort()) walk(`${name}/${child}`);
		else if (stat.isFile()) names.push(name);
		else throw new Error("Unsupported source-capsule file type.");
	}
	if (all) for (const name of fs.readdirSync(root).sort()) walk(name);
	else {
		for (const name of ROOT_FILES) if (fs.existsSync(path.join(root, name))) walk(name);
		for (const name of ROOT_DIRS) if (fs.existsSync(path.join(root, name))) walk(name);
	}
	return names.sort();
}
export function createSourceCapsule({ workspace, destination, maxBytes = 64 * 1024 * 1024, maxFiles = 4096 }) {
	const origin = fs.realpathSync(workspace), target = path.resolve(destination);
	const within = path.relative(origin, target);
	if (!within || (!within.startsWith(`..${path.sep}`) && within !== ".." && !path.isAbsolute(within))) throw new Error("A source capsule must be outside its originating checkout.");
	if (fs.existsSync(target)) throw new Error("A source capsule needs a fresh destination.");
	const names = inventory(origin); if (names.length > maxFiles) throw new Error("Source capsule exceeds its file budget.");
	const files = []; let bytes = 0;
	// Read and validate the entire base before creating output, including links and size limits.
	const payloads = names.map(name => {
		const file = safeFile(origin, name), stat = fs.statSync(file); bytes += stat.size;
		if (stat.size > 16 * 1024 * 1024 || bytes > maxBytes) throw new Error("Source capsule exceeds its byte budget.");
		const content = fs.readFileSync(file); if (content.length !== stat.size) throw new Error("Source changed during capture.");
		files.push({ path: name, bytes: content.length, sha256: sha(content), writable: name.startsWith("src/") && TEXT_SOURCE.test(name) });
		return { name, content };
	});
	const descriptor = { format: 1, version: JSON.parse(payloads.find(file => file.name === "package.json")?.content.toString("utf8") ?? "{}").version ?? "unknown", files };
	const digest = `sha256:${sha(canonical(descriptor))}`;
	if (inventory(origin).join("\n") !== names.join("\n") || files.some(file => sha(fs.readFileSync(safeFile(origin, file.path))) !== file.sha256)) throw new Error("Source changed during capture.");
	fs.mkdirSync(target, { recursive: true });
	for (const directory of ["base", "candidate"]) for (const { name, content } of payloads) {
		const file = path.join(target, directory, ...name.split("/")); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
	}
	fs.writeFileSync(path.join(target, "capsule.json"), JSON.stringify({ ...descriptor, digest }, null, 2));
	fs.writeFileSync(path.join(target, "candidate-files.json"), JSON.stringify(names));
	return openSourceCapsule(target);
}
export function openSourceCapsule(directory, { expectedDigest } = {}) {
	const root = fs.realpathSync(directory), base = path.join(root, "base"), candidate = path.join(root, "candidate");
	const bytes = fs.readFileSync(path.join(root, "capsule.json")); if (bytes.length > 2 * 1024 * 1024) throw new Error("Source-capsule descriptor exceeds its budget.");
	const { digest, ...descriptor } = JSON.parse(bytes);
	if (descriptor.format !== 1 || !Array.isArray(descriptor.files) || descriptor.files.length > 4096 || digest !== `sha256:${sha(canonical(descriptor))}`) throw new Error("Source-capsule identity does not match its descriptor.");
	if (expectedDigest && digest !== expectedDigest) throw new Error("The source capsule no longer matches the recorded repair base.");
	const original = new Map(descriptor.files.map(file => [relativeName(file.path), file]));
	if (original.size !== descriptor.files.length) throw new Error("Source capsule contains duplicate paths.");
	const indexFile = path.join(root, "candidate-files.json");
	const candidateNames = () => {
		const bytes = fs.readFileSync(indexFile); if (bytes.length > 2 * 1024 * 1024) throw new Error("Candidate index exceeds its budget.");
		const names = JSON.parse(bytes); if (!Array.isArray(names) || names.length > 4096 || new Set(names).size !== names.length) throw new Error("Invalid candidate index.");
		return names.map(relativeName).sort();
	};
	function verifyBase() {
		if (inventory(base, { all: true }).join("\n") !== [...original.keys()].sort().join("\n")) throw new Error("Source-capsule base file set changed.");
		for (const [name, expected] of original) { const content = fs.readFileSync(safeFile(base, name)); if (content.length !== expected.bytes || sha(content) !== expected.sha256) throw new Error("Source-capsule base bytes changed."); }
	}
	function inspect() {
		verifyBase(); const names = candidateNames();
		if (inventory(candidate, { all: true }).join("\n") !== names.join("\n") || [...original].some(([name, file]) => !file.writable && !names.includes(name))) throw new Error("Candidate source file set changed outside maintenance.");
		const changed = [...original.keys()].filter(name => !names.includes(name)), files = []; let total = 0;
		for (const name of names) {
			const content = fs.readFileSync(safeFile(candidate, name)), before = original.get(name); total += content.length;
			if (content.length > 16 * 1024 * 1024 || total > 64 * 1024 * 1024) throw new Error("Candidate source exceeds its byte budget.");
			const current = { path: name, bytes: content.length, sha256: sha(content) }; files.push(current);
			if (current.sha256 !== before?.sha256) {
				if (!(before?.writable ?? (name.startsWith("src/") && TEXT_SOURCE.test(name)))) throw new Error("Candidate changed a host-owned package, dependency, validation or binary file.");
				changed.push(name);
			}
		}
		changed.sort(); return { baseDigest: digest, digest: `sha256:${sha(canonical(files))}`, files, changed, requiresNativeBuild: changed.some(name => name.endsWith(".cs")), kernelChanges: changed.filter(name => /^(?:src\/(?:policy|storage|contracts|recovery|runtime|inference|builder|scheduler|resources|desktop|missions|context|memory|evidence|skills|connectors|windows|search|voice|perception|tools)\/|src\/(?:main\.mjs|preload\.cjs|settings\.mjs)$|src\/plugins\/(?!builtin\/))/.test(name)) };
	}
	return {
		root, base, candidate, digest, version: descriptor.version,
		list: () => candidateNames().map(name => ({ path: name, writable: original.get(name)?.writable ?? (name.startsWith("src/") && TEXT_SOURCE.test(name)) })),
		read(name) { if (!candidateNames().includes(name)) throw new Error("This file is outside the candidate source list."); const file = safeFile(candidate, name), content = fs.readFileSync(file); if (content.length > 128 * 1024 || !TEXT_SOURCE.test(name)) throw new Error("Only bounded source text can enter a builder request."); return content.toString("utf8"); },
		patch(name, { expectedSha256, find, replace }) {
			if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? "") || typeof find !== "string" || !find || typeof replace !== "string" || Buffer.byteLength(find) > 16_384 || Buffer.byteLength(replace) > 16_384) throw new Error("An exact source patch needs a file digest and bounded literal text.");
			const text = this.read(name); if (sha(text) !== expectedSha256) throw new Error("The source file changed after the builder read it. Read its current bytes again.");
			const needle = lineEndings(find, text), replacement = lineEndings(replace, text), at = text.indexOf(needle);
			if (at < 0 || text.indexOf(needle, at + 1) !== -1) throw new Error("A source patch must match exactly one occurrence.");
			return this.write(name, text.slice(0, at) + replacement + text.slice(at + needle.length));
		},
		write(name, text) {
			relativeName(name); if (!name.startsWith("src/") || !TEXT_SOURCE.test(name) || (original.has(name) && !original.get(name).writable) || typeof text !== "string" || Buffer.byteLength(text) > 128 * 1024) throw new Error("The core builder can change bounded src text only.");
			if (candidateNames().some(value => value !== name && value.toLowerCase() === name.toLowerCase())) throw new Error("Source paths cannot alias another candidate file.");
			verifyBase(); const file = safeFile(candidate, name, { missing: true }); if (fs.existsSync(file)) text = lineEndings(text, fs.readFileSync(file, "utf8"));
			if (Buffer.byteLength(text) > 128 * 1024) throw new Error("Candidate text exceeds its maintenance budget.");
			fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
			const names = candidateNames(); if (!names.includes(name)) { names.push(name); names.sort(); fs.writeFileSync(indexFile, JSON.stringify(names)); }
			return { path: name, sha256: sha(text) };
		},
		remove(name) {
			relativeName(name); const names = candidateNames();
			if (!name.startsWith("src/") || !TEXT_SOURCE.test(name) || !names.includes(name) || (original.has(name) && !original.get(name).writable)) throw new Error("Only candidate src text can be removed.");
			verifyBase(); fs.unlinkSync(safeFile(candidate, name)); fs.writeFileSync(indexFile, JSON.stringify(names.filter(value => value !== name))); return { removed: name };
		},
		freeze(destination) {
			const snapshot = inspect(), target = path.resolve(destination);
			for (const forbidden of [base, candidate]) { const relative = path.relative(forbidden, target); if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Frozen output cannot be inside live source."); }
			if (fs.existsSync(target)) throw new Error("Frozen source needs a fresh destination.");
			const payloads = snapshot.files.map(file => { const content = fs.readFileSync(safeFile(candidate, file.path)); if (sha(content) !== file.sha256) throw new Error("Candidate changed during freeze."); return { name: file.path, content }; });
			if (inspect().digest !== snapshot.digest) throw new Error("Candidate changed during freeze.");
			fs.mkdirSync(target, { recursive: true });
			for (const payload of payloads) { const file = path.join(target, ...payload.name.split("/")); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, payload.content); }
			return { ...snapshot, root: target };
		},
		verifyBase, inspect,
	};
}
