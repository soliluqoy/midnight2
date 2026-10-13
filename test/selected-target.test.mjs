import assert from "node:assert/strict";
import test from "node:test";
import { createTargetCapsules } from "../src/context/capsules.mjs";
import { paragraphPatch, parseTargetProposal } from "../src/context/proposals.mjs";
import { boundedStream } from "../src/inference/request-limits.mjs";
import { createWordBroker } from "../src/desktop/word-broker.mjs";
import { startHost, makeModel, fauxAssistantMessage, fauxText, settled, fakePlatform } from "./e2e-helpers.mjs";
import { sha256 } from "../src/policy/canonical.mjs";

const snapshot = overrides => ({ kind: "paragraph", documentId: "unsaved-instance", handle: "original-range", processId: 43, windowId: "6789", connector: { id: "word", api: 1, artifact: `sha256:${"a".repeat(64)}` }, text: "Quarterly revenue increased by 12%.", structureHash: `sha256:${"b".repeat(64)}`, metadata: { style: "Normal", supported: true }, ...overrides });

test("target capsules freeze app and connector identity, enforce scope, and expire on a clock", () => {
	let time = 1000;
	const capsules = createTargetCapsules({ now: () => time });
	const original = snapshot();
	const captured = capsules.capture(original);
	original.text = "a later user selection";
	assert.equal(capsules.get(captured.id).text, "Quarterly revenue increased by 12%.");
	const packet = capsules.context(captured.id);
	assert.doesNotMatch(packet, /unsaved-instance|original-range|6789|sha256/);
	assert.equal(capsules.assertCurrent(captured.id, snapshot()).id, captured.id);
	for (const changed of [{ text: "edited while the model worked" }, { kind: "chart" }, { documentId: "another-window" }, { handle: "repeated-paragraph" }, { connector: { id: "other", api: 1, artifact: `sha256:${"a".repeat(64)}` } }, { connector: { id: "word", api: 1, artifact: `sha256:${"c".repeat(64)}` } }]) assert.throws(() => capsules.assertCurrent(captured.id, snapshot(changed)), { code: "TARGET_CONFLICT" });
	assert.throws(() => capsules.capture(snapshot({ text: "x".repeat(6001) })), { code: "TARGET_TOO_LARGE" });
	assert.throws(() => capsules.capture(snapshot({ metadata: { wholeDocument: "unrelated content" } })), { code: "TARGET_INVALID" });
	time += 60_000;
	assert.throws(() => capsules.get(captured.id), { code: "TARGET_EXPIRED" });
	assert.equal(capsules.size(), 0);
});

test("selected-target mission sends no broad recall, tools, root paths, or standing instructions", async t => {
	const model = await makeModel();
	let packet;
	model.faux.setResponses([ctx => { packet = ctx; return fauxAssistantMessage([fauxText(JSON.stringify({ kind: "paragraph.replace", text: "Quarterly revenue grew by 12%." }))]); }]);
	const { host } = await startHost({ model, settings: { instructions: "STANDING_PRIVATE_INSTRUCTIONS", embedding: { enabled: true, assist: true } } });
	t.after(() => host.close());
	host.tools.memory.remember("Quarterly revenue SECRET_OTHER_PARAGRAPH");
	host.tools.context.prepare = async () => { throw new Error("Broad retrieval must not run."); };
	const target = host.targets.capture(snapshot());
	// Faux transport lets this test inspect the same bounded packet sent by the configured cloud route.
	const { missionId } = host.coordinator.createMission({ text: "Make this paragraph clearer", requestId: host.newRequestId(), context: "UNRELATED_FOREGROUND_CONTEXT", attachments: [{ kind: "text", name: "other.txt", text: "UNRELATED_ATTACHMENT_TEXT" }, { kind: "image", name: "other.png", mimeType: "image/png", data: "UNRELATED_IMAGE_DATA" }], scope: { contextProfile: "selectedTarget", targetId: target.id, targetKind: target.kind } });
	const result = await settled(host, missionId);
	assert.equal(result.status, "succeeded");
	assert.doesNotMatch(JSON.stringify(packet), /SECRET_OTHER_PARAGRAPH|STANDING_PRIVATE_INSTRUCTIONS|unsaved-instance|original-range|UNRELATED_FOREGROUND_CONTEXT|UNRELATED_ATTACHMENT_TEXT|UNRELATED_IMAGE_DATA/);
	assert.match(JSON.stringify(packet), /Quarterly revenue increased by 12%/);
	assert.deepEqual(packet.tools ?? [], []);
	assert.equal(host.store.all("SELECT type FROM events WHERE mission_id = ? AND type = 'context.prepared'", missionId).length, 0);
});

