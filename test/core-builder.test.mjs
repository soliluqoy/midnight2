import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { createBuilderService } from "../src/builder/service.mjs";
import { createPluginStore } from "../src/plugins/store.mjs";
import { createPluginRuntime } from "../src/plugins/runtime.mjs";
import { createInferenceArbiter } from "../src/inference/arbiter.mjs";
import { createStopControl } from "../src/policy/stop.mjs";
import { runBuilderTurn } from "../src/builder/turn.mjs";
import { makeModel, fauxAssistantMessage, fauxToolCall, fauxText, until } from "./e2e-helpers.mjs";
import { tempDir } from "./helpers.mjs";
import { createCoreWorkspace, coreSourceDiff } from "../src/builder/core-workspace.mjs";
import { createHost } from "../src/runtime/host.mjs";
import { fakePlatform } from "./e2e-helpers.mjs";
import { createSourceWorkspaceWorker } from "../src/builder/source-workspace.mjs";
import { settled } from "./e2e-helpers.mjs";
import { sha256 } from "../src/policy/canonical.mjs";

function sourceFixture(root) {
	const source = path.join(root, "public-source");
	for (const directory of ["src", "scripts", "test", "vendor"]) fs.mkdirSync(path.join(source, directory), { recursive: true });
	for (const [name, content] of [["package.json", '{"version":"1.0.0","type":"module"}\n'], ["package-lock.json", "{}\n"], ["vendor/PROVENANCE.json", "{}\n"], ["src/main.mjs", "export const ready = false;\n"], ["src/old.mjs", "export const obsolete = true;"], ["test/fixed.test.mjs", "host-owned validation"], ["scripts/build.mjs", "host-owned build"]]) fs.writeFileSync(path.join(source, name), content);
	fs.writeFileSync(path.join(source, "auth.json"), "PRIVATE_UNRELATED_CREDENTIAL"); return source;
}
function serviceFixture(root, extra = {}) {
	const plugins = createPluginStore({ root: path.join(root, "plugins") }), stop = createStopControl(), arbiter = createInferenceArbiter();
	const options = { root: path.join(root, "changes"), sessions: path.join(root, "sessions"), plugins, pluginRuntime: createPluginRuntime({ store: plugins, execute: () => { throw new Error("Core proposals cannot execute private plugin code."); } }), stop, arbiter, sourceRoot: sourceFixture(root), settings: () => ({ provider: "faux", model: "m1", privacy: "cloud" }), ...extra };
	return { options, plugins, stop, arbiter };
}
const valid = frozen => ({ ok: true, digest: frozen.digest, baseDigest: frozen.baseDigest, processesExited: true, counts: { tests: 1, passed: 1, failed: 0, skipped: 0 } });
test("a narrow source patch exports a small context diff that Git applies without rewriting unrelated lines", () => {
	const root = tempDir("core-narrow-diff"), source = sourceFixture(root), text = Array.from({ length: 500 }, (_, i) => `// source line ${i}`).join("\n") + "\n";
	fs.writeFileSync(path.join(source, "src/main.mjs"), text);
	const capsule = createCoreWorkspace({ source, directory: path.join(root, "job") });
	capsule.patch("src/main.mjs", { expectedSha256: createHash("sha256").update(text).digest("hex"), find: "// source line 250", replace: "// source line 250 repaired" });
	const diff = coreSourceDiff(capsule); assert.ok(diff.length < 700); assert.equal(diff.includes("source line 0\n"), false);
	const file = path.join(root, "source.patch"); fs.writeFileSync(file, diff);
	const applied = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", file], { cwd: source, encoding: "utf8", windowsHide: true });
	assert.equal(applied.status, 0, applied.stderr); assert.equal(fs.readFileSync(path.join(source, "src/main.mjs"), "utf8"), text.replace("// source line 250", "// source line 250 repaired"));
});
test("host checks source-validation readiness after admission and before any cloud builder forks", async t => {
	const root = tempDir("source-preflight-host"), source = sourceFixture(root), model = await makeModel(); let preflights = 0, forks = 0;
	const sourceValidate = async () => { throw new Error("An unprepared source cannot validate"); };
	sourceValidate.preflight = async () => { preflights++; throw new Error("App repair validation needs setup"); };
	const host = await createHost({ dataDir: path.join(root, "profile"), core: model.core, modelRuntime: model.rt, platform: fakePlatform(), sourceRoot: source, sourceValidate, builderRun: async () => { forks++; return { error: "owned plugin fixture completed" }; }, settings: { provider: "faux", model: "m1", profile: "quiet" } });
	t.after(() => host.close()); await host.start();
	const job = await host.handle("builder.request", { scope: "official", pluginId: "midnight.core", text: "Repair this app" });
	await until(() => host.builder.get(job.id).status === "waiting"); assert.equal(preflights, 0); assert.equal(forks, 0);
	assert.equal(fs.existsSync(path.join(root, "profile/changes", job.id, "source")), false, "a gated intent does not capture source before admission");
	host.setSettings({ ...host.settings(), profile: "balanced" }); await until(() => host.builder.get(job.id).status === "failed");
	assert.equal(preflights, 1); assert.equal(forks, 0); assert.match(host.builder.get(job.id).error, /validation needs setup/);
	assert.equal(fs.existsSync(path.join(root, "profile/changes", job.id, "source")), false, "failed readiness cannot create a source worker or snapshot");
	const plugin = await host.handle("builder.request", { scope: "user", text: "Repair my chart" }); await until(() => host.builder.get(plugin.id).status === "failed");
	assert.equal(forks, 1); assert.equal(preflights, 1, "ordinary plugins do not acquire a source-build prerequisite");
});
for (const slots of [1, 2]) test(`actual source capture worker ${slots === 1 ? "exits before single-slot quick work" : "stays owned while reserved quick work completes"}`, async t => {
	const root = tempDir(`source-capture-slots-${slots}`), source = sourceFixture(root), model = await makeModel();
	const wait = new SharedArrayBuffer(4); let actual, sourceClient, entered = false, exited = false, providerSawExit, forks = 0;
	const sourceValidate = async () => { throw new Error("Capture is deliberately waiting"); }; sourceValidate.preflight = async () => {};
	const host = await createHost({ dataDir: path.join(root, "profile"), core: model.core, modelRuntime: model.rt, platform: fakePlatform(), sourceRoot: source, sourceValidate, settings: { provider: "faux", model: "m1" }, builderRun: async () => { forks++; throw new Error("A waiting capture cannot fork a model"); }, sourceWorkerFactory: options => sourceClient = createSourceWorkspaceWorker({ ...options, workerFactory: workerOptions => {
		actual = new Worker(new URL("./source-worker-fixture.mjs", import.meta.url), { ...workerOptions, workerData: { ...workerOptions.workerData, wait } });
		actual.on("message", message => { if (message.kind === "entered") entered = true; }); actual.once("exit", () => { exited = true; }); return actual;
	} }) });
	t.after(async () => { Atomics.store(new Int32Array(wait), 0, 1); Atomics.notify(new Int32Array(wait), 0); await host.close(); }); await host.start(); host.queue.setSlots({ network: slots });
	model.faux.setResponses([() => { providerSawExit = exited; return fauxAssistantMessage([fauxText('{"kind":"paragraph.replace","text":"Revenue increased by 12%."}')]); }]);
	const job = await host.handle("builder.request", { scope: "official", pluginId: "midnight.core", text: "Prepare an app repair" });
	assert.equal(job.base, undefined); await until(() => entered); assert.equal(host.builder.get(job.id).status, "preparing"); assert.equal(forks, 0);
	const target = { kind: "paragraph", handle: "OWNED_HANDLE", documentId: "OWNED_DOCUMENT", processId: 5, windowId: "52", text: "Revenue rose by 12%.", metadata: { supported: true }, structureHash: sha256("structure"), connector: { id: "word", api: 1, artifact: sha256("connector") }, capturedAt: Date.now() };
	const quick = await host.handle("mission.targetAssist", { text: "Make this clearer", requestId: `capture-slot-${slots}`, target }); await settled(host, quick.missionId);
	assert.equal(host.repo.get(quick.missionId).status, "succeeded"); assert.equal(providerSawExit, slots === 1); assert.equal(forks, 0);
	if (slots === 1) { await until(() => host.builder.get(job.id).status === "interrupted"); assert.equal(sourceClient.status().exited, true); assert.equal(actual.threadId, -1); }
	else { assert.equal(host.queue.isRunning(`builder:${job.id}`), true); assert.equal(sourceClient.status().exited, false); await host.handle("builder.cancel", { jobId: job.id }); await until(() => host.builder.get(job.id).status === "cancelled"); assert.equal(sourceClient.status().exited, true); }
	assert.equal(fs.existsSync(path.join(root, "profile/changes", job.id, "source")), false);
});

