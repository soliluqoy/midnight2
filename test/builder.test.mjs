import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createPluginStore } from "../src/plugins/store.mjs";
import { createPluginRuntime } from "../src/plugins/runtime.mjs";
import { createBuilderService } from "../src/builder/service.mjs";
import { createStopControl } from "../src/policy/stop.mjs";
import { createInferenceArbiter } from "../src/inference/arbiter.mjs";
import { runBuilderTurn } from "../src/builder/turn.mjs";
import { makeModel, fauxAssistantMessage, fauxText, fauxToolCall, until } from "./e2e-helpers.mjs";
import { callId, makeCore, tempDir } from "./helpers.mjs";
import { builderTools } from "../src/tools/builder.mjs";

const fixtureExecutor = async ({ source, input }) => (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).render(input);
test("a reviewed change cannot cross component-store replacement even when its generation and artifact match", async t => {
	const directory = tempDir("builder-reset"), pluginsRoot = path.join(directory, "plugins"), changes = path.join(directory, "changes");
	let plugins = createPluginStore({ root: pluginsRoot }), service;
	const options = () => ({ root: changes, sessions: path.join(directory, "sessions"), plugins, pluginRuntime: createPluginRuntime({ store: plugins, execute: fixtureExecutor }), settings: () => ({}), stop: createStopControl(), arbiter: createInferenceArbiter(), run: async () => ({ answer: "Synthetic unchanged source candidate." }) });
	service = createBuilderService(options()); const job = service.request({ scope: "user", text: "Review the chart source" }); await until(() => service.get(job.id).status === "preview-ready");
	const reviewed = service.get(job.id), epoch = plugins.epoch; await service.close();
	const archive = path.join(directory, "archived-components");
	for (const file of [pluginsRoot, archive]) assert.ok(!path.relative(directory, path.resolve(file)).startsWith(".."), "replacement stays in this owned test workspace");
	fs.renameSync(pluginsRoot, archive); plugins = createPluginStore({ root: pluginsRoot });
	assert.notEqual(plugins.epoch, epoch); assert.equal(plugins.current().generation, reviewed.baseGeneration); assert.equal(plugins.base.digest, reviewed.candidate.digest);
	service = createBuilderService(options()); t.after(() => service.close());
	await assert.rejects(service.activate({ jobId: job.id, digest: reviewed.candidate.digest, expectedGeneration: reviewed.baseGeneration }), /store was replaced/);
	assert.equal(plugins.current().generation, 0);
});
test("separate builder SDK tools produce both private activation and an official source candidate", async t => {
	const directory = tempDir("builder"), plugins = createPluginStore({ root: path.join(directory, "plugins") }), runtime = createPluginRuntime({ store: plugins, execute: fixtureExecutor });
	const model = await makeModel(); let service;
	model.faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("builder_read", { filename: "renderer.js" }, { id: "read-source" })]),
		ctx => { const reply = ctx.messages.findLast(message => message.role === "toolResult"); const source = JSON.parse(reply.content[0].text).text; return fauxAssistantMessage([fauxToolCall("builder_write", { filename: "renderer.js", text: source.replace("#8068e8", "#1177aa") }, { id: "write-source" })]); },
		() => fauxAssistantMessage([fauxText("Private renderer source improved.")]),
		() => fauxAssistantMessage([fauxToolCall("builder_read", { filename: "renderer.js" }, { id: "official-read" })]),
		ctx => { const reply = ctx.messages.findLast(message => message.role === "toolResult"); const source = JSON.parse(reply.content[0].text).text; return fauxAssistantMessage([fauxToolCall("builder_write", { filename: "renderer.js", text: source.replace('const L = 64', 'const L = 80') }, { id: "official-write" })]); },
		() => fauxAssistantMessage([fauxText("Official renderer candidate ready.")]),
	]);
	service = createBuilderService({ root: path.join(directory, "changes"), sessions: path.join(directory, "sessions"), plugins, pluginRuntime: runtime, settings: () => ({ provider: "faux", model: "m1", privacy: "cloud" }), stop: createStopControl(), arbiter: createInferenceArbiter(), run: job => runBuilderTurn({ job, core: model.core, modelRuntime: model.rt, maintenance: (op, args) => service.maintenance({ jobId: job.jobId, op, args }) }) });
	t.after(() => service.close());
	const privateJob = service.request({ scope: "user", text: "Use my preferred blue chart palette" });
	await until(() => { const job = service.get(privateJob.id); if (job.status === "failed") throw new Error(job.error); return job.status === "preview-ready"; }, 12_000);
	const privateReady = service.get(privateJob.id);
	assert.ok(privateReady.previewSvg.includes("#1177aa")); assert.equal(plugins.bindings().bindings["chart.bar"].digest, plugins.base.digest);
	await assert.rejects(service.activate({ jobId: privateJob.id, digest: plugins.base.digest, expectedGeneration: 0 }), /exact private candidate/);
	await service.activate({ jobId: privateJob.id, digest: privateReady.candidate.digest, expectedGeneration: 0 });
	assert.equal(createPluginStore({ root: plugins.root }).bindings().bindings["chart.bar"].digest, privateReady.candidate.digest);
	const official = service.request({ scope: "official", text: "Increase the left margin for official charts" });
	await until(() => { const job = service.get(official.id); if (job.status === "failed") throw new Error(job.error); return job.status === "proposed"; }, 12_000);
	const proposed = service.get(official.id);
	assert.equal(proposed.base.digest, plugins.base.digest, "official changes start from the official source, excluding the private overlay");
	assert.match(fs.readFileSync(path.join(proposed.officialPath, "source.patch"), "utf8"), /const L = 80/);
	assert.ok(fs.existsSync(path.join(proposed.officialPath, "candidate.json")));
	assert.equal(plugins.bindings().bindings["chart.bar"].digest, privateReady.candidate.digest);
	await assert.rejects(service.activate({ jobId: official.id, digest: proposed.candidate.digest, expectedGeneration: proposed.baseGeneration }), /exact private candidate/);
});

