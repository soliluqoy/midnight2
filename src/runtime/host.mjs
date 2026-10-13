// The local agent host (plan ch. 04): single owner of storage, the Pi runtime, missions, the broker, scheduling and
// budgets. It has no Electron dependency so it runs headless in tests and in an Electron utility process in the app.
// Anything that needs the desktop shell (web windows, screen, secret storage) goes through `platform`.
import fs from "node:fs";
import path from "node:path";
import { pageAssistantContext } from "../apps/page-context.mjs";
import { newId } from "../contracts/events.mjs";
import { createCoordinator } from "../missions/coordinator.mjs";
import { emptyProjection, reduce, reduceAll, stackOf } from "../missions/projection.mjs";
import { createMissionRepo } from "../missions/repo.mjs";
import { createApprovals } from "../policy/approvals.mjs";
import { createBroker } from "../policy/broker.mjs";
import { createGrants } from "../policy/grants.mjs";
import { createLedger } from "../policy/ledger.mjs";
import { createLocks } from "../policy/locks.mjs";
import { createRoots } from "../policy/roots.mjs";
import { createStopControl } from "../policy/stop.mjs";
import { createBudgets } from "../resources/budget.mjs";
import { createEvidence } from "../evidence/store.mjs";
import { createQueue, PRIORITY } from "../scheduler/queue.mjs";
import { openStore } from "../storage/db.mjs";
import { createJournal } from "../storage/journal.mjs";
import { createUnitOfWork } from "../storage/uow.mjs";
import { buildTools, createResources } from "../tools/index.mjs";
import { createModelRuntime, createPiRuntime, resolveMediaApiKey, RUNTIME_VERSION } from "./adapter.mjs";
import { registerLocalEndpoint } from "./models.mjs";
import { corePaths, dataPaths } from "./paths.mjs";
import { EMBEDDING_DEFAULTS, embeddingSettings } from "../search/config.mjs";
import { createSpeechRuntime } from "../voice/runtime.mjs";
import { createInferenceArbiter } from "../inference/arbiter.mjs";
import { createResidencyBudget, LOCAL_MODEL_BUDGETS } from "../inference/residency.mjs";
import { createTargetCapsules } from "../context/capsules.mjs";
import { parseTargetProposal } from "../context/proposals.mjs";
import { createTargetEditBroker } from "../policy/target-edits.mjs";
import { createPluginStore } from "../plugins/store.mjs";
import { createPluginRuntime } from "../plugins/runtime.mjs";
import { createBuilderService } from "../builder/service.mjs";
import { createCoreSourceValidator } from "../builder/core-validation.mjs";
import { fileURLToPath } from "node:url";
import { createPerceptionService } from "../perception/service.mjs";
import { perceptionSettings } from "../perception/config.mjs";

export const HOST_DEFAULTS = {
	provider: "",
	model: "",
	thinking: "low",
	answerLength: "normal",
	instructions: "",
	mode: "ask",
	privacy: "cloud",
	computerUse: "ask",
	local: { enabled: false, baseUrl: "http://localhost:11434/v1", model: "", vision: false },
	embedding: { ...EMBEDDING_DEFAULTS },
	budget: {},
	profile: "balanced",
	quietHours: { enabled: false, from: "22:00", to: "07:00" },
	demoConnectors: false,
};

/**
 * @param {{ dataDir: string, platform: object, settings?: object, modelRuntime?: object, core?: object, log?: Function, extraTools?: object[] }} o
 */
