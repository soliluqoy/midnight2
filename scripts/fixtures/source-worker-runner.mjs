import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const root = fs.realpathSync(process.env.MIDNIGHT_SOURCE_QUAL_ROOT), origin = fs.realpathSync(process.env.MIDNIGHT_SOURCE_QUAL_ORIGIN), runtimeRoot = process.env.MIDNIGHT_SOURCE_QUAL_RUNTIME;
const load = name => import(pathToFileURL(path.join(runtimeRoot, name)).href), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceFile = path.join(origin, "src/scheduler/queue.mjs"), original = hash(fs.readFileSync(sourceFile)), coreDir = path.join(root, "core"); fs.mkdirSync(coreDir);
const [{ createHost }, { createModelRuntime }, { corePaths }, { createSourceWorkspaceWorker }] = await Promise.all([load("src/runtime/host.mjs"), load("src/runtime/adapter.mjs"), load("src/runtime/paths.mjs"), load("src/builder/source-workspace.mjs")]);
const core = corePaths(coreDir), modelRuntime = await createModelRuntime({ core }), checks = [], stages = []; let host, sourceWorker, beats = 0;
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`[source-worker] PASS ${name}`); };
const sourceValidate = async frozen => ({ ok: true, digest: frozen.digest, baseDigest: frozen.baseDigest, processesExited: true, counts: { tests: 0, passed: 0, failed: 0 }, scripted: true }); sourceValidate.preflight = async () => {};
try {
	host = await createHost({ dataDir: path.join(root, "profile"), core, modelRuntime, sourceRoot: origin, sourceValidate, settings: { provider: "owned", model: "owned", privacy: "offline", voice: false, local: { enabled: false } }, platform: { call: async () => { throw new Error("Unexpected desktop or provider operation"); } }, sourceWorkerFactory: options => {
		const client = createSourceWorkspaceWorker(options); sourceWorker = client;
		return { ...client, async call(op, args) { const before = beats, started = performance.now(); console.log(`[source-worker] STAGE ${op}`); try { return await client.call(op, args); } finally { const stage = { op, elapsedMs: Math.round(performance.now() - started), heartbeats: beats - before }; stages.push(stage); console.log(`[source-worker] FINISH ${op} ${stage.elapsedMs}ms`); } } };
	}, builderRun: async job => {
		const maintenance = (op, args = {}) => host.builder.maintenance({ jobId: job.jobId, op, args });
		const file = await maintenance("read", { filename: "src/scheduler/queue.mjs" });
		await maintenance("patch", { filename: file.filename, expectedSha256: file.sha256, find: "Finish or dismiss a pending quick request before starting another.", replace: "Finish or dismiss a pending quick request, then capture the selection again." });
		await maintenance("diff"); await maintenance("validate"); return { usage: { modelCalls: 0 } };
	} }); await host.start();
	let previous = performance.now(); const gaps = [];
	const ticker = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now; beats++; }, 10);
	try {
		const started = performance.now(), job = host.builder.request({ scope: "official", pluginId: "midnight.core", text: "Owned source I/O and host responsiveness qualification" }), requestMs = performance.now() - started;
		check("source request returns its durable intent before capturing app source", job.base === undefined && job.status === "requested");
		const deadline = Date.now() + 300_000; let finished;
		for (;;) { finished = host.builder.get(job.id); if (finished.status === "source-proposed") break; if (["failed", "cancelled", "interrupted"].includes(finished.status)) throw new Error(finished.error); if (Date.now() > deadline) { host.builder.cancel(job.id); throw new Error("Owned source I/O qualification exceeded its deadline"); } await new Promise(resolve => setTimeout(resolve, 10)); }
		check("actual source capture runs in a worker while the utility host processes heartbeats", stages.some(stage => stage.op === "capture" && stage.heartbeats > 1));
		check("diff, frozen validation preparation and proposal export stay off the host event loop", ["diff", "prepare-validation", "propose"].every(op => stages.some(stage => stage.op === op && stage.heartbeats > 0)));
		check("whole preparation and proposal work share the builder's admission through actual worker exit", sourceWorker.status().exited && !host.queue.isRunning(`builder:${job.id}`));
		check("exact patch changes only its scoped candidate and preserves the original source file", finished.changed.length === 1 && finished.changed[0] === "src/scheduler/queue.mjs" && hash(fs.readFileSync(sourceFile)) === original);
		check("source proposal explicitly retains pending Windows build and app preview", finished.windowsBuild === "pending" && finished.appPreview === "pending");
		console.log(`[source-worker] RESULT ${JSON.stringify({ at: new Date().toISOString(), passed: true, packagedModules: runtimeRoot.endsWith("app.asar"), checks, requestMs: Math.round(requestMs), maxHostHeartbeatGapMs: Math.round(Math.max(...gaps)), stages, actualUtilityProcess: true, limitations: ["Public checkout captured by actual source workers in an Electron utility process; optional ASAR modules are loaded by the fixture, rather than enabling installed source repairs.", "Model and validator are scripted; this measures host I/O responsiveness and lifecycle, not real-cloud quality, unit conformance, Windows candidate builds, installed source delivery or statistical foreground/whole-day latency."] })}`);
	} finally { clearInterval(ticker); }
} catch (error) { console.log(`[source-worker] RESULT ${JSON.stringify({ at: new Date().toISOString(), passed: false, error: error.message, stages, packagedModules: runtimeRoot.endsWith("app.asar") })}`); console.log(`[source-worker] FAIL ${error.message}`); process.exitCode = 1; }
finally { await host?.close(); }
process.exit(process.exitCode ?? 0);
