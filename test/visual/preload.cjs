// Fixture bridge for visual tests: the same `midnight` API as src/preload.cjs, answered from canned data, plus a
// test hook to push engine events. Never loaded by the app.
const { contextBridge, ipcRenderer } = require("electron");

const listeners = [];
const t = (min) => new Date(Date.UTC(2026, 9, 2, 10, min)).toISOString();
const steps = [
	{ id: "n1", title: "Find the final Q3 workbook", tag: "files", state: "done", note: "" },
	{ id: "n2", title: "Check CRM closed-won deals", tag: "connector", state: "done", note: "East differs: 398 vs 401" },
	{ id: "n3", title: "Chart and report", state: "active", note: "" },
	{ id: "n4", title: "Send to Sam", tag: "approval", state: "todo", note: "" },
];
const feed = [
	{ at: t(1), icon: "◎", cls: "look", text: "files › find *sales*q3* in Sales" },
	{ at: t(1), icon: "◎", cls: "look", text: "sheet › Q3 sales final.xlsx A1:C6" },
	{ at: t(2), icon: "◎", cls: "look", text: "crm › deals {\"quarter\":\"Q3\"}" },
	{ at: t(2), icon: "∑", cls: "look", text: "calculate › Q3 vs Q2 change (%)" },
	{ at: t(3), icon: "✓", cls: "ok", text: "revenue-by-region.svg r1 · validated" },
];
const base = {
	id: "m1",
	title: "Q3 sales brief for Sam",
	goal: "Make the Q3 sales brief and send it to Sam",
	lastInput: "Make the Q3 sales brief and send it to Sam",
	label: "MISSION",
	mode: "ask",
	privacy: "cloud",
	createdAt: t(0),
	updatedAt: t(4),
	trigger: { kind: "user" },
	steps,
	feed,
	actions: {},
	approvals: [],
	artifacts: [{ id: "art1", name: "revenue-by-region.svg", type: "chart", revision: 1, ok: true, issues: [] }],
	sites: [],
	checks: [],
	answer: "",
	plan: { nodes: steps, checks: [] },
};
const answer = "**Q3 revenue rose 10.4% to $1,421k.**\n\n| Region | Q2 | Q3 |\n|---|---|---|\n| North | 412 | 486 |\n| South | 298 | 271 |\n| East | 356 | 401 |\n| West | 221 | 263 |\n\n- East differs between CRM (398k) and the workbook (401k).\n- Chart and report are attached to the draft for Sam.";
const variants = {
	running: { ...base, status: "running" },
	approval: {
		...base,
		status: "waiting-approval",
		approvals: [
			{
				id: "apr1",
				nonce: "n1",
				intentHash: "sha256:x",
				display: {
					title: "Send “Q3 sales brief”",
					verb: "Send now",
					decline: "Keep draft",
					effect: "external.communication",
					effectLabel: "send a message",
					account: "you@work.example",
					recipients: ["sam@example.test"],
					attachments: [
						{ name: "revenue-by-region.svg", revision: 1, hash: "sha256:9f3c1a2b77" },
						{ name: "q3-sales-brief.docx", revision: 2, hash: "sha256:41ab09ce12" },
					],
					preview: "Hi Sam, Q3 revenue rose 10.4%. Chart and report attached.",
					consequence: "1 recipient will receive this. It cannot be unsent.",
					routine: true,
					why: "needs your OK",
				},
			},
		],
	},
	"approval-diff": {
		...base,
		status: "waiting-approval",
		approvals: [{ id: "apr2", nonce: "n2", intentHash: "sha256:y", display: { title: "Save plan.md to C:\\Users\\you\\Documents", verb: "Save", decline: "Decline", effect: "local.write", effectLabel: "save a file", previewKind: "diff", preview: "--- plan.md (now)\n+++ plan.md (after saving)\n # Plan\n-Ship on Thursday\n+Ship on Friday\n Owner: Sam\n(1 line added, 1 removed)", consequence: "This replaces the existing file (a backup is kept).", routine: true } }],
	},
	"approval-submit": {
		...base,
		status: "waiting-approval",
		approvals: [{ id: "apr3", nonce: "n3", intentHash: "sha256:z", display: { title: "Press “Place order” on shop.example", verb: "Allow this click", decline: "Decline", effect: "browser.commit", effectLabel: "submit on a website", consequence: "This may submit a form, send a message or make a purchase on that website.", sends: [{ label: "Email", value: "you@example.test" }, { label: "Password", value: "••••••••" }, { label: "Quantity", value: "2" }], sendsHidden: 3, sendsTo: "shop.example · POST" } }],
	},
	question: { ...base, status: "waiting-input", waiting: { kind: "input", question: { id: "q1", prompt: "Two workbooks look like Q3 sales. Which one is final?", options: ["Q3 sales final.xlsx", "Q3 sales draft.xlsx"] } } },
	reconcile: { ...base, status: "needs-reconciliation", recovery: { finished: ["revenue-by-region.svg r1 (validated)", "q3-sales-brief.docx r2 (validated)"], uncertain: [{ intentId: "act1", title: "Send “Q3 sales brief”", effect: "external.communication" }], next: "Check whether the uncertain action happened before anything is retried." } },
	done: {
		...base,
		status: "succeeded",
		answer,
		steps: steps.map((s) => ({ ...s, state: "done" })),
		actions: { a: { effect: "external.communication", state: "verified" } },
		checks: [
			{ id: "c1", kind: "calculation", label: "Numbers come from a deterministic calculation", state: "passed", detail: "" },
			{ id: "c2", kind: "artifact", label: "A validated chart was produced", state: "passed", detail: "" },
			{ id: "c3", kind: "receipt", label: "An external effect has a verified receipt", state: "passed", detail: "" },
		],
		budget: { text: "41k tokens · $0.086 · 11 actions", spent: { tokens: 41200, costUsd: 0.086, toolCalls: 11 }, limits: { costUsd: 2 } },
		outcome: { status: "succeeded", summary: "3/3 checks passed" },
	},
	partial: {
		...base,
		status: "partially-succeeded",
		answer: "Kept as a draft.",
		checks: [{ id: "c3", kind: "receipt", label: "An external effect has a verified receipt", state: "failed", detail: "the action did not happen" }],
		outcome: { status: "partially-succeeded", summary: "An external effect has a verified receipt: the action did not happen" },
	},
};
let current = variants.running;
const snapshot = () => ({
	seq: 1,
	missions: {
		m1: current,
		m2: { ...variants.done, id: "m2", title: "Tidy Downloads", updatedAt: t(-30) },
		m3: { ...variants.running, id: "m3", title: "Research: laptop batteries", status: "queued", queued: "queued behind another mission", updatedAt: t(2) },
	},
	notifications: [{ id: "n1", title: "Pricing page changed", reason: "the page changed (“Plans and pricing”)", status: "queued", severity: "info" }],
	screen: null,
	watching: { count: 1, next: t(30) },
});
const settings = {
	settings: { corner: "right", textSize: 1, highContrast: false, reducedMotion: true, autoExpand: false, hotkey: "Control+Super", mode: "ask", privacy: "cloud", onboarded: true, thinking: "low", answerLength: "normal", computerUse: "ask", shareContext: true, launchAtLogin: false, instructions: "", searchEngine: "google", fastPages: true, local: { enabled: false }, embedding: { enabled: true, model: "google/embeddinggemma-2", dimensions: 768, device: "cpu", pythonPath: "" }, quietHours: { enabled: true, from: "22:00", to: "07:00" }, budget: { costUsd: 2 }, profile: "balanced", demoConnectors: false },
	accounts: [{ id: "anthropic", name: "Anthropic", oauth: true, apiKey: true, configured: true, source: "stored" }],
	models: [{ provider: "anthropic", providerName: "Anthropic", id: "claude-fable-5-1", name: "Claude Fable 5.1", vision: true }],
	current: { provider: "anthropic", model: "claude-fable-5-1" },
	version: "0.2.0",
	dataDir: "C:\\Users\\you\\AppData\\Roaming\\midnight",
	engine: "ready",
};
const ok = (v) => () => Promise.resolve(v);
const noop = () => Promise.resolve(null);
const dims = { idle: [760, 460], chat: [760, 460], mission: [760, 640], settings: [760, 640], stack: [760, 640], search: [760, 460], read: [940, 900] };
const fileStatus = { state: "ready", busy: false, operation: null, phase: "Ready", error: null, progress: { done: 8, total: 8, file: null, segments: 24 }, counts: { files: 8, segments: 24, kinds: { document: 5, image: 1, audio: 1, video: 1 } }, runtime: { model: "google/embeddinggemma-2", dimensions: 768, device: "cpu", available: true, ready: true }, skipped: 0, truncated: 0, warnings: [], lastIndexedAt: t(0) };
const fileResults = [
	{ id: "fs1", path: "C:\\Users\\you\\Documents\\Sales\\Q3 budget.pdf", name: "Q3 budget.pdf", kind: "document", text: "The Q3 budget allocates additional funding to the East region after revenue grew 10.4%. The updated forecast includes hiring and infrastructure costs.", locator: { page: 3 }, score: .89, match: "both" },
	{ id: "fs2", path: "C:\\Users\\you\\Documents\\Sales\\budget meeting.mp4", name: "budget meeting.mp4", kind: "video", text: "We discussed the regional budget and next quarter's hiring plan.", locator: { seconds: 66, endSeconds: 92, modality: "audio" }, score: .76, match: "semantic" },
	{ id: "fs3", path: "C:\\Users\\you\\Documents\\Sales\\whiteboard.png", name: "whiteboard.png", kind: "image", text: "", locator: { modality: "image" }, score: .71, match: "semantic" },
];
// contextBridge cannot clone proxies: list every method, defaulting to a no-op.
const NS = {
	ui: ["size", "dims", "focus", "hide", "show", "textSize", "strings"],
	clipboard: ["read", "write"],
	attachments: ["fromFiles", "paste", "remove"],
	apps: ["state", "open", "add", "update", "remove", "layout", "command", "ask", "stop", "viewTask"],
	settings: ["get", "set"],
	query: ["snapshot", "events", "mission", "history"],
	missions: ["create", "followUp", "steer", "pause", "resume", "cancel", "archive", "confirm", "answer", "extendBudget", "resolveUnknown", "checkAgain", "saveRecipe"],
	approvals: ["displayed", "decide"],
	watches: ["create", "setPaused", "remove", "list"],
	sources: ["pick", "list", "remove"],
	files: ["status", "setup", "index", "search", "cancel", "clear", "open"],
	grants: ["create", "revoke", "list"],
	memory: ["list", "remember", "correct", "confirm", "forget", "export"],
	recipes: ["list", "review", "run", "export", "import"],
	connectors: ["list", "mcpList", "mcpAdd", "mcpRemove", "mcpSetEnabled", "mcpInspect", "mcpReview", "openApp"],
	skills: ["list"],
	resources: ["status"],
	data: ["clearBrowser", "openFolder", "export", "remove", "diagnostics", "saveDiagnostics"],
	auth: ["login", "cancel", "logout", "answer"],
	stop: ["emergency", "clear"],
	proactive: ["pause"],
	notifications: ["act"],
	artifacts: ["open"],
	engine: ["restart"],
	updates: ["check", "install"],
};
const proxy = (obj) => obj;
const overrides = {};
const calls = [];
const fill = (api) => {
	for (const [k, names] of Object.entries(NS)) {
		api[k] ??= {};
		for (const n of names) {
			const fallback = api[k][n] ?? noop;
			api[k][n] = (...args) => {
				const method = `${k}.${n}`;
				calls.push({ method, args });
				const spec = overrides[method];
				const response = spec?.queue?.length ? spec.queue.shift() : spec;
				const result = response && Object.hasOwn(response, "result") ? Promise.resolve(response.result) : fallback(...args);
				return new Promise((resolve, reject) => setTimeout(() => {
					if (response?.error) reject(new Error(response.error));
					else Promise.resolve(result).then(resolve, reject);
				}, response?.delay ?? 0));
			};
		}
	}
	return api;
};

