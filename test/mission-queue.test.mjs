import assert from "node:assert/strict";
import test from "node:test";
import { createQueue, PRIORITY } from "../src/scheduler/queue.mjs";
import { makeModel, startHost, fakePlatform, fauxAssistantMessage, fauxText, until, settled } from "./e2e-helpers.mjs";
import { sha256 } from "../src/policy/canonical.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHost } from "../src/runtime/host.mjs";
import { tempDir } from "./helpers.mjs";

const target = (capturedAt = Date.now()) => ({ kind: "paragraph", handle: "PRIVATE_HANDLE", documentId: "PRIVATE_DOCUMENT", processId: 5, windowId: "52", text: "Revenue rose by 12%.", metadata: { supported: true }, structureHash: sha256("structure"), connector: { id: "word", api: 1, artifact: sha256("connector") }, capturedAt });
test("host restart retains an old source-build slot and delays new builders until physical recovery settles", async t => {
	const model = await makeModel(), platform = fakePlatform(); let releaseRecovery, workerCalls = 0, closing;
	const sourceValidate = async () => { throw new Error("No source validation expected"); };
	sourceValidate.pending = () => ["owned-container-journal"];
	sourceValidate.recover = () => new Promise(resolve => { releaseRecovery = resolve; });
	const host = await createHost({ dataDir: tempDir("source-recovery-host"), core: model.core, modelRuntime: model.rt, platform, sourceValidate, settings: { provider: "faux", model: "m1", profile: "quiet" }, builderRun: async () => { workerCalls++; return { error: "owned fixture completed" }; } });
	t.after(async () => { releaseRecovery?.(); await (closing ?? host.close()); }); await host.start(); await until(() => releaseRecovery);
	assert.equal(host.queue.isRunning("source-build-recovery"), true);
	const job = await host.handle("builder.request", { scope: "user", text: "Repair my chart after resource recovery" });
	host.signal({ type: "on-battery" }); await new Promise(resolve => setImmediate(resolve)); assert.equal(workerCalls, 0);
	assert.equal(host.queue.isRunning("source-build-recovery"), true, "policy cancellation cannot free cleanup ownership");
	await host.handle("builder.cancel", { jobId: job.id }); let closed = false; closing = host.close().then(() => { closed = true; });
	await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); assert.equal(workerCalls, 0);
	releaseRecovery(); await closing; assert.equal(host.queue.isRunning("source-build-recovery"), false); assert.equal(workerCalls, 0);
});
test("power and profile cancellation during source recovery does not poison subsequent admitted builders", async t => {
	const model = await makeModel(); let releaseRecovery, calls = 0;
	const sourceValidate = async () => {}; sourceValidate.pending = () => ["old-build"];
	sourceValidate.recover = () => new Promise(resolve => { releaseRecovery = resolve; });
	const host = await createHost({ dataDir: tempDir("source-recovery-ready"), core: model.core, modelRuntime: model.rt, platform: fakePlatform(), sourceValidate, settings: { provider: "faux", model: "m1", profile: "quiet" }, builderRun: async () => { calls++; return { error: "owned fixture completed" }; } });
	t.after(async () => { releaseRecovery?.(); await host.close(); }); await host.start(); await until(() => releaseRecovery);
	releaseRecovery(); await until(() => !host.queue.isRunning("source-build-recovery"));
	host.setSettings({ ...host.settings(), profile: "balanced" });
	const job = await host.handle("builder.request", { scope: "user", text: "Repair a chart after the old build exits" });
	await until(() => host.builder.get(job.id).status === "failed"); assert.equal(calls, 1); assert.match(host.builder.get(job.id).error, /owned fixture completed/);
});
test("scheduled background work yields a single slot but retains it until its backend cleanup settles", async () => {
	let release, taskSignal; const started = [];
	const queue = createQueue({ slots: { network: 1, inference: 1 }, start: item => started.push(item.missionId) });
	const background = queue.run({ missionId: "builder", priority: PRIORITY.speculative, preemptible: true }, async signal => { taskSignal = signal; await new Promise(resolve => { release = resolve; }); return "late result"; });
	const rejected = assert.rejects(background, { code: "QUEUE_PREEMPTED" }); await until(() => release);
	queue.enqueue({ missionId: "quick", priority: PRIORITY.interactive }); assert.equal(taskSignal.aborted, true);
	queue.done("builder"); await new Promise(resolve => setImmediate(resolve)); assert.equal(queue.isRunning("builder"), true); assert.deepEqual(started, []);
	release(); await rejected; await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(started, ["quick"]); queue.done("quick"); queue.close();
});
test("a free reserved slot serves quick work without cancelling a running builder", async () => {
	let release, taskSignal; const started = [];
	const queue = createQueue({ reserveInteractive: true, start: item => started.push(item.missionId) });
	const background = queue.run({ missionId: "builder", priority: PRIORITY.speculative, preemptible: true }, async signal => { taskSignal = signal; await new Promise(resolve => { release = resolve; }); });
	await until(() => release); queue.enqueue({ missionId: "quick", priority: PRIORITY.interactive }); await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(started, ["quick"]); assert.equal(taskSignal.aborted, false); release(); await background; queue.done("quick"); queue.close();
});
test("scheduled cancellation and expiry remove gated work without dispatch or idle deadline timers", async () => {
	let now = 0, callback; const reasons = [], queue = createQueue({ start() {}, now: () => now, setTimer: fn => { callback = fn; return 1; }, clearTimer() {} });
	queue.setGate(() => "Waiting for power"); let calls = 0;
	const controller = new AbortController(), cancelled = queue.run({ missionId: "cancel", priority: PRIORITY.speculative }, async () => calls++, { signal: controller.signal, onWaiting: value => reasons.push(value) });
	const cancellation = assert.rejects(cancelled, /cancelled/); controller.abort(new Error("cancelled")); await cancellation;
	assert.equal(queue.status().capacity.background.used, 0); assert.deepEqual(reasons, ["Waiting for power"]);
	const expired = queue.run({ missionId: "expire", priority: PRIORITY.speculative, deadline: 100 }, async () => calls++), rejection = assert.rejects(expired, { code: "QUEUE_EXPIRED" });
	now = 100; callback(); await rejection; assert.equal(calls, 0); assert.equal(queue.status().waiting.length, 0); queue.close();
});
test("policy revocation and queue shutdown retain active background cleanup ownership", async () => {
	let release, taskSignal;
	const queue = createQueue({ start() {} });
	const pending = queue.run({ missionId: "builder", priority: PRIORITY.speculative, preemptible: true }, async signal => { taskSignal = signal; await new Promise(resolve => { release = resolve; }); });
	const rejected = assert.rejects(pending, { code: "QUEUE_DEFERRED" }); await until(() => release);
	queue.setGate(() => "Waiting for power"); assert.equal(taskSignal.aborted, true); queue.close(); assert.equal(queue.isRunning("builder"), true);
	release(); await rejected; assert.equal(queue.isRunning("builder"), false);
});
test("actual host builder waits before forking for power, profile and connectivity and cancellation keeps cleanup ownership", async t => {
	const model = await makeModel(), platform = fakePlatform(), original = platform.call; let calls = 0, release, workerSignal;
	platform.call = (op, args, options) => op === "builder.run" ? (++calls, workerSignal = options.signal, new Promise(resolve => { release = resolve; })) : original(op, args, options);
	const { host } = await startHost({ model, platform }); t.after(async () => { release?.({ error: "fixture shutdown" }); await host.close(); });
	host.signal({ type: "on-battery" });
	const job = await host.handle("builder.request", { scope: "user", text: "Make my chart blue" });
	await until(() => host.builder.get(job.id).status === "waiting"); assert.match(host.builder.get(job.id).waitingReason, /power/); assert.equal(calls, 0);
	host.setSettings({ ...host.settings(), profile: "quiet" }); assert.match(host.builder.get(job.id).waitingReason, /Quiet/); assert.equal(calls, 0);
	host.setSettings({ ...host.settings(), profile: "focused" }); host.signal({ type: "on-ac" }); assert.match(host.builder.get(job.id).waitingReason, /Focused/); assert.equal(calls, 0);
	host.signal({ type: "online", online: false }); host.setSettings({ ...host.settings(), profile: "balanced" }); assert.match(host.builder.get(job.id).waitingReason, /reconnect/); assert.equal(calls, 0);
	host.signal({ type: "online", online: true }); await until(() => release); assert.equal(calls, 1); assert.equal(host.builder.get(job.id).status, "patching");
	await host.handle("builder.cancel", { jobId: job.id }); assert.equal(workerSignal.aborted, true); assert.equal(host.queue.isRunning(`builder:${job.id}`), true);
	release({ error: "fixture completed after cleanup" }); await until(() => host.builder.get(job.id).status === "cancelled"); assert.equal(host.queue.isRunning(`builder:${job.id}`), false);
});
test("actual host quick request preempts a builder at one slot and retains its partial candidate for explicit resume", async t => {
	const model = await makeModel(), platform = fakePlatform(), original = platform.call; let release, workerSignal, calls = 0, providerCalls = 0;
	platform.call = (op, args, options) => op === "builder.run" ? (++calls, workerSignal = options.signal, new Promise(resolve => { release = resolve; })) : original(op, args, options);
	model.faux.setResponses([() => { providerCalls++; return fauxAssistantMessage([fauxText('{"kind":"paragraph.replace","text":"Revenue increased by 12%."}')]); }]);
	const { host, dataDir } = await startHost({ model, platform }); t.after(async () => { release?.({ error: "fixture shutdown" }); await host.close(); });
	const job = await host.handle("builder.request", { scope: "user", text: "Make my chart blue" }); await until(() => release);
	const candidate = path.join(dataDir, "changes", job.id, "candidate/renderer.js"), partial = fs.readFileSync(candidate, "utf8").replace("#8068e8", "#1177aa");
	await host.builder.maintenance({ jobId: job.id, op: "write", args: { filename: "renderer.js", text: partial } });
	host.queue.setSlots({ network: 1 });
	const quick = await host.handle("mission.targetAssist", { text: "Make this clearer", requestId: "builder-priority", target: target() });
	assert.equal(workerSignal.aborted, true); assert.equal(host.queue.isRunning(`builder:${job.id}`), true); assert.equal(providerCalls, 0);
	await assert.rejects(host.builder.maintenance({ jobId: job.id, op: "write", args: { filename: "renderer.js", text: "late source" } }), /no longer allowed/);
	release({ error: "fixture completed after cleanup" }); await settled(host, quick.missionId); await until(() => host.builder.get(job.id).status === "interrupted");
	assert.equal(host.repo.get(quick.missionId).status, "succeeded"); assert.equal(providerCalls, 1); assert.equal(fs.readFileSync(candidate, "utf8"), partial); assert.equal(host.plugins.current().generation, 0);
	await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1, "interrupted code generation does not replay automatically");
	await host.handle("builder.resume", { jobId: job.id }); await until(() => calls === 2); assert.equal(fs.readFileSync(candidate, "utf8"), partial);
	await host.handle("builder.cancel", { jobId: job.id }); release({ error: "fixture resumed cleanup" }); await until(() => host.builder.get(job.id).status === "cancelled");
});
test("actual host refuses a builder's full shared background queue without forking or losing its durable candidate", async t => {
	const model = await makeModel(), platform = fakePlatform(), { host, dataDir } = await startHost({ model, platform }); t.after(() => host.close());
	host.queue.setGate(() => "fixture gate");
	for (let i = 0; i < 4; i++) host.coordinator.createMission({ text: `Background ${i}`, requestId: `background-cap-${i}`, priority: PRIORITY.routine });
	const job = await host.handle("builder.request", { scope: "user", text: "Make my chart blue" }); await until(() => host.builder.get(job.id).status === "interrupted");
	assert.match(host.builder.get(job.id).error, /Background work is full/); assert.equal(platform.calls.some(value => value.op === "builder.run"), false);
	assert.ok(fs.existsSync(path.join(dataDir, "changes", job.id, "candidate/renderer.js"))); assert.equal(host.queue.status().capacity.background.used, 4);
});
test("mission capacity includes reserved/running work and separates quick, user and background limits", () => {
	const queue = createQueue({ start() {}, limits: { interactive: 1, user: 1, background: 1 } });
	queue.setGate(() => "fixture gate"); const reservation = queue.reserve({ priority: PRIORITY.user });
	assert.throws(() => queue.reserve({ priority: PRIORITY.user }), { code: "QUEUE_FULL" });
	queue.enqueue({ missionId: "user", priority: PRIORITY.user }, reservation);
	assert.throws(() => queue.enqueue({ missionId: "another-user" }), { code: "QUEUE_FULL" });
	queue.enqueue({ missionId: "background", priority: PRIORITY.routine }); queue.enqueue({ missionId: "quick", priority: PRIORITY.interactive });
	assert.equal(queue.status().waiting.length, 3); assert.equal(queue.status().capacity.user.used, 1);
	queue.remove("user"); queue.enqueue({ missionId: "replacement-user" }); queue.setGate(() => undefined);
	assert.throws(() => queue.enqueue({ missionId: "third-user" }), { code: "QUEUE_FULL" }); queue.close();
});
test("aging stays below fresh explicit work and the reserved cloud slot admits quick work without aborting another task", async () => {
	let now = 0; const started = [], queue = createQueue({ start: item => started.push(item.missionId), reserveInteractive: true, now: () => now });
	queue.setGate(() => "fixture gate"); queue.enqueue({ missionId: "aged-background", priority: PRIORITY.routine });
	now = 20 * 60_000; queue.enqueue({ missionId: "user", priority: PRIORITY.user }); queue.enqueue({ missionId: "quick", priority: PRIORITY.interactive });
	queue.setGate(() => undefined); await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(started, ["quick", "user"]); assert.match(queue.why("aged-background"), /slot stays available/);
	queue.done("user"); await new Promise(resolve => setTimeout(resolve, 0)); assert.deepEqual(started, ["quick", "user", "aged-background"]); queue.close();
});
test("queued deadlines expire under closed resource gates and cancel their timer on shutdown", () => {
	let now = 0, callback, scheduled = 0, cleared = 0; const started = [], expired = [];
	const queue = createQueue({ start: item => started.push(item.missionId), now: () => now, onExpire: item => expired.push(item.missionId), setTimer: fn => { callback = fn; scheduled++; return scheduled; }, clearTimer: timer => { if (timer) cleared++; } });
	queue.setGate(() => "locked"); queue.enqueue({ missionId: "quick", priority: PRIORITY.interactive, deadline: 100 }); assert.equal(scheduled, 1);
	now = 100; callback(); assert.deepEqual(expired, ["quick"]); assert.equal(queue.isWaiting("quick"), false); assert.deepEqual(started, []);
	queue.enqueue({ missionId: "another", deadline: 200 }); queue.close(); assert.ok(cleared >= 2); assert.throws(() => queue.reserve(), /closed/);
});
test("host rejects excess work before persisting a mission and releases capacity after a queued cancellation", async t => {
	const model = await makeModel(), { host } = await startHost({ model }); t.after(() => host.close()); host.queue.setGate(() => "fixture gate");
	const ids = []; for (let i = 0; i < 16; i++) ids.push((await host.handle("mission.create", { requestId: `capacity-${i}`, text: `Task ${i}` })).missionId);
	await assert.rejects(host.handle("mission.create", { requestId: "over-capacity", text: "This must not become an orphaned mission" }), { code: "QUEUE_FULL" });
	assert.equal(host.repo.list().length, 16); assert.equal(host.queue.status().capacity.user.used, 16);
	const duplicate = await host.handle("mission.create", { requestId: "capacity-0", text: "Task 0" }); assert.equal(duplicate.missionId, ids[0]); assert.equal(duplicate.duplicate, true);
	await host.handle("mission.cancel", { missionId: ids[0] }); await host.handle("mission.create", { requestId: "replacement", text: "Replacement task" }); assert.equal(host.queue.status().capacity.user.used, 16);
});
test("actual host/Pi quick generation completes while a background provider stream stays active", async t => {
	const model = await makeModel(); let finishBackground, quickPacket;
	model.faux.setResponses([
		(_context, options) => new Promise(resolve => { finishBackground = () => resolve(fauxAssistantMessage([fauxText("Background update ready.")])); options.signal?.addEventListener("abort", finishBackground, { once: true }); }),
		context => { quickPacket = JSON.stringify(context); return fauxAssistantMessage([fauxText('{"kind":"paragraph.replace","text":"Revenue increased by 12%."}')]); },
		() => fauxAssistantMessage([fauxText("Ordinary task ready.")]),
	]);
	const { host } = await startHost({ model }); t.after(async () => { finishBackground?.(); await host.close(); });
	const background = host.coordinator.createMission({ text: "UNRELATED_BACKGROUND_INPUT", requestId: "background-held", trigger: { kind: "watch" }, priority: PRIORITY.routine }); await until(() => finishBackground);
	const ordinary = await host.handle("mission.create", { text: "Ordinary work", requestId: "ordinary-held" });
	const quick = await host.handle("mission.targetAssist", { text: "Make this clearer", requestId: "quick-priority", target: target() }); await settled(host, quick.missionId);
	assert.equal(host.repo.get(quick.missionId).status, "succeeded"); assert.equal(host.runtime.isRunning(background.missionId), true); assert.equal(host.queue.isWaiting(ordinary.missionId), true);
	assert.equal(host.ledger.forMission(quick.missionId).length, 0); assert.doesNotMatch(quickPacket, /UNRELATED_BACKGROUND_INPUT|PRIVATE_DOCUMENT|PRIVATE_HANDLE/);
	finishBackground(); await settled(host, ordinary.missionId);
});
test("actual host queue expiry cancels an old capture without dispatching a provider request", async t => {
	const model = await makeModel(); let providerCalls = 0;
	model.faux.setResponses([() => { providerCalls++; return fauxAssistantMessage([fauxText("Must not run")]); }]);
	const { host } = await startHost({ model }); t.after(() => host.close()); host.queue.setGate(() => "fixture gate");
	const quick = await host.handle("mission.targetAssist", { text: "Make this clearer", requestId: "expiring-quick", target: target(Date.now() - 59_600) });
	await until(() => host.repo.get(quick.missionId).status === "cancelled", 2000);
	assert.match(host.repo.get(quick.missionId).outcome.summary, /expired/); assert.equal(providerCalls, 0); assert.equal(host.targets.size(), 0); assert.equal(host.queue.isWaiting(quick.missionId), false);
	host.queue.setGate(() => undefined); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(providerCalls, 0);
});
test("recovery pauses queue overflow durably and retains every pending input", async t => {
	const model = await makeModel();
	const { host } = await startHost({ model, before: h => {
		h.signal({ type: "lock-screen" });
		for (let i = 0; i < 20; i++) h.repo.create({ title: `Recovered ${i}`, goal: `Goal ${i}`, scope: { pending: { input: `Preserved input ${i}`, requestId: `recovered-${i}` } } });
	} }); t.after(() => host.close());
	assert.equal(host.queue.status().capacity.user.used, 16); assert.equal(host.repo.withStatus("paused").length, 4);
	assert.equal(host.repo.list().filter(mission => mission.scope.pending.input.startsWith("Preserved input")).length, 20);
	assert.equal(host.runtime.running().length, 0);
});
