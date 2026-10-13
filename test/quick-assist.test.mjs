import assert from "node:assert/strict";
import test from "node:test";
import { createQuickAssist } from "../src/desktop/quick-assist.mjs";
import { sha256 } from "../src/policy/canonical.mjs";

const pending = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t, overrides = {}) {
	const events = [], calls = [], shown = [];
	let revoked = false, privacy = "cloud";
	const native = { kind: "paragraph", documentId: "PRIVATE_DOCUMENT_ID", handle: "PRIVATE_NATIVE_HANDLE", processId: 41, windowId: "52", text: "Revenue rose by 12%.", metadata: { supported: true, scope: "paragraph" }, structureHash: sha256("before"), connector: { id: "word", api: 1, artifact: sha256("connector") }, ...overrides };
	const word = { capture: async () => { events.push("capture"); return structuredClone(native); }, inspect: async () => structuredClone(native), release: async handle => events.push(`release:${handle}`) };
	const responses = {
		"mission.targetAssist": { missionId: "m1" }, "query.mission": { status: "running" },
		"mission.targetProposal": { id: "proposal_current", kind: "paragraph.replace", text: "Revenue increased by 12%.", directlySupported: true },
		"mission.targetPrepare": { id: "act_1", argsHash: sha256("exact-intent"), missionId: "m1" },
		"mission.targetApply": { intent: { id: "act_1", missionId: "m1", state: "verified" } },
		"mission.targetUndo": { id: "act_undo", missionId: "m1", argsHash: sha256("undo") },
		"mission.targetCommand": { missionId: "mchart", intent: { id: "act_chart", missionId: "mchart", argsHash: sha256("chart") } },
	};
	const timer = { fire: undefined };
	const quick = createQuickAssist({ word, setTimer: callback => { timer.fire = callback; return { unref() {} }; }, clearTimer: () => { timer.fire = undefined; }, request: async (method, params) => { calls.push({ method, params }); const response = responses[method]; return typeof response === "function" ? response(params) : structuredClone(response); },
		settings: () => ({ privacy }), blocked: () => revoked, publish: state => events.push(`phase:${state.phase}`), present: options => { shown.push(options); events.push(`present:${options.focus}`); }, hide: () => events.push("hide") });
	t.after(() => quick.close());
	return { quick, word, native, events, calls, shown, responses, timer, setBlocked: value => { revoked = value; }, setPrivacy: value => { privacy = value; } };
}
async function preview(f) {
	await f.quick.open();
	await f.quick.submit({ panelId: f.quick.state().panelId, text: "Make this paragraph clearer" });
	await f.quick.onEngine({ kind: "update", missionId: "m1", mission: { status: "succeeded" } });
}

test("quick capture completes before focus and surface state contains no native identity", async t => {
	const f = fixture(t); const capture = pending(); f.word.capture = () => capture.promise;
	const opening = f.quick.open(); assert.equal(f.shown.length, 0);
	capture.resolve(f.native); await opening;
	assert.equal(f.shown[0].focus, true);
	assert.doesNotMatch(JSON.stringify(f.quick.state()), /PRIVATE_DOCUMENT_ID|PRIVATE_NATIVE_HANDLE|connector|processId/);
	assert.equal(f.quick.state().scope, "Current paragraph");
});

test("late capture after lock or dismissal never shows a prompt or starts a model request", async t => {
	const f = fixture(t); const capture = pending(); f.word.capture = () => capture.promise;
	const opening = f.quick.open(); f.setBlocked(true); f.quick.invalidate(); f.setBlocked(false);
	capture.resolve(f.native); await opening;
	assert.equal(f.quick.state().phase, "closed"); assert.equal(f.shown.length, 0); assert.equal(f.calls.length, 0);
	assert.ok(f.events.includes("release:PRIVATE_NATIVE_HANDLE"));
});

test("changed targets and privacy routes block quick submission before inference", async t => {
	const f = fixture(t); await f.quick.open(); f.native.text = "Later user work"; f.native.structureHash = sha256("changed");
	await f.quick.submit({ panelId: f.quick.state().panelId, text: "Improve it" });
	assert.equal(f.quick.state().phase, "error"); assert.equal(f.calls.filter(call => call.method === "mission.targetAssist").length, 0);
	const g = fixture(t); await g.quick.open(); g.setPrivacy("local");
	await g.quick.submit({ panelId: g.quick.state().panelId, text: "Improve it" });
	assert.match(g.quick.state().message, /privacy setting changed/); assert.equal(g.calls.length, 0);
});

