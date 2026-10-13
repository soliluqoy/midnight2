// Exact selected-target writes reuse the durable action ledger. Model tools cannot enter this lane: the shell
// prepares a validated proposal and acknowledges its exact hash. Unknown effects are inspected, never retried.
import { randomUUID } from "node:crypto";
import { sha256 } from "./canonical.mjs";
import { parseTargetProposal } from "../context/proposals.mjs";

export const TARGET_EDIT_TOOL = "target_edit";
const fail = (message, code = "TARGET_EDIT_DENIED") => Object.assign(new Error(message), { code });
const expected = snapshot => ({ handle: snapshot.handle, documentId: snapshot.documentId, kind: snapshot.kind, processId: snapshot.processId, windowId: snapshot.windowId, structureHash: snapshot.structureHash, textHash: sha256(snapshot.text ?? "") });
const identityMatches = (a, b) => ["handle", "documentId", "kind", "processId", "windowId"].every(key => a[key] === b[key]) && a.connector?.id === b.connector?.id && a.connector?.api === b.connector?.api && a.connector?.artifact === b.connector?.artifact;

export function createTargetEditBroker({ store, journal, ledger, commit, emit, targets, stop, locks, platform, now = () => Date.now() }) {
	let epoch = randomUUID(), closed = false;
	const active = new Map();
	const checkStop = missionId => { if (closed) throw fail("The native edit service is closed."); const blocked = stop.blocked(missionId); if (blocked) throw fail(blocked); };
	const call = (op, params, signal) => platform.call(`word.${op}`, params, { signal });
	const argumentsFor = intent => {
		const args = JSON.parse(journal.getPayload(intent.argsRef) ?? "{}").args;
		if (!args || intent.tool !== TARGET_EDIT_TOOL || intent.toolVersion !== args.connector?.artifact || sha256(JSON.stringify(args)) !== intent.argsHash) throw fail("The stored native edit no longer has its exact connector and arguments.");
		return args;
	};
	function prepareStored(missionId, args, title) {
		const argsHash = sha256(JSON.stringify(args));
		const idempotencyKey = `${TARGET_EDIT_TOOL}:${args.requestKey}`;
		const duplicate = store.get("SELECT id FROM action_intents WHERE idempotency_key = ?", idempotencyKey);
		if (duplicate) return ledger.get(duplicate.id);
		return commit(() => {
			const argsRef = journal.putPayload(missionId, "intent-args", { tool: TARGET_EDIT_TOOL, args });
			const intent = ledger.prepare({ missionId, tool: TARGET_EDIT_TOOL, toolVersion: args.connector.artifact, effect: "app.edit", target: args.expected.handle, argsHash, argsRef, idempotencyKey, display: { title, preview: args.text ?? "Pie chart", previewKind: "diff" } });
			emit("action.prepared", { missionId, correlationId: intent.id, payload: { intentId: intent.id, tool: TARGET_EDIT_TOOL, effect: "app.edit", label: title } });
			return intent;
		});
	}
	function record(intent, state, snapshot, detail) {
		return commit(() => {
			ledger.transition(intent.id, state);
			const postRef = snapshot ? journal.putPayload(intent.missionId, "edit-poststate", snapshot) : undefined;
			const receipt = ledger.receipt(intent.id, { state, resultHash: snapshot ? sha256(JSON.stringify(snapshot)) : undefined, observed: { postRef, detail }, verification: state === "verified" ? ["original-native-target", "expected-content", "preserved-common-properties"] : [] });
			emit("action.reconciled", { missionId: intent.missionId, correlationId: intent.id, payload: { intentId: intent.id, tool: TARGET_EDIT_TOOL, state, receiptId: receipt.id, effect: "app.edit" } });
			const args = argumentsFor(intent);
			if (state === "verified" && args.undoOf && ledger.get(args.undoOf)?.state === "verified") {
				ledger.transition(args.undoOf, "compensated");
				const reversal = ledger.receipt(args.undoOf, { state: "compensated", observed: { undoIntentId: intent.id }, verification: ["conditional-reverse-patch"] });
				emit("action.reconciled", { missionId: intent.missionId, correlationId: args.undoOf, payload: { intentId: args.undoOf, tool: TARGET_EDIT_TOOL, state: "compensated", receiptId: reversal.id, effect: "app.edit" } });
			}
			return { intent: ledger.get(intent.id), receipt };
		});
	}
	function matchesPost(args, snapshot) {
		return identityMatches({ ...args.expected, connector: args.connector }, snapshot) && snapshot.preservationHash === args.before.preservationHash && (args.operation === "paragraph.replace" ? snapshot.text === args.text : snapshot.metadata?.chartType === args.chartType);
	}
	async function inspectOutcome(intent, args) {
		const receipt = await call("receipt", { editId: intent.id });
		if (receipt?.found) {
			if (receipt.result?.editId !== intent.id || receipt.result.state !== "verified" || !matchesPost(args, receipt.result.snapshot)) return { state: "unknown" };
			return { state: "verified", snapshot: receipt.result.snapshot };
		}
		const current = await call("inspect", { handle: args.expected.handle });
		if (matchesPost(args, current)) return { state: "verified", snapshot: current };
		if (identityMatches(args.before, current) && current.structureHash === args.expected.structureHash && sha256(current.text ?? "") === args.expected.textHash) return { state: "failed", detail: "The original prestate is still present after native dispatch finished." };
		return { state: "unknown", detail: "The current target matches neither the intended prestate nor poststate." };
	}
	const api = {
		invalidate() { epoch = randomUUID(); },
		async close({ wait = true } = {}) { closed = true; api.invalidate(); unsubscribe(); if (wait) await Promise.allSettled(active.values()); },
		async prepareParagraph({ missionId, targetId, answer, proposalId }) {
			checkStop(missionId);
			const target = targets.get(targetId);
			const proposal = parseTargetProposal(target, answer);
			if (proposal.id !== proposalId || proposal.kind !== "paragraph.replace" || !proposal.directlySupported || proposal.unchanged) throw fail("Review a supported changed paragraph proposal before preparing its edit.");
			const before = await call("inspect", { handle: target.handle });
			checkStop(missionId); targets.assertCurrent(targetId, before);
			if (before.metadata?.supported !== true) throw fail("This target no longer supports direct paragraph replacement.", "TARGET_UNSUPPORTED");
			if (!/^sha256:[a-f0-9]{64}$/.test(before.preservationHash ?? "")) throw fail("This connector has not fingerprinted the properties to preserve.");
			const args = { operation: "paragraph.replace", requestKey: proposal.id, expected: expected(before), connector: target.connector, text: proposal.text, before, targetId, expiresAt: target.expiresAt, epoch };
			return prepareStored(missionId, args, "Replace the selected paragraph");
		},
		async prepareChart({ missionId, targetId, instruction }) {
			checkStop(missionId);
			const target = targets.get(targetId);
			if (target.kind !== "chart" || !/^\s*(?:change|convert|switch)\s+(?:(?:this|the|selected)\s+)?(?:bar\s+)?chart\s+(?:to|into)\s+(?:a\s+)?pie(?:\s+chart)?[.!]?\s*$/i.test(instruction ?? "")) throw fail("Select one native chart and specify its pie conversion.");
			const before = await call("inspect", { handle: target.handle });
			checkStop(missionId); targets.assertCurrent(targetId, before);
			if (![51, 57].includes(before.metadata?.chartType) || before.metadata?.seriesCount !== 1 || !before.metadata?.editable || !/^sha256:[a-f0-9]{64}$/.test(before.preservationHash ?? "")) throw fail("This quick conversion needs one editable series in a supported 2D chart.");
			return prepareStored(missionId, { operation: "chart.setType", requestKey: `chart_${targetId}`, chartType: 5, expected: expected(before), connector: target.connector, before, targetId, expiresAt: target.expiresAt, epoch }, "Change the selected chart to pie");
		},
		async prepareUndo(intentId) {
			const original = ledger.get(intentId);
			if (!original || original.tool !== TARGET_EDIT_TOOL || original.state !== "verified") throw fail("This edit has no verified result to reverse.");
			checkStop(original.missionId);
			const args = argumentsFor(original);
			const post = JSON.parse(journal.getPayload(ledger.latestReceipt(intentId)?.observed.postRef) ?? "null");
			if (!post) throw fail("The recorded poststate is no longer available for undo.");
			const current = await call("inspect", { handle: post.handle });
			checkStop(original.missionId);
			if (!identityMatches(post, current) || post.structureHash !== current.structureHash || post.text !== current.text) throw fail("Later work changed this target. Its earlier edit cannot be reversed automatically.", "TARGET_CONFLICT");
			return prepareStored(original.missionId, { operation: args.operation === "paragraph.replace" ? "paragraph.replace" : "chart.restoreType", requestKey: `undo_${original.id}`, expected: expected(current), connector: args.connector, ...(args.operation === "paragraph.replace" ? { text: args.before.text } : { chartType: args.before.metadata.chartType }), before: current, undoOf: original.id, expiresAt: now() + 60_000, epoch }, "Undo the selected-target edit");
		},
		async apply(intentId, acknowledgedHash, { signal } = {}) {
			const original = ledger.get(intentId);
			if (!original || original.tool !== TARGET_EDIT_TOOL || original.argsHash !== acknowledgedHash) throw fail("The acknowledgement does not match this exact edit.");
			if (active.has(intentId)) return active.get(intentId);
			if (["verified", "compensated", "failed", "denied", "cancelled", "unknown"].includes(original.state)) return { intent: original, receipt: ledger.latestReceipt(intentId), duplicate: true };
			if (original.state !== "prepared") throw fail("This edit may already be in flight. Reconcile it before doing more.");
			const work = (async () => {
				const args = argumentsFor(original);
				const release = await locks.acquire([{ key: `native-app:${args.connector.id}:${args.expected.processId}`, mode: "write" }], intentId, { timeoutMs: 5000 });
				try {
					checkStop(original.missionId); signal?.throwIfAborted();
					const unresolved = ledger.unresolved().find(other => {
						if (other.id === intentId || other.tool !== TARGET_EDIT_TOOL) return false;
						try { const prior = argumentsFor(other); return prior.expected.processId === args.expected.processId && prior.connector.id === args.connector.id; } catch { return true; }
					});
					if (unresolved) throw fail("An earlier edit in this app has an unknown outcome. Reconcile it before applying another.", "EDIT_UNKNOWN_BLOCKED");
					if (args.epoch !== epoch || args.expiresAt <= now()) throw fail("This edit expired or was revoked. Prepare a fresh target.");
					const current = await call("inspect", { handle: args.expected.handle }, signal);
					checkStop(original.missionId); signal?.throwIfAborted();
					if (args.epoch !== epoch || args.expiresAt <= now()) throw fail("This edit expired or was revoked.");
					if (!identityMatches(args.before, current) || current.structureHash !== args.expected.structureHash || sha256(current.text ?? "") !== args.expected.textHash) throw fail("The target changed before native commit.", "TARGET_CONFLICT");
					if (!args.undoOf) targets.assertCurrent(args.targetId, current);
					commit(() => {
						ledger.transition(intentId, "authorized", { authority: { kind: "exact-selection", origin: "trusted-shell", argsHash: acknowledgedHash } });
						ledger.transition(intentId, "dispatching");
						emit("action.dispatched", { missionId: original.missionId, correlationId: intentId, payload: { intentId, tool: TARGET_EDIT_TOOL, effect: "app.edit" } });
					});
					let result;
					try {
						result = await call("apply", { handle: args.expected.handle, editId: intentId, operation: args.operation, expected: args.expected, connector: args.connector, text: args.text, chartType: args.chartType }, signal);
					} catch (err) {
						return record(original, err.uncertain || ["TIMEOUT", "EDIT_UNKNOWN", "ECONNRESET", "EPIPE"].includes(err.code) ? "unknown" : "failed", undefined, err.message);
					}
					if (result?.editId !== intentId || result?.state !== "verified" || !matchesPost(args, result.snapshot)) return record(original, "unknown", undefined, "The native response did not prove the exact poststate.");
					return record(original, "verified", result.snapshot, "Only the captured target and tested common properties were verified.");
				} finally { release(); }
			})();
			active.set(intentId, work);
			try { return await work; } finally { active.delete(intentId); }
		},
		async reconcile(intentId) {
			const intent = ledger.get(intentId);
			if (!intent || intent.tool !== TARGET_EDIT_TOOL) throw fail("This is not a selected-target edit.");
			if (["dispatching", "acknowledged", "verifying"].includes(intent.state)) commit(() => ledger.transition(intentId, "unknown"));
			if (ledger.get(intentId).state !== "unknown") return { intent: ledger.get(intentId), receipt: ledger.latestReceipt(intentId) };
			let outcome;
			try { outcome = await inspectOutcome(intent, argumentsFor(intent)); } catch { outcome = { state: "unknown", detail: "The original live handle or exact connector is unavailable; no edit was retried." }; }
			return record(ledger.get(intentId), outcome.state, outcome.snapshot, outcome.detail);
		},
		// Installed in the broker's map only for recovery. It is never advertised as a model tool.
		spec: {
			name: TARGET_EDIT_TOOL, version: "1", label: "Selected-target edit",
			classify() { throw fail("Native target edits need the exact trusted-shell proposal acknowledgement."); },
		},
	};
	const unsubscribe = stop.subscribe(event => { if (event.type === "emergency" || (event.type === "session" && event.reason)) api.invalidate(); });
	return api;
}