contextBridge.exposeInMainWorld(
	"midnight",
	fill({
		ui: proxy({ size: (s) => ipcRenderer.invoke("fixture:size", s), dims: ok(dims), focus: noop, textSize: ok(1) }),
		clipboard: proxy({ read: ok(""), write: noop }),
		attachments: proxy({ fromFiles: ok([{ status: "fulfilled", value: { id: "att_1", name: "notes.txt", kind: "text", size: 2048 } }]), paste: ok({ id: "att_2", name: "Pasted picture.jpg", kind: "image", size: 40000, thumbnail: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }), remove: ok({ removed: true }) }),
		apps: proxy({ state: ok({ apps: [] }) }),
		settings: proxy({ get: () => Promise.resolve(settings), set: (patch) => { Object.assign(settings.settings, patch); return Promise.resolve({ settings: settings.settings, current: settings.current }); } }),
		query: proxy({ snapshot: () => Promise.resolve(snapshot()), mission: ok({ evidence: [{ kind: "calculation", source: "Q3 vs Q2 change (%)", locator: {}, capturedAt: t(2), derived: { formula: "round((q3 - q2) / q2 * 100, 1)", inputs: { q2: 1287, q3: 1421 }, result: 10.4 } }], actions: [] }) }),
		missions: proxy({}),
		approvals: proxy({}),
		watches: proxy({ list: ok([{ id: "w1", label: "Pricing page", status: "Watching; next check 10:30", source: { kind: "url" } }]) }),
		sources: proxy({ list: ok([{ id: "r1", path: "C:\\Users\\you\\Documents\\Sales", purpose: "output" }]) }),
		files: proxy({ status: ok(fileStatus), search: ({ kind }) => Promise.resolve({ results: kind ? fileResults.filter((r) => r.kind === kind) : fileResults, mode: "hybrid", status: fileStatus }), setup: ok({ started: true }), index: ok({ started: true }), cancel: ok({ cancelled: true }), clear: ok({ cleared: true }), open: ok({ opened: true }) }),
		grants: proxy({ list: ok([{ id: "g1", label: "Weekly report to Sam", actionClasses: ["external.communication"], destinations: ["sam@example.test"], used: 3, limits: { maxActions: 50 }, expiresAt: t(60 * 24 * 20) }]) }),
		memory: proxy({ list: ok([{ id: "mm1", kind: "preference", text: "Save reports in Documents\\Reports", confirmed: true, uses: 4, why: "You told midnight" }]) }),
		recipes: proxy({ list: ok([]) }),
		connectors: proxy({ list: ok([]) }),
		skills: proxy({ list: ok([]) }),
		resources: proxy({ status: ok({ weather: { text: "1 mission working", profile: "Balanced", power: "plugged in" } }) }),
		data: proxy({}),
		auth: proxy({}),
		stop: proxy({}),
		proactive: proxy({}),
		notifications: proxy({}),
		artifacts: proxy({}),
		engine: proxy({}),
		openExternal: noop,
		peekBrowser: noop,
		on: (fn) => listeners.push(fn),
		onOverlay: () => {},
	}),
);
contextBridge.exposeInMainWorld("__fixture", {
	configure: (patch) => Object.assign(overrides, patch),
	calls: () => calls.slice(),
	emit: (m) => listeners.forEach((fn) => fn(m)),
	variant: (name) => {
		current = variants[name];
		listeners.forEach((fn) => fn({ kind: "ready", snapshot: snapshot() }));
	},
});