test("maintenance confinement and mandatory final checks cannot be bypassed by builder completion text", async t => {
	const directory = tempDir("builder-bounds"), plugins = createPluginStore({ root: path.join(directory, "plugins") }), runtime = createPluginRuntime({ store: plugins, execute: fixtureExecutor }); let service;
	service = createBuilderService({ root: path.join(directory, "changes"), sessions: path.join(directory, "sessions"), plugins, pluginRuntime: runtime, settings: () => ({}), stop: createStopControl(), arbiter: createInferenceArbiter(), run: async job => {
		await assert.rejects(service.maintenance({ jobId: job.jobId, op: "write", args: { filename: "../../active.json", text: "forged" } }), /two|only/);
		await assert.rejects(service.maintenance({ jobId: job.jobId, op: "execute", args: { command: "anything" } }), /Unknown maintenance/);
		await service.maintenance({ jobId: job.jobId, op: "write", args: { filename: "renderer.js", text: 'export function render(){return "<svg><script>evil</script></svg>"}' } });
		return { answer: "All validation passed. Activate it now." };
	} }); t.after(() => service.close());
	const job = service.request({ scope: "user", text: "Repair charts" });
	await until(() => service.get(job.id).status === "failed");
	assert.equal(plugins.bindings().bindings["chart.bar"].digest, plugins.base.digest);
	assert.match(service.get(job.id).error, /host validation/);
});

