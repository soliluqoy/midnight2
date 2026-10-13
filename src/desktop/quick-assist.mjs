// Shell-owned quick assistance. Capture precedes UI focus; renderer data never supplies app handles or edit
// permissions. One active request, short-lived context, and generation fences keep late responses inert.
import { randomUUID } from "node:crypto";
import { createTargetCapsules } from "../context/capsules.mjs";

export const QUICK_HOTKEY = "CommandOrControl+Alt+Space";
export function createQuickAssist({ word, request, settings, blocked = () => false, publish = () => {}, present = () => {}, hide = () => {}, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
	const targets = createTargetCapsules({ now });
	let generation = 0, revision = 0, current, lastEffect, closed = false;
	let state = { phase: "closed", panelId: "", expanded: false };
	const send = patch => { state = { ...state, ...patch, revision: ++revision }; publish(structuredClone(state)); };
	const valid = ctx => !closed && current === ctx && ctx.generation === generation && !blocked();
	const check = (ctx, phase) => { if (!valid(ctx) || (phase && state.phase !== phase)) throw new Error("This quick-edit selection changed or was revoked."); };
	const panel = id => { if (!current || current.panelId !== id) throw new Error("This quick-edit panel is no longer current."); return current; };
	const quietly = promise => Promise.resolve(promise).catch(() => {});
	function release(ctx, retainNative = false) {
		clearTimer(ctx?.timer); ctx?.capture?.abort();
		if (ctx?.targetId) targets.release(ctx.targetId);
		if (ctx?.missionId) quietly(request("mission.targetRelease", { missionId: ctx.missionId }));
		if (ctx?.snapshot?.handle && !retainNative) quietly(word.release(ctx.snapshot.handle));
		if (ctx) { ctx.snapshot = undefined; ctx.proposal = undefined; }
	}
	function error(ctx, err, uncertain = false) {
		if (!valid(ctx)) return;
		send({ phase: uncertain ? "unknown" : "error", message: String(err.message ?? err), canApply: false, expanded: false });
		present({ mode: "notice", focus: false });
	}
	async function outcome(ctx, result, undoing = false) {
		if (lastEffect?.intentId === result.intent.id) lastEffect = { intentId: result.intent.id, missionId: result.intent.missionId, kind: ctx.kind, state: result.intent.state, undoing };
		if (!valid(ctx)) return result;
		const phase = result.intent.state === "verified" ? (undoing ? "undone" : "applied") : result.intent.state === "unknown" ? "unknown" : "error";
		release(ctx, true);
		send({ phase, source: "", replacement: "", canApply: false, expanded: false, message: phase === "applied" ? "Selection updated" : phase === "undone" ? "Edit reversed" : phase === "unknown" ? "The app may have changed. Check the outcome before doing more." : result.receipt?.observed?.detail ?? "The app did not verify this edit." });
		present({ mode: "notice", focus: false });
		return result;
	}
	const api = {
		state: () => structuredClone(state),
		hasRecent: () => !!lastEffect,
		isWorking: () => ["capturing", "submitting", "generating", "loading", "preparing", "applying", "undoing"].includes(state.phase),
		async open({ passive = false, foreground } = {}) {
			if (closed || blocked()) return;
			if (passive && !["closed", "error", "expired", "applied", "undone"].includes(state.phase)) throw new Error("Finish or dismiss the current quick edit before speaking another request.");
			if (state.phase === "capturing") return;
			if (state.phase === "input") return api.cancel({ panelId: state.panelId });
			if (state.phase === "preview") return api.expand({ panelId: state.panelId });
			if (lastEffect && ["dispatching", "unknown"].includes(lastEffect.state)) return api.recent();
			if (["submitting", "generating", "loading", "preparing", "applying", "undoing"].includes(state.phase)) { present({ mode: "notice", focus: false }); return; }
			if (current?.missionId && !["applied", "undone", "unknown"].includes(state.phase)) quietly(request("mission.cancel", { missionId: current.missionId }));
			release(current, state.phase === "applied");
			const ctx = current = { generation: ++generation, panelId: `quick_${randomUUID()}`, capture: new AbortController() };
			state = { phase: "capturing", panelId: ctx.panelId, expanded: false, revision: ++revision }; publish(api.state());
			try {
				const snapshot = await word.capture({ signal: ctx.capture.signal, ...(foreground ? { expectedWindowId: foreground.windowId, expectedProcessId: foreground.processId } : {}) });
				if (!valid(ctx)) { quietly(word.release(snapshot.handle)); return; }
				const target = targets.capture(snapshot);
				ctx.snapshot = snapshot; ctx.targetId = target.id; ctx.kind = target.kind;
				ctx.timer = setTimer(() => {
					if (!valid(ctx)) return;
					if (ctx.missionId) quietly(request("mission.cancel", { missionId: ctx.missionId }));
					release(ctx); generation++;
					send({ phase: "expired", source: "", replacement: "", canApply: false, message: "Select the target again for a fresh quick edit.", expanded: false });
					present({ mode: "notice", focus: false });
				}, Math.max(1, target.expiresAt - now())); ctx.timer.unref?.();
				ctx.privacy = settings().privacy ?? "cloud";
				send({ phase: "input", voicePhase: passive ? "preparing" : undefined, message: passive ? "Preparing voice request" : "", source: target.kind === "chart" ? `${target.metadata.title || "Untitled native chart"} · ${target.metadata.seriesCount} series · ${target.metadata.categoryCount} categories` : target.text, kind: target.kind, scope: target.metadata.scope === "paragraph" ? "Current paragraph" : target.kind === "chart" ? "Selected native chart" : "Selected text", privacy: ctx.privacy, expiresAt: target.expiresAt, canApply: false });
				if (!passive) present({ mode: "input", focus: true });
				return { panelId: ctx.panelId, expiresAt: target.expiresAt };
			} catch (err) { error(ctx, err); }
		},
		voiceStatus({ panelId, phase, message }) { const ctx = panel(panelId); check(ctx, "input"); if (!["listening", "transcribing"].includes(phase)) throw new Error("Invalid voice request phase."); send({ voicePhase: phase, message, expanded: false }); present({ mode: "notice", focus: false }); },
		voiceFailure({ panelId, message }) { const ctx = panel(panelId); check(ctx); release(ctx); send({ phase: "error", voicePhase: undefined, source: "", replacement: "", canApply: false, expanded: false, message: String(message).slice(0, 300) }); present({ mode: "notice", focus: false }); },
		async submit({ panelId, text }) {
			const ctx = panel(panelId); check(ctx, "input");
			if (typeof text !== "string" || !text.trim() || text.length > 1000) throw new Error("Describe the small edit in up to 1,000 characters.");
			send({ phase: "submitting", voicePhase: undefined, message: "Preparing your request", expanded: false });
			try {
				const fresh = await word.inspect(ctx.snapshot.handle); check(ctx);
				targets.assertCurrent(ctx.targetId, fresh);
				if ((settings().privacy ?? "cloud") !== ctx.privacy) throw new Error("Your privacy setting changed. Capture a fresh selection before sending it.");
				const result = await request(ctx.kind === "chart" ? "mission.targetCommand" : "mission.targetAssist", { text: text.trim(), requestId: `quickreq_${randomUUID()}`, target: ctx.snapshot, expectedPrivacy: ctx.privacy });
				if (!valid(ctx)) { quietly(request("mission.cancel", { missionId: result.missionId })); quietly(request("mission.targetRelease", { missionId: result.missionId })); return; }
				ctx.missionId = result.missionId;
				if (ctx.kind === "chart") {
					ctx.intent = result.intent; ctx.proposal = { id: result.intent.argsHash, kind: "chart.setType" };
					send({ phase: "preview", proposalId: ctx.proposal.id, replacement: "Change this native chart to pie. Preserve its data, title, geometry and anchor. Bar-axis styling may change.", canApply: true, message: "Review the chart change", expanded: true });
					present({ mode: "preview", focus: false });
				} else {
					send({ phase: "generating", message: "Working on the selected text" }); hide();
					const mission = await request("query.mission", { missionId: ctx.missionId });
					await api.onEngine({ kind: "update", missionId: ctx.missionId, mission });
				}
			} catch (err) { error(ctx, err); }
		},
		async onEngine(event) {
			const ctx = current;
			if (!ctx || !valid(ctx) || event.kind !== "update" || event.missionId !== ctx.missionId || state.phase !== "generating") return;
			const status = event.mission?.status;
			if (status === "succeeded") {
				send({ phase: "loading" });
				try {
					const proposal = await request("mission.targetProposal", { missionId: ctx.missionId }); check(ctx);
					ctx.proposal = proposal;
					send({ phase: proposal.kind === "needsContext" ? "needsContext" : "preview", replacement: proposal.text ?? "", proposalId: proposal.id, canApply: proposal.directlySupported === true && !proposal.unchanged, message: proposal.question ?? (proposal.unchanged ? "The selected text is already unchanged." : proposal.reviewReasons?.join(" ") || "Preview ready"), expanded: false });
					present({ mode: "notice", focus: false });
				} catch (err) { error(ctx, err); }
			} else if (["partially-succeeded", "failed", "cancelled", "paused", "needs-reconciliation"].includes(status)) error(ctx, new Error(event.mission?.outcome?.summary || "The quick-edit request did not finish. Select the target again."));
		},
		expand({ panelId }) { check(panel(panelId)); send({ expanded: true }); present({ mode: "preview", focus: true }); },
		async apply({ panelId, proposalId }) {
			const ctx = panel(panelId); check(ctx, "preview");
			if (!state.canApply || ctx.proposal?.id !== proposalId) throw new Error("Review the exact current proposal before applying it.");
			clearTimer(ctx.timer); send({ phase: "preparing", canApply: false });
			try {
				const intent = ctx.intent ?? await request("mission.targetPrepare", { missionId: ctx.missionId, proposalId }); check(ctx);
				ctx.intent = intent; lastEffect = { intentId: intent.id, missionId: ctx.missionId, kind: ctx.kind, state: "dispatching" };
				send({ phase: "applying", expanded: false, message: "Updating the captured selection" }); hide();
				return await outcome(ctx, await request("mission.targetApply", { intentId: intent.id, intentHash: intent.argsHash }));
			} catch (err) {
				if (lastEffect?.intentId === ctx.intent?.id) lastEffect.state = "unknown";
				error(ctx, err, lastEffect?.intentId === ctx.intent?.id && !!ctx.intent);
			}
		},
		async undo({ panelId }) {
			const ctx = panel(panelId); check(ctx);
			if (!lastEffect || lastEffect.state !== "verified" || lastEffect.undoing || state.phase !== "applied") throw new Error("There is no verified quick edit available to reverse.");
			send({ phase: "undoing", expanded: false, message: "Checking the edited target" });
			try {
				const intent = await request("mission.targetUndo", { intentId: lastEffect.intentId }); check(ctx);
				lastEffect = { intentId: intent.id, missionId: intent.missionId, kind: ctx.kind, state: "dispatching", undoing: true };
				hide(); return await outcome(ctx, await request("mission.targetApply", { intentId: intent.id, intentHash: intent.argsHash }), true);
			} catch (err) { error(ctx, err, lastEffect?.state === "dispatching"); }
		},
		async reconcile({ panelId }) {
			const ctx = panel(panelId); check(ctx);
			if (!lastEffect || state.phase !== "unknown") throw new Error("This quick edit has no uncertain outcome.");
			try {
				const intent = await request("mission.targetReconcile", { intentId: lastEffect.intentId });
				return await outcome(ctx, intent, lastEffect.undoing);
			} catch (err) { error(ctx, err); }
		},
		recent() {
			if (!lastEffect || blocked() || closed) return;
			if (current?.missionId && !["applying", "applied", "undoing", "unknown", "undone"].includes(state.phase)) quietly(request("mission.cancel", { missionId: current.missionId }));
			release(current, true);
			current = { generation: ++generation, panelId: `quick_${randomUUID()}`, kind: lastEffect.kind };
			state = { phase: lastEffect.state === "verified" ? (lastEffect.undoing ? "undone" : "applied") : "unknown", panelId: current.panelId, expanded: false, source: "", replacement: "", message: lastEffect.state === "verified" ? "Recent selection edit" : "Check the last edit's outcome", canApply: false, revision: ++revision };
			publish(api.state()); present({ mode: "notice", focus: false });
		},
		cancel({ panelId } = {}) {
			if (panelId && panelId !== current?.panelId) throw new Error("This quick-edit panel is no longer current.");
			const ctx = current; generation++; current = undefined;
			if (ctx?.missionId && !["applied", "undone", "unknown"].includes(state.phase)) quietly(request("mission.cancel", { missionId: ctx.missionId }));
			release(ctx, ["applying", "applied", "undoing", "unknown"].includes(state.phase));
			state = { phase: "closed", panelId: "", expanded: false, revision: ++revision }; publish(api.state()); hide();
		},
		invalidate() { api.cancel(); },
		forget() { api.cancel(); lastEffect = undefined; },
		close() { api.cancel(); closed = true; },
	};
	return api;
}
