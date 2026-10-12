// Opt-in retrieval over selected folders. The index is a cache, never authority: every hit and open rechecks
// the selected root, real path, cloud-file attributes and source hash. Indexing is user-started and bounded.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { within } from "../policy/grants.mjs";
import { realTarget } from "../policy/roots.mjs";
import { readDocx } from "../tools/documents/docx.mjs";
import { readZip, xmlUnescape } from "../tools/documents/zip.mjs";
import { createEmbeddingRuntime } from "./runtime.mjs";

export const SEARCH_LIMITS = Object.freeze({ maxFiles: 5000, maxEntries: 20000, maxDepth: 12, maxSegments: 20000, maxSegmentsPerFile: 120, maxTextChars: 300000, maxFileBytes: 512 * 1024 * 1024, maxTextFileBytes: 20 * 1024 * 1024 });
const SKIP_DIR = /^(node_modules|\.git|\.svn|\$recycle\.bin|system volume information|appdata|\.cache|cache|temp|tmp|__pycache__|\.venv|venv|windows|windows\.old|program files(?:\s*\(x86\))?|programdata|recovery|boot|build|dist|vendor)$/i;
export const SECRET_NAME = /(^\.env(\..*)?$|\.pem$|\.key$|\.pfx$|\.p12$|^id_(rsa|ed25519|ecdsa)|\.kdbx$|credentials|secret|password|token)/i;
// Reject whole documents containing recognizable private key material or live credential assignments.
export const SECRET_TEXT = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----|\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b|(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|authorization)\s*[=:]\s*["']?(?:Bearer\s+)?[A-Za-z0-9_+./=-]{12,}/i;
const TEXT_EXTS = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".log", ".html", ".htm", ".xml", ".yaml", ".yml", ".rst"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"]);
const AUDIO_EXTS = new Set([".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".aiff", ".aif", ".opus", ".wma"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v", ".wmv", ".mpeg", ".mpg"]);
const STOP_WORDS = new Set(["a", "an", "and", "are", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "was", "with"]);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const identityPath = (p) => process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
const fileId = (p) => `sf_${hash(identityPath(p)).slice(0, 32)}`;
const segmentId = (id, ordinal) => `ss_${hash(`${id}:${ordinal}`).slice(0, 32)}`;
const norm = (text) => String(text ?? "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
const tokens = (text) => [...new Set((norm(text).match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => !STOP_WORDS.has(t)))];
const json = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const abortError = () => Object.assign(new Error("File search cancelled."), { name: "AbortError" });
const checkSignal = (signal) => { if (signal?.aborted) throw signal.reason ?? abortError(); };
const yieldTask = () => new Promise((resolve) => setImmediate(resolve));
const errText = (error) => String(error?.message ?? error).slice(0, 600);
const metadataVersion = (st) => `${st.mtime.toISOString()}|${st.size}`;

function formatOf(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	if (TEXT_EXTS.has(ext)) return { kind: "document", format: "text", ext };
	if ([".docx", ".pptx"].includes(ext)) return { kind: "document", format: ext.slice(1), ext };
	if (ext === ".pdf") return { kind: "document", format: "pdf", ext };
	if (IMAGE_EXTS.has(ext)) return { kind: "image", format: "image", ext };
	if (AUDIO_EXTS.has(ext)) return { kind: "audio", format: "audio", ext };
	if (VIDEO_EXTS.has(ext)) return { kind: "video", format: "video", ext };
	return { kind: "other", format: "unsupported", ext };
}

/** Normalize even vectors from injected/local runtimes; invalid vectors never enter the persistent index. */
export function normalizeVector(vector, dimensions) {
	if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) throw new Error("Embedding model returned an invalid vector.");
	const out = Array.from(vector);
	if (!out.length || out.length > 8192 || (dimensions && out.length !== dimensions) || out.some((v) => typeof v !== "number" || !Number.isFinite(v))) throw new Error("Embedding model returned a vector with invalid values or dimensions.");
	const length = Math.hypot(...out);
	if (!Number.isFinite(length) || length <= 0) throw new Error("Embedding model returned an empty vector.");
	return out.map((v) => v / length);
}

function chunkText(text, locator = {}, limit = SEARCH_LIMITS.maxSegmentsPerFile) {
	const segments = [];
	const clipped = text.slice(0, SEARCH_LIMITS.maxTextChars);
	for (let start = 0; start < clipped.length && segments.length < limit;) {
		let end = Math.min(clipped.length, start + 1800);
		if (end < clipped.length) {
			const boundary = Math.max(clipped.lastIndexOf("\n", end), clipped.lastIndexOf(" ", end));
			if (boundary > start + 900) end = boundary;
		}
		const value = clipped.slice(start, end);
		if (value.trim()) segments.push({ text: value, locator: { ...locator, startChar: start, endChar: end, line: clipped.slice(0, start).split("\n").length } });
		if (end === clipped.length) break;
		start = Math.max(start + 1, end - 180);
	}
	return { segments, truncated: text.length > clipped.length || (segments.length === limit && (segments.at(-1)?.locator.endChar ?? 0) < clipped.length) };
}

function readDocument(buf, format) {
	if (format === "docx") {
		const text = readDocx(buf).text;
		if (SECRET_TEXT.test(text)) throw new Error("Sensitive credential content was excluded.");
		return chunkText(text);
	}
	if (format === "pptx") {
		const zip = readZip(buf);
		const slides = [...zip.entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(/slide(\d+)/.exec(a)[1]) - Number(/slide(\d+)/.exec(b)[1]));
		if (!slides.length) throw new Error("This presentation has no readable slides.");
		const segments = [];
		let truncated = false;
		let chars = 0;
		for (const name of slides) {
			const text = [...zip.text(name).matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => xmlUnescape(m[1])).join("\n");
			if (SECRET_TEXT.test(text)) throw new Error("Sensitive credential content was excluded.");
			const remaining = SEARCH_LIMITS.maxSegmentsPerFile - segments.length;
			if (!remaining || chars >= SEARCH_LIMITS.maxTextChars) { truncated = true; break; }
			const split = chunkText(text.slice(0, SEARCH_LIMITS.maxTextChars - chars), { slide: Number(/slide(\d+)/.exec(name)[1]) }, remaining);
			segments.push(...split.segments);
			chars += text.length;
			truncated ||= split.truncated || chars > SEARCH_LIMITS.maxTextChars;
		}
		return { segments, truncated };
	}
	if (buf.includes(0)) throw new Error("This file contains binary content and is searchable by filename only.");
	const text = buf.toString("utf8");
	if (SECRET_TEXT.test(text)) throw new Error("Sensitive credential content was excluded.");
	return chunkText(text);
}

/** Metadata-only helper: never opens data streams, so checks do not hydrate OneDrive placeholders. */
function createAttributeReader() {
	let child = null;
	let idle = null;
	let sequence = 0;
	let buffer = "";
	const pending = new Map();
	const unavailable = () => new Error("Windows cloud-file attributes could not be checked; content was not read.");
	function stop(error = unavailable()) {
		clearTimeout(idle);
		const previous = child;
		child = null;
		buffer = "";
		previous?.kill();
		for (const task of pending.values()) task.finish(error);
		pending.clear();
	}
	function start() {
		if (child) return;
		const script = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); while (($line=[Console]::ReadLine()) -ne $null) { try { $request=$line | ConvertFrom-Json; $items=@($request.paths | ForEach-Object { $f=$_; try { @{path=$f;attributes=[int][IO.File]::GetAttributes($f)} } catch { @{path=$f;error='unavailable'} } }); [Console]::WriteLine((@{id=$request.id;rows=$items} | ConvertTo-Json -Compress -Depth 4)) } catch { [Console]::WriteLine('{\"error\":\"metadata unavailable\"}') } }";
		const started = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		child = started;
		const fail = () => { if (child === started) stop(); };
		started.on("error", fail);
		started.stdin.on("error", fail);
		started.on("close", fail);
		started.stderr.resume();
		started.stdout.setEncoding("utf8");
		started.stdout.on("data", (data) => {
			if (child !== started) return;
			buffer += data;
			if (buffer.length > 8 * 1024 * 1024) { stop(new Error("Windows attribute response exceeded its limit.")); return; }
			for (let end; (end = buffer.indexOf("\n")) >= 0;) {
				const line = buffer.slice(0, end).replace(/^\uFEFF/, "");
				buffer = buffer.slice(end + 1);
				try {
					const message = JSON.parse(line);
					if (!Array.isArray(message.rows)) { stop(); return; }
					pending.get(message.id)?.finish(null, new Map(message.rows.map((row) => [row.path, typeof row.attributes === "number" ? row.attributes : null])));
				} catch { stop(); return; }
			}
		});
	}
	async function read(filePaths, { signal } = {}) {
		checkSignal(signal);
		if (!filePaths.length) return new Map();
		if (process.platform !== "win32") return new Map(filePaths.map((p) => [p, 0]));
		clearTimeout(idle);
		start();
		return new Promise((resolve, reject) => {
			const id = ++sequence;
			const abort = () => stop(signal?.reason ?? abortError());
			const timer = setTimeout(() => stop(), 15000);
			const finish = (error, value) => {
				if (!pending.has(id)) return;
				pending.delete(id); clearTimeout(timer); signal?.removeEventListener("abort", abort);
				if (!pending.size && child) { idle = setTimeout(() => stop(), 5000); idle.unref(); }
				error ? reject(error) : resolve(value);
			};
			pending.set(id, { finish });
			signal?.addEventListener("abort", abort, { once: true });
			child.stdin.write(`${JSON.stringify({ id, paths: filePaths })}\n`);
		});
	}
	return { read, close: () => stop(abortError()) };
}
// Hidden, system, reparse, offline, recall on open, recall on data access. Reparse points include junctions.
const UNSAFE_ATTRIBUTES = 2 | 4 | 0x400 | 0x1000 | 0x40000 | 0x400000;
const safeAttributes = (attrs) => typeof attrs === "number" && !(attrs & UNSAFE_ATTRIBUTES);