test("shell-only selected-target entry uses the configured cloud route and clears captures on lock", async t => {
	const model = await makeModel();
	let cloudCalls = 0;
	model.faux.setResponses([(ctx, options) => {
		cloudCalls++;
		assert.equal(options.maxTokens, 2048);
		assert.match(JSON.stringify(ctx), /Quarterly revenue increased by 12%/);
		assert.doesNotMatch(JSON.stringify(ctx), /unsaved-instance|original-range|STANDING_PRIVATE_INSTRUCTIONS/);
		assert.deepEqual(ctx.tools ?? [], []);
		return fauxAssistantMessage([fauxText(JSON.stringify({ kind: "paragraph.replace", text: "Quarterly revenue grew by 12%." }))]);
	}]);
	const { host } = await startHost({ model, settings: { privacy: "cloud", instructions: "STANDING_PRIVATE_INSTRUCTIONS" } });
	t.after(() => host.close());
	const { missionId } = await host.handle("mission.targetAssist", { text: "Improve the selected paragraph", requestId: host.newRequestId(), target: snapshot() });
	const result = await settled(host, missionId);
	assert.equal(result.status, "succeeded");
	assert.equal(result.privacy, "cloud");
	assert.equal(cloudCalls, 1);
	const proposal = await host.handle("mission.targetProposal", { missionId });
	assert.equal(proposal.kind, "paragraph.replace");
	assert.equal(proposal.directlySupported, true);
	assert.equal(proposal.patch.before, "increased");
	assert.equal(proposal.patch.after, "grew");
	await assert.rejects(host.handle("mission.followUp", { missionId, text: "Use the entire document instead", requestId: host.newRequestId() }), /Capture a new selected target/);
	await assert.rejects(host.handle("mission.steer", { missionId, text: "Add more history" }), /Capture a new selected target/);
	const gate = await host.broker.gate({ missionId, runId: "invalid", toolCallId: "fake", toolName: "arbitrary_model_tool", input: {} });
	assert.equal(gate.block, true);
	assert.match(gate.reason, /only propose/);
	host.signal({ type: "lock-screen" });
	assert.equal(host.targets.size(), 0);
	await assert.rejects(host.handle("mission.targetProposal", { missionId }), /locked/);
	await assert.rejects(host.handle("mission.targetAssist", { text: "Edit", requestId: host.newRequestId(), target: snapshot() }), /locked/);
});

