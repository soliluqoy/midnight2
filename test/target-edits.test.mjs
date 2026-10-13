import assert from "node:assert/strict";
import test from "node:test";
import { makeCore, openTestStore } from "./helpers.mjs";
import { createTargetCapsules } from "../src/context/capsules.mjs";
import { parseTargetProposal } from "../src/context/proposals.mjs";
import { createTargetEditBroker } from "../src/policy/target-edits.mjs";
import { createLedger } from "../src/policy/ledger.mjs";
import { createJournal } from "../src/storage/journal.mjs";
import { createUnitOfWork } from "../src/storage/uow.mjs";
import { createLocks } from "../src/policy/locks.mjs";
import { createStopControl } from "../src/policy/stop.mjs";
import { sha256 } from "../src/policy/canonical.mjs";

async function fixture(t, overrides = {}) {
	const core = await makeCore(); t.after(() => { if (!core.closed) core.close(); });
	core.addMission("selected", { scope: { contextProfile: "selectedTarget" } });
	const targets = createTargetCapsules();
	const native = { state: { kind: "paragraph", documentId: "original-unsaved-instance", handle: "range-2", processId: 17, windowId: "31", text: "Revenue increased by 12%.", metadata: { supported: true, style: "Normal" }, connector: { id: "word", api: 1, artifact: sha256("helper-artifact") }, preservationHash: sha256("unchanged-format-or-chart-properties"), ...overrides }, calls: 0, receipts: new Map() };
	native.state.structureHash = sha256(JSON.stringify({ text: native.state.text, metadata: native.state.metadata }));
	const platform = { async call(op, args) {
		if (op === "word.inspect") { native.onInspect?.(); if (native.missing) throw new Error("Handle lost."); return structuredClone(native.state); }
		if (op === "word.receipt") return native.receipts.has(args.editId) ? { found: true, result: structuredClone(native.receipts.get(args.editId)) } : { found: false };
		if (op !== "word.apply") throw new Error(`Unexpected ${op}`);
		assert.equal(core.ledger.get(args.editId).state, "dispatching", "intent is committed before native dispatch");
		assert.equal(core.ledger.get(args.editId).authority.origin, "trusted-shell");
		native.calls++;
		if (args.operation === "paragraph.replace") native.state.text = args.text; else native.state.metadata.chartType = args.chartType;
		native.state.structureHash = sha256(JSON.stringify({ text: native.state.text, metadata: native.state.metadata }));
		const result = { editId: args.editId, state: "verified", snapshot: structuredClone(native.state) };
		native.receipts.set(args.editId, result);
		native.onApply?.();
		if (native.lose) throw Object.assign(new Error("Reply lost after commit."), { uncertain: true, code: "EDIT_UNKNOWN" });
		return result;
	} };
	const deps = { ...core, targets, platform };
	const edits = createTargetEditBroker(deps);
	const target = targets.capture(native.state);
	const answer = JSON.stringify({ kind: "paragraph.replace", text: "Revenue grew by 12%." });
	const prepare = () => edits.prepareParagraph({ missionId: "selected", targetId: target.id, answer, proposalId: parseTargetProposal(target, answer).id });
	return { core, native, target, targets, edits, prepare, deps };
}

test("exact native intents persist, deduplicate dispatch and reverse only their verified target", async t => {
	const f = await fixture(t);
	const intent = await f.prepare();
	assert.equal((await f.prepare()).id, intent.id);
	await assert.rejects(f.edits.apply(intent.id, sha256("wrong acknowledgement")), /acknowledgement/);
	const results = await Promise.all([f.edits.apply(intent.id, intent.argsHash), f.edits.apply(intent.id, intent.argsHash)]);
	assert.equal(results[0].intent.state, "verified"); assert.equal(results[1].intent.state, "verified");
	assert.equal(f.native.calls, 1);
	assert.equal(f.native.state.text, "Revenue grew by 12%.");
	assert.equal((await f.edits.apply(intent.id, intent.argsHash)).duplicate, true);
	const undo = await f.edits.prepareUndo(intent.id);
	assert.equal((await f.edits.prepareUndo(intent.id)).id, undo.id);
	assert.equal((await f.edits.apply(undo.id, undo.argsHash)).intent.state, "verified");
	assert.equal(f.native.state.text, "Revenue increased by 12%.");
	assert.equal(f.core.ledger.get(intent.id).state, "compensated");
});

test("later target changes prevent both pending edits and reversal without touching user work", async t => {
	const f = await fixture(t);
	const intent = await f.prepare();
	f.native.state.text = "Later user text."; f.native.state.structureHash = sha256("later structure");
	await assert.rejects(f.edits.apply(intent.id, intent.argsHash), { code: "TARGET_CONFLICT" });
	assert.equal(f.native.calls, 0); assert.equal(f.native.state.text, "Later user text.");
	const g = await fixture(t); const applied = await g.prepare(); await g.edits.apply(applied.id, applied.argsHash);
	g.native.state.structureHash = sha256("later formatting");
	await assert.rejects(g.edits.prepareUndo(applied.id), { code: "TARGET_CONFLICT" });
	assert.equal(g.native.calls, 1);
});

