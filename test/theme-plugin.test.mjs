import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createPluginStore } from "../src/plugins/store.mjs";
import { createPluginRuntime, THEME_FIXTURES, CHART_FIXTURES } from "../src/plugins/runtime.mjs";
import { validateThemeOutput, colorContrast } from "../src/plugins/theme-validation.mjs";
import { render } from "../src/plugins/builtin/theme/renderer.js";
import { createBuilderService } from "../src/builder/service.mjs";
import { createStopControl } from "../src/policy/stop.mjs";
import { createInferenceArbiter } from "../src/inference/arbiter.mjs";
import { runBuilderTurn } from "../src/builder/turn.mjs";
import { makeModel, fauxAssistantMessage, fauxToolCall, fauxText, until, startHost } from "./e2e-helpers.mjs";
import { tempDir } from "./helpers.mjs";

const execute = async ({ source, input }) => (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).render(input);
const teal = source => source.replace("#7662b7", "#176b65").replace("#7c66c0", "#176b65").replace("#322d43", "#173530").replace("#c4b5f3", "#a0e8d0");
function themeCandidate(store) { const base = store.get(store.bases["ui.colors"].digest); return store.install({ ...base.manifest, version: "1.0.1" }, teal(base.source)); }
function chartCandidate(store) { const base = store.get(store.base.digest); return store.install({ ...base.manifest, version: "1.0.1" }, base.source.replace("#8068e8", "#1177aa")); }

test("declarative theme validation refuses CSS/network values, unknown tokens and unreadable controls", () => {
	const tokens = JSON.parse(render({})); assert.equal(validateThemeOutput(JSON.stringify(tokens)).ok, true);
	assert.equal(colorContrast("#ffffff", "#000000"), 21);
	for (const changed of [{ ...tokens, accent: "url(https://example.test)" }, { ...tokens, accent: "#000000;display:none" }, { ...tokens, accent: "#fff" }, { ...tokens, accent: "#ffffff" }, { ...tokens, highlight: "#202027" }, { ...tokens, html: "<script>" }, { ...tokens, "accent-soft": "#ffffff" }]) assert.equal(validateThemeOutput(JSON.stringify(changed)).ok, false);
});

test("theme presets remain exact and profile-local across restart without executing private code to paint", async () => {
	const root = tempDir("theme-profile"), store = createPluginStore({ root: path.join(root, "one") }), other = createPluginStore({ root: path.join(root, "two") }); let calls = 0;
	const runtime = createPluginRuntime({ store, execute: args => { calls++; return execute(args); } }), pin = themeCandidate(store);
	await runtime.validate(pin); store.activate(pin, 0); store.accept(pin.digest);
	const before = calls; assert.equal(runtime.themePreset(pin).tokens.accent, "#176b65"); assert.equal(calls, before);
	const restarted = createPluginStore({ root: store.root }); assert.equal(restarted.bindings().bindings["ui.colors"].digest, pin.digest);
	assert.equal(createPluginRuntime({ store: restarted, execute: () => { throw new Error("Live paint cannot execute generated code."); } }).themePreset(pin).tokens.accent, "#176b65");
	assert.equal(other.bindings().bindings["ui.colors"].digest, other.bases["ui.colors"].digest);
	assert.equal(createPluginStore({ root: store.root, safeMode: true }).bindings().bindings["ui.colors"].digest, store.bases["ui.colors"].digest);
	await assert.rejects(runtime.render(pin, CHART_FIXTURES[0]), /not a chart/);
});

