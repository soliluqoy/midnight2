// Persistent jobs own isolated plugin files or bounded public source candidates. The kernel owns
// admission, qualification, activation and official output. User profiles and receipts are not exported.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PLUGIN_FILES, hash } from "../plugins/manifest.mjs";
import { CHART_FIXTURES, THEME_FIXTURES } from "../plugins/runtime.mjs";
import { validateChartSvg } from "../plugins/chart-validation.mjs";
import { validateThemeOutput } from "../plugins/theme-validation.mjs";
import { COMPONENTS, componentFor } from "../plugins/catalog.mjs";
import { CORE_COMPONENT, hasCoreSource } from "./core-workspace.mjs";
import { createSourceWorkspaceWorker } from "./source-workspace.mjs";

const JOB_ID = /^change_[a-f0-9-]{36}$/;
function generationRoute(settings, privacy) {
	const route = Object.fromEntries(["provider", "model", "thinking"].filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));
	route.privacy = privacy ?? settings.privacy ?? "cloud";
	if (!["cloud", "local", "offline"].includes(route.privacy)) throw new Error("Unsupported builder privacy route.");
	if (settings.local) route.local = Object.fromEntries(["enabled", "baseUrl", "model", "vision", "contextWindow", "allowRemoteHost"].filter(key => settings.local[key] !== undefined).map(key => [key, settings.local[key]]));
	return structuredClone(route);
}
function save(file, value) { const temporary = `${file}.tmp`, fd = fs.openSync(temporary, "w"); try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temporary, file); }
export function createBuilderService({ root, sessions, plugins, pluginRuntime, run, settings, stop, arbiter, sourceRoot, sourceValidate, sourceWorkerFactory = createSourceWorkspaceWorker, schedule = async (_job, task, { signal }) => { signal.throwIfAborted(); return task(signal); }, publish = () => {} }) {
	fs.mkdirSync(root, { recursive: true });
	const active = new Map(), activations = new Map(), queued = []; let closed = false;
	const directory = id => { if (!JOB_ID.test(id)) throw new Error("Invalid change-job identity."); return path.join(root, id); };
	const load = id => JSON.parse(fs.readFileSync(path.join(directory(id), "job.json"), "utf8"));
	const persist = job => { save(path.join(directory(job.id), "job.json"), job); publish({ kind: "builder", job: publicJob(job) }); return job; };
	const publicJob = job => {
		let previewSvg, previewTokens;
		if (job.previewPath && fs.existsSync(job.previewPath)) { const svg = fs.readFileSync(job.previewPath, "utf8"); if (validateChartSvg(svg, CHART_FIXTURES[0]).ok) previewSvg = svg; }
		if (job.previewPath && job.pluginId === "midnight.theme" && fs.existsSync(job.previewPath)) { const checked = validateThemeOutput(fs.readFileSync(job.previewPath, "utf8")); if (checked.ok) previewTokens = checked.tokens; }
		return { id: job.id, kind: job.kind, scope: job.scope, pluginId: job.pluginId, component: job.kind === "core" ? CORE_COMPONENT.label : componentFor(job.pluginId).label, status: job.status, request: job.request, error: job.error, waitingReason: job.waitingReason, candidate: job.candidate, base: job.base, baseGeneration: job.baseGeneration, validation: job.validation, previewPath: job.previewPath, previewSvg, previewTokens, officialPath: job.officialPath, sourceDiff: job.sourceDiff, diffTruncated: job.diffTruncated, changed: job.changed, kernelChanges: job.kernelChanges, windowsBuild: job.windowsBuild, appPreview: job.appPreview, createdAt: job.createdAt, updatedAt: job.updatedAt };
	};
	function candidateFile(job, filename) {
		if (!PLUGIN_FILES.includes(filename)) throw new Error("The builder can access manifest.json and renderer.js only.");
		const file = path.join(directory(job.id), "candidate", filename);
		if (fs.lstatSync(file).isSymbolicLink() || !fs.realpathSync(file).startsWith(fs.realpathSync(path.join(directory(job.id), "candidate")) + path.sep)) throw new Error("The candidate file escaped its workspace.");
		return file;
	}
	const update = (id, patch) => persist({ ...load(id), ...patch, updatedAt: new Date().toISOString() });
	const sourceWaiting = id => reason => update(id, { waitingReason: reason });
	function sourceOperation(id, op, args = {}) {
		const entry = active.get(id);
		const operation = entry.sourceSerial.then(async () => {
			entry.controller.signal.throwIfAborted(); const job = load(id);
			const worker = entry.sourceWorker ??= sourceWorkerFactory({ directory: directory(id), sourceRoot, baseDigest: job.base?.digest, signal: entry.controller.signal });
			if (op === "validate") {
				if (!sourceValidate) throw new Error("Core source validation is not configured for this installation.");
				const prepared = await worker.call("prepare-validation"); if (prepared.cached) return prepared.cached;
				const result = await sourceValidate(prepared.frozen, { signal: entry.controller.signal, jobId: id, onWaiting: sourceWaiting(id) });
				entry.controller.signal.throwIfAborted(); return worker.call("finish-validation", { result });
			}
			return worker.call(op, args);
		});
		entry.sourceSerial = operation.catch(() => {}); return track(id, operation);
	}
	async function freeze(job, signal) {
		const manifest = JSON.parse(fs.readFileSync(candidateFile(job, "manifest.json"), "utf8")), source = fs.readFileSync(candidateFile(job, "renderer.js"), "utf8");
		if (manifest.id !== job.pluginId) throw new Error("A candidate cannot change its plugin namespace.");
		const pin = plugins.install(manifest, source);
		const report = await pluginRuntime.validate(pin, { signal });
		const component = componentFor(job.pluginId), input = component.method === "render" ? CHART_FIXTURES[0] : THEME_FIXTURES[0];
		const preview = await pluginRuntime[component.method](pin, input, { signal, priority: 4, validateOnly: true });
		const previewPath = path.join(directory(job.id), component.previewKind === "chart" ? "preview.svg" : "preview.json"); fs.writeFileSync(previewPath, preview.svg ?? JSON.stringify(preview.tokens));
		return { pin, report, previewPath };
	}
	async function execute(job) {
		const controller = new AbortController(); active.set(job.id, { controller, leases: [], operations: new Set(), sourceSerial: Promise.resolve() });
		try {
			if (stop.blocked(`builder:${job.id}`)) throw new Error(stop.blocked(`builder:${job.id}`));
			if (job.kind !== "core" && job.baseEpoch !== plugins.epoch) throw new Error("The component store was replaced. Create a fresh change request.");
			const completed = await schedule({ jobId: job.id, kind: job.kind, settings: job.route }, async () => {
				try { return await executeAdmitted(job, controller); } finally { await cleanupJob(job.id); }
			}, { signal: controller.signal, onRevoke: reason => controller.abort(reason), onWaiting: reason => { if (!controller.signal.aborted) update(job.id, { status: reason ? "waiting" : "patching", waitingReason: reason }); } });
			controller.signal.throwIfAborted(); update(job.id, completed);
		} catch (error) { update(job.id, { status: ["QUEUE_PREEMPTED", "QUEUE_DEFERRED", "QUEUE_EXPIRED", "QUEUE_FULL"].includes(error.code) ? "interrupted" : controller.signal.aborted ? "cancelled" : "failed", error: error.message, waitingReason: undefined }); }
		finally { await cleanupJob(job.id); active.delete(job.id); pump(); }
	}
	async function executeAdmitted(job, controller) {
		controller.signal.throwIfAborted();
		if (job.kind === "core" && !job.base) {
			update(job.id, { status: "preparing", error: undefined, waitingReason: undefined });
			const base = await sourceOperation(job.id, "capture"); controller.signal.throwIfAborted();
			job = update(job.id, { base });
		}
		update(job.id, { status: "patching", error: undefined, waitingReason: undefined });
		const result = await run({ jobId: job.id, kind: job.kind, request: job.request, scope: job.scope, pluginId: job.pluginId, base: job.base, sessionDir: path.join(sessions, job.id), sessionFile: job.sessionFile, settings: job.route }, { signal: controller.signal, awaitCleanup: () => awaitOperations(job.id) });
			controller.signal.throwIfAborted();
			if (result.error || result.aborted) throw new Error(result.error ?? "The builder stopped.");
			update(job.id, { status: "validating", usage: result.usage, sessionFile: result.sessionFile });
			if (job.kind === "core") {
				const validation = await sourceOperation(job.id, "validate");
				controller.signal.throwIfAborted();
				const proposal = await sourceOperation(job.id, "propose", { validation }); controller.signal.throwIfAborted();
				return { status: "source-proposed", ...proposal };
			}
			const candidate = await freeze(job, controller.signal); controller.signal.throwIfAborted();
			let officialPath;
			if (job.scope === "official") {
				officialPath = path.join(directory(job.id), "official-candidate"); fs.mkdirSync(officialPath, { recursive: true });
				const artifact = plugins.get(candidate.pin.digest), base = plugins.get(job.base.digest);
				for (const filename of PLUGIN_FILES) fs.writeFileSync(path.join(officialPath, filename), filename === "renderer.js" ? artifact.source : JSON.stringify(artifact.manifest, null, 2));
				fs.writeFileSync(path.join(officialPath, "source.patch"), diff(base, artifact, job.pluginId));
				save(path.join(officialPath, "candidate.json"), { format: 1, target: `src/plugins/builtin/${componentFor(job.pluginId).directory}`, base: job.base, candidate: candidate.pin, validation: candidate.report, files: PLUGIN_FILES, publishing: "maintainer review required" });
			}
			return { status: job.scope === "official" ? "proposed" : "preview-ready", candidate: candidate.pin, validation: candidate.report, previewPath: candidate.previewPath, officialPath };
	}
	async function cleanupJob(id) { await awaitOperations(id); const entry = active.get(id); await entry?.sourceWorker?.close(); for (const lease of entry?.leases ?? []) lease.release(); if (entry) entry.leases.length = 0; }
	async function awaitOperations(id) { while (active.get(id)?.operations.size) await Promise.allSettled([...active.get(id).operations]); }
	function track(id, operation) { const entry = active.get(id); entry.operations.add(operation); void operation.finally(() => entry.operations.delete(operation)).catch(() => {}); return operation; }
	function pump() { if (closed || active.size || !queued.length || stop.blocked("builder-queue")) return; const id = queued.shift(); void execute(load(id)); }
	function diff(base, candidate, pluginId = base.manifest.id) {
		const target = `src/plugins/builtin/${componentFor(pluginId).directory}`;
		return PLUGIN_FILES.map(filename => {
			const old = filename === "renderer.js" ? base.source : JSON.stringify(base.manifest, null, 2), next = filename === "renderer.js" ? candidate.source : JSON.stringify(candidate.manifest, null, 2);
			const a = old.replace(/\r\n/g, "\n").split("\n"), b = next.replace(/\r\n/g, "\n").split("\n");
			return `--- a/${target}/${filename}\n+++ b/${target}/${filename}\n@@ -1,${a.length} +1,${b.length} @@\n${a.map(line => `-${line}`).join("\n")}\n${b.map(line => `+${line}`).join("\n")}\n`;
		}).join("\n");
	}
	const api = {
		request({ scope, text, pluginId = "midnight.chart" }, { privacy } = {}) {
			if (closed || stop.blocked("builder-request")) throw new Error("Self-improvement is stopped for this session.");
			const core = pluginId === CORE_COMPONENT.id, component = core ? CORE_COMPONENT : componentFor(pluginId);
			if (core && scope !== "official") throw new Error("App source changes prepare an official proposal. Choose a plugin for private customization.");
			if (core && !hasCoreSource(sourceRoot)) throw new Error("Matching app source and validation files are not available in this installation.");
			if (!["user", "official"].includes(scope) || typeof text !== "string" || !text.trim() || text.length > 4000) throw new Error("Choose private or official scope and describe the component improvement in up to 4,000 characters.");
			if (queued.length >= 8) throw new Error("The change-job queue is full.");
			const route = generationRoute(settings(), privacy);
			const current = plugins.bindings(), id = `change_${randomUUID()}`; let base;
			if (core) fs.mkdirSync(directory(id));
			else {
				base = scope === "official" ? plugins.bases[component.binding] : current.bindings[component.binding]; const artifact = plugins.get(base.digest), workspace = path.join(directory(id), "candidate"); fs.mkdirSync(workspace, { recursive: true });
				fs.writeFileSync(path.join(workspace, "renderer.js"), artifact.source); save(path.join(workspace, "manifest.json"), artifact.manifest);
			}
			const time = new Date().toISOString(), job = persist({ id, kind: core ? "core" : "plugin", scope, request: text.trim(), pluginId, status: "requested", base, baseGeneration: current.generation, baseEpoch: plugins.epoch, route, createdAt: time, updatedAt: time });
			queued.push(id); pump(); return publicJob(job);
		},
		list: () => fs.readdirSync(root).filter(name => JOB_ID.test(name)).map(id => publicJob(load(id))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
		components: () => [...COMPONENTS.map(component => ({ id: component.id, label: component.label })), { ...CORE_COMPONENT, available: hasCoreSource(sourceRoot), reason: hasCoreSource(sourceRoot) ? undefined : "Matching app source files are required." }],
		get: id => publicJob(load(id)),
		async maintenance({ jobId, op, args = {} }) {
			const job = load(jobId), entry = active.get(jobId);
			if (!entry || !["patching", "validating"].includes(job.status) || entry.controller.signal.aborted) throw new Error("This builder job is no longer allowed to edit or validate.");
			if (op === "session") {
				const file = path.resolve(args.file); if (!file.startsWith(path.resolve(sessions, jobId) + path.sep)) throw new Error("The builder session escaped its job."); update(jobId, { sessionFile: file }); return { ok: true };
			}
			if (op === "local.acquire") { const lease = await arbiter.acquire({ role: "builder-generation", priority: 4, preemptible: true, signal: entry.controller.signal }); entry.leases.push(lease); lease.signal.addEventListener("abort", () => entry.controller.abort(lease.signal.reason), { once: true }); return { id: lease.id }; }
			if (op === "local.release") { const lease = entry.leases.find(item => item.id === args.id); lease?.release(); entry.leases = entry.leases.filter(item => item !== lease); return { ok: true }; }
			if (job.kind === "core") {
				if (!["tree", "read", "write", "patch", "remove", "diff", "validate"].includes(op)) throw new Error("Unknown source maintenance operation.");
				return sourceOperation(jobId, op, args);
			}
			if (op === "read") return { filename: args.filename, text: fs.readFileSync(candidateFile(job, args.filename), "utf8") };
			if (op === "write") {
				if (typeof args.text !== "string" || Buffer.byteLength(args.text) > 128 * 1024) throw new Error("Candidate text exceeds its maintenance budget.");
				fs.writeFileSync(candidateFile(job, args.filename), args.text); return { filename: args.filename, hash: hash(args.text) };
			}
			if (op === "validate") { const candidate = await track(jobId, freeze(job, entry.controller.signal)); return { digest: candidate.pin.digest, validation: candidate.report }; }
			if (op === "diff") { const manifest = JSON.parse(fs.readFileSync(candidateFile(job, "manifest.json"), "utf8")), source = fs.readFileSync(candidateFile(job, "renderer.js"), "utf8"); return { diff: diff(plugins.get(job.base.digest), { manifest, source }) }; }
			throw new Error("Unknown maintenance operation.");
		},
		async activate({ jobId, digest, expectedGeneration }) {
			const job = load(jobId);
			if (job.scope !== "user" || job.status !== "preview-ready" || job.candidate?.digest !== digest || job.baseGeneration !== expectedGeneration) throw new Error("Review the exact private candidate before activating it.");
			if (job.baseEpoch !== plugins.epoch) throw new Error("The component store was replaced. Create a fresh change request.");
			if (closed || stop.blocked("builder-activation")) throw new Error("Activation is stopped for this session.");
			if (activations.has(jobId)) throw new Error("This candidate is already being activated.");
			const controller = new AbortController(); let switched = false;
			activations.set(jobId, controller);
			const allowed = () => { controller.signal.throwIfAborted(); if (closed || stop.blocked("builder-activation")) throw new Error("Activation is stopped for this session."); };
			try {
				await pluginRuntime.validate(job.candidate, { signal: controller.signal }); // candidate files/report are not accepted as authority
				allowed(); plugins.activate(job.candidate, expectedGeneration); switched = true;
				const component = componentFor(job.pluginId), input = component.method === "render" ? CHART_FIXTURES[1] : THEME_FIXTURES[1];
				const observed = await pluginRuntime[component.method](job.candidate, input, { priority: 4, signal: controller.signal });
				if (component.method === "theme" && JSON.stringify(observed.tokens) !== JSON.stringify(plugins.qualification(job.candidate).tokens)) throw new Error("The color preset changed during its health check.");
				allowed(); plugins.accept(digest); return publicJob(update(jobId, { status: "accepted", error: undefined }));
			} catch (err) {
				const component = componentFor(job.pluginId);
				if (switched && plugins.current().bindings[component.binding]?.digest === digest) plugins.rollback("failed or interrupted candidate health check", { binding: component.binding });
				update(jobId, { status: switched ? "rolled-back" : "preview-ready", error: err.message }); throw err;
			} finally { activations.delete(jobId); }
		},
		cancel(jobId) { const entry = active.get(jobId), activation = activations.get(jobId); entry?.controller.abort(new Error("Change job cancelled.")); activation?.abort(new Error("Activation cancelled.")); const index = queued.indexOf(jobId); if (index >= 0) queued.splice(index, 1); if (!entry && !activation) update(jobId, { status: "cancelled" }); return { ok: true }; },
		recover() { for (const job of api.list()) if (["requested", "waiting", "preparing", "patching", "validating"].includes(job.status)) update(job.id, { status: "interrupted", waitingReason: undefined, error: "Builder interrupted. Resume this exact source/session explicitly." }); },
		resume(jobId) { if (closed || stop.blocked("builder-request")) throw new Error("Self-improvement is stopped for this session."); const job = load(jobId); if (!["interrupted", "failed", "cancelled"].includes(job.status)) throw new Error("This job cannot be resumed."); if (queued.length >= 8) throw new Error("Change-job queue full."); update(jobId, { status: "requested" }); queued.push(jobId); pump(); return api.get(jobId); },
		async close() { closed = true; queued.length = 0; for (const entry of active.values()) entry.controller.abort(new Error("Builder stopped.")); for (const controller of activations.values()) controller.abort(new Error("Builder stopped.")); while (active.size || activations.size) await new Promise(resolve => setTimeout(resolve, 20)); unsubscribe(); },
	};
	const unsubscribe = stop.subscribe(event => {
		if (event.type === "emergency" || (event.type === "session" && event.reason)) {
			for (const entry of active.values()) entry.controller.abort(new Error("The app session is blocked."));
			for (const controller of activations.values()) controller.abort(new Error("The app session is blocked."));
		} else if (event.type === "clear" || (event.type === "session" && !event.reason)) pump();
	});
	return api;
}