test("paragraph proposals reject untyped commands and mark changed values and unsupported structure for review", () => {
	const target = createTargetCapsules().capture(snapshot());
	const parse = value => parseTargetProposal(target, JSON.stringify(value));
	for (const value of [null, [], { kind: "chart.setType", text: "pie" }, { kind: "paragraph.replace", text: "Clean text", authority: true }, { kind: "paragraph.replace", text: "" }, { kind: "paragraph.replace", text: "First\rSecond" }, { kind: "paragraph.replace", text: "First\u2029Second" }, { kind: "paragraph.replace", text: "bad\ud800" }, { kind: "paragraph.replace", text: "x".repeat(6001) }]) assert.throws(() => parse(value), { code: "TARGET_PROPOSAL_INVALID" });
	assert.throws(() => parseTargetProposal(target, "Just paste this replacement"), { code: "TARGET_PROPOSAL_INVALID" });
	const altered = parse({ kind: "paragraph.replace", text: "Quarterly revenue grew by 21%." });
	assert.equal(altered.directlySupported, false);
	assert.match(altered.reviewReasons.join(" "), /Numeric values/);
	const unsupported = parseTargetProposal({ ...target, metadata: { supported: false } }, JSON.stringify({ kind: "paragraph.replace", text: "Quarterly revenue grew by 12%." }));
	assert.equal(unsupported.directlySupported, false);
	const cited = { ...target, text: "Revenue grew by 12% [Smith, 2026]." };
	const removed = parseTargetProposal(cited, JSON.stringify({ kind: "paragraph.replace", text: "Revenue grew by 12% in 2026." }));
	assert.match(removed.reviewReasons.join(" "), /Citations or links/);
	assert.deepEqual(parse({ kind: "needsContext", question: "Which meaning should this sentence express?" }), { kind: "needsContext", targetId: target.id, question: "Which meaning should this sentence express?" });
});

test("selected-target rewrites preserve supplied citations without fetching unrelated web context", async t => {
	const model = await makeModel();
	const text = "Revenue increased by 12% [2026]. See https://example.test/report.";
	model.faux.setResponses([() => fauxAssistantMessage([fauxText(JSON.stringify({ kind: "paragraph.replace", text: text.replace("increased", "grew") }))])]);
	const { host, platform } = await startHost({ model });
	t.after(() => host.close());
	const { missionId } = await host.handle("mission.targetAssist", { text: "Make this clearer", requestId: host.newRequestId(), target: snapshot({ text }) });
	assert.equal((await settled(host, missionId)).status, "succeeded");
	assert.equal((await host.handle("mission.targetProposal", { missionId })).directlySupported, true);
	assert.equal(platform.calls.some(call => /search|fetch|read_pages/.test(call.op)), false);
});

test("malformed or truncated quick-edit replies never produce a successful proposal", async t => {
	for (const response of [fauxAssistantMessage([fauxText("Just paste this")]), fauxAssistantMessage([fauxText(JSON.stringify({ kind: "paragraph.replace", text: "Quarterly revenue grew by 12%." }))], { stopReason: "length" })]) {
		const model = await makeModel();
		model.faux.setResponses([response]);
		const { host } = await startHost({ model });
		t.after(() => host.close());
		const { missionId } = await host.handle("mission.targetAssist", { text: "Make this clearer", requestId: host.newRequestId(), target: snapshot() });
		assert.notEqual((await settled(host, missionId)).status, "succeeded");
		await assert.rejects(host.handle("mission.targetProposal", { missionId }), /complete quick-edit response/);
	}
});

test("paragraph patches stay within the captured range and never split a surrogate pair", () => {
	for (const [before, after] of [["A 😀 value", "A 😁 value"], ["😀 old", "😁 new"], ["prefix old suffix", "prefix new suffix"], ["same", "same"], ["old", "new"]]) {
		const patch = paragraphPatch(before, after);
		assert.equal(before.slice(0, patch.start) + patch.after + before.slice(patch.end), after);
		assert.equal(patch.before.isWellFormed(), true);
		assert.equal(patch.after.isWellFormed(), true);
	}
});

test("quick requests cap provider calls and tokens and stop before dispatch when cancelled", () => {
	const ac = new AbortController();
	const calls = [];
	const stream = boundedStream((model, context, options) => { calls.push(options); return "sent"; }, { signal: ac.signal });
	assert.equal(stream({}, {}, { maxTokens: 10000 }), "sent");
	assert.equal(calls[0].maxTokens, 2048);
	assert.throws(() => stream({}, {}), /provider-call budget/);
	const lower = boundedStream((model, context, options) => options.maxTokens);
	assert.equal(lower({}, {}, { maxTokens: 500 }), 500);
	ac.abort(new Error("locked"));
	assert.equal(calls[0].signal.aborted, true, "transport sees cancellation after dispatch");
	const cancelled = boundedStream(() => { throw new Error("must not dispatch"); }, { signal: ac.signal });
	assert.throws(() => cancelled({}, {}), /locked/);
	assert.equal(calls.length, 1);
});