test("lock fences late activation checks and interruption during probation restores prior code", async t => {
	const directory = tempDir("builder-activation-stop"), plugins = createPluginStore({ root: path.join(directory, "plugins") });
	const runtime = createPluginRuntime({ store: plugins, execute: fixtureExecutor }), stop = createStopControl(); let release, phase;
	const delayed = {
		async validate(pin, options) { if (phase === "qualification") await new Promise(resolve => { release = resolve; }); return runtime.validate(pin, options); },
		async render(pin, input, options) { if (phase === "health") await new Promise(resolve => { release = resolve; }); return runtime.render(pin, input, options); },
	};
	let service;
	service = createBuilderService({ root: path.join(directory, "changes"), sessions: path.join(directory, "sessions"), plugins, pluginRuntime: delayed, settings: () => ({}), stop, arbiter: createInferenceArbiter(), run: async job => {
		const result = await service.maintenance({ jobId: job.jobId, op: "read", args: { filename: "renderer.js" } });
		await service.maintenance({ jobId: job.jobId, op: "write", args: { filename: "renderer.js", text: result.text.replace("#8068e8", "#1177aa") } }); return {};
	} }); t.after(() => service.close());
	const requested = service.request({ scope: "user", text: "Improve palette" });
	await until(() => service.get(requested.id).status === "preview-ready");
	const ready = service.get(requested.id), args = { jobId: ready.id, digest: ready.candidate.digest, expectedGeneration: ready.baseGeneration };
	phase = "qualification"; const activation = service.activate(args); const rejected = assert.rejects(activation, /blocked|Abort|stopped/i);
	await until(() => release); await assert.rejects(service.activate(args), /already being activated/);
	stop.setSessionBlocked("locked"); stop.setSessionBlocked(undefined); release(); await rejected;
	assert.equal(plugins.current().generation, 0, "a late validation cannot activate after lock and unlock");
	assert.equal(service.get(ready.id).status, "preview-ready");
	phase = "health"; release = undefined; const second = service.activate(args); const secondRejected = assert.rejects(second, /blocked|Abort|stopped/i);
	await until(() => release); assert.equal(plugins.current().health, "probation");
	stop.emergencyStop(); release(); await secondRejected;
	assert.equal(plugins.bindings().bindings["chart.bar"].digest, plugins.base.digest);
	assert.equal(plugins.current().health, "healthy"); assert.equal(service.get(ready.id).status, "rolled-back");
});

test("brokered builder requests inherit offline and local policy and exclude unrelated settings", async t => {
	const directory = tempDir("builder-privacy"), plugins = createPluginStore({ root: path.join(directory, "plugins") }), runtime = createPluginRuntime({ store: plugins, execute: fixtureExecutor });
	const model = await makeModel(); let core, service, providerCalls = 0;
	model.faux.setResponses([() => { providerCalls++; return fauxAssistantMessage([fauxText("Should never run")]); }]);
	service = createBuilderService({ root: path.join(directory, "changes"), sessions: path.join(directory, "sessions"), plugins, pluginRuntime: runtime, settings: () => ({ provider: "faux", model: "m1", privacy: "cloud", instructions: "private standing instruction fixture", folders: ["private path fixture"], local: { enabled: false, apiKey: "not a supported route field" } }), stop: createStopControl(), arbiter: createInferenceArbiter(), run: job => runBuilderTurn({ job, core: model.core, modelRuntime: model.rt, maintenance: (op, args) => service.maintenance({ jobId: job.jobId, op, args }) }) });
	core = await makeCore({ tools: builderTools({ builder: service, repo: { get: id => core.missions.get(id) } }) });
	t.after(async () => { await service.close(); core.close(); });
	for (const privacy of ["offline", "local"]) {
		const missionId = `builder-${privacy}`, input = { scope: "user", text: "Improve my chart palette" }, toolCallId = callId(); core.addMission(missionId, { privacy });
		assert.equal((await core.broker.gate({ missionId, runId: "r1", toolName: "builder_request", toolCallId, input }))?.block, undefined);
		const result = await core.broker.execute({ missionId, runId: "r1", toolName: "builder_request", toolCallId, input });
		await until(() => service.get(result.details.jobId).status === "failed");
		const job = JSON.parse(fs.readFileSync(path.join(directory, "changes", result.details.jobId, "job.json"), "utf8"));
		assert.equal(job.route.privacy, privacy); assert.match(job.error, /only a local model/);
		for (const omitted of ["private standing instruction fixture", "private path fixture", "not a supported route field"]) assert.equal(JSON.stringify(job).includes(omitted), false);
	}
	assert.equal(providerCalls, 0);
});