test("lock/unlock revokes an already prepared native intent and stop during recheck cannot dispatch", async t => {
	const f = await fixture(t); const intent = await f.prepare();
	f.core.stop.setSessionBlocked("locked"); f.core.stop.setSessionBlocked(undefined);
	await assert.rejects(f.edits.apply(intent.id, intent.argsHash), /revoked/); assert.equal(f.native.calls, 0);
	const g = await fixture(t); const another = await g.prepare();
	g.native.onInspect = () => g.core.stop.emergencyStop();
	await assert.rejects(g.edits.apply(another.id, another.argsHash), /emergency/); assert.equal(g.native.calls, 0);
});

test("lost native response is unknown until reconciled and never redispatched", async t => {
	const f = await fixture(t); const intent = await f.prepare(); f.native.lose = true;
	assert.equal((await f.edits.apply(intent.id, intent.argsHash)).intent.state, "unknown");
	assert.equal((await f.edits.apply(intent.id, intent.argsHash)).duplicate, true); assert.equal(f.native.calls, 1);
	assert.equal((await f.edits.reconcile(intent.id)).intent.state, "verified"); assert.equal(f.native.calls, 1);
	const undo = await f.edits.prepareUndo(intent.id); assert.equal(undo.state, "prepared");
});

test("receipt storage failure leaves a reconcilable in-flight intent rather than reporting a failed effect", async t => {
	const f = await fixture(t); let failReceipt = false;
	const edits = createTargetEditBroker({ ...f.deps, commit: fn => { if (failReceipt) throw new Error("storage failed"); return f.core.commit(fn); } });
	const intent = await f.prepare();
	// This service has a new epoch, so prepare its own fresh exact target first.
	const answer = JSON.stringify({ kind: "paragraph.replace", text: "Revenue grew by 12%." });
	const target = f.targets.capture(f.native.state);
	const own = await edits.prepareParagraph({ missionId: "selected", targetId: target.id, answer, proposalId: parseTargetProposal(target, answer).id });
	f.native.onApply = () => { failReceipt = true; };
	await assert.rejects(edits.apply(own.id, own.argsHash), /storage failed/);
	assert.equal(f.core.ledger.get(own.id).state, "dispatching");
	failReceipt = false;
	assert.equal((await edits.reconcile(own.id)).intent.state, "verified"); assert.equal(f.native.calls, 1);
	assert.equal(f.core.ledger.get(intent.id).state, "prepared");
});

test("persisted unknown edit survives store restart and missing original handles remain unknown", async t => {
	const f = await fixture(t); const intent = await f.prepare(); f.native.lose = true;
	await f.edits.apply(intent.id, intent.argsHash);
	f.core.close(); f.core.closed = true;
	const store = await openTestStore(f.core.dir); t.after(() => store.close());
	const journal = createJournal(store); const ledger = createLedger(store); const uow = createUnitOfWork(store, journal);
	const edits = createTargetEditBroker({ store, journal, ledger, ...uow, platform: f.deps.platform, targets: createTargetCapsules(), stop: createStopControl(), locks: createLocks() });
	assert.equal((await edits.reconcile(intent.id)).intent.state, "verified"); assert.equal(f.native.calls, 1);
	const g = await fixture(t); const missing = await g.prepare(); g.native.lose = true; await g.edits.apply(missing.id, missing.argsHash);
	g.native.receipts.clear(); g.native.missing = true;
	assert.equal((await g.edits.reconcile(missing.id)).intent.state, "unknown"); assert.equal(g.native.calls, 1);
});

test("deterministic chart intent uses the same receipt and reversal path without generation", async t => {
	const f = await fixture(t, { kind: "chart", text: "", metadata: { editable: true, chartType: 57, seriesCount: 1, categoryCount: 3, title: "Budget" } });
	const intent = await f.edits.prepareChart({ missionId: "selected", targetId: f.target.id, instruction: "Change this bar chart to pie" });
	await f.edits.apply(intent.id, intent.argsHash); assert.equal(f.native.state.metadata.chartType, 5);
	const undo = await f.edits.prepareUndo(intent.id); await f.edits.apply(undo.id, undo.argsHash);
	assert.equal(f.native.state.metadata.chartType, 57);
	const g = await fixture(t, { kind: "chart", text: "", metadata: { editable: true, chartType: 57, seriesCount: 2, categoryCount: 3 } });
	await assert.rejects(g.edits.prepareChart({ missionId: "selected", targetId: g.target.id, instruction: "Change this bar chart to pie" }), /one editable series/);
	assert.equal(g.native.calls, 0);
});

test("an unknown earlier effect blocks another native write in that app until reconciled", async t => {
	const f = await fixture(t); const first = await f.prepare(); f.native.lose = true;
	await f.edits.apply(first.id, first.argsHash);
	const next = f.targets.capture(f.native.state);
	const answer = JSON.stringify({ kind: "paragraph.replace", text: "Revenue advanced by 12%." });
	const later = await f.edits.prepareParagraph({ missionId: "selected", targetId: next.id, answer, proposalId: parseTargetProposal(next, answer).id });
	await assert.rejects(f.edits.apply(later.id, later.argsHash), { code: "EDIT_UNKNOWN_BLOCKED" });
	assert.equal(f.native.calls, 1);
	await f.edits.reconcile(first.id); f.native.lose = false;
	assert.equal((await f.edits.apply(later.id, later.argsHash)).intent.state, "verified"); assert.equal(f.native.calls, 2);
});