export async function createHost(o) {
	const log = o.log ?? (() => {});
	const paths = dataPaths(o.dataDir);
	for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true });
	const store = await openStore(o.dataDir, { backupsDir: paths.backups });
	const journal = createJournal(store);
	const { commit, emit } = createUnitOfWork(store, journal);
	let settings = { ...HOST_DEFAULTS, ...(o.settings ?? {}) };
	settings.embedding = embeddingSettings(settings.embedding);
	settings.perception = perceptionSettings(settings.perception);
	const platform = o.platform;
	const arbiter = o.inferenceArbiter ?? createInferenceArbiter();
	const residencyBudget = o.residencyBudget ?? createResidencyBudget({ readMemory: o.readMemory, onPressure: () => arbiter.revokeBackground() });
	const targets = createTargetCapsules();
	const plugins = createPluginStore({ root: paths.plugins, safeMode: !!process.env.MIDNIGHT_SAFE_MODE });
	const pluginRuntime = createPluginRuntime({ store: plugins, arbiter, execute: (args, options) => platform.call("plugin.execute", args, options) });

	const repo = createMissionRepo(store, emit);
	const ledger = createLedger(store, { runtimeVersion: RUNTIME_VERSION });
	const grants = createGrants(store);
	const approvals = createApprovals(store);
	const budgets = createBudgets(store);
	const locks = createLocks();
	const stop = createStopControl();
	const roots = createRoots(store);
	const evidence = createEvidence(store, journal, emit, { workspaces: paths.workspaces });

	const outbound = new Set();
	const send = (m) => {
		for (const fn of outbound) fn(m);
	};

	const modelRuntime = o.modelRuntime ?? (await createModelRuntime({ core: o.core ?? corePaths() }));
	try {
		registerLocalEndpoint(modelRuntime, settings.local);
	} catch (err) {
		log("local endpoint", err.message);
	}
	const runtime = createPiRuntime({
		arbiter,
		modelRuntime,
		sessionsDir: paths.sessions,
		core: o.core ?? corePaths(),
		quiet: () => settings.profile === "quiet",
		onLive: (missionId, e) => send({ kind: "live", missionId, ...e }),
	});

	let coord; // late-bound: broker hooks and tools call into the coordinator
	const missionsForBroker = { get: (id) => repo.get(id) };
	const toolMap = new Map();
	const reconciliationHandlers = new Map();
	const broker = createBroker({
		commit,
		emit,
		ledger,
		grants,
		approvals,
		budgets,
		locks,
		stop,
		missions: missionsForBroker,
		roots,
		tools: toolMap,
		journal,
		platform,
		reconciliationHandlers,
		hooks: {
			waiting: (m, kind, info) => coord.onWaiting(m, kind, info),
			resumed: (m) => coord.onResumed(m),
			reconcileNeeded: (m) => coord.onReconcileNeeded(m),
		},
	});
	const services = { store, journal, commit, emit, repo, ledger, grants, approvals, budgets, roots, evidence, platform, settings: () => settings, paths, broker, stop, arbiter, residencyBudget, targets, plugins, pluginRuntime, version: RUNTIME_VERSION };
	const queue = createQueue({ start: (item) => coord.start(item), onExpire: item => coord.expireQueued(item), reserveInteractive: true });
	const sourceRoot = o.sourceRoot ?? fileURLToPath(new URL("../../", import.meta.url));
	const sourceValidator = o.sourceValidate ?? createCoreSourceValidator({ dependencies: path.join(sourceRoot, "node_modules"), ownershipRoot: path.join(paths.changes, ".source-builds"), onCleanupWaiting: reason => { if (reason) log("source-build recovery", reason); } });
	// Cleanup starts before ordinary scheduling gates are applied. A restart must retain ownership of
	// an old container even when builds are disabled, cancelled, or the Docker control plane is offline.
	let sourceRecovered = false;
	const sourceCleanup = sourceValidator.pending?.().length ? queue.run({ missionId: "source-build-recovery", priority: PRIORITY.interactive, slot: "network", requiresNetwork: false }, async () => { await sourceValidator.recover(); sourceRecovered = true; }).catch(error => { if (!sourceRecovered) throw error; }) : Promise.resolve();
	void sourceCleanup.catch(error => log("source-build recovery", error.message));
	const builder = createBuilderService({ root: paths.changes, sessions: path.join(paths.sessions, "builder"), plugins, pluginRuntime,
		schedule: async (job, task, options) => { await sourceCleanup; return queue.run({ missionId: `builder:${job.jobId}`, priority: PRIORITY.speculative, slot: "network", preemptible: true, requiresNetwork: job.settings.privacy === "cloud" }, async signal => { if (job.kind === "core") await sourceValidator.preflight?.(); signal.throwIfAborted(); return task(signal); }, options); },
		run: (job, options) => (o.builderRun ?? ((value, context) => platform.call("builder.run", value, context)))(job, options),
		sourceWorkerFactory: o.sourceWorkerFactory,
		sourceRoot, sourceValidate: (frozen, options) => queue.isRunning(`builder:${options.jobId}`) ? sourceValidator(frozen, options) : queue.run({ missionId: `source-validation:${options.jobId}`, priority: PRIORITY.speculative, slot: "network", preemptible: true, requiresNetwork: false }, signal => sourceValidator(frozen, { ...options, signal }), { signal: options.signal }),
		settings: () => settings, stop, arbiter, publish: send });
	const perception = createPerceptionService({ settings: () => settings, stop, qualificationFile: path.join(o.dataDir, "media-qualification.json"), credential: (provider, options) => resolveMediaApiKey(modelRuntime, provider, options), credentialStatus: async provider => (await modelRuntime.checkAuth(provider))?.type === "api_key", inspectVideo: (item, options) => platform.call("media.inspectClip", { data: item.data, mimeType: item.mimeType }, options), adapters: o.perceptionAdapters, publish: send });
	const targetEdits = createTargetEditBroker({ ...services, locks });
	reconciliationHandlers.set(targetEdits.spec.name, async id => (await targetEdits.reconcile(id)).intent);
	const tools = buildTools({ ...services, builder, searchRuntime: o.searchRuntime, coord: () => coord });
	for (const t of [...tools.all, ...(o.extraTools ?? [])]) toolMap.set(t.name, t);
	toolMap.set(targetEdits.spec.name, targetEdits.spec);

	const toPiTool = (spec, missionId, runId) => ({
		name: spec.name,
		label: spec.label,
		description: spec.description,
		promptSnippet: spec.promptSnippet,
		parameters: spec.parameters,
		executionMode: spec.executionMode,
		async execute(toolCallId, params, signal, onUpdate) {
			const out = await broker.execute({ missionId, runId, toolCallId, toolName: spec.name, input: params, signal, onUpdate });
			return { content: out.content?.length ? out.content : [{ type: "text", text: "ok" }], details: out.details ?? {} };
		},
	});

	const speech = o.speechRuntime ?? createSpeechRuntime({ paths: { dataDir: o.dataDir }, arbiter, residencyBudget });
	for (const [role, model] of [["speech", speech], ["embedding", tools.embeddingRuntime]]) {
		model.setResidencyBudget?.(residencyBudget);
		residencyBudget.register({ role, ...LOCAL_MODEL_BUDGETS[role], inspect: () => model.residency?.() ?? { resident: false, busy: false }, unload: () => model.unload?.() });
	}
	const voiceRequests = new Set();
	const quickVoiceRequests = new Map();
	const speechHolds = new Map();
	const releaseSpeechHold = id => { const hold = speechHolds.get(id); if (!hold) return; speechHolds.delete(id); clearTimeout(hold.timer); hold.release(); };
	const releaseSpeechHolds = () => { for (const id of speechHolds.keys()) releaseSpeechHold(id); };
	let speechSetup;
	tools.resources = createResources({ queue, settings: () => settings, arbiter, stop });
	const speechPolicy = () => speech.setIdleRetention?.(tools.resources.power().onBattery || settings.profile === "quiet" ? 30_000 : 120_000);
	const unsubscribeSpeech = stop.subscribe(event => { if (event.type === "emergency" || event.type === "session" && event.reason) { releaseSpeechHolds(); for (const ac of voiceRequests) ac.abort(); void speech.unload?.(); } });
	coord = createCoordinator({
		...services,
		runtime,
		queue,
		stop,
		live: send,
		toPiTool,
		toolset: (mission) => tools.forMission(mission, settings).map((n) => toolMap.get(n)).filter(Boolean),
		connectorTools: async (mission) => {
			const specs = await tools.mcp.specsFor(mission);
			for (const s of specs) toolMap.set(s.name, s); // the broker dispatches by name
			return specs;
		},
		memory: tools.memory,
		context: tools.context,
		skills: tools.skills,
		attention: tools.attention,
		log,
	});

	// ---- projection and view updates ----
	let projection = reduceAll(emptyProjection(), journal.after(0, 1e9));
	const viewOf = (id) => {
		const m = projection.missions[id];
		if (!m) return undefined;
		const answer = m.answerRef ? journal.getPayload(m.answerRef) ?? "" : "";
		return {
			...m,
			targetAssist: ["selectedTarget", "targetAction"].includes(repo.get(id)?.scope.contextProfile),
			answer,
			steps: m.plan.nodes.map((n) => ({ ...n, state: m.steps[n.id]?.state ?? "todo", note: m.steps[n.id]?.note ?? "" })),
			approvals: m.approvals.map((a) => projection.approvals[a]).filter(Boolean),
			artifacts: Object.values(m.artifacts),
			queued: queue.why(id),
		};
	};
	const snapshot = () => ({
		seq: projection.seq,
		missions: Object.fromEntries(Object.keys(projection.missions).map((id) => [id, viewOf(id)])),
		stack: Object.fromEntries(Object.entries(stackOf(projection)).map(([k, list]) => [k, list.map((m) => m.id)])),
		notifications: Object.values(projection.notifications).filter((n) => n.status === "queued" || n.status === "held"),
		screen: projection.screen,
		watching: tools.watches?.summary() ?? { count: 0 },
		emergency: stop.isEmergency(),
		proactivePaused: stop.proactivePaused(),
		readOnly: store.readOnly,
		settings: { mode: settings.mode, privacy: settings.privacy, profile: settings.profile },
	});
	journal.subscribe((e) => {
		projection = reduce(projection, e);
		send({
			kind: "update",
			seq: e.seq,
			type: e.type,
			missionId: e.missionId || undefined,
			mission: e.missionId ? viewOf(e.missionId) : undefined,
			notifications: e.type.startsWith("notification") ? Object.values(projection.notifications).filter((n) => n.status === "queued" || n.status === "held") : undefined,
			watching: e.type.startsWith("watch.") ? tools.watches.summary() : undefined,
			notificationId: e.type === "notification.created" ? e.payload.id : undefined,
			screen: e.type === "lease.changed" ? projection.screen : undefined,
			stop: e.type === "system.stopped" ? true : undefined,
		});
	});

	// ---- methods (route "host" in contracts/ipc.mjs) ----
	const methods = {
		"builder.request": p => builder.request(p),
		"builder.components": () => builder.components(),
		"theme.current": () => {
			const state = plugins.current(), active = plugins.bindings();
			const chosen = active.bindings["ui.colors"];
			const pin = state.health === "healthy" || chosen.digest === plugins.bases["ui.colors"].digest ? chosen : state.lastGood?.["ui.colors"] ?? plugins.bases["ui.colors"];
			try { return { ...pluginRuntime.themePreset(pin), generation: state.generation }; }
			catch { try { plugins.quarantine(pin, "Color preset unavailable"); } catch {} return { ...pluginRuntime.themePreset(plugins.bases["ui.colors"]), generation: plugins.current().generation, restored: true }; }
		},
		"builder.list": () => builder.list(),
		"builder.get": p => builder.get(p.jobId),
		"builder.cancel": p => builder.cancel(p.jobId),
		"builder.resume": p => builder.resume(p.jobId),
		"builder.activate": p => builder.activate(p),
		"builder.maintenance": p => builder.maintenance(p),
		// Shell-only registration, deliberately absent from renderer IPC. The shell must capture before focus.
		"mission.targetAssist": (p) => {
			if (stop.blocked("target-assist")) throw new Error(stop.blocked("target-assist"));
			if (p.expectedPrivacy !== undefined && p.expectedPrivacy !== settings.privacy) throw new Error("Your privacy setting changed. Capture the selection again.");
			if (typeof p.text !== "string" || !p.text.trim() || p.text.length > 1000) throw new Error("Describe a small edit in up to 1,000 characters.");
			const duplicate = repo.runByRequest(p.requestId) ?? store.get("SELECT id FROM missions WHERE json_extract(scope, '$.pending.requestId') = ?", p.requestId);
			if (duplicate) return { missionId: duplicate.mission_id ?? duplicate.id, duplicate: true };
			const target = targets.capture(p.target);
			try { return coord.createMission({ text: p.text, requestId: p.requestId, privacy: settings.privacy, mode: "ask", title: "Improve selected text", scope: { contextProfile: "selectedTarget", targetId: target.id, targetKind: target.kind, targetDeadline: target.expiresAt, connector: target.connector } }); }
			catch (err) { targets.release(target.id); throw err; }
		},
		// A model response can be reviewed by the shell, but this method never dispatches a native edit.
		"mission.targetProposal": (p) => {
			if (stop.blocked(p.missionId)) throw new Error(stop.blocked(p.missionId));
			const mission = repo.get(p.missionId);
			if (!mission || mission.scope.contextProfile !== "selectedTarget") throw new Error("This task has no selected-target proposal.");
			if (mission.status !== "succeeded" || runtime.isRunning(mission.id)) throw new Error("Wait for a complete quick-edit response before reviewing it.");
			const target = targets.get(mission.scope.targetId);
			return parseTargetProposal(target, viewOf(mission.id).answer);
		},
		"mission.targetPrepare": (p) => {
			const mission = repo.get(p.missionId);
			if (!mission || mission.scope.contextProfile !== "selectedTarget" || mission.status !== "succeeded" || runtime.isRunning(mission.id)) throw new Error("Review a complete selected-target proposal first.");
			return targetEdits.prepareParagraph({ missionId: mission.id, targetId: mission.scope.targetId, answer: viewOf(mission.id).answer, proposalId: p.proposalId });
		},
		"mission.targetCommand": async (p) => {
			if (stop.blocked("target-command")) throw new Error(stop.blocked("target-command"));
			const duplicate = store.get("SELECT id FROM missions WHERE json_extract(scope, '$.nativeRequestId') = ?", p.requestId);
			if (duplicate) return { missionId: duplicate.id, intent: ledger.forMission(duplicate.id).find(i => i.tool === targetEdits.spec.name) };
			const target = targets.capture(p.target);
			if (target.kind !== "chart") { targets.release(target.id); throw new Error("This command needs a selected native chart."); }
			const { missionId } = coord.createMission({ text: p.text, requestId: p.requestId, nativeAction: true, privacy: settings.privacy, mode: "ask", title: "Change selected chart", scope: { targetId: target.id, targetKind: "chart", connector: target.connector } });
			try { return { missionId, intent: await targetEdits.prepareChart({ missionId, targetId: target.id, instruction: p.text }) }; }
			catch (err) { targets.release(target.id); await coord.cancel(missionId); throw err; }
		},
		"mission.targetReconcile": async (p) => {
			const result = await targetEdits.reconcile(p.intentId);
			const mission = repo.get(result.intent.missionId);
			if (mission?.scope.contextProfile === "targetAction" && ["running", "needs-reconciliation"].includes(mission.status) && result.intent.state !== "unknown") {
				if (mission.status === "needs-reconciliation") commit(() => repo.setStatus(mission.id, "running"));
				await coord.verify(mission.id);
			}
			return result;
		},
		"mission.targetApply": async (p) => {
			const result = await targetEdits.apply(p.intentId, p.intentHash);
			const mission = repo.get(result.intent.missionId);
			if (mission?.scope.contextProfile === "targetAction" && ["running", "needs-reconciliation"].includes(mission.status)) {
				if (mission.status === "needs-reconciliation") commit(() => repo.setStatus(mission.id, "running"));
				await coord.verify(mission.id);
			}
			return result;
		},
		"mission.targetUndo": (p) => targetEdits.prepareUndo(p.intentId),
		"mission.targetRelease": (p) => {
			const mission = repo.get(p.missionId);
			if (!["selectedTarget", "targetAction"].includes(mission?.scope.contextProfile)) throw new Error("This task has no quick-edit target.");
			return { released: targets.release(mission.scope.targetId) };
		},
		// Shell-owned page snapshots only; this method is deliberately absent from renderer IPC.
		"mission.pageAssist": (p) => {
			const { page } = p;
			if (!page || !/^app_[a-f\d-]{36}$/.test(page.appId) || typeof page.text !== "string" || page.text.length > 18000 || !p.text?.trim()) throw new Error("Invalid app page context.");
			const duplicate = repo.runByRequest(p.requestId) ?? store.get("SELECT id FROM missions WHERE json_extract(scope, '$.pending.requestId') = ?", p.requestId);
			if (duplicate) {
				const id = duplicate.mission_id ?? duplicate.id;
				if (repo.get(id)?.scope.pageAssistant?.appId !== page.appId || (p.missionId && p.missionId !== id)) throw new Error("This request belongs to another app conversation.");
				return { missionId: id, duplicate: true };
			}
			const context = pageAssistantContext(page);
			const contextEvidence = page.url && page.text ? { kind: "web", source: page.url, locator: { title: page.title, appId: page.appId, profile: page.profile, scope: page.scope }, excerpt: page.text, freshness: page.capturedAt } : undefined;
			if (p.missionId) {
				const mission = repo.get(p.missionId);
				if (mission?.scope.pageAssistant?.appId !== page.appId) throw new Error("This conversation belongs to another app.");
				if (mission.privacy !== settings.privacy) throw new Error("Your model privacy setting changed. Start a new conversation to use the new setting.");
				if (!["succeeded", "partially-succeeded", "failed", "cancelled"].includes(mission.status) || runtime.isRunning(mission.id)) throw new Error("Wait for this response or stop it before sending another.");
				if (contextEvidence) commit(() => evidence.record(mission.id, contextEvidence));
				coord.followUp(mission.id, p.text, p.requestId, context);
				return { missionId: mission.id };
			}
			if (repo.list().some((m) => m.scope.pageAssistant?.appId === page.appId && !["succeeded", "partially-succeeded", "failed", "cancelled"].includes(m.status))) throw new Error("This app already has an active conversation. Finish or stop it first.");
			return coord.createMission({ text: p.text, requestId: p.requestId, context, contextEvidence, mode: "prepare", scope: { pageAssistant: { appId: page.appId } }, trigger: { kind: "user", appId: page.appId, appName: page.appName, profile: page.profile } });
		},
		"mission.create": (p) => coord.createMission({ text: p.text, requestId: p.requestId, mode: p.mode, skill: p.skill, privacy: p.privacy, context: p.context, attachments: p.attachments }),
		"mission.followUp": (p) => coord.followUp(p.missionId, p.text, p.requestId, p.context, p.attachments),
		"mission.steer": (p) => coord.steer(p.missionId, p.text),
		"mission.pause": (p) => coord.pause(p.missionId),
		"mission.resume": (p) => coord.resume(p.missionId),
		"mission.cancel": (p) => coord.cancel(p.missionId),
		"mission.archive": (p) => coord.archive(p.missionId),
		"mission.confirm": (p) => coord.confirm(p.missionId, p.checkId, p.ok),
		"mission.answer": (p) => coord.answer(p.missionId, p.questionId, p.value),
		"mission.extendBudget": (p) => coord.extendBudget(p.missionId),
		"mission.resolveUnknown": (p) => coord.resolveUnknown(p.missionId, p.intentId, p.outcome),
		"mission.checkAgain": async (p) => ({ state: (await broker.reconcile(p.intentId)).state }),
		"mission.saveRecipe": (p) => tools.recipes.capture(p.missionId, p.label),
		"recipe.list": () => tools.recipes.list(),
		"recipe.review": (p) => ({ ok: tools.recipes.markReviewed(p.recipeId) }),
		"recipe.run": (p) => tools.recipes.run(p.recipeId, { requestId: p.requestId }),
		"recipe.exportFile": (p) => tools.recipes.exportFile(p.recipeId), // only the shell's save dialog calls this
		"recipe.importFile": (p) => tools.recipes.importFile(p.routine), // only the shell's open dialog calls this
		"skill.list": () => tools.skills.list(),
		"connector.list": () => tools.connectors.list(),
		"mcp.list": () => tools.mcp.list(),
		"mcp.add": (p) => tools.mcp.add(p), // only the shell calls this, after the user confirms in a system dialog
		"mcp.remove": (p) => tools.mcp.remove(p.id),
		"mcp.setEnabled": (p) => tools.mcp.setEnabled(p.id, p.enabled),
		"mcp.inspect": (p) => tools.mcp.inspect(p.id),
		"mcp.windows": () => tools.discoverWindowsConnectors(),
		"mcp.review": (p) => tools.mcp.review(p.id, p.tool, { digest: p.digest, readOnly: p.readOnly }),
		"artifact.view": (p) => {
			// Only the shell's sandboxed MCP App viewer calls this.
			const a = evidence.artifact(p.artifactId);
			if (!a || a.type !== "mcp-app") throw new Error("no such app view");
			return { path: a.path, name: a.name };
		},
		"stop.emergency": () => {
			tools.fileSearch.cancel();
			return coord.emergencyStop();
		},
		"stop.clear": () => (coord.clearEmergency(), { ok: true }),
		"proactive.pause": (p) => (stop.setProactivePaused(p.paused), { paused: p.paused }),
		"approval.displayed": (p) => ({ ok: approvals.markDisplayed(p.approvalId, p.nonce) }),
		"approval.decide": (p) => coord.decideApproval(p),
		"grant.create": (p) => {
			const g = grants.create(p.draft, "user:rule-editor");
			commit(() => emit("grant.created", { missionId: p.draft.missionId ?? "", payload: { grantId: g.id, label: g.label } }));
			return g;
		},
		"grant.revoke": (p) => {
			const ok = grants.revoke(p.grantId);
			if (ok) commit(() => emit("grant.revoked", { payload: { grantId: p.grantId } }));
			return { ok };
		},
		"grant.list": () => grants.list({ includeInactive: false }),
		"watch.create": (p) => tools.watches.create(p.draft),
		"watch.setPaused": (p) => tools.watches.setPaused(p.watchId, p.paused),
		"watch.delete": (p) => tools.watches.remove(p.watchId),
		"watch.list": () => tools.watches.list(),
		"notification.act": (p) => tools.attention.act(p.notificationId, p.action),
		"memory.list": (p) => tools.memory.list(p.query),
		"memory.remember": (p) => tools.memory.remember(p.text, { kind: p.kind }),
		"memory.correct": (p) => tools.memory.correct(p.memoryId, p.text),
		"memory.forget": (p) => tools.memory.forget(p.memoryId),
		"memory.confirm": (p) => tools.memory.confirm(p.memoryId),
		"memory.export": () => tools.memory.exportAll(),
		"sources.list": () => roots.list(),
		"sources.add": (p) => roots.add(p.path, p.purpose), // only the shell's trusted folder picker calls this
		"data.backup": async () => ({ file: await store.backup() }), // only the shell's updater calls this
		"sources.remove": (p) => {
			const ok = roots.remove(p.rootId);
			tools.fileSearch.removeRoot(p.rootId);
			return { ok };
		},
		"files.status": () => tools.fileSearch.status(),
		"files.setup": async () => {
			const result = await tools.fileSearch.setup();
			tools.context.schedule();
			return result;
		},
		"files.index": () => tools.fileSearch.index(),
		"files.search": (p) => tools.fileSearch.search(p),
		"files.cancel": () => tools.fileSearch.cancel(),
		"files.clear": () => tools.fileSearch.clear(),
		"files.open": async (p) => {
			const result = await tools.fileSearch.resolve(p.id);
			return platform.call("open.searchResult", { path: result.path, kind: result.path.toLowerCase().endsWith(".pdf") ? "pdf" : result.kind, locator: result.locator, reveal: !!p.reveal });
		},
		"artifact.open": (p) => {
			const a = evidence.artifact(p.artifactId);
			if (!a) throw new Error("no such artifact");
			if (a.type === "mcp-app") throw new Error("Open a connector's view from the mission; it is never opened in your browser.");
			return platform.call("open.path", { path: a.publishedPath ?? a.path, reveal: !!p.reveal });
		},
		"query.snapshot": () => snapshot(),
		"query.events": (p) => journal.after(p.afterSeq, 2000),
		"query.mission": (p) => ({
			mission: viewOf(p.missionId),
			evidence: evidence.list(p.missionId).slice(-200),
			actions: ledger.forMission(p.missionId).map((i) => ({ ...i, receipt: ledger.latestReceipt(i.id) })),
			questions: repo.openQuestions(p.missionId),
		}),
		"query.history": (p) => (p.query?.trim() ? repo.search(p.query, { limit: p.limit ?? 50 }) : repo.list({ limit: p.limit ?? 50 })).map((m) => viewOf(m.id)).filter(Boolean),
		"data.export": () => tools.data.exportAll(),
		"data.delete": (p) => {
			if (p.scope === "all") tools.fileSearch.clear();
			return tools.data.remove(p.scope);
		},
		"diagnostics.preview": () => tools.data.diagnostics(),
		// The packaged app's native pieces load: sqlite-vec in the store and ONNX Runtime for local search.
		"diagnostics.native": async () => ({ vector: !!store.vector, onnx: await import("@huggingface/transformers").then(() => true, (err) => err.message) }),
		"voice.status": () => ({ ...speech.status(), progress: speechSetup?.progress }),
		"voice.setup": () => {
			if (speechSetup?.running) return { started: false, reason: "Voice input is already being installed." };
			const job = (speechSetup = { running: true, progress: undefined });
			speech.setup({ onProgress: (p) => (job.progress = { done: p.bytesDone, total: p.bytesTotal }) }).catch((err) => log("voice setup", err.message)).finally(() => (job.running = false));
			return { started: true };
		},
		"voice.transcribe": async (p) => { // only the shell calls this
			const ac = new AbortController(); voiceRequests.add(ac);
			try { return await speech.transcribe(p.samples, { language: p.language, signal: ac.signal }); }
			finally { voiceRequests.delete(ac); }
		},
		"voice.quickTranscribe": async p => { // shell-owned PCM only; absent from renderer IPC contracts
			if (!settings.voice || !settings.pushToTalk || stop.blocked("voice-quick")) throw new Error("Push-to-talk is disabled or stopped.");
			if (!/^ptt_[a-f0-9-]{36}$/.test(p.captureId) || quickVoiceRequests.has(p.captureId) || !(p.samples instanceof Float32Array) || p.samples.length < 1600 || p.samples.length > 480000 || !Number.isFinite(p.deadline) || p.deadline <= Date.now() || p.deadline > Date.now() + 30_000 || ![null, "en", "ms", "zh", "ta", "hi"].includes(p.language)) throw new Error("Invalid bounded push-to-talk request.");
			const ac = new AbortController(), timer = setTimeout(() => ac.abort(), Math.max(1, p.deadline - Date.now())); voiceRequests.add(ac); quickVoiceRequests.set(p.captureId, ac);
			try { return await speech.transcribe(p.samples, { language: p.language, signal: ac.signal, priority: 0, deadline: p.deadline, maxSeconds: 30 }); }
			finally { clearTimeout(timer); voiceRequests.delete(ac); quickVoiceRequests.delete(p.captureId); releaseSpeechHold(p.captureId); p.samples.fill(0); }
		},
		"voice.quickPrepare": async p => { // shell-owned held gesture; no renderer IPC and no audio accepted
			if (!settings.voice || !settings.pushToTalk || settings.perception.enabled || stop.blocked("voice-quick")) throw new Error("Local push-to-talk preparation is disabled or stopped.");
			if (!p || Object.keys(p).some(key => !["captureId", "deadline"].includes(key)) || !/^ptt_[a-f0-9-]{36}$/.test(p.captureId) || quickVoiceRequests.has(p.captureId) || speechHolds.has(p.captureId) || !Number.isFinite(p.deadline) || p.deadline <= Date.now() || p.deadline > Date.now() + 30_000) throw new Error("Invalid bounded push-to-talk preparation.");
			const ac = new AbortController(), timer = setTimeout(() => ac.abort(), Math.max(1, p.deadline - Date.now())); voiceRequests.add(ac); quickVoiceRequests.set(p.captureId, ac);
			try {
				const hold = { release: residencyBudget.pin("speech", p.captureId, p.deadline) }; hold.timer = setTimeout(() => { if (speechHolds.get(p.captureId) === hold) releaseSpeechHold(p.captureId); }, Math.max(1, p.deadline - Date.now())); hold.timer.unref?.(); speechHolds.set(p.captureId, hold);
				return await speech.prepare({ signal: ac.signal, priority: 0, deadline: p.deadline });
			} catch (error) { releaseSpeechHold(p.captureId); throw error; }
			finally { clearTimeout(timer); voiceRequests.delete(ac); quickVoiceRequests.delete(p.captureId); }
		},
		"voice.quickCancel": p => { quickVoiceRequests.get(p.captureId)?.abort(); releaseSpeechHold(p.captureId); return { ok: true }; },
		"perception.status": () => perception.status(),
		"perception.qualify": () => perception.qualify(),
		"perception.observe": async p => { // fixed shell producer only; absent from renderer contract
			try { return await perception.observe(p); } finally { for (const item of p?.media ?? []) { item.samples?.fill(0); item.data?.fill(0); } }
		},
		"perception.cancel": p => { perception.cancel(p.requestId); return { ok: true }; },
		"resources.status": () => { const memory = residencyBudget.status(), weather = tools.resources?.weather(); if (memory.waiting.length && weather) weather.text = "Waiting for local memory"; return { queue: queue.status(), inference: arbiter.status(), memory, profile: settings.profile, weather }; },
	};

	const host = {
		version: RUNTIME_VERSION,
		store,
		coordinator: coord,
		broker,
		ledger,
		grants,
		approvals,
		roots,
		evidence,
		repo,
		queue,
		arbiter,
		targets,
		targetEdits,
		builder,
		perception,
		residencyBudget,
		plugins,
		pluginRuntime,
		runtime,
		tools,
		modelRuntime,
		async handle(method, params = {}) {
			const fn = methods[method];
			if (!fn) throw new Error(`unknown host method ${method}`);
			return fn(params);
		},
		subscribe(fn) {
			outbound.add(fn);
			return () => outbound.delete(fn);
		},
		snapshot,
		viewOf,
		settings: () => settings,
		setSettings(next) {
			const before = settings;
			settings = { ...settings, ...next };
			settings.perception = perceptionSettings(settings.perception);
			if (JSON.stringify(before.perception) !== JSON.stringify(settings.perception) || before.privacy !== settings.privacy) perception.settingsChanged();
			if (["voice", "pushToTalk", "voiceLanguage", "privacy"].some(key => before[key] !== settings[key]) || JSON.stringify(before.perception) !== JSON.stringify(settings.perception)) { for (const ac of quickVoiceRequests.values()) ac.abort(); releaseSpeechHolds(); }
			if (before.voice && !settings.voice) { for (const ac of voiceRequests) ac.abort(); void speech.unload?.(); }
			settings.embedding = embeddingSettings(settings.embedding);
			if (JSON.stringify(before.embedding) !== JSON.stringify(settings.embedding)) {
				const { assist: priorAssist, ...priorSearch } = before.embedding;
				const { assist: nextAssist, ...nextSearch } = settings.embedding;
				if (JSON.stringify(priorSearch) !== JSON.stringify(nextSearch)) tools.fileSearch.cancel();
				tools.context.reset();
			}
			if (JSON.stringify(before.local) !== JSON.stringify(settings.local)) {
				try {
					registerLocalEndpoint(modelRuntime, settings.local);
				} catch (err) {
					log("local endpoint", err.message);
				}
			}
			tools.resources?.apply(settings);
			speechPolicy();
		},
		/** Power, lock and connectivity signals from the shell. */
		signal(s) {
			if (["voice-cancel", "lock-screen", "suspend"].includes(s.type)) { for (const ac of voiceRequests) ac.abort(); releaseSpeechHolds(); }
			tools.resources?.signal(s);
			speechPolicy();
			tools.watches?.signal?.(s);
			if (s.type === "lock-screen" || s.type === "suspend") {
				targets.clear();
				for (const mission of repo.list().filter(m => ["running", "verifying"].includes(m.status))) coord.pause(mission.id).catch(err => log("session pause", err.message));
				speech.unload?.();
				tools.embeddingRuntime?.unload?.();
			}
		},
		async start() {
			builder.recover();
			const r = await coord.recover();
			tools.watches?.start();
			tools.resources?.apply(settings);
			speechPolicy();
			tools.context.schedule();
			residencyBudget.start();
			return r;
		},
		async close() {
			unsubscribeSpeech();
			releaseSpeechHolds();
			const memoryClosed = residencyBudget.close();
			await perception.close();
			await builder.close();
			await sourceCleanup;
			for (const ac of voiceRequests) ac.abort();
			targets.clear();
			arbiter.close();
			await memoryClosed;
			tools.resources?.close();
			tools.watches?.stop();
			await coord.shutdown();
			await tools.mcp?.closeAll();
			await speech.close();
			tools.context.close();
			await tools.fileSearch.close();
			await targetEdits.close();
			for (const id of runtime.running()) await runtime.abort(id).catch(() => {});
			store.close();
		},
		/** Test hook: drop everything without cleanup, as a crash would. */
		crash() {
			queue.close();
			unsubscribeSpeech();
			releaseSpeechHolds(); void residencyBudget.close();
			void perception.close();
			targetEdits.close({ wait: false });
			targets.clear();
			arbiter.close();
			tools.resources?.close();
			speech.close();
			tools.watches?.stop();
			tools.context.close();
			tools.fileSearch.close();
			try {
				store.raw.close();
			} catch {}
			store.release();
		},
		newRequestId: () => newId("req"),
	};
	return host;
}