for (const privacy of ["local", "offline"]) test(`selected-target ${privacy} policy never falls back to cloud`, async t => {
	const model = await makeModel();
	let cloudCalls = 0;
	model.faux.setResponses([() => { cloudCalls++; return fauxAssistantMessage([fauxText("Must not run")]); }]);
	const { host } = await startHost({ model, settings: { privacy } });
	t.after(() => host.close());
	const { missionId } = await host.handle("mission.targetAssist", { text: "Improve this paragraph", requestId: host.newRequestId(), target: snapshot() });
	const result = await settled(host, missionId);
	assert.equal(result.status, "failed");
	assert.equal(result.privacy, privacy);
	assert.equal(cloudCalls, 0);
});

test("native Word discovery runs on the owned helper without opening or editing Word", { skip: process.platform !== "win32" }, async () => {
	const broker = createWordBroker();
	try {
		const status = await broker.status();
		assert.equal(typeof status.installed, "boolean");
		assert.equal(status.api, 1);
		assert.equal(status.editText, true, "the helper has typed edit operations; this test only discovers registration");
		assert.equal(status.convertChart, ["microsoft-word", "wps"].includes(status.provider), "typed chart adapters are available; discovery alone does not qualify a target");
		if (status.provider === "wps") assert.deepEqual(status.chartQualification, { mode: "target-preflight", apiVersion: "12.0", build: "12.1.0.28485" }, "WPS capture/edit requires the separately qualified provider/build");
	} finally { broker.close(); }
});

test("cloud target proposal reaches durable native edit recovery and conditional undo through the real host", async t => {
	const model = await makeModel();
	let modelCalls = 0, nativeCalls = 0;
	model.faux.setResponses([() => { modelCalls++; return fauxAssistantMessage([fauxText(JSON.stringify({ kind: "paragraph.replace", text: "Quarterly revenue grew by 12%." }))]); }]);
	let current = snapshot({ preservationHash: sha256("uniform-format") });
	const platform = fakePlatform(); const fallback = platform.call.bind(platform); const receipts = new Map();
	platform.call = async (op, args) => {
		if (op === "word.inspect") return structuredClone(current);
		if (op === "word.receipt") return receipts.has(args.editId) ? { found: true, result: structuredClone(receipts.get(args.editId)) } : { found: false };
		if (op === "word.apply") {
			nativeCalls++;
			current = { ...current, text: args.text, structureHash: sha256(args.text) };
			const result = { editId: args.editId, state: "verified", snapshot: structuredClone(current) };
			receipts.set(args.editId, result);
			if (nativeCalls === 1) throw Object.assign(new Error("Response lost after native commit"), { uncertain: true, code: "EDIT_UNKNOWN" });
			return result;
		}
		return fallback(op, args);
	};
	const first = await startHost({ model, platform });
	const { missionId } = await first.host.handle("mission.targetAssist", { text: "Make this clearer", requestId: first.host.newRequestId(), target: current });
	await settled(first.host, missionId);
	const proposal = await first.host.handle("mission.targetProposal", { missionId });
	const intent = await first.host.handle("mission.targetPrepare", { missionId, proposalId: proposal.id });
	assert.equal((await first.host.handle("mission.targetApply", { intentId: intent.id, intentHash: intent.argsHash })).intent.state, "unknown");
	await first.host.close();
	const second = await startHost({ model, platform, dataDir: first.dataDir }); t.after(() => second.host.close());
	assert.equal(second.host.ledger.get(intent.id).state, "verified", "startup uses the exact native receipt protocol");
	assert.equal(nativeCalls, 1); assert.equal(modelCalls, 1);
	const undo = await second.host.handle("mission.targetUndo", { intentId: intent.id });
	assert.equal((await second.host.handle("mission.targetApply", { intentId: undo.id, intentHash: undo.argsHash })).intent.state, "verified");
	assert.equal(current.text, "Quarterly revenue increased by 12%.");
	assert.equal(second.host.ledger.get(intent.id).state, "compensated");
	assert.equal(second.host.ledger.latestReceipt(intent.id).state, "compensated");
	assert.equal(modelCalls, 1, "native recovery and undo never call a model");
});