async function sourceHash(filePath, signal) {
	checkSignal(signal);
	const digest = createHash("sha256");
	const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
	const abort = () => stream.destroy(signal?.reason ?? abortError());
	signal?.addEventListener("abort", abort, { once: true });
	try { for await (const data of stream) { checkSignal(signal); digest.update(data); } return `sha256:${digest.digest("hex")}`; }
	finally { signal?.removeEventListener("abort", abort); stream.destroy(); }
}

export function createFileSearch({ store, roots, settings, paths, runtime = createEmbeddingRuntime({ settings, paths }), getFileAttributes }) {
	const attributeReader = getFileAttributes ? null : createAttributeReader();
	getFileAttributes ??= attributeReader.read;
	const settingsNow = () => typeof settings === "function" ? settings() : settings ?? {};
	const fingerprint = () => runtime.fingerprint();
	let closed = false;
	let active = null;
	let epoch = 0;
	const readers = new Set();
	const known = new Map(); // bounded filename-only results for trusted id-only open
	// Filename discovery is reused instead of walking every folder per query. A folder's modification time changes
	// when an entry is added, removed or renamed in it, so a cheap stat of the known folders detects new files.
	let discovered = null; // { at, found, folders: Map(path -> mtimeMs), roots }
	const DISCOVERY_TTL = 10 * 60_000;
	const folderTimes = (folders) => new Map([...folders].map((dir) => { try { return [dir, fs.statSync(dir).mtimeMs]; } catch { return [dir, -1]; } }));
	const remember = (found) => (discovered = { at: Date.now(), found, folders: folderTimes(found.folders ?? []), roots: roots.list().map((r) => r.id).join(",") });
	function fresh() {
		if (!discovered || Date.now() - discovered.at > DISCOVERY_TTL || discovered.roots !== roots.list().map((r) => r.id).join(",")) return false;
		for (const [dir, mtime] of discovered.folders) {
			try { if (fs.statSync(dir).mtimeMs !== mtime) return false; } catch { if (mtime !== -1) return false; }
		}
		return true;
	}
	async function discoverCached(signal) {
		if (fresh()) return discovered.found;
		const found = await discover(signal);
		remember(found);
		return found;
	}
	let state = "idle";
	let error = null;
	let phase = "idle";
	let progress = { done: 0, total: 0, file: null, segments: 0 };
	let warnings = [];
	let skipped = 0;
	let truncated = 0;
	const warning = (text) => { if (!warnings.includes(text) && warnings.length < 12) warnings.push(text); };
	const assertLive = () => { if (closed) throw new Error("File search is closed."); };
	const currentRoot = (id) => closed ? undefined : roots.list().find((root) => root.id === id);
	function validPath(file, root = currentRoot(file.root_id ?? file.rootId)) {
		if (!root) return false;
		try {
			const relative = path.relative(root.path, file.path);
			if (!relative || relative.split(path.sep).some((part, i, all) => part.startsWith(".") || SECRET_NAME.test(part) || (i < all.length - 1 && SKIP_DIR.test(part)))) return false;
			const real = realTarget(file.path);
			if (identityPath(real) !== identityPath(file.path) || !within(root.path, real)) return false;
			let child = path.resolve(file.path);
			while (identityPath(child) !== identityPath(root.path)) {
				if (fs.lstatSync(child).isSymbolicLink()) return false;
				const parent = path.dirname(child);
				if (parent === child) return false;
				child = parent;
			}
			return fs.statSync(real).isFile();
		} catch { return false; }
	}
	const forgetFile = (id) => {
		if (!closed && !store.readOnly) store.tx(() => {
			for (const table of vecTables()) store.run(`DELETE FROM ${table} WHERE rowid IN (SELECT seq FROM search_segments WHERE file_id = ?)`, id);
			store.run("DELETE FROM search_files WHERE id = ?", id);
		});
		known.delete(id);
	};
	function counts() {
		if (closed) return { files: 0, segments: 0, kinds: {} };
		return {
			files: Number(store.get("SELECT COUNT(*) AS n FROM search_files").n),
			segments: Number(store.get("SELECT COUNT(*) AS n FROM search_segments").n),
			kinds: Object.fromEntries(store.all("SELECT kind,COUNT(*) AS n FROM search_files GROUP BY kind").map((r) => [r.kind, Number(r.n)])),
		};
	}
	function status() {
		const totals = counts();
		return { enabled: !!settingsNow().embedding?.enabled, state: state === "idle" && totals.files ? "ready" : state, busy: !!active, operation: active?.operation ?? null, phase, error, progress: { ...progress }, counts: totals, runtime: runtime.status(), limits: SEARCH_LIMITS, skipped, truncated, warnings: [...warnings], lastIndexedAt: closed ? null : store.meta("search.last-indexed-at") ?? null };
	}
	function reportProgress(value, signal) {
		if (closed || signal.aborted) return;
		const next = typeof value === "string" ? { message: value } : value ?? {};
		if (next.phase && next.phase !== phase) {
			phase = next.phase;
			progress.bytesDone = 0; progress.bytesTotal = 0;
		}
		if (next.message) progress.message = String(next.message).slice(0, 500);
		for (const key of ["bytesDone", "bytesTotal"]) if (Number.isFinite(next[key])) progress[key] = Math.max(0, next[key]);
		if (Number.isFinite(next.segments)) progress.fileSegments = Math.max(0, next.segments);
		if (next.locator) progress.locator = next.locator;
	}
	function start(operation, run) {
		assertLive();
		if (active) return { started: false, reason: "File search is already busy. Cancel the current operation first." };
		const job = { operation, epoch: ++epoch, controller: new AbortController(), promise: null };
		active = job;
		state = operation === "setup" ? "setting-up" : "indexing";
		phase = operation;
		error = null;
		warnings = [];
		skipped = 0;
		truncated = 0;
		progress = { done: 0, total: 0, file: null, segments: 0, startedAt: Date.now() };
		const guard = () => { checkSignal(job.controller.signal); if (closed || epoch !== job.epoch) throw abortError(); };
		job.promise = Promise.resolve().then(async () => { guard(); await run(job.controller.signal, guard); guard(); state = "ready"; phase = "ready"; }).catch((err) => {
			if (closed || active !== job || epoch !== job.epoch) return;
			if (job.controller.signal.aborted || err?.name === "AbortError") { state = "cancelled"; phase = "cancelled"; }
			else { state = "error"; phase = "error"; error = errText(err); }
		}).finally(() => { if (active === job) { active = null; progress.file = null; } });
		return { started: true };
	}
	async function discover(signal) {
		const files = [];
		const directories = new Set();
		let seen = 0;
		let limited = false;
		let attributeFailure = false;
		const visited = new Set();
		const selected = roots.list();
		async function visit(root, dir, depth, ancestors) {
			checkSignal(signal);
			if (seen >= SEARCH_LIMITS.maxEntries || files.length >= SEARCH_LIMITS.maxFiles) { limited = true; return; }
			// Listing an offline folder can request its cloud metadata. Check directory attributes first as well.
			try {
				const attrs = await getFileAttributes([dir], { signal });
				checkSignal(signal);
				if (!safeAttributes(attrs.get(dir))) { skipped++; warning("Hidden, system, linked, unavailable or cloud-only folders were skipped; OneDrive files were not downloaded."); return; }
			} catch (err) { checkSignal(signal); attributeFailure = true; warning(errText(err)); return; }
			let entries;
			try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
			catch { warning("Some selected folders could not be read."); return; }
			entries.sort((a, b) => a.name.localeCompare(b.name));
			for (const entry of entries) {
				checkSignal(signal);
				if (++seen > SEARCH_LIMITS.maxEntries || files.length >= SEARCH_LIMITS.maxFiles) { limited = true; break; }
				if (entry.name.startsWith(".") || SECRET_NAME.test(entry.name) || entry.isSymbolicLink()) { skipped++; continue; }
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (SKIP_DIR.test(entry.name)) { skipped++; continue; }
					if (depth >= SEARCH_LIMITS.maxDepth) { limited = true; continue; }
					directories.add(full);
					await visit(root, full, depth + 1, [...ancestors, full]);
				} else if (entry.isFile() && !visited.has(identityPath(full))) {
					visited.add(identityPath(full));
					try {
						const st = await fsp.lstat(full);
						if (!st.isFile() || st.isSymbolicLink()) { skipped++; continue; }
						files.push({ id: fileId(full), rootId: root.id, path: full, name: entry.name, ...formatOf(full), size: st.size, modifiedMs: st.mtimeMs, ancestors });
					} catch { skipped++; }
				}
			}
		}
		for (const root of selected) {
			try { if (identityPath(realTarget(root.path)) !== identityPath(root.path)) { warning("A selected folder changed its location; add it again before indexing."); continue; } }
			catch { warning("A selected folder is unavailable."); continue; }
			await visit(root, root.path, 0, []);
		}
		checkSignal(signal);
		let attrs;
		try { attrs = await getFileAttributes([...directories, ...files.map((file) => file.path)], { signal }); }
		catch (err) { checkSignal(signal); warning(errText(err)); return { files: [], limited, safe: false }; }
		const safe = files.filter((file) => {
			if (!safeAttributes(attrs.get(file.path)) || file.ancestors.some((dir) => !safeAttributes(attrs.get(dir)))) { skipped++; return false; }
			if (!validPath(file)) { skipped++; return false; }
			return true;
		});
		if (safe.length < files.length) warning("Hidden, system, linked, unavailable or cloud-only files were skipped; OneDrive files were not downloaded.");
		if (limited) warning(`Discovery is limited to ${SEARCH_LIMITS.maxFiles} files, ${SEARCH_LIMITS.maxEntries} entries and ${SEARCH_LIMITS.maxDepth} folder levels. Narrow your selected folders to cover more files.`);
		return { files: safe, limited, safe: !attributeFailure, folders: [...selected.map((root) => root.path), ...directories] };
	}
	async function revalidate(file, { signal, checkHash = true } = {}) {
		checkSignal(signal);
		if (!validPath(file)) return null;
		const root = currentRoot(file.root_id ?? file.rootId);
		const attributePaths = [file.path];
		for (let parent = path.dirname(file.path); root && identityPath(parent) !== identityPath(root.path); parent = path.dirname(parent)) {
			if (path.dirname(parent) === parent) return null;
			attributePaths.push(parent);
		}
		const attrs = await getFileAttributes(attributePaths, { signal });
		checkSignal(signal);
		if (attributePaths.some((p) => !safeAttributes(attrs.get(p))) || !validPath(file)) return null;
		const st = await fsp.stat(file.path);
		if (file.size !== undefined && (st.size !== file.size || (file.modified_ms ?? file.modifiedMs) !== st.mtimeMs)) return null;
		const expected = file.source_hash ?? file.hash;
		if (checkHash && expected && await sourceHash(file.path, signal) !== expected) return null;
		checkSignal(signal);
		if (!validPath(file)) return null;
		const after = await fsp.stat(file.path);
		if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) return null;
		return { path: file.path, name: file.name, kind: file.kind, hash: expected ?? undefined, sourceVersion: metadataVersion(after) };
	}
	// Vectors: Float32 BLOBs in search_segments; with sqlite-vec loaded, a vec0 table per dimension gives KNN.
	const vecTable = (dims) => `search_vec_${dims}`;
	const vecReady = new Set();
	function ensureVec(dims) {
		if (!store.vector || vecReady.has(dims)) return store.vector;
		store.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${vecTable(dims)} USING vec0(embedding float[${dims}] distance_metric=cosine)`);
		vecReady.add(dims);
		return true;
	}
	const vecTables = () => store.vector ? store.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'search_vec_[0-9]*' AND sql LIKE 'CREATE VIRTUAL TABLE%'").map((r) => r.name) : [];
	/** Remove vector rows for segments that are gone (a deleted file, root or cleared index). */
	function pruneVectors() {
		if (closed || store.readOnly) return;
		for (const table of vecTables()) store.run(`DELETE FROM ${table} WHERE rowid NOT IN (SELECT seq FROM search_segments)`);
	}
	const blob = (vector) => new Uint8Array(Float32Array.from(vector).buffer);
	const unblob = (b) => b ? new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)) : null;
	function saveFile(file, source, fp, segments, { state: fileState = "indexed", note = null, truncated: clipped = false } = {}) {
		const dims = segments.find((s) => s.vector)?.vector.length;
		const useVec = dims ? ensureVec(dims) : false;
		store.tx(() => {
			for (const table of vecTables()) store.run(`DELETE FROM ${table} WHERE rowid IN (SELECT seq FROM search_segments WHERE file_id = ?)`, file.id);
			store.run("DELETE FROM search_files WHERE id = ?", file.id);
			store.run("INSERT INTO search_files (id,root_id,path,name,kind,size,modified_ms,source_hash,fingerprint,state,note,truncated,indexed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", file.id, file.rootId, file.path, file.name, file.kind, file.size, file.modifiedMs, source, fp, fileState, note, Number(clipped), new Date().toISOString());
			for (let ordinal = 0; ordinal < segments.length; ordinal++) {
				const segment = segments[ordinal];
				const vector = segment.vector ? blob(segment.vector) : null;
				const seq = store.run("INSERT INTO search_segments (id,file_id,ordinal,text,locator,embedding,dimensions,fingerprint) VALUES (?,?,?,?,?,?,?,?)", segmentId(file.id, ordinal), file.id, ordinal, segment.text ?? "", JSON.stringify(segment.locator ?? {}), vector, segment.vector?.length ?? 0, fp).lastInsertRowid;
				store.run("INSERT INTO search_fts (rowid, text, name) VALUES (?, ?, ?)", seq, segment.text ?? "", file.name);
				if (vector && useVec && segment.vector.length === dims) store.run(`INSERT INTO ${vecTable(dims)} (rowid, embedding) VALUES (?, ?)`, BigInt(seq), vector);
			}
		});
	}
	function setup() { return start("setup", async (signal, guard) => { await runtime.setup({ signal, onProgress: (value) => reportProgress(value, signal) }); guard(); }); }
	function index() {
		assertLive();
		if (!settingsNow().embedding?.enabled) return { started: false, reason: "Enable local file search in Settings, then set up the embedding model." };
		if (!runtime.status().available) return { started: false, reason: "Set up the local embedding model before indexing files." };
		if (!roots.list().length) return { started: false, reason: "Add a folder to read in Settings before indexing files." };
		return start("index", async (signal, guard) => {
			reportProgress({ phase: "discovering", message: "Finding files in your selected folders" }, signal);
			const found = await discover(signal);
			guard();
			if (!found.safe) throw new Error("File attributes could not be checked safely. No file content was read.");
			const present = new Set(found.files.map((file) => file.id));
			for (const old of store.all("SELECT * FROM search_files")) if (!currentRoot(old.root_id) || !validPath(old) || (!found.limited && !present.has(old.id))) forgetFile(old.id);
			const fp = fingerprint();
			progress.total = found.files.length;
			let totalSegments = counts().segments;
			let fileErrors = 0;
			for (const file of found.files) {
				guard();
				progress.file = file.name;
				progress.fileSegments = 0; progress.locator = null;
				reportProgress({ phase: "embedding", message: "Reading files for meaning search" }, signal);
				try {
					if (file.size > SEARCH_LIMITS.maxFileBytes || (["text", "docx", "pptx"].includes(file.format) && file.size > SEARCH_LIMITS.maxTextFileBytes)) {
						forgetFile(file.id); saveFile(file, null, "", [], { state: "filename", note: "File exceeds the content size limit; filename only." }); skipped++; warning("Files larger than the content size limit are searchable by filename only."); continue;
					}
					if (file.format === "unsupported") { saveFile(file, null, "", [], { state: "filename", note: "Unsupported format; filename only." }); warning("Unsupported formats are searchable by filename only."); continue; }
					if (!await revalidate(file, { signal, checkHash: false })) { forgetFile(file.id); skipped++; continue; }
					const source = await sourceHash(file.path, signal);
					guard();
					if (!validPath(file)) { forgetFile(file.id); skipped++; continue; }
					const old = store.get("SELECT * FROM search_files WHERE id = ?", file.id);
					const oldSegments = Number(store.get("SELECT COUNT(*) AS n FROM search_segments WHERE file_id = ?", file.id).n);
					if (old?.source_hash === source && old.fingerprint === fp && old.state === "indexed") { progress.segments += oldSegments; continue; }
					let generated;
					if (["text", "docx", "pptx"].includes(file.format)) {
						const buffer = await fsp.readFile(file.path);
						guard();
						if (!validPath(file)) { forgetFile(file.id); skipped++; continue; }
						generated = readDocument(buffer, file.format);
						if (generated.segments.some((segment) => SECRET_TEXT.test(segment.text))) { forgetFile(file.id); skipped++; warning("Documents containing credentials or private keys were excluded."); continue; }
						if (generated.segments.length) {
							const vectors = await runtime.embedText(generated.segments.map((segment) => segment.text), { signal, onProgress: (value) => reportProgress(value, signal) });
							if (!Array.isArray(vectors) || vectors.length !== generated.segments.length) throw new Error("Embedding model returned the wrong number of passage vectors.");
							generated.segments.forEach((segment, i) => { segment.vector = vectors[i]; });
						}
					} else generated = await runtime.embedMedia(file.path, file.format, { signal, maxSegments: SEARCH_LIMITS.maxSegmentsPerFile, onProgress: (value) => reportProgress(value, signal) });
					guard();
					if (!generated || !Array.isArray(generated.segments)) throw new Error("Embedding model returned invalid media segments.");
					const segments = generated.segments.slice(0, SEARCH_LIMITS.maxSegmentsPerFile);
					const dimensions = Number(settingsNow().embedding?.dimensions ?? runtime.status().dimensions ?? segments[0]?.vector?.length);
					for (const segment of segments) {
						segment.vector = normalizeVector(segment.vector, dimensions);
						segment.text = String(segment.text ?? "").slice(0, 6000);
						if (!segment.locator || typeof segment.locator !== "object" || Array.isArray(segment.locator) || JSON.stringify(segment.locator).length > 2000) throw new Error("Embedding model returned an invalid passage locator.");
					}
					if (segments.some((segment) => SECRET_TEXT.test(segment.text))) { forgetFile(file.id); skipped++; warning("Documents containing credentials or private keys were excluded."); continue; }
					if (totalSegments - oldSegments + segments.length > SEARCH_LIMITS.maxSegments) { warning(`The index reached its ${SEARCH_LIMITS.maxSegments} passage limit. Narrow your selected folders.`); truncated++; break; }
					if (!await revalidate({ ...file, hash: source }, { signal })) { forgetFile(file.id); skipped++; warning("Files changed during indexing were skipped. Index again after editing finishes."); continue; }
					guard();
					if (fingerprint() !== fp) throw new Error("Embedding settings changed during indexing. Index again with the new settings.");
					const clipped = !!generated.truncated || generated.segments.length > segments.length;
					saveFile(file, source, fp, segments, { truncated: clipped });
					totalSegments += segments.length - oldSegments;
					progress.segments += segments.length;
					if (clipped) { truncated++; warning("Long documents and media were sampled or truncated at the per-file passage limit; matches include page or time locations."); }
				} catch (err) {
					guard();
					forgetFile(file.id);
					if (/Sensitive credential/.test(errText(err))) { skipped++; warning("Documents containing credentials or private keys were excluded."); }
					else { fileErrors++; skipped++; warning(`${file.name}: ${errText(err)}`); }
				} finally { if (!closed) progress.done++; }
				await yieldTask();
			}
			guard();
			store.meta("search.last-indexed-at", new Date().toISOString());
			if (fileErrors) throw new Error(`${fileErrors} file${fileErrors === 1 ? "" : "s"} could not be indexed. See the file search warnings and try again.`);
		});
	}
	function lexical(query, queryTokens, text, name) {
		const textNorm = norm(text);
		const nameNorm = norm(name);
		const textTokens = new Set(tokens(textNorm));
		const nameTokens = new Set(tokens(nameNorm));
		const denominator = queryTokens.length || 1;
		const textFraction = queryTokens.filter((t) => textTokens.has(t)).length / denominator;
		const nameFraction = queryTokens.filter((t) => nameTokens.has(t)).length / denominator;
		const phrase = textNorm.includes(query);
		const filenamePhrase = nameNorm.includes(query);
		return { score: textFraction * 0.45 + nameFraction * 0.25 + (phrase ? 0.45 : 0) + (filenamePhrase ? 0.3 : 0), matched: phrase || filenamePhrase || textFraction > 0 || nameFraction > 0 };
	}
	async function queryCached({ query, kind, limit = 12, signal, queryVector: suppliedVector, vectorFingerprint, wordsOnly = false } = {}) {
		assertLive();
		checkSignal(signal);
		if (typeof query !== "string" || !query.trim() || query.length > 1000) throw new Error("Enter a search query of 1 to 1000 characters.");
		limit = Math.min(50, Math.max(1, Number.isInteger(limit) ? limit : 12));
		const kindFilter = ["text", "pdf", "slides"].includes(kind) ? "document" : kind;
		if (kindFilter && !["all", "document", "image", "audio", "video", "other"].includes(kindFilter)) throw new Error("Choose documents, images, audio, video or all files.");
		const q = norm(query);
		const ts = tokens(q);
		const fp = fingerprint();
		const available = settingsNow().embedding?.enabled && runtime.status().available;
		let mode = "words";
		let searchWarning;
		let queryVector;
		const matchingVectors = Number(store.get("SELECT COUNT(*) AS n FROM search_segments WHERE fingerprint = ? AND embedding IS NOT NULL", fp).n);
		if (available && matchingVectors && suppliedVector && vectorFingerprint === fp) {
			queryVector = normalizeVector(suppliedVector, Number(settingsNow().embedding?.dimensions ?? runtime.status().dimensions));
			mode = "hybrid";
		} else if (available && matchingVectors && !wordsOnly) {
			try {
				const vectors = await runtime.embedText([query], { query: true, signal });
				checkSignal(signal); assertLive();
				if (!Array.isArray(vectors) || vectors.length !== 1) throw new Error("Embedding model returned an invalid query response.");
				queryVector = normalizeVector(vectors[0], Number(settingsNow().embedding?.dimensions ?? runtime.status().dimensions));
				if (fp !== fingerprint()) throw new Error("Embedding settings changed during search.");
				mode = "hybrid";
			} catch (err) { checkSignal(signal); assertLive(); searchWarning = `Semantic search failed: ${errText(err)} Showing word and filename matches.`; }
		} else searchWarning = !settingsNow().embedding?.enabled ? "Local embeddings are disabled. Showing word and filename matches." : !runtime.status().available ? "The embedding model is not set up. Showing word and filename matches." : "Index your selected folders to enable semantic matches for this model. Showing word and filename matches.";
		// Candidate passages come from two indexes instead of a scan: FTS5 for words and sqlite-vec (or a BLOB scan
		// when the extension is unavailable) for meaning. Only candidates are scored, loaded and revalidated.
		const pool = limit * 30;
		const cosineBySeq = new Map();
		const seqs = new Set();
		if (ts.length) {
			const match = ts.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
			try { for (const r of store.all("SELECT rowid FROM search_fts WHERE search_fts MATCH ? ORDER BY bm25(search_fts) LIMIT ?", match, pool)) seqs.add(Number(r.rowid)); }
			catch (err) { searchWarning = searchWarning ?? `Word search failed: ${errText(err)}`; }
		}
		let vectorComparisons = 0;
		if (queryVector) {
			const dims = queryVector.length;
			if (store.vector && vecTables().includes(vecTable(dims))) {
				for (const r of store.all(`SELECT rowid, distance FROM ${vecTable(dims)} WHERE embedding MATCH ? AND k = ?`, blob(queryVector), pool)) {
					cosineBySeq.set(Number(r.rowid), 1 - r.distance);
					seqs.add(Number(r.rowid));
				}
			} else {
				const q = Float32Array.from(queryVector);
				const best = [];
				for (const r of store.raw.prepare("SELECT seq, embedding FROM search_segments WHERE fingerprint = ? AND dimensions = ? AND embedding IS NOT NULL LIMIT ?").iterate(fp, dims, SEARCH_LIMITS.maxSegments)) {
					const v = unblob(r.embedding);
					let dot = 0;
					for (let i = 0; i < dims; i++) dot += v[i] * q[i];
					best.push([Number(r.seq), dot]);
				}
				best.sort((a, b) => b[1] - a[1]);
				for (const [seq, cosine] of best.slice(0, pool)) { cosineBySeq.set(seq, cosine); seqs.add(seq); }
			}
		}
		const candidates = [];
		const files = new Map();
		const fileRow = (id) => {
			if (!files.has(id)) {
				const row = store.get("SELECT * FROM search_files WHERE id = ?", id);
				files.set(id, row && (!kindFilter || kindFilter === "all" || row.kind === kindFilter) ? row : null);
			}
			return files.get(id);
		};
		const add = (candidate) => { candidates.push(candidate); if (candidates.length > limit * 30) { candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)); candidates.length = limit * 20; } };
		for (const seq of seqs) {
			const segment = store.get("SELECT * FROM search_segments WHERE seq = ?", seq);
			if (!segment) continue;
			const file = fileRow(segment.file_id);
			if (!file) continue;
			const words = lexical(q, ts, segment.text, file.name);
			let cosine = 0;
			if (queryVector && segment.fingerprint === fp && segment.dimensions === queryVector.length && cosineBySeq.has(seq)) { cosine = cosineBySeq.get(seq); vectorComparisons++; }
			if (!words.matched && cosine < 0.2) continue;
			add({ ...file, id: segment.id, fileId: file.id, text: segment.text, locator: json(segment.locator, {}), score: words.score + Math.max(0, cosine) * 0.6, match: words.matched ? (cosine >= 0.2 ? "both" : "words") : "semantic" });
		}
		if (mode === "hybrid" && !vectorComparisons) { mode = "words"; searchWarning = searchWarning ?? "No valid indexed vectors are available for this model. Showing word and filename matches."; }
		for (const file of store.all("SELECT * FROM search_files LIMIT ?", SEARCH_LIMITS.maxFiles)) {
			if (kindFilter && kindFilter !== "all" && file.kind !== kindFilter) continue;
			const words = lexical(q, ts, "", file.name);
			if (words.matched) add({ ...file, fileId: file.id, text: "", locator: {}, score: words.score, match: "filename" });
		}
		// Only names are discovered on demand (cached briefly); content is indexed exclusively from the user's Index action.
		const found = await discoverCached(signal);
		checkSignal(signal); assertLive();
		known.clear();
		const indexed = new Set(store.all("SELECT id FROM search_files").map((r) => r.id));
		for (const file of found.files) {
			if (indexed.has(file.id) || (kindFilter && kindFilter !== "all" && file.kind !== kindFilter)) continue;
			const words = lexical(q, ts, "", file.name);
			if (!words.matched) continue;
			const candidate = { ...file, root_id: file.rootId, modified_ms: file.modifiedMs, fileId: file.id, text: "", locator: {}, score: words.score, match: "filename", note: file.format === "unsupported" ? "Unsupported format; filename only." : "Content has not been indexed; filename only." };
			add(candidate);
			known.set(file.id, candidate);
		}
		candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
		const results = [];
		const verified = new Map();
		const perFile = new Map();
		for (const candidate of candidates) {
			checkSignal(signal); assertLive();
			if (results.length >= limit) break;
			if ((perFile.get(candidate.fileId) ?? 0) >= 3) continue;
			let source = verified.get(candidate.fileId);
			if (source === undefined) {
				try { source = await revalidate(candidate, { signal }); }
				catch (err) { checkSignal(signal); warning(errText(err)); source = null; }
				checkSignal(signal); assertLive();
				verified.set(candidate.fileId, source);
			}
			if (!source || !validPath(candidate)) { forgetFile(candidate.fileId); continue; }
			results.push({ id: candidate.id, ...source, text: candidate.text.slice(0, 6000), locator: candidate.locator, score: Math.round(candidate.score * 1000) / 1000, match: candidate.match, ...(candidate.note ? { note: candidate.note } : {}) });
			perFile.set(candidate.fileId, (perFile.get(candidate.fileId) ?? 0) + 1);
		}
		if (found.limited) searchWarning = [searchWarning, "Filename discovery reached its limit; narrow the selected folders."].filter(Boolean).join(" ");
		return { results, mode, ...(searchWarning ? { warning: searchWarning } : {}), status: status() };
	}
	async function resolveCached(id, signal) {
		assertLive();
		if (typeof id !== "string" || !/^s[fs]_[a-f0-9]{32}$/.test(id)) throw new Error("Choose a file from the search results.");
		const segment = store.get("SELECT * FROM search_segments WHERE id = ?", id);
		const file = segment ? store.get("SELECT * FROM search_files WHERE id = ?", segment.file_id) : store.get("SELECT * FROM search_files WHERE id = ?", id) ?? known.get(id);
		if (!file) throw new Error("This search result is no longer available. Search again.");
		let current;
		try { current = await revalidate(file, { signal }); } catch { checkSignal(signal); current = null; }
		assertLive();
		if (!current || !validPath(file)) { forgetFile(segment?.file_id ?? id); throw new Error("This file changed, is unavailable, or is outside your selected folders. Search or index again."); }
		return { ...current, locator: segment ? json(segment.locator, {}) : {} };
	}
	function readOperation(run, callerSignal) {
		assertLive();
		const reader = { controller: new AbortController(), promise: null };
		readers.add(reader);
		const signal = callerSignal ? AbortSignal.any([callerSignal, reader.controller.signal]) : reader.controller.signal;
		reader.promise = Promise.resolve().then(() => run(signal)).finally(() => readers.delete(reader));
		return reader.promise;
	}
	const search = (args = {}) => readOperation((signal) => queryCached({ ...args, signal }), args.signal);
	const resolve = (id) => readOperation((signal) => resolveCached(id, signal));
	function cancel() {
		if (!active) return { cancelled: false };
		epoch++;
		active.controller.abort(abortError());
		state = "cancelled"; phase = "cancelled";
		return { cancelled: true };
	}
	function clear() {
		assertLive(); cancel(); known.clear();
		for (const reader of readers) reader.controller.abort(abortError());
		store.tx(() => { store.run("DELETE FROM search_files"); store.run("DELETE FROM meta WHERE key = 'search.last-indexed-at'"); });
		pruneVectors();
		discovered = null;
		state = "idle"; phase = "idle"; error = null; warnings = []; progress = { done: 0, total: 0, file: null, segments: 0 };
		return { cleared: true };
	}
	function removeRoot(rootId) { assertLive(); cancel(); known.clear(); for (const reader of readers) reader.controller.abort(abortError()); store.run("DELETE FROM search_files WHERE root_id = ?", rootId); pruneVectors(); discovered = null; return { removed: true }; }
	async function close() {
		if (closed) return;
		cancel(); closed = true; epoch++; known.clear();
		const pendingReaders = [...readers];
		for (const reader of pendingReaders) reader.controller.abort(abortError());
		attributeReader?.close();
		await runtime.close();
		await active?.promise;
		await Promise.allSettled(pendingReaders.map((reader) => reader.promise));
	}
	return { status, setup, index, search, resolve, cancel, clear, removeRoot, close };
}
