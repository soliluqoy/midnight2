import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { createBuilderRunner } from "../src/desktop/builder-runner.mjs";
import { createBuilderService } from "../src/builder/service.mjs";
import { createCoreSourceValidator } from "../src/builder/core-validation.mjs";
import { createPluginStore } from "../src/plugins/store.mjs";
import { createPluginRuntime } from "../src/plugins/runtime.mjs";
import { createStopControl } from "../src/policy/stop.mjs";
import { createInferenceArbiter } from "../src/inference/arbiter.mjs";
const root = fs.realpathSync(process.env.MIDNIGHT_CORE_CLOUD_ROOT); assert.match(path.basename(root), /^midnight-core-cloud-/); app.setPath("userData", path.join(root, "profile")); app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
	const workspace = fileURLToPath(new URL("..", import.meta.url)), checks = [], arbiter = createInferenceArbiter(), plugins = createPluginStore({ root: path.join(root, "plugins") }); let service;
	const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`[core-check] PASS ${name}`); };
	const runner = createBuilderRunner({ maintenance: args => service.maintenance(args) });
	service = createBuilderService({ root: path.join(root, "changes"), sessions: path.join(root, "sessions"), plugins, pluginRuntime: createPluginRuntime({ store: plugins, execute: () => { throw new Error("Core source cannot execute plugins."); } }), sourceRoot: workspace, sourceValidate: createCoreSourceValidator({ dependencies: path.join(workspace, "node_modules"), ownershipRoot: path.join(root, "source-builds") }), stop: createStopControl(), arbiter, settings: () => ({ provider: process.env.MIDNIGHT_CORE_CLOUD_PROVIDER, model: process.env.MIDNIGHT_CORE_CLOUD_MODEL, privacy: "cloud", thinking: "low" }), run: (job, options) => runner.run(job, options) });
	try {
		const started = Date.now(), job = service.request({ scope: "official", pluginId: "midnight.core", text: "Improve the quick-request queue-full error in src/scheduler/queue.mjs: tell the user to finish or dismiss a pending quick request, then capture the selection again. Use builder_patch with the file digest for this narrow change. Change only that message, preserve all queue limits, priorities, codes and behavior, inspect the diff, then validate the source once. Do not edit other files." }); console.log("[core-check] START real app-source builder");
		const deadline = Date.now() + 23 * 60_000;
		let finished, previous;
		for (;;) {
			finished = service.get(job.id); if (finished.status !== previous) { console.log(`[core-check] STATUS ${finished.status}`); previous = finished.status; }
			if (finished.status === "source-proposed") break;
			if (["failed", "cancelled", "interrupted"].includes(finished.status)) throw new Error(finished.error);
			if (Date.now() > deadline) { service.cancel(job.id); throw new Error("Core builder qualification exceeded its deadline."); }
			await new Promise(resolve => setTimeout(resolve, 500));
		}
		check("real separate builder changes exactly the requested app source file", finished.changed.length === 1 && finished.changed[0] === "src/scheduler/queue.mjs");
		check("actual isolated full-source validation passes with explicit platform skips", finished.validation.ok && finished.validation.counts.failed === 0 && finished.validation.counts.tests >= 316 && finished.validation.processesExited);
		const proposed = fs.readFileSync(path.join(finished.officialPath, "source/src/scheduler/queue.mjs"), "utf8"); check("quick queue error directs a fresh capture without changing capacity", /capture.*selection|selection.*again/i.test(proposed) && proposed.includes("interactive: 8, user: 16, background: 4"));
		const metadata = JSON.parse(fs.readFileSync(path.join(finished.officialPath, "candidate.json"), "utf8")); check("official patch and exact source candidate are reviewable with Windows steps still pending", metadata.candidate.digest === finished.candidate.digest && finished.sourceDiff.includes("src/scheduler/queue.mjs") && metadata.windowsBuild === "pending" && metadata.appPreview === "pending");
		check("private plugin activation and the immutable app base are untouched", plugins.current().generation === 0);
		const persisted = JSON.parse(fs.readFileSync(path.join(root, "changes", job.id, "job.json"), "utf8"));
		const messages = fs.readFileSync(persisted.sessionFile, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line).message).filter(Boolean), assistants = messages.filter(message => message.role === "assistant");
		check("provider messages use the exact configured cloud model", assistants.length > 0 && assistants.every(message => message.provider === process.env.MIDNIGHT_CORE_CLOUD_PROVIDER && message.model === process.env.MIDNIGHT_CORE_CLOUD_MODEL));
		const calls = assistants.flatMap(message => message.content ?? []).filter(item => item.type === "toolCall");
		check("source model uses only named maintenance tools", calls.every(item => ["builder_tree", "builder_read", "builder_patch", "builder_write", "builder_remove", "builder_validate", "builder_diff"].includes(item.name)));
		check("narrow source repair uses a digest-bound patch and flags kernel review", calls.some(item => item.name === "builder_patch") && finished.kernelChanges.includes("src/scheduler/queue.mjs"));
		console.log(`[core-check] RESULT ${JSON.stringify({ at: new Date().toISOString(), passed: true, provider: process.env.MIDNIGHT_CORE_CLOUD_PROVIDER, model: process.env.MIDNIGHT_CORE_CLOUD_MODEL, checks, elapsedMs: Date.now() - started, candidate: finished.candidate, changed: finished.changed, validation: finished.validation, modelCalls: persisted.usage?.modelCalls, limitations: ["One requested app-source wording improvement through the real separate SDK process and Docker validator; not broad repair quality, Windows build/preview, installed source capsules, signing, migration or publication.", "Disposable profile/source candidates and existing selected credentials only; no production customization or checkout source change."] })}`);
	} finally { await service.close(); runner.close(); arbiter.close(); }
	app.exit(0);
}).catch(error => { console.log(`[core-check] FAIL ${error.message}`); app.exit(1); });
