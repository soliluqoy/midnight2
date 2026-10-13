import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { createBuilderRunner } from "../src/desktop/builder-runner.mjs";
import { createPlatformBridge } from "../src/runtime/platform-bridge.mjs";
import { createQueue, PRIORITY } from "../src/scheduler/queue.mjs";
import { createResources } from "../src/resources/profiles.mjs";
const root = fs.realpathSync(process.env.MIDNIGHT_SCHEDULING_ROOT);
assert.match(path.basename(root), /^midnight-builder-scheduling-[^/\\]+$/); app.setPath("userData", root);
app.on("window-all-closed", () => {});
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
const wait = async predicate => { const deadline = Date.now() + 10_000; while (!predicate()) { if (Date.now() >= deadline) throw new Error("Owned scheduling fixture did not settle."); await new Promise(resolve => setTimeout(resolve, 10)); } };
app.whenReady().then(async () => {
	const checks = [], controllers = new Map(), workers = new Map();
	const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); };
	const runner = createBuilderRunner({ entry: fileURLToPath(new URL("../test/builder-worker-fixture.mjs", import.meta.url)), maintenance: ({ jobId, args }) => new Promise(resolve => { workers.set(jobId, { pid: args.pid, release: resolve }); }) });
	const bridge = createPlatformBridge({ send(message) {
		if (message.kind === "platform-cancel") { controllers.get(message.id)?.abort(new Error("Owned worker cancellation")); return; }
		const controller = new AbortController(); controllers.set(message.id, controller);
		void runner.run(message.args, { signal: controller.signal }).then(result => bridge.respond({ id: message.id, ok: true, result }), error => bridge.respond({ id: message.id, ok: false, error: error.message })).finally(() => controllers.delete(message.id));
	} });
	const run = (queue, id, options) => queue.run({ missionId: id, priority: PRIORITY.speculative, preemptible: true }, signal => bridge.call("builder.run", { jobId: id, fixture: "wait-for-rpc" }, { signal }), options);
	let queue, resources;
	try {
		let quickStarted = false, workerWasGone = false;
		queue = createQueue({ slots: { network: 1, inference: 1 }, start: item => { quickStarted = true; workerWasGone = !alive(workers.get("single").pid) && !runner.isBusy(); queue.done(item.missionId); } });
		const background = run(queue, "single"), rejected = assert.rejects(background, { code: "QUEUE_PREEMPTED" }); await wait(() => workers.has("single"));
		const first = workers.get("single"); check("actual builder utility process is alive before preemption", alive(first.pid) && runner.isBusy());
		const started = Date.now(); queue.enqueue({ missionId: "quick", priority: PRIORITY.interactive });
		await new Promise(resolve => setTimeout(resolve, 50));
		check("cancel request retains the shared slot and platform request while the actual child remains alive", alive(first.pid) && queue.isRunning("single") && bridge.pendingCount() === 1 && !quickStarted);
		await rejected; await wait(() => quickStarted); const preemptionMs = Date.now() - started;
		check("quick dispatch observes actual owned child exit before using the single slot", workerWasGone && !alive(first.pid) && bridge.pendingCount() === 0);
		first.release({ late: true }); await new Promise(resolve => setTimeout(resolve, 30)); check("late maintenance reply cannot revive the exited worker", !runner.isBusy()); queue.close();
		quickStarted = false;
		queue = createQueue({ reserveInteractive: true, start: item => { quickStarted = true; queue.done(item.missionId); } });
		const parallel = run(queue, "reserved"); await wait(() => workers.has("reserved"));
		queue.enqueue({ missionId: "quick-reserved", priority: PRIORITY.interactive }); await wait(() => quickStarted);
		check("reserved capacity serves quick work while the actual builder remains alive", alive(workers.get("reserved").pid) && runner.isBusy() && queue.isRunning("reserved"));
		workers.get("reserved").release({ complete: true }); await parallel;
		check("normal builder completion releases capacity only after child exit", !alive(workers.get("reserved").pid) && !runner.isBusy() && queue.status().capacity.background.used === 0); queue.close();
		queue = createQueue({ start() {} }); resources = createResources({ queue, settings: () => ({ profile: "balanced" }) }); resources.signal({ type: "on-battery" });
		const cancelled = new AbortController(), waiting = run(queue, "battery", { signal: cancelled.signal }), cancellation = assert.rejects(waiting, /cancelled before fork/);
		await new Promise(resolve => setTimeout(resolve, 50)); check("battery gate defers builder before any utility-process or platform dispatch", !runner.isBusy() && bridge.pendingCount() === 0 && !workers.has("battery") && /power/.test(queue.why("battery")));
		cancelled.abort(new Error("cancelled before fork")); await cancellation;
		check("cancelling a gated build leaves no admitted or waiting capacity", queue.status().capacity.background.used === 0);
		if (process.env.MIDNIGHT_TEST_REPORT) { const file = path.resolve(process.env.MIDNIGHT_TEST_REPORT); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), passed: true, checks, preemptionMs, actualUtilityProcesses: true, limitations: ["Owned development-only waiting workers and synthetic scheduler requests; not physical microphone/Word, real-cloud latency, power-device qualification or full process-tree accounting.", "The shipping queue, platform cancellation bridge and builder runner execute; whole-mission preemption for ordinary missions remains separate work."] }, null, 2)); }
	} finally { resources?.close(); queue?.close(); runner.close(); }
	app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