test("separate SDK source tools repair a candidate, validate once and export an applicable official patch", async t => {
	const root = tempDir("core-builder"), model = await makeModel(); let builder, checks = 0;
	model.faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("builder_tree", {}, { id: "tree" })]),
		() => fauxAssistantMessage([fauxToolCall("builder_read", { filename: "src/main.mjs" }, { id: "read" })]),
		() => fauxAssistantMessage([fauxToolCall("builder_patch", { filename: "src/main.mjs", expectedSha256: createHash("sha256").update("export const ready = false;\n").digest("hex"), find: "ready = false", replace: "ready = true" }, { id: "repair" })]),
		() => fauxAssistantMessage([fauxToolCall("builder_write", { filename: "src/new.mjs", text: "export const added = true;" }, { id: "new" })]),
		() => fauxAssistantMessage([fauxToolCall("builder_remove", { filename: "src/old.mjs" }, { id: "remove" })]),
		() => fauxAssistantMessage([fauxToolCall("builder_validate", {}, { id: "validate" })]),
		() => fauxAssistantMessage([fauxToolCall("builder_diff", {}, { id: "diff" })]),
		() => fauxAssistantMessage([fauxText("Source repaired. Windows build and preview remain pending.")]),
	]);
	const f = serviceFixture(root, { sourceValidate: async frozen => { checks++; assert.equal(fs.readFileSync(path.join(frozen.root, "src/main.mjs"), "utf8"), "export const ready = true;\n"); assert.equal(fs.readFileSync(path.join(frozen.root, "test/fixed.test.mjs"), "utf8"), "host-owned validation"); return valid(frozen); }, run: job => runBuilderTurn({ job, core: model.core, modelRuntime: model.rt, maintenance: (op, args) => builder.maintenance({ jobId: job.jobId, op, args }) }) });
	builder = createBuilderService(f.options); t.after(async () => { await builder.close(); f.arbiter.close(); });
	assert.throws(() => builder.request({ scope: "user", pluginId: "midnight.core", text: "Repair the app" }), /official proposal/);
	const initial = builder.request({ scope: "official", pluginId: "midnight.core", text: "Repair startup, add a small module and remove the obsolete module" });
	await until(() => { const job = builder.get(initial.id); if (job.status === "failed") throw new Error(job.error); return job.status === "source-proposed"; }, 12_000);
	const job = builder.get(initial.id); assert.equal(checks, 1, "unchanged final bytes reuse the host-owned validation");
	assert.equal(job.kind, "core"); assert.equal(job.windowsBuild, "pending"); assert.equal(job.appPreview, "pending"); assert.deepEqual(job.changed, ["src/main.mjs", "src/new.mjs", "src/old.mjs"]); assert.deepEqual(job.kernelChanges, ["src/main.mjs"]);
	assert.equal(fs.readFileSync(path.join(f.options.sourceRoot, "src/main.mjs"), "utf8"), "export const ready = false;\n"); assert.equal(f.plugins.current().generation, 0);
	const target = path.join(root, "apply-check"); fs.cpSync(f.options.sourceRoot, target, { recursive: true });
	const patch = path.join(job.officialPath, "source.patch"), applied = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", patch], { cwd: target, encoding: "utf8", windowsHide: true });
	assert.equal(applied.status, 0, applied.stderr); assert.equal(fs.readFileSync(path.join(target, "src/main.mjs"), "utf8"), "export const ready = true;\n"); assert.equal(fs.existsSync(path.join(target, "src/old.mjs")), false); assert.equal(fs.readFileSync(path.join(target, "src/new.mjs"), "utf8"), "export const added = true;");
	await assert.rejects(builder.activate({ jobId: job.id, digest: job.candidate.digest, expectedGeneration: job.baseGeneration }), /private candidate/);
	await builder.close(); builder = createBuilderService(f.options); assert.equal(builder.get(job.id).candidate.digest, job.candidate.digest); assert.equal(builder.get(job.id).status, "source-proposed");
});
test("source jobs reject unavailable bases, host-owned writes, no-op changes and a failed validator", async t => {
	const root = tempDir("core-confinement"); let builder;
	const f = serviceFixture(root, { run: async job => {
		await assert.rejects(builder.maintenance({ jobId: job.jobId, op: "write", args: { filename: "test/fixed.test.mjs", text: "fake pass" } }), /src text/);
		await assert.rejects(builder.maintenance({ jobId: job.jobId, op: "write", args: { filename: "src/file\n---evil.mjs", text: "fake" } }), /Invalid/);
		return {};
	}, sourceValidate: async frozen => ({ ...valid(frozen), ok: false }) });
	builder = createBuilderService(f.options); t.after(async () => { await builder.close(); f.arbiter.close(); });
	const unchanged = builder.request({ scope: "official", pluginId: "midnight.core", text: "Do not pretend an unchanged app was repaired" }); await until(() => builder.get(unchanged.id).status === "failed"); assert.match(builder.get(unchanged.id).error, /did not produce a change/);
	await builder.close();
	builder = createBuilderService({ ...f.options, run: async job => { await builder.maintenance({ jobId: job.jobId, op: "write", args: { filename: "src/main.mjs", text: "export const ready=true;" } }); return {}; } });
	const failed = builder.request({ scope: "official", pluginId: "midnight.core", text: "Invalid source must remain unproposed" }); await until(() => builder.get(failed.id).status === "failed"); assert.equal(builder.get(failed.id).officialPath, undefined);
	await builder.close(); builder = createBuilderService({ ...f.options, sourceRoot: undefined });
	assert.equal(builder.components().find(item => item.id === "midnight.core").available, false); assert.throws(() => builder.request({ scope: "official", pluginId: "midnight.core", text: "Unavailable" }), /not available/);
});
test("a changed source after validation cannot reuse an earlier source validation record", async t => {
	const root = tempDir("core-revalidation"); let builder, checks = 0;
	const f = serviceFixture(root, { sourceValidate: async frozen => { checks++; return valid(frozen); }, run: async job => {
		await builder.maintenance({ jobId: job.jobId, op: "write", args: { filename: "src/main.mjs", text: "export const ready=true;" } });
		await builder.maintenance({ jobId: job.jobId, op: "validate" });
		await builder.maintenance({ jobId: job.jobId, op: "write", args: { filename: "src/main.mjs", text: "export const ready=true; export const changedAgain=true;" } });
		return {};
	} });
	builder = createBuilderService(f.options); t.after(async () => { await builder.close(); f.arbiter.close(); });
	const job = builder.request({ scope: "official", pluginId: "midnight.core", text: "Validate exact final source" }); await until(() => builder.get(job.id).status === "source-proposed"); assert.equal(checks, 2);
});
test("cancellation retains an in-flight source validation until its backend cleanup settles", async t => {
	const root = tempDir("core-cancel"); let builder, release, backendSignal;
	const f = serviceFixture(root, { sourceValidate: async (frozen, { signal }) => { backendSignal = signal; await new Promise(resolve => { release = resolve; }); return valid(frozen); }, run: async job => {
		await builder.maintenance({ jobId: job.jobId, op: "write", args: { filename: "src/main.mjs", text: "export const ready=true;" } });
		await builder.maintenance({ jobId: job.jobId, op: "validate" }); return {};
	} });
	builder = createBuilderService(f.options); t.after(async () => { release?.(); await builder.close(); f.arbiter.close(); });
	const job = builder.request({ scope: "official", pluginId: "midnight.core", text: "A cancellable repair" }); await until(() => release);
	builder.cancel(job.id); assert.equal(backendSignal.aborted, true); let closed = false; const closing = builder.close().then(() => { closed = true; });
	await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
	release(); await closing; assert.equal(builder.get(job.id).status, "cancelled"); assert.equal(builder.get(job.id).officialPath, undefined);
});
