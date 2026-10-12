// The local agent host (plan ch. 04): single owner of storage, the Pi runtime, missions, the broker, scheduling and
// budgets. It has no Electron dependency so it runs headless in tests and in an Electron utility process in the app.
// Anything that needs the desktop shell (web windows, screen, secret storage) goes through `platform`.
import fs from "node:fs";
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
import { createQueue } from "../scheduler/queue.mjs";
import { openStore } from "../storage/db.mjs";
import { createJournal } from "../storage/journal.mjs";
import { createUnitOfWork } from "../storage/uow.mjs";
import { buildTools, createResources } from "../tools/index.mjs";
import { createModelRuntime, createPiRuntime, RUNTIME_VERSION } from "./adapter.mjs";
import { registerLocalEndpoint } from "./models.mjs";
import { corePaths, dataPaths } from "./paths.mjs";
import { EMBEDDING_DEFAULTS, embeddingSettings } from "../search/config.mjs";

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
	const platform = o.platform;

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
		modelRuntime,
		sessionsDir: paths.sessions,
		core: o.core ?? corePaths(),
		quiet: () => settings.profile === "quiet",
		onLive: (missionId, e) => send({ kind: "live", missionId, ...e }),
	});

	let coord; // late-bound: broker hooks and tools call into the coordinator
	const missionsForBroker = { get: (id) => repo.get(id) };
	const toolMap = new Map();
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
		hooks: {
			waiting: (m, kind, info) => coord.onWaiting(m, kind, info),
			resumed: (m) => coord.onResumed(m),
			reconcileNeeded: (m) => coord.onReconcileNeeded(m),
		},
	});
	const services = { store, journal, commit, emit, repo, ledger, grants, approvals, budgets, roots, evidence, platform, settings: () => settings, paths, broker, stop, version: RUNTIME_VERSION };
	const tools = buildTools({ ...services, searchRuntime: o.searchRuntime, coord: () => coord });
	for (const t of [...tools.all, ...(o.extraTools ?? [])]) toolMap.set(t.name, t);

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

	const queue = createQueue({ start: (item) => coord.start(item) });
	tools.resources = createResources({ queue, settings: () => settings });
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
		"resources.status": () => ({ queue: queue.status(), profile: settings.profile, weather: tools.resources?.weather() }),
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
		},
		/** Power, lock and connectivity signals from the shell. */
		signal(s) {
			tools.resources?.signal(s);
			tools.watches?.signal?.(s);
		},
		async start() {
			const r = await coord.recover();
			tools.watches?.start();
			tools.resources?.apply(settings);
			tools.context.schedule();
			return r;
		},
		async close() {
			tools.watches?.stop();
			await coord.shutdown();
			await tools.mcp?.closeAll();
			tools.context.close();
			await tools.fileSearch.close();
			for (const id of runtime.running()) await runtime.abort(id).catch(() => {});
			store.close();
		},
		/** Test hook: drop everything without cleanup, as a crash would. */
		crash() {
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