test("model completion is passive, exact review applies once, and undo uses its recorded effect", async t => {
	const f = fixture(t); await preview(f);
	assert.equal(f.quick.state().phase, "preview"); assert.equal(f.shown.at(-1).focus, false);
	assert.deepEqual(f.calls.find(call => call.method === "mission.targetAssist").params.target, f.native);
	await assert.rejects(f.quick.apply({ panelId: f.quick.state().panelId, proposalId: "other" }), /exact current proposal/);
	f.quick.expand({ panelId: f.quick.state().panelId });
	const state = f.quick.state(); await f.quick.apply({ panelId: state.panelId, proposalId: state.proposalId });
	assert.equal(f.quick.state().phase, "applied"); assert.equal(f.quick.state().source, ""); assert.equal(f.shown.at(-1).focus, false);
	assert.deepEqual(f.calls.find(call => call.method === "mission.targetApply").params, { intentId: "act_1", intentHash: sha256("exact-intent") });
	f.responses["mission.targetApply"] = { intent: { id: "act_undo", missionId: "m1", state: "verified" } };
	await f.quick.undo({ panelId: state.panelId }); assert.equal(f.quick.state().phase, "undone");
	assert.equal(f.calls.filter(call => call.method === "mission.targetAssist").length, 1);
});

test("dismissal while the model reply is pending prevents preview and any native effect", async t => {
	const f = fixture(t); await f.quick.open(); await f.quick.submit({ panelId: f.quick.state().panelId, text: "Improve it" });
	const proposal = pending(); f.responses["mission.targetProposal"] = () => proposal.promise;
	const completion = f.quick.onEngine({ kind: "update", missionId: "m1", mission: { status: "succeeded" } });
	f.quick.cancel(); proposal.resolve({ id: "late", kind: "paragraph.replace", text: "Late answer", directlySupported: true }); await completion;
	assert.equal(f.quick.state().phase, "closed"); assert.equal(f.calls.some(call => call.method === "mission.targetApply"), false);
	assert.equal(f.shown.filter(show => show.focus).length, 1);
});

test("lost apply response offers scoped reconciliation instead of retrying and forgotten history stays forgotten", async t => {
	const f = fixture(t); await preview(f);
	f.responses["mission.targetApply"] = () => { throw new Error("Response lost"); };
	const state = f.quick.state(); await f.quick.apply({ panelId: state.panelId, proposalId: state.proposalId });
	assert.equal(f.quick.state().phase, "unknown");
	f.responses["mission.targetReconcile"] = { intent: { id: "act_1", missionId: "m1", state: "verified" } };
	await f.quick.reconcile({ panelId: state.panelId }); assert.equal(f.quick.state().phase, "applied");
	assert.equal(f.calls.filter(call => call.method === "mission.targetApply").length, 1);
	const g = fixture(t); await preview(g); const apply = pending(); g.responses["mission.targetApply"] = () => apply.promise;
	const before = g.quick.state(); const applying = g.quick.apply({ panelId: before.panelId, proposalId: before.proposalId });
	await new Promise(resolve => setImmediate(resolve)); g.quick.forget();
	apply.resolve({ intent: { id: "act_1", missionId: "m1", state: "verified" } }); await applying;
	assert.equal(g.quick.hasRecent(), false); assert.equal(g.quick.state().phase, "closed");
});

test("native chart quick command reaches review without requesting generation", async t => {
	const f = fixture(t, { kind: "chart", text: "", metadata: { title: "Budget", chartType: 57, seriesCount: 1, categoryCount: 3, editable: true } });
	await f.quick.open(); await f.quick.submit({ panelId: f.quick.state().panelId, text: "Change this bar chart to pie" });
	assert.equal(f.quick.state().phase, "preview"); assert.equal(f.calls.some(call => call.method === "mission.targetAssist"), false);
	assert.equal(f.calls.some(call => call.method === "mission.targetCommand"), true);
});

test("expiry clears the source and cannot be revived by a queued model answer", async t => {
	const f = fixture(t); await f.quick.open(); await f.quick.submit({ panelId: f.quick.state().panelId, text: "Improve it" });
	const reply = pending(); f.responses["mission.targetProposal"] = () => reply.promise;
	const completion = f.quick.onEngine({ kind: "update", missionId: "m1", mission: { status: "succeeded" } });
	f.timer.fire();
	reply.resolve({ id: "expired_proposal", kind: "paragraph.replace", text: "Late data", directlySupported: true }); await completion;
	assert.equal(f.quick.state().phase, "expired"); assert.equal(f.quick.state().source, ""); assert.equal(f.quick.state().replacement, "");
	assert.equal(f.calls.some(call => call.method === "mission.targetApply"), false);
});