test("native chart command has a verified mission without generation or agent replay after restart", async t => {
	const model = await makeModel(); let modelCalls = 0, nativeCalls = 0;
	model.faux.setResponses([() => { modelCalls++; return fauxAssistantMessage([fauxText("Must not run")]); }]);
	let current = snapshot({ kind: "chart", text: "", metadata: { chartType: 57, seriesCount: 1, categoryCount: 3, title: "Budget", editable: true }, preservationHash: sha256("same-chart-data-and-geometry") });
	const platform = fakePlatform(); const fallback = platform.call.bind(platform); const receipts = new Map();
	platform.call = async (op, args) => {
		if (op === "word.inspect") return structuredClone(current);
		if (op === "word.receipt") return receipts.has(args.editId) ? { found: true, result: structuredClone(receipts.get(args.editId)) } : { found: false };
		if (op === "word.apply") {
			nativeCalls++; current.metadata.chartType = args.chartType; current.structureHash = sha256(`chart-${args.chartType}`);
			const result = { editId: args.editId, state: "verified", snapshot: structuredClone(current) }; receipts.set(args.editId, result);
			throw Object.assign(new Error("Lost reply"), { code: "EDIT_UNKNOWN", uncertain: true });
		}
		return fallback(op, args);
	};
	const first = await startHost({ model, platform });
	const command = await first.host.handle("mission.targetCommand", { text: "Change this bar chart to pie", requestId: first.host.newRequestId(), target: current });
	assert.equal(first.host.runtime.isRunning(command.missionId), false);
	await first.host.handle("mission.targetApply", { intentId: command.intent.id, intentHash: command.intent.argsHash });
	assert.equal(first.host.repo.get(command.missionId).status, "needs-reconciliation");
	await first.host.close();
	const second = await startHost({ model, platform, dataDir: first.dataDir }); t.after(() => second.host.close());
	assert.equal(second.host.repo.get(command.missionId).status, "succeeded");
	assert.equal(nativeCalls, 1); assert.equal(modelCalls, 0);
	await assert.rejects(second.host.handle("mission.followUp", { missionId: command.missionId, text: "Use a model now", requestId: second.host.newRequestId() }), /fresh|new selected target/);
});

test("a pending native chart preview is cancelled on restart without calling an agent", async t => {
	const model = await makeModel(); let modelCalls = 0;
	model.faux.setResponses([() => { modelCalls++; return fauxAssistantMessage([fauxText("Must not run")]); }]);
	const current = snapshot({ kind: "chart", text: "", metadata: { chartType: 57, seriesCount: 1, categoryCount: 3, editable: true }, preservationHash: sha256("chart-properties") });
	const platform = fakePlatform(); const fallback = platform.call.bind(platform);
	platform.call = (op, args) => op === "word.inspect" ? Promise.resolve(current) : fallback(op, args);
	const first = await startHost({ model, platform });
	const command = await first.host.handle("mission.targetCommand", { text: "Change this bar chart to pie", requestId: first.host.newRequestId(), target: current });
	await first.host.close();
	const second = await startHost({ model, platform, dataDir: first.dataDir }); t.after(() => second.host.close());
	assert.equal(second.host.repo.get(command.missionId).status, "cancelled"); assert.equal(modelCalls, 0);
});