test("one component's quarantine preserves another accepted customization and serializes probation", async () => {
	const store = createPluginStore({ root: tempDir("theme-recovery") }), runtime = createPluginRuntime({ store, execute });
	const theme = themeCandidate(store), chart = chartCandidate(store); await runtime.validate(theme); await runtime.validate(chart);
	store.activate(theme, 0); assert.throws(() => store.activate(chart, 1), /probation/); store.accept(theme.digest);
	store.activate(chart, 1); store.accept(chart.digest);
	store.quarantine(theme, "Theme failed after activation");
	assert.equal(store.bindings().bindings["ui.colors"].digest, store.bases["ui.colors"].digest);
	assert.equal(store.bindings().bindings["chart.bar"].digest, chart.digest);
	assert.match((await runtime.render(chart, CHART_FIXTURES[0])).svg, /#1177aa/);
});

test("older chart-only activation metadata gains the official theme without losing private code or receipts", async () => {
	const root = tempDir("theme-upgrade"), store = createPluginStore({ root }), runtime = createPluginRuntime({ store, execute }), chart = chartCandidate(store);
	await runtime.validate(chart); store.activate(chart, 0); store.accept(chart.digest);
	const state = store.current(); delete state.bindings["ui.colors"]; delete state.lastGood["ui.colors"]; for (const bindings of state.historyGood) delete bindings["ui.colors"];
	fs.writeFileSync(path.join(root, "active.json"), JSON.stringify(state)); const receipt = path.join(root, "retained-receipt.txt"); fs.writeFileSync(receipt, "outside action receipt");
	const upgraded = createPluginStore({ root });
	assert.equal(upgraded.current().generation, 2); assert.equal(upgraded.bindings().bindings["chart.bar"].digest, chart.digest);
	assert.equal(upgraded.bindings().bindings["ui.colors"].digest, upgraded.bases["ui.colors"].digest);
	assert.equal(fs.readFileSync(receipt, "utf8"), "outside action receipt");
	assert.equal(createPluginStore({ root }).current().generation, 2, "the catalog addition is idempotent");
});

test("a display-dependent color generator cannot masquerade as a frozen preset", async () => {
	const store = createPluginStore({ root: tempDir("theme-constant") }), base = store.get(store.bases["ui.colors"].digest), runtime = createPluginRuntime({ store, execute });
	const source = base.source.replace("export function render(", "function original(") + '\nexport function render(input){const tokens=JSON.parse(original(input));if(input.textSize===2)tokens.accent="#176b65";return JSON.stringify(tokens);}';
	const pin = store.install({ ...base.manifest, version: "1.0.2" }, source);
	await assert.rejects(runtime.validate(pin), /constant/);
	assert.throws(() => store.activate(pin, 0)); assert.equal(store.current().generation, 0);
});

test("the separate builder prepares both theme destinations using the exact registered source path", async t => {
	const root = tempDir("theme-builder"), plugins = createPluginStore({ root: path.join(root, "plugins") }), runtime = createPluginRuntime({ store: plugins, execute }), model = await makeModel(); let service;
	model.faux.setResponses(Array.from({ length: 2 }, () => [
		() => fauxAssistantMessage([fauxToolCall("builder_read", { filename: "renderer.js" }, { id: "read" })]),
		context => { const source = JSON.parse(context.messages.findLast(message => message.role === "toolResult").content[0].text).text; return fauxAssistantMessage([fauxToolCall("builder_write", { filename: "renderer.js", text: teal(source) }, { id: "write" })]); },
		() => fauxAssistantMessage([fauxText("Theme candidate prepared.")]),
	]).flat());
	service = createBuilderService({ root: path.join(root, "changes"), sessions: path.join(root, "sessions"), plugins, pluginRuntime: runtime, settings: () => ({ provider: "faux", model: "m1", privacy: "cloud" }), stop: createStopControl(), arbiter: createInferenceArbiter(), run: job => runBuilderTurn({ job, core: model.core, modelRuntime: model.rt, maintenance: (op, args) => service.maintenance({ jobId: job.jobId, op, args }) }) }); t.after(() => service.close());
	const wait = async id => { await until(() => { const job = service.get(id); if (job.status === "failed") throw new Error(job.error); return ["preview-ready", "proposed"].includes(job.status); }); return service.get(id); };
	const privateJob = await wait(service.request({ scope: "user", text: "Make my launcher accent teal", pluginId: "midnight.theme" }).id);
	assert.equal(privateJob.previewTokens.accent, "#176b65"); assert.equal(privateJob.previewSvg, undefined);
	await service.activate({ jobId: privateJob.id, digest: privateJob.candidate.digest, expectedGeneration: privateJob.baseGeneration });
	const official = await wait(service.request({ scope: "official", text: "Improve official launcher colors", pluginId: "midnight.theme" }).id);
	assert.equal(official.base.digest, plugins.bases["ui.colors"].digest);
	assert.equal(JSON.parse(fs.readFileSync(path.join(official.officialPath, "candidate.json"), "utf8")).target, "src/plugins/builtin/theme");
	assert.match(fs.readFileSync(path.join(official.officialPath, "source.patch"), "utf8"), /a\/src\/plugins\/builtin\/theme\/renderer.js/);
	assert.equal(plugins.bindings().bindings["ui.colors"].digest, privateJob.candidate.digest);
});

test("the UI's preset read exposes only validated colors and does not run a sandbox/model", async t => {
	const model = await makeModel(), { host, platform } = await startHost({ model }); t.after(() => host.close());
	const runtime = createPluginRuntime({ store: host.plugins, execute }), pin = themeCandidate(host.plugins); await runtime.validate(pin);
	host.plugins.activate(pin, 0); host.plugins.accept(pin.digest);
	const result = await host.handle("theme.current", {}); assert.equal(result.tokens.accent, "#176b65");
	assert.equal(platform.calls.some(call => call.op === "plugin.execute" || call.op === "builder.run"), false);
	assert.equal(Object.keys(result.tokens).length, 6);
	fs.writeFileSync(path.join(host.plugins.root, "qualification", `${pin.digest.slice(7)}.json`), JSON.stringify({ ...host.plugins.qualification(pin), tokens: { accent: "url(https://example.test)" } }));
	const restored = await host.handle("theme.current", {});
	assert.equal(restored.tokens.accent, "#7662b7"); assert.equal(restored.restored, true); assert.equal(host.plugins.isQuarantined(pin.digest), true);
});
