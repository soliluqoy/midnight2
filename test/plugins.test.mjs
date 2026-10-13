import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createPluginStore } from "../src/plugins/store.mjs";
import { createPluginRuntime, CHART_FIXTURES } from "../src/plugins/runtime.mjs";
import { validateChartSvg } from "../src/plugins/chart-validation.mjs";
import { render } from "../src/plugins/builtin/chart/renderer.js";
import { callId, makeCore, tempDir } from "./helpers.mjs";
import { workTools } from "../src/tools/work.mjs";
import { createEvidence } from "../src/evidence/store.mjs";

const trustedFixtureExecutor = async ({ source, input }) => (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).render(input);
const candidate = store => { const base = store.get(store.base.digest); return store.install({ ...base.manifest, version: "1.0.1" }, base.source.replace("#8068e8", "#1177aa")); };
test("passive chart validation rejects active markup, changed data and deceptive bar geometry", () => {
	const input = CHART_FIXTURES[0], svg = render(input);
	assert.equal(validateChartSvg(svg, input).ok, true);
	for (const changed of [svg.replace("</svg>", "<script>alert(1)</script></svg>"), svg.replace('data-value="120"', 'data-value="999"'), svg.replace(/height="[0-9.]+" rx="3"/, 'height="1" rx="3"'), svg.replace('fill="#8068e8"', 'fill="url(file:///secret)"'), svg.replace("</svg>", '<image href="https://example.test/leak"/></svg>')]) assert.equal(validateChartSvg(changed, input).ok, false);
	const dense = { title: "Dense", categories: Array.from({ length: 40 }, (_, i) => `C${i}`), series: Array.from({ length: 5 }, (_, i) => ({ name: `S${i}`, values: Array.from({ length: 40 }, () => i + 1) })) };
	assert.equal(validateChartSvg(render(dense), dense).ok, true);
});
test("private activation persists, isolates profiles and keeps exact old artifacts available", async () => {
	const directory = tempDir("plugins"), store = createPluginStore({ root: path.join(directory, "one") }), other = createPluginStore({ root: path.join(directory, "two") });
	const runtime = createPluginRuntime({ store, execute: trustedFixtureExecutor }), pin = candidate(store);
	await runtime.validate(pin); const before = store.bindings(); store.activate(pin, before.generation); store.accept(pin.digest);
	assert.equal(createPluginStore({ root: store.root }).bindings().bindings["chart.bar"].digest, pin.digest);
	assert.equal(other.bindings().bindings["chart.bar"].digest, other.base.digest);
	assert.match((await runtime.render(pin, CHART_FIXTURES[0])).svg, /#1177aa/);
	assert.match((await runtime.render(before.bindings["chart.bar"], CHART_FIXTURES[0])).svg, /#8068e8/);
	assert.throws(() => store.activate(pin, before.generation), /generation changed/);
});
test("interrupted activation rolls back without resetting generation or core receipts", async () => {
	const directory = tempDir("plugin-crash"), receipts = path.join(directory, "core-receipts.json"); fs.writeFileSync(receipts, "retained outside-action receipt");
	const store = createPluginStore({ root: path.join(directory, "plugins"), fault: phase => { if (phase === "after-pointer") throw new Error("crash"); } });
	const runtime = createPluginRuntime({ store, execute: trustedFixtureExecutor }), pin = candidate(store); await runtime.validate(pin);
	assert.throws(() => store.activate(pin, 0), /crash/);
	const recovered = createPluginStore({ root: store.root });
	assert.equal(recovered.bindings().bindings["chart.bar"].digest, store.base.digest); assert.equal(recovered.current().generation, 2);
	assert.equal(fs.readFileSync(receipts, "utf8"), "retained outside-action receipt");
	fs.writeFileSync(path.join(store.root, "active.json"), "broken");
	assert.ok(createPluginStore({ root: store.root }).current().generation > 2);
});
test("changed pinned artifacts and incompatible contracts cannot execute or activate", async () => {
	const store = createPluginStore({ root: tempDir("plugin-pin") }), base = store.get(store.base.digest);
	assert.throws(() => store.install({ ...base.manifest, api: 2 }, base.source), /unsupported API/);
	assert.throws(() => store.install({ ...base.manifest, permissions: ["network"] }, base.source), /unsupported API/);
	const pin = candidate(store); fs.appendFileSync(path.join(store.root, "artifacts", pin.digest.slice(7), "renderer.js"), "\n// changed after validation");
	assert.throws(() => store.get(pin.digest), /missing or changed/);
	assert.throws(() => store.activate(pin, 0), /missing or changed/);
});
test("a candidate failing live output checks is quarantined and previous code remains available", async () => {
	const store = createPluginStore({ root: tempDir("plugin-health") }), base = store.get(store.base.digest);
	const source = base.source.replace("export function render(", "function baseRender(") + '\nexport function render(input){return input.title === "Fail live" ? "<svg>bad</svg>" : baseRender(input);}';
	const pin = store.install({ ...base.manifest, version: "1.0.2" }, source), runtime = createPluginRuntime({ store, execute: trustedFixtureExecutor });
	await runtime.validate(pin); store.activate(pin, 0);
	store.accept(pin.digest);
	await assert.rejects(runtime.render(pin, { ...CHART_FIXTURES[0], title: "Fail live" }), /host validation/);
	assert.equal(store.isQuarantined(pin.digest), true); assert.equal(store.bindings().bindings["chart.bar"].digest, store.base.digest);
});

test("restore skips a quarantined former version and safe mode bypasses healthy private code", async () => {
	const store = createPluginStore({ root: tempDir("plugin-restore-history") }), runtime = createPluginRuntime({ store, execute: trustedFixtureExecutor });
	const first = candidate(store), base = store.get(store.base.digest), second = store.install({ ...base.manifest, version: "1.0.2" }, base.source.replace("#8068e8", "#119944"));
	await runtime.validate(first); store.activate(first, 0); store.accept(first.digest);
	await runtime.validate(second); store.activate(second, 1); store.accept(second.digest);
	assert.equal(createPluginStore({ root: store.root, safeMode: true }).bindings().bindings["chart.bar"].digest, store.base.digest);
	store.quarantine(first, "old queued request exposed a defect");
	assert.equal(store.bindings().bindings["chart.bar"].digest, second.digest);
	store.rollback(); assert.equal(store.bindings().bindings["chart.bar"].digest, store.base.digest);
	assert.equal(store.current().generation, 3);
});

test("an interrupted prepared intent leaves the pointer unchanged and a forged contract pin cannot activate", async () => {
	const store = createPluginStore({ root: tempDir("plugin-intent"), fault: phase => { if (phase === "after-intent") throw new Error("prepared interruption"); } });
	const runtime = createPluginRuntime({ store, execute: trustedFixtureExecutor }), pin = candidate(store); await runtime.validate(pin);
	assert.throws(() => store.activate({ ...pin, api: 2 }, 0), /exact plugin contract/);
	assert.throws(() => store.activate(pin, 0), /prepared interruption/);
	const recovered = createPluginStore({ root: store.root }); assert.equal(recovered.current().generation, 0);
	assert.equal(recovered.bindings().bindings["chart.bar"].digest, store.base.digest);
});

test("stored chart work uses its mission's exact renderer after activation and refuses missing or replaced pins", async t => {
	const directory = tempDir("plugin-stored-work"), plugins = createPluginStore({ root: path.join(directory, "plugins") });
	const runtime = createPluginRuntime({ store: plugins, execute: trustedFixtureExecutor }); let core, evidence;
	const chart = workTools({ plugins, pluginRuntime: runtime, repo: { get: id => core.missions.get(id) }, evidence: { stage: (...args) => evidence.stage(...args) }, commit: fn => core.commit(fn) }).all.find(spec => spec.name === "chart_create");
	core = await makeCore({ tools: [chart] }); t.after(() => core.close());
	evidence = createEvidence(core.store, core.journal, core.emit, { workspaces: path.join(directory, "workspaces") });
	const oldBindings = plugins.bindings(); core.addMission("old", { scope: { pluginBindings: oldBindings } });
	const input = CHART_FIXTURES[0], firstCall = callId();
	assert.equal((await core.broker.gate({ missionId: "old", runId: "r1", toolCallId: firstCall, toolName: chart.name, input }))?.block, undefined);
	const firstIntent = core.ledger.forMission("old")[0]; assert.equal(firstIntent.toolVersion, plugins.base.digest);
	const pin = candidate(plugins); await runtime.validate(pin); plugins.activate(pin, 0); plugins.accept(pin.digest);
	const oldResult = await core.broker.dispatchStored(firstIntent.id), oldArtifact = evidence.artifact(oldResult.details.artifactId);
	assert.match(fs.readFileSync(oldArtifact.path, "utf8"), /#8068e8/); assert.equal(oldArtifact.toolVersion, plugins.base.digest);
	core.addMission("new", { scope: { pluginBindings: plugins.bindings() } }); const newCall = callId();
	await core.broker.gate({ missionId: "new", runId: "r1", toolCallId: newCall, toolName: chart.name, input });
	const newResult = await core.broker.execute({ missionId: "new", runId: "r1", toolCallId: newCall, toolName: chart.name, input });
	const newArtifact = evidence.artifact(newResult.details.artifactId); assert.match(fs.readFileSync(newArtifact.path, "utf8"), /#1177aa/); assert.equal(newArtifact.toolVersion, pin.digest);
	const secondInput = { ...input, title: "Stored work requiring old renderer" };
	await core.broker.gate({ missionId: "old", runId: "r1", toolCallId: callId(), toolName: chart.name, input: secondInput });
	const secondIntent = core.ledger.forMission("old").find(intent => intent.id !== firstIntent.id);
	core.missions.get("old").scope.pluginBindings = plugins.bindings();
	await assert.rejects(core.broker.dispatchStored(secondIntent.id), /exact implementation/);
	core.missions.get("old").scope.pluginBindings = oldBindings;
	fs.appendFileSync(path.join(plugins.root, "artifacts", plugins.base.digest.slice(7), "renderer.js"), "\n// changed");
	await assert.rejects(core.broker.dispatchStored(secondIntent.id), /missing or changed/);
	assert.equal(evidence.artifacts("old").length, 2, "neither refusal stages new artifacts");
});
