// The launcher renderer. It shows the engine's projections and never decides outcomes: a mission turns green only when
// the engine says its checks passed; streaming text is shown live, but the record is the engine's.
const $ = (id) => document.getElementById(id);
const cap = $("cap");
const api = window.midnight;

let cur = "idle"; // idle | chat | mission | read | settings | stack | search
let prev = "chat";
let signedIn = false;
let prefs = { textSize: 1, autoExpand: true, highContrast: false, reducedMotion: false, mode: "ask", privacy: "cloud", onboarded: true };
let parked = true; // hidden in the tray; minimizing never discards the current view
const TEXT_SIZES = [0.9, 1, 1.15, 1.3, 1.45, 1.6];

// engine state
let snap = { seq: 0, missions: {}, notifications: [], screen: null, watching: { count: 0 } };
let current; // mission id on screen
const live = {}; // missionId -> { text, streaming }
const lit = {}; // missionId -> Set of connector lights
const runStart = {}; // missionId -> ms (local clock, for the timer)
let engine = "starting";
let timer;
let clip = null;
let clipboardRevision = 0;
const homeDrafts = { chat: "", search: "" };
let hasSearchDraft = false;
let taskFileContext;
let attached = []; // files and pictures for the next task: { id, name, kind, size, thumbnail, truncated }
let continueKey = "";
let readEvidence = false;
let viewRevision = 0;
let settingsRevision = 0;
let stackRevision = 0;
let evidenceRevision = 0;
let snapshotRequest;
const pendingUpdates = new Map();
const renderedContent = new WeakMap();
const command = (e) => e.ctrlKey || e.metaKey;
const commandName = /Mac/.test(navigator.platform) ? "Cmd" : "Ctrl";

function checked(result) {
	if (result?.ok === false) throw new Error(i18n.t(result.error || result.reason || "The request could not be completed."));
	return result;
}
window.checkedResult = checked;

function syncLayers() {
	// The open decision card (approval or question) contains keyboard focus whenever the mission is on screen.
	const decision = (cur === "mission" || cur === "read") && { ask: $("fAsk"), q: $("fQ") }[cap.dataset.f];
	if (decision) focusTrap.contain(decision, { focus: false });
	else focusTrap.release();
	for (const layer of document.querySelectorAll(".lay")) {
		const active = layer.classList.contains(`l-${cur === "read" ? "mission" : cur === "search" ? "chat" : cur}`);
		layer.inert = !active;
		layer.setAttribute("aria-hidden", String(!active));
	}
	for (const [id, active] of [["navHome", cur === "chat" || cur === "search"], ["navMissions", cur === "stack" || cur === "mission" || cur === "read"], ["navSettings", cur === "settings"]]) {
		if (active) $(id).setAttribute("aria-current", "page");
		else $(id).removeAttribute("aria-current");
	}
}

const TERMINAL = new Set(["succeeded", "partially-succeeded", "failed", "cancelled"]);
const RUNNING = new Set(["queued", "planning", "ready", "running", "verifying", "recovering"]);
const NEEDS = new Set(["waiting-input", "waiting-approval", "needs-reconciliation"]);
const mission = () => (current ? snap.missions[current] : undefined);
const reqId = () => `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

// ---------- screen-reader announcements, batched so streaming never floods speech ----------
let say = "";
let sayT;
function announce(t) {
	say = t;
	clearTimeout(sayT);
	sayT = setTimeout(() => ($("live").textContent = say), 600);
}

// ---------- capsule state ----------
async function setState(s) {
	if (s === cur) return;
	wake();
	if (s === "settings" && cur !== "settings") prev = cur;
	const from = cur;
	const revision = ++viewRevision;
	if (from === "chat" || from === "search") homeDrafts[from] = $("box").value;
	if (s === "search" && !hasSearchDraft) {
		homeDrafts.search = (from === "chat" ? homeDrafts.chat : "").slice(0, 1000);
		hasSearchDraft = true;
	}
	cur = s;
	cap.dataset.s = s;
	if (s === "chat" || s === "search") {
		$("box").value = homeDrafts[s];
		renderHomeMode();
	}
	syncLayers();
	if (from === "search") window.fileSearch?.leave();
	if (s === "idle") hideLauncher();
	try { await api.ui.size(s); } catch (err) { showErr(err); }
	if (revision !== viewRevision) return;
	cap.scrollTop = 0;
	if (s === "chat" || s === "search") {
		if (s === "chat") checkClipboard();
		else window.fileSearch?.enter();
		setTimeout(async () => {
			if (revision !== viewRevision) return;
			const movedFocus = () => document.activeElement !== $("box") && document.activeElement.closest?.(".l-chat");
			if (movedFocus()) return;
			try { await api.ui.focus(); } catch (err) { showErr(err); return; }
			if (revision === viewRevision && !movedFocus()) $("box").focus({ preventScroll: true });
		}, 350);
	}
	if (s === "stack") renderStack();
	if ((s === "mission" || s === "read") && from !== "mission" && from !== "read") setTimeout(() => {
		if (revision !== viewRevision) return;
		focusFooter();
		acknowledgeVisibleApproval();
	}, 400);
	if (s !== "read") {
		if (readEvidence) evidenceRevision++;
		readEvidence = false;
		$("evidence").hidden = true;
	}
	cap.dataset.e = s === "read" && readEvidence ? "1" : "";
}

function mood() {
	const m = mission();
	const needs = Object.values(snap.missions).filter((x) => NEEDS.has(x.status) && !x.archived).length;
	const running = Object.values(snap.missions).some((x) => RUNNING.has(x.status));
	let md = "idle";
	if (cur !== "idle" && m) md = NEEDS.has(m.status) ? "ask" : RUNNING.has(m.status) ? "work" : m.status === "succeeded" ? "done" : TERMINAL.has(m.status) ? "warn" : "idle";
	else md = needs ? "ask" : running ? "work" : "idle";
	if (cap.dataset.m !== md) wake();
	cap.dataset.m = md;
	const notes = snap.notifications?.filter((n) => n.status === "queued").length ?? 0;
	const badge = needs + notes;
	$("badge").hidden = !badge;
	$("badge").textContent = String(badge);
	$("badge").title = `${needs} need you${notes ? ` · ${notes} update${notes > 1 ? "s" : ""}` : ""}`;
	let st = "idle";
	if (engine !== "ready") st = engine === "down" ? "engine stopped" : "starting";
	else if (!signedIn) st = "sign in";
	else if (needs) st = "needs you";
	else if (running) st = "working";
	else if (snap.watching?.count) st = snap.watching.next ? `watching · ${new Date(snap.watching.next).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "watching";
	$("idleSt").textContent = st;
	renderContinue();
}

// Quiet idle: the breathing dot rests after a minute without change (it cost ~3% of a core; docs/performance.md).
let restT;
function wake() {
	delete cap.dataset.rest;
	clearTimeout(restT);
	restT = setTimeout(() => (cap.dataset.rest = "1"), 60000);
}
cap.addEventListener("pointerenter", wake);

// Sizes come from main (zoom- and screen-aware) as CSS variables.
async function applyDims() {
	const d = await api.ui.dims();
	for (const [k, [w, h]] of Object.entries(d)) {
		document.documentElement.style.setProperty(`--w-${k}`, `${w}px`);
		document.documentElement.style.setProperty(`--h-${k}`, `${h}px`);
	}
}
function applyPrefs(s) {
	prefs = { ...prefs, ...s };
	document.body.dataset.contrast = prefs.highContrast ? "high" : "";
	document.body.dataset.motion = prefs.reducedMotion ? "reduced" : "";
	const chip = $("chipCtx");
	chip.dataset.p = prefs.privacy;
	chip.textContent = i18n.t(prefs.privacy === "offline" ? "offline" : prefs.privacy === "local" ? "local" : "cloud");
	chip.title = i18n.t(
		prefs.privacy === "cloud"
			? "Your request and the files you let midnight read go to the AI provider you chose. Missions, rules and files stay on this computer."
			: prefs.privacy === "local"
				? "Only your local model runs. Web tools may still fetch public pages."
				: "Offline: local model and local files only. Nothing goes to the network.",
	);
}

// ---------- engine events ----------
function applyUpdate(m) {
	if (m.seq <= snap.seq) return;
	if (m.seq > snap.seq + 1) {
		pendingUpdates.set(m.seq, m);
		return resnapshot(); // a gap: never render a guessed state
	}
	snap.seq = m.seq;
	if (m.mission) {
		const before = snap.missions[m.missionId];
		snap.missions[m.missionId] = m.mission;
		onMissionChange(before, m.mission, m.type);
	}
	if (m.notifications) snap.notifications = m.notifications;
	if (m.watching) snap.watching = m.watching;
	if (m.screen !== undefined) snap.screen = m.screen;
	if (m.missionId === current || m.screen !== undefined) renderMission();
	if (cur === "stack") renderStack();
	mood();
}
function acceptSnapshot(s) {
	if (!s || s.seq < snap.seq) return;
	const before = snap;
	snap = s;
	if (!current) current = latestOpen();
	for (const m of Object.values(s.missions)) onMissionChange(before.missions[m.id], m, "snapshot");
	renderMission();
	if (cur === "stack") renderStack();
	mood();
}
function resnapshot() {
	if (snapshotRequest) return snapshotRequest;
	let received = false;
	snapshotRequest = api.query.snapshot().then((s) => {
		received = true;
		acceptSnapshot(s);
		for (const [seq, update] of [...pendingUpdates].sort(([a], [b]) => a - b)) {
			if (seq <= snap.seq) pendingUpdates.delete(seq);
			else if (seq === snap.seq + 1) {
				pendingUpdates.delete(seq);
				applyUpdate(update);
			}
		}
	}).catch(() => {}).finally(() => {
		snapshotRequest = undefined;
		if (received && pendingUpdates.size) setTimeout(resnapshot, 50);
	});
	return snapshotRequest;
}
async function refreshShellState() {
	const revision = ++settingsRevision;
	try {
		const s = await api.settings.get();
		if (revision !== settingsRevision) return;
		applyPrefs(s.settings);
		window.setAccel(s.settings.hotkey);
		if (s.engine === "ready") {
			signedIn = !!s.current?.model;
			setChip(s.current ?? {});
		} else if (engine !== "ready") engine = s.engine;
		mood();
	} catch {}
}

function onMissionChange(before, m, type) {
	if (RUNNING.has(m.status) && !runStart[m.id]) runStart[m.id] = Date.now();
	if ((type === "run.started" && (!m.runId || before?.runId !== m.runId)) || (type === "snapshot" && m.runId && before?.runId !== m.runId)) {
		live[m.id] = { text: "", streaming: false };
		runStart[m.id] = Date.now();
		lit[m.id] = new Set();
	}
	if (TERMINAL.has(m.status) && live[m.id]) live[m.id].streaming = false;
	if (before?.status !== m.status) {
		if (NEEDS.has(m.status)) announce(`${m.title}: needs you`);
		if (TERMINAL.has(m.status)) {
			announce(`${m.title}: ${m.status.replace("-", " ")}`);
			if (live[m.id]) live[m.id].streaming = false;
			finishView(m);
		}
	}
}

function finishView(m) {
	if (m.trigger?.kind && m.trigger.kind !== "user") return; // proactive work stays quiet: it waits in the queue
	if ((cur === "idle" || parked) && m.id === current) {
		notify(i18n.t(m.status === "succeeded" ? "Done" : m.outcome?.status === "cancelled" ? "Cancelled" : "Needs a look"), m.answer || i18n.t(m.outcome?.summary || ""));
	} else if (m.id === current && cur === "mission" && prefs.autoExpand && m.status === "succeeded" && (m.answer ?? "").length > 1200) {
		setState("read");
	}
}

function onLive(e) {
	const m = snap.missions[e.missionId];
	if (m?.runId && e.runId && m.runId !== e.runId) return;
	const l = (live[e.missionId] ??= { text: "", streaming: false });
	if (e.type === "assistant_start") {
		l.text = "";
		l.streaming = true;
	} else if (e.type === "text") {
		l.text += e.delta;
		l.streaming = true;
	} else if (e.type === "tool_start") {
		const set = (lit[e.missionId] ??= new Set());
		set.add(e.name === "computer" ? "cDesk" : e.name === "user_browser" ? "cYours" : /^(files_|sheet_|file_)/.test(e.name) ? "cFiles" : ["search", "read_pages", "browser"].includes(e.name) ? "cBrowser" : "");
	}
	if (e.missionId === current) {
		if (e.type === "tool_start") renderLights();
		else drawAnswer();
	}
}

api.on((m) => {
	switch (m.kind) {
		case "ready":
			engine = "ready";
			acceptSnapshot(m.snapshot);
			refreshShellState();
			break;
		case "update":
			applyUpdate(m);
			break;
		case "live":
			onLive(m);
			break;
		case "shell":
			onShell(m);
			break;
	}
});

function onShell(m) {
	switch (m.type) {
		case "apps":
			renderPinnedApps(m.apps);
			break;
		case "summon":
			parked = false;
			if (m.restore && cur !== "idle") focusView();
			else summon();
			break;
		case "hidden":
			parked = true;
			break;
		case "shortcut-error":
			showErr(m.error);
			break;
		case "open-settings":
			parked = false;
			openSettings();
			break;
		case "open-mission":
			if (m.missionId) openMission(m.missionId);
			break;
		case "settings":
			settingsRevision++;
			// A new interface language reloads the page; every view is restored from the engine's projection.
			if (prefs.language !== undefined && m.settings.language !== prefs.language) return location.reload();
			applyPrefs(m.settings);
			window.setAccel(m.settings.hotkey);
			break;
		case "model":
			settingsRevision++;
			signedIn = !!m.model;
			setChip(m);
			mood();
			break;
		case "relayout":
			applyDims().then(() => api.ui.size(cur)).catch(showErr);
			break;
		case "screen":
			snap.screen = m.holder ? { missionId: m.holder.missionId, epoch: m.holder.epoch, title: m.holder.title } : null;
			renderStrip();
			break;
		case "takeover": {
			// The shell already revoked the screen; pause the mission you are looking at if it is the one working.
			const target = m.missionId ?? (mission() && RUNNING.has(mission().status) ? current : undefined);
			if (target) api.missions.pause({ missionId: target }).catch(() => {});
			announce(i18n.t("You took over. Midnight stopped using the screen."));
			break;
		}
		case "emergency":
			announce(i18n.t("Emergency stop: nothing new will run until you resume it from the tray."));
			resnapshot();
			break;
		case "update":
			if (m.available) announce(`midnight ${m.latest} is available. Install it from Settings → Data → Updates.`);
			break;
		case "engine":
			engine = m.state;
			settingsRevision++;
			if (m.state === "ready") {
				resnapshot();
				refreshShellState();
			}
			mood();
			renderMission();
			break;
	}
}

// ---------- pieces ----------
const clip40 = (s, n = 40) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const host = (u) => {
	try {
		return new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).host.replace(/^www\./, "");
	} catch {
		return u;
	}
};
const el = (tag, props = {}, ...kids) => {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === "class") e.className = v;
		else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
		else if (v !== undefined && v !== false) e.setAttribute(k, v === true ? "" : ["title", "aria-label", "placeholder"].includes(k) ? i18n.t(v) : v);
	}
	for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(typeof c === "string" ? i18n.t(c) : c));
	return e;
};
const elapsed = (ms) => {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
function tick() {
	const m = mission();
	if (!m) return;
	const t0 = runStart[m.id] ?? Date.parse(m.createdAt);
	const end = TERMINAL.has(m.status) || NEEDS.has(m.status) ? Date.parse(m.updatedAt) : Date.now();
	$("mTime").textContent = elapsed(end - t0);
}

function renderLights() {
	const set = lit[current] ?? new Set();
	for (const id of ["cBrowser", "cFiles", "cYours", "cDesk"]) $(id).classList.toggle("lit", set.has(id));
}
function renderStrip() {
	const s = snap.screen;
	const strip = $("screenStrip");
	strip.hidden = !s;
	if (s) strip.textContent = i18n.t("{title} has the screen · Esc to take over", { title: clip40(snap.missions[s.missionId]?.title ?? s.title ?? i18n.t("A mission"), 34) });
}

const STEP_STATES = { todo: "todo", active: "active", done: "done", skipped: "skipped", failed: "failed" };
function renderSteps(m) {
	const ul = $("steps");
	const key = JSON.stringify([m.id, m.steps]);
	if (renderedContent.get(ul) === key) return;
	renderedContent.set(ul, key);
	ul.textContent = "";
	for (const s of m.steps ?? []) {
		const li = el("li", { "data-st": STEP_STATES[s.state] ?? "todo" }, el("i", { class: "si", "aria-hidden": "true" }), el("div", {}, el("b", {}, s.title), el("span", {}, s.note || s.detail || "")));
		li.setAttribute("aria-label", `${s.title}: ${s.state}`);
		if (s.tag) {
			const tag = el("em", { class: `tag${s.tag === "approval" ? " edge" : ""}` }, s.tag === "approval" ? "asks first" : s.tag);
			li.append(tag);
		}
		ul.append(li);
	}
}
function renderFeed(m) {
	const f = $("feed");
	const existing = new Map([...f.children].map((node) => [node.dataset.key, node]));
	const counts = new Map();
	const rows = [];
	for (const it of (m.feed ?? []).slice(-40)) {
		const key = JSON.stringify([m.id, it]);
		const count = (counts.get(key) ?? 0) + 1;
		counts.set(key, count);
		const rowKey = `${key}:${count}`;
		if (existing.has(rowKey)) {
			rows.push(existing.get(rowKey));
			continue;
		}
		const ts = new Date(it.at);
		const d = el("div", { class: `fl ${it.cls}`, title: it.text }, el("span", { class: "ts" }, `${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}`), el("span", { class: "ic" }, it.icon), el("span", { class: "tx" }, it.text));
		d.dataset.key = rowKey;
		rows.push(d);
	}
	for (const node of [...f.children]) if (!rows.includes(node)) node.remove();
	rows.forEach((node, i) => { if (f.children[i] !== node) f.insertBefore(node, f.children[i] ?? null); });
}
function renderArtifacts(m) {
	const box = $("arts");
	box.textContent = "";
	const list = m.artifacts ?? [];
	box.hidden = !list.length;
	for (const a of list) {
		const b = el(
			"button",
			{ class: a.ok ? "" : "bad", title: `${a.type} · revision ${a.revision}${a.ok ? " · validated" : ` · did not validate: ${a.issues.join("; ")}`}${a.publishedPath ? `\nSaved: ${a.publishedPath}` : ""}\nClick to open · Alt+click to show in folder` },
			`${a.ok ? "✓" : "!"} ${clip40(a.name, 28)} r${a.revision}`,
		);
		b.onclick = (e) => api.artifacts.open(a.id, e.altKey).catch((err) => announce(err.message));
		box.append(b);
	}
}

// ---------- the answer panel ----------
let drawQueued = false;
function drawAnswer() {
	if (drawQueued) return;
	drawQueued = true;
	requestAnimationFrame(() => {
		drawQueued = false;
		const m = mission();
		const node = $("ans");
		if (!m) return (node.hidden = true);
		const l = live[m.id];
		const streaming = !!l?.streaming && !TERMINAL.has(m.status);
		const text = streaming ? l.text : m.answer || l?.text || "";
		if (node.dataset.mission !== m.id) {
			node.dataset.mission = m.id;
			node.scrollTop = 0;
		}
		node.hidden = !text.trim();
		if (node.hidden) return;
		const stick = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
		const key = JSON.stringify([m.id, text, streaming]);
		if (renderedContent.get(node) === key) return;
		renderedContent.set(node, key);
		node.innerHTML = md.render(text) + (streaming ? '<span class="caret"></span>' : "");
		if (streaming && stick) node.scrollTop = node.scrollHeight;
	});
}
$("ans").addEventListener("click", (e) => {
	const copy = e.target.closest(".code-copy");
	if (copy) {
		copyCode(copy, (text) => api.clipboard.write(text));
		return;
	}
	const a = e.target.closest("a[href]");
	if (!a) return;
	e.preventDefault();
	api.openExternal(a.getAttribute("href"));
});

// ---------- mission view ----------
const LABEL = {
	queued: "QUEUED",
	planning: "PLANNING",
	running: "WORKING",
	verifying: "CHECKING",
	recovering: "RECOVERING",
	"waiting-input": "NEEDS YOU",
	"waiting-approval": "NEEDS YOUR OK",
	"waiting-resource": "WAITING",
	"waiting-time": "WAITING",
	paused: "PAUSED",
	"needs-reconciliation": "CHECKING AN ACTION",
	succeeded: "DONE",
	"partially-succeeded": "PARTLY DONE",
	failed: "DIDN'T FINISH",
	cancelled: "CANCELLED",
};
function renderMission() {
	const m = mission();
	clearInterval(timer);
	if (!signedIn && !m) return foot("login");
	if (!m) return;
	$("mTitle").textContent = m.title;
	$("mTitle").title = m.goal ?? m.title;
	$("mLabel").textContent = i18n.t(RUNNING.has(m.status) && m.label && m.label !== "MISSION" ? m.label : LABEL[m.status] ?? m.label ?? "MISSION");
	$("prompt").textContent = m.lastInput ?? m.goal ?? "";
	renderSteps(m);
	renderFeed(m);
	renderLights();
	renderStrip();
	renderArtifacts(m);
	drawAnswer();
	tick();
	if (RUNNING.has(m.status)) timer = setInterval(tick, 1000);
	renderFooter(m);
	mood();
}

function foot(f) {
	const appeared = cap.dataset.f !== f;
	cap.dataset.f = f;
	// A decision (approval, question, confirmation) holds keyboard focus until it is answered or the view changes.
	const card = f === "ask" ? $("fAsk") : f === "q" ? $("fQ") : null;
	// Approvals take focus on the card itself (never on Approve); questions keep focus in their answer input.
	if (card && (cur === "mission" || cur === "read")) focusTrap.contain(card, { focus: f === "ask" && (appeared || focusTrap.active !== card) && !card.contains(document.activeElement) });
	else focusTrap.release();
}

const displayedApprovals = new Map();
const decidingApprovals = new Set();
let visibleApproval;
async function ensureDisplayed(a) {
	const key = `${a.id}:${a.nonce}`;
	if (!displayedApprovals.has(key)) {
		const request = api.approvals.displayed({ approvalId: a.id, nonce: a.nonce }).then(checked).catch((err) => {
			displayedApprovals.delete(key);
			throw err;
		});
		displayedApprovals.set(key, request);
	}
	return displayedApprovals.get(key);
}
function acknowledgeVisibleApproval() {
	if (!visibleApproval || !inMission() || cap.dataset.s !== cur || document.hidden || cap.dataset.f !== "ask") return;
	if (Number(getComputedStyle($("l-mission")).opacity) === 0) return;
	ensureDisplayed(visibleApproval).catch(showErr);
}
document.addEventListener("visibilitychange", acknowledgeVisibleApproval);
function renderFooter(m) {
	visibleApproval = undefined;
	if (engine === "down") {
		$("waitNote").textContent = i18n.t("Midnight's engine stopped. Your missions are saved; restart it to continue.");
		$("waitMain").textContent = i18n.t("Restart engine");
		$("waitMain").onclick = () => api.engine.restart();
		$("waitAlt").hidden = true;
		return foot("wait");
	}
	$("waitAlt").hidden = false;
	if (m.status === "waiting-approval" && m.approvals?.length) return renderApproval(m, m.approvals[0]);
	if (m.status === "waiting-input" && m.waiting?.question) return renderQuestion(m, m.waiting.question);
	if (m.status === "waiting-input" && m.waiting?.kind === "confirm") return renderConfirm(m);
	if (m.status === "needs-reconciliation") return renderReconcile(m);
	if (m.status === "waiting-resource" || m.status === "waiting-time") {
		$("waitNote").textContent = i18n.t(m.waiting?.reason || "Waiting for resources.");
		$("waitMain").textContent = i18n.t(/budget/i.test(m.waiting?.reason ?? "") ? "Extend budget" : "Try now");
		$("waitMain").onclick = () => (/budget/i.test(m.waiting?.reason ?? "") ? api.missions.extendBudget({ missionId: m.id }) : api.missions.resume({ missionId: m.id })).catch(showErr);
		$("waitAlt").textContent = i18n.t("Stop here");
		$("waitAlt").onclick = () => api.missions.cancel({ missionId: m.id }).catch(showErr);
		return foot("wait");
	}
	if (m.status === "paused") {
		$("waitNote").textContent = m.recovery?.finished?.length ? i18n.t("Paused. Finished so far: {items}.", { items: m.recovery.finished.slice(0, 3).join(", ") }) : i18n.t("Paused. Nothing new runs until you resume it.");
		$("waitMain").textContent = i18n.t("Resume");
		$("waitMain").onclick = () => api.missions.resume({ missionId: m.id }).catch(showErr);
		$("waitAlt").textContent = i18n.t("Cancel");
		$("waitAlt").onclick = () => api.missions.cancel({ missionId: m.id }).catch(showErr);
		return foot("wait");
	}
	if (RUNNING.has(m.status)) {
		const note = $("runNote");
		note.textContent = "";
		if (m.status === "queued" && m.queued) note.append(m.queued);
		else if (m.status === "verifying") note.append("checking the result…");
		else if (m.status === "recovering") note.append(m.recovery?.next ?? "recovering after a restart…");
		else note.append("working · ", el("b", {}, "Esc"), " to take over");
		$("stop").textContent = i18n.t(snap.screen?.missionId === m.id ? "Take over" : "Stop");
		return foot("run");
	}
	if (TERMINAL.has(m.status)) return renderDone(m);
	foot("none");
}

/** A plain preview, or a diff with added and removed lines marked for the eye and for screen readers. */
function renderPreview(node, d) {
	node.classList.toggle("diff", d.previewKind === "diff");
	if (d.previewKind !== "diff") return (node.textContent = d.preview ?? "");
	node.replaceChildren(...String(d.preview ?? "").split("\n").map((line) => {
		const kind = /^\+(?!\+\+ )/.test(line) ? "add" : /^-(?!-- )/.test(line) ? "del" : "";
		const span = el("span", { class: kind ? `diff-${kind}` : "" }, document.createTextNode(`${line}\n`));
		if (kind) span.setAttribute("aria-label", `${i18n.t(kind === "add" ? "added" : "removed")}: ${line.slice(1)}`);
		return span;
	}));
}

function renderApproval(m, a) {
	visibleApproval = a;
	const d = a.display ?? {};
	$("askTitle").textContent = i18n.t(d.title ?? "Midnight needs your OK");
	const facts = $("askFacts");
	facts.textContent = "";
	const row = (k, v) => v && facts.append(el("dt", {}, k), el("dd", {}, document.createTextNode(i18n.t(v))));
	row("WHAT", d.effectLabel);
	row("ACCOUNT", d.account);
	if (d.recipients?.length) row(i18n.t("TO ({n})", { n: d.recipients.length }), d.recipients.join(", "));
	if (d.attachments?.length) row("FILES", d.attachments.map((x) => `${x.name} r${x.revision} · ${String(x.hash ?? "").slice(7, 15)}`).join("\n"));
	if (!d.recipients?.length && d.target && !d.plan) row("TARGET", d.target);
	$("askPreviewBox").hidden = !d.preview;
	renderPreview($("askPreview"), d);
	$("askPreviewBox").open = !!d.plan || d.previewKind === "diff";
	const sends = $("askSends");
	sends.hidden = !(d.sends?.length || d.sendsHidden || d.sendsTo);
	sends.replaceChildren(
		el("h6", {}, d.sendsTo ? i18n.t("What will be sent to {to}", { to: d.sendsTo }) : "What will be sent"),
		...(d.sends?.length ? [el("dl", { class: "facts" }, ...d.sends.flatMap((f) => [el("dt", {}, document.createTextNode(f.label)), el("dd", {}, document.createTextNode(f.value || "—"))]))] : [el("p", { class: "hint" }, "No filled-in fields were found; the page or app decides what it sends.")]),
		d.sendsHidden ? el("p", { class: "hint" }, i18n.t("Plus {n} hidden fields the page adds.", { n: d.sendsHidden })) : null,
	);
	$("askConsequence").textContent = i18n.t(d.consequence ?? "");
	$("askWhy").textContent = d.why && d.why !== "needs your OK" ? i18n.t(d.why) : "";
	$("askYes").textContent = i18n.t(d.verb ?? "Approve");
	$("askNo").textContent = i18n.t(d.decline ?? "Decline");
	const send = d.effect === "external.communication";
	$("askEdit").hidden = !send;
	$("askRoutine").hidden = !d.routine || !!d.plan;
	const decide = (decision) => async () => {
		if (!inMission() || current !== m.id || visibleApproval?.id !== a.id || decidingApprovals.has(a.id)) return;
		decidingApprovals.add(a.id);
		for (const b of ["askYes", "askNo", "askEdit", "askRoutine"]) $(b).disabled = true;
		try {
			await ensureDisplayed(a);
			if (!inMission() || current !== m.id || visibleApproval?.id !== a.id) return;
			checked(await api.approvals.decide({ approvalId: a.id, nonce: a.nonce, intentHash: a.intentHash, decision }));
		} catch (err) {
			showErr(err);
			return false;
		} finally {
			decidingApprovals.delete(a.id);
			for (const b of ["askYes", "askNo", "askEdit", "askRoutine"]) $(b).disabled = decidingApprovals.has(visibleApproval?.id);
		}
		return true;
	};
	$("askYes").onclick = decide("approve");
	$("askNo").onclick = decide(send ? "keep-draft" : "decline");
	$("askRoutine").onclick = decide("allow-routine");
	$("askEdit").onclick = async () => {
		if (!(await decide("keep-draft")())) return;
		$("reply").value = i18n.t("Change the draft: ");
		setTimeout(() => $("reply").focus(), 300);
	};
	foot("ask");
	for (const b of ["askYes", "askNo", "askEdit", "askRoutine"]) $(b).disabled = decidingApprovals.has(a.id);
	requestAnimationFrame(acknowledgeVisibleApproval);
}

function renderQuestion(m, q) {
	const key = JSON.stringify([m.id, q]);
	if (renderedContent.get($("qOpts")) === key) return foot("q");
	renderedContent.set($("qOpts"), key);
	$("qText").textContent = q.prompt;
	const box = $("qOpts");
	box.textContent = "";
	let pending = false;
	const answer = async (v) => {
		if (pending) return;
		pending = true;
		const controls = [...box.querySelectorAll("button, textarea")];
		controls.forEach((c) => c.disabled = true);
		try { checked(await api.missions.answer({ missionId: m.id, questionId: q.id, value: v })); }
		catch (err) { showErr(err); }
		finally { pending = false; controls.forEach((c) => c.disabled = false); }
	};
	for (const o of q.options ?? []) box.append(el("button", { class: "pb", onclick: () => answer(o) }, o));
	const inp = el("textarea", { class: "inp", rows: "1", placeholder: q.options?.length ? "Or type an answer… (Enter)" : "Type your answer… (Enter)", "aria-label": "Your answer" });
	inp.onkeydown = (e) => {
		if (e.key === "Enter" && !e.shiftKey && inp.value.trim()) {
			e.preventDefault();
			answer(inp.value.trim());
		}
	};
	box.append(inp);
	foot("q");
}

function renderConfirm(m) {
	renderedContent.delete($("qOpts"));
	const c = (m.checks ?? []).find((x) => x.kind === "confirm" && x.state === "waiting");
	$("qText").textContent = c ? `${i18n.t(c.label)}?` : i18n.t("Does this look right?");
	const box = $("qOpts");
	box.textContent = "";
	box.append(
		el("button", { class: "pb pri", onclick: () => api.missions.confirm({ missionId: m.id, checkId: c?.id ?? "c1", ok: true }).catch(showErr) }, "Yes, it's right"),
		el("button", { class: "pb", onclick: () => api.missions.confirm({ missionId: m.id, checkId: c?.id ?? "c1", ok: false }).catch(showErr) }, "No"),
	);
	foot("q");
}

function renderReconcile(m) {
	const r = m.recovery ?? { finished: [], uncertain: [], next: "" };
	$("recH").textContent = i18n.t(r.uncertain?.length ? "The request may have completed" : "Checking before trying again");
	$("recText").textContent = r.finished?.length ? i18n.t("Finished: {items}.", { items: r.finished.join(", ") }) : i18n.t("Nothing else was finished.");
	const items = $("recItems");
	items.textContent = "";
	for (const u of r.uncertain ?? []) {
		items.append(
			el(
				"div",
				{ class: "item" },
				el("span", { title: u.title }, u.title),
				el("button", { class: "sb", onclick: () => api.missions.checkAgain({ missionId: m.id, intentId: u.intentId }).catch(showErr) }, "Check again"),
				el("button", { class: "sb", onclick: () => api.missions.resolveUnknown({ missionId: m.id, intentId: u.intentId, outcome: "happened" }).catch(showErr) }, "It happened"),
				el("button", { class: "sb", onclick: () => api.missions.resolveUnknown({ missionId: m.id, intentId: u.intentId, outcome: "did-not-happen" }).catch(showErr) }, "It didn't"),
			),
		);
	}
	$("recNext").textContent = r.next ?? "";
	$("recCancel").onclick = () => api.missions.cancel({ missionId: m.id }).catch(showErr);
	foot("rec");
}

const DONE_H = { succeeded: "Done", "partially-succeeded": "Partly done", failed: "Didn't finish", cancelled: "Cancelled" };
function renderDone(m) {
	const o = m.outcome ?? { status: m.status, summary: "" };
	const h = $("doneH");
	h.textContent = i18n.t(DONE_H[m.status] ?? "Finished");
	h.dataset.o = m.status;
	const checks = $("checks");
	checks.textContent = "";
	for (const c of m.checks ?? []) checks.append(el("li", { "data-s": c.state, title: c.detail }, `${c.label}${c.state !== "passed" ? ` — ${c.detail}` : ""}`));
	const rc = $("receipts");
	rc.textContent = "";
	const chip = (t, title) => rc.append(el("span", { title: title ?? "" }, t));
	const steps = m.steps ?? [];
	if (steps.length) chip(i18n.t("{done}/{total} steps reported", { done: steps.filter((s) => s.state === "done").length, total: steps.length }), "Steps the model reported; the checks below are what Midnight verified");
	if (m.sites?.length) chip(`${m.sites.length} site${m.sites.length === 1 ? "" : "s"}`, m.sites.join("\n"));
	if (m.budget?.text) chip(m.budget.text);
	$("doneText").textContent = !m.answer && o.summary ? o.summary : m.status !== "succeeded" && o.summary ? o.summary : "";
	const sends = Object.values(m.actions ?? {}).filter((a) => a.effect === "external.communication" || a.effect === "browser.commit" || a.effect === "connector.write");
	const sent = sends.filter((a) => a.state === "verified").length;
	$("doneSub").textContent = `${$("mTime").textContent} · ${sends.length ? `${sent} of ${sends.length} outside action${sends.length > 1 ? "s" : ""} verified` : "nothing left this computer except your request to the model"}`;
	$("saveRecipe").hidden = m.status !== "succeeded" || !Object.values(m.actions ?? {}).some((a) => a.effect !== "read.web");
	foot("done");
}

function focusFooter() {
	const f = cap.dataset.f;
	if (f === "ask") return $("fAsk").focus({ preventScroll: true }); // read the request first; Enter never approves by default
	const target = { q: "qOpts", rec: "recItems", wait: "waitMain", done: "reply", run: "stop" }[f];
	const node = target && $(target);
	(node?.querySelector?.("button, textarea") ?? node)?.focus?.({ preventScroll: true });
}
function showErr(err) {
	const text = String(err?.message ?? err);
	$("errorText").textContent = text;
	$("uiError").hidden = false;
	announce(text);
}
$("errorDismiss").onclick = () => $("uiError").hidden = true;

// ---------- missions ----------
function latestOpen() {
	const list = Object.values(snap.missions).filter((m) => !m.archived);
	list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
	return (list.find((m) => NEEDS.has(m.status)) ?? list.find((m) => RUNNING.has(m.status)) ?? list[0])?.id;
}
function openMission(id) {
	if (current !== id) {
		$("reply").value = "";
		$("reply").style.height = "";
		$("missionBody").scrollTop = 0;
	}
	current = id;
	evidenceRevision++;
	readEvidence = false;
	$("evidence").hidden = true;
	renderMission();
	setState("mission");
}
async function startMission(text, attachments = []) {
	remember(text);
	try {
		const r = await api.missions.create(attachments.length ? { text, requestId: reqId(), attachments } : { text, requestId: reqId() });
		current = r.missionId;
		live[current] = { text: "", streaming: false };
		lit[current] = new Set();
		runStart[current] = Date.now();
		setState("mission");
		renderMission();
		return true;
	} catch (err) {
		showErr(err);
		const draft = cur === "chat" ? $("box").value : homeDrafts.chat;
		homeDrafts.chat = draft.trim() && !draft.includes(text) ? `${draft}\n\n${text}` : draft || text;
		if (cur === "chat") $("box").value = homeDrafts.chat;
		return false;
	}
}
async function followUp(text) {
	const m = mission();
	if (!m) return startMission(text);
	remember(text);
	try {
		checked(await api.missions.followUp({ missionId: m.id, text, requestId: reqId() }));
		return true;
	} catch (err) {
		showErr(err);
		return false;
	}
}
function newTask() {
	current = undefined;
	setState("chat");
	mood();
}
function copyAnswer() {
	const l = live[current];
	const t = l?.streaming ? l.text : mission()?.answer || l?.text;
	if (!t) return;
	api.clipboard.write(t).then(
		() => ($("copy").textContent = i18n.t("Copied ✓")),
		(err) => { $("copy").textContent = i18n.t("Copy failed"); showErr(err); },
	).finally(() => setTimeout(() => ($("copy").textContent = i18n.t("Copy")), 1400));
}

function notify(title, body) {
	try {
		const n = new Notification(`midnight · ${title}`, { body: String(body).replace(/[#*_`>[\]]/g, "").slice(0, 180), silent: true });
		n.onclick = () => api.ui.show().then(() => setState("mission")).catch(showErr);
	} catch {}
}

// ---------- recent work on the home screen ----------
const HOME_STATUS = {
	queued: "Queued", planning: "Planning", ready: "Ready", running: "Working", verifying: "Checking", recovering: "Recovering",
	"waiting-input": "Needs an answer", "waiting-approval": "Needs approval", "needs-reconciliation": "Needs review",
	"waiting-resource": "Waiting", "waiting-time": "Scheduled", paused: "Paused",
	succeeded: "Completed", "partially-succeeded": "Partly done", failed: "Didn't finish", cancelled: "Cancelled",
};
function renderContinue() {
	const recent = Object.values(snap.missions).filter((m) => !m.archived).sort((a, b) =>
		Number(NEEDS.has(b.status)) - Number(NEEDS.has(a.status)) || String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")) || a.id.localeCompare(b.id),
	).slice(0, 3);
	const key = JSON.stringify(recent.map(({ id, title, status }) => ({ id, title, status })));
	if (key === continueKey) return;
	continueKey = key;
	const target = $("continueMissions");
	const focused = target.contains(document.activeElement) ? document.activeElement.dataset.mission : undefined;
	$("homeContinue").hidden = !recent.length;
	target.replaceChildren(...recent.map((m) => {
		const status = i18n.t(HOME_STATUS[m.status] ?? m.status);
		const kind = NEEDS.has(m.status) ? "needs" : RUNNING.has(m.status) ? "active" : m.status === "succeeded" ? "ok" : TERMINAL.has(m.status) ? "warn" : "idle";
		return el("button", { class: "continue-mission", "data-mission": m.id, "data-k": kind, title: `${m.title} · ${status}`, "aria-label": i18n.t("Open {title}, {status}", { title: m.title, status }), onclick: () => openMission(m.id) },
			el("span", { class: "mission-dot", "aria-hidden": "true" }), el("span", { class: "continue-title" }, m.title),
			el("span", { class: "continue-status" }, status), el("span", { class: "continue-arrow", "aria-hidden": "true" }, "→"));
	}));
	if (focused) (Array.from(target.children).find((button) => button.dataset.mission === focused) ?? $("navMissions")).focus({ preventScroll: true });
}

// ---------- the mission stack ----------
function card(m, kind, sub) {
	return el(
		"button",
		{ class: "card", role: "listitem", "data-k": kind, "data-mission": m.id, onclick: () => openMission(m.id), "aria-label": `${m.title}, ${sub}` },
		el("i", { "aria-hidden": "true" }),
		el("div", {}, el("b", {}, m.title), el("span", {}, sub)),
		el("em", {}, new Date(m.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
	);
}
async function renderStack() {
	const revision = ++stackRevision;
	const list = Object.values(snap.missions).filter((m) => !m.archived);
	const notes = (snap.notifications ?? []).filter((n) => n.status === "queued" || n.status === "held");
	const [watches, resources] = await Promise.all([api.watches.list().catch(() => []), api.resources.status().catch(() => ({}))]);
	if (revision !== stackRevision || cur !== "stack") return;
	const box = document.createDocumentFragment();
	const by = (a, b) => (a.updatedAt < b.updatedAt ? 1 : -1);
	const needs = list.filter((m) => NEEDS.has(m.status)).sort(by);
	const act = list.filter((m) => RUNNING.has(m.status) || ["paused", "waiting-resource", "waiting-time"].includes(m.status)).sort(by);
	const hist = list.filter((m) => TERMINAL.has(m.status)).sort(by).slice(0, 40);
	box.textContent = "";
	const section = (title, items) => {
		box.append(el("h6", {}, title));
		if (!items.length) box.append(el("div", { class: "empty" }, title === "NEEDS YOU" ? "Nothing needs you." : "None."));
		else box.append(...items);
	};
	section("NEEDS YOU", needs.map((m) => card(m, "needs", m.status === "waiting-approval" ? `${i18n.t("needs your OK")} · ${i18n.t(m.approvals?.[0]?.display?.title ?? "")}` : m.status === "needs-reconciliation" ? "an action's outcome is unknown" : m.waiting?.reason || "needs an answer")));
	section("ACTIVE", act.map((m) => card(m, "active", m.status === "paused" ? "paused" : m.queued ?? m.waiting?.reason ?? (m.status === "running" ? "working" : m.status))));
	box.append(el("h6", {}, "WATCHING"));
	if (!watches.length && !notes.length) box.append(el("div", { class: "empty" }, "No watches. Add one in Settings → Watches."));
	for (const n of notes) {
		box.append(
			el(
				"div",
				{ class: "card", "data-k": "watch", role: "listitem" },
				el("i", { "aria-hidden": "true" }),
				el("div", {}, el("b", {}, n.title), el("span", { title: n.reason }, n.status === "held" ? `held for quiet hours · ${n.reason}` : n.reason)),
				el(
					"div",
					{ class: "acts" },
					n.missionId ? el("button", { class: "sb", onclick: () => openMission(n.missionId) }, "Open") : null,
					el("button", { class: "sb", title: "Later", onclick: () => api.notifications.act({ notificationId: n.id, action: "later" }) }, "Later"),
					el("button", { class: "sb", title: "Not useful", onclick: () => api.notifications.act({ notificationId: n.id, action: "not-useful" }) }, "✕"),
				),
			),
		);
	}
	for (const w of watches) box.append(el("div", { class: "card", "data-k": "watch", role: "listitem" }, el("i", { "aria-hidden": "true" }), el("div", {}, el("b", {}, w.label), el("span", {}, w.status)), el("em", {}, "")));
	section("HISTORY", hist.map((m) => card(m, m.status === "succeeded" ? "ok" : "warn", `${i18n.t(DONE_H[m.status] ?? m.status).toLowerCase()}${m.outcome?.summary ? ` · ${i18n.t(m.outcome.summary)}` : ""}`)));
	const target = $("stack");
	const scroll = target.scrollTop;
	const focused = document.activeElement.closest?.("[data-mission]")?.dataset.mission;
	target.replaceChildren(box);
	target.scrollTop = scroll;
	if (focused) [...target.querySelectorAll("[data-mission]")].find((b) => b.dataset.mission === focused)?.focus({ preventScroll: true });
	$("weather").textContent = resources.weather?.text ?? "";
	$("weather").title = resources.weather ? `${resources.weather.profile} · ${resources.weather.power}` : "";
}

// ---------- evidence drawer (reading view) ----------
async function toggleEvidence() {
	const revision = ++evidenceRevision;
	const id = current;
	readEvidence = !readEvidence;
	const box = $("evidence");
	if (!readEvidence) return (box.hidden = true);
	box.hidden = false;
	box.textContent = i18n.t("Loading…");
	try {
		const r = await api.query.mission(id);
		if (revision !== evidenceRevision || current !== id || !readEvidence) return;
		box.textContent = "";
		if (!r.evidence.length) box.append(el("div", { class: "empty" }, "No evidence recorded for this mission."));
		for (const e of r.evidence.slice().reverse()) {
			const where = e.kind === "web" ? e.source : e.kind === "sheet" ? `${e.source.split(/[\\/]/).pop()} › ${e.locator.sheet}!${e.locator.range}` : e.kind === "connector" ? `${e.source} · ${e.locator.account ?? ""} · retrieved ${e.freshness ?? ""}` : e.kind === "calculation" ? "calculation" : e.source;
			const node = el("div", { class: "ev" }, el("small", { title: where }, `${e.kind.toUpperCase()} · ${where} · ${new Date(e.capturedAt).toLocaleString()}`));
			if (e.derived) node.append(el("p", {}, el("code", {}, `${e.derived.formula} = ${e.derived.result}`), `\n${Object.entries(e.derived.inputs).map(([k, v]) => `${k} = ${v}`).join(", ")}`));
			else if (e.excerpt) node.append(el("p", {}, e.excerpt));
			if (e.kind === "web") node.onclick = () => api.openExternal(e.source);
			box.append(node);
		}
	} catch (err) {
		if (revision === evidenceRevision && current === id && readEvidence) box.textContent = String(err.message);
	}
}

// ---------- prompt history (per viewer; optional) ----------
const HKEY = "midnight.history";
let history = [];
try {
	history = JSON.parse(localStorage.getItem(HKEY) ?? "[]");
} catch {}
let hIdx = -1;
function remember(t) {
	history = [t, ...history.filter((x) => x !== t)].slice(0, 30);
	hIdx = -1;
	try {
		localStorage.setItem(HKEY, JSON.stringify(history));
	} catch {}
}

// ---------- clipboard: offer to summarize a copied link or text ----------
async function checkClipboard() {
	const revision = ++clipboardRevision;
	const c = $("chipClip");
	let t = "";
	try {
		t = (await api.clipboard.read()).trim();
	} catch {}
	if (revision !== clipboardRevision) return;
	clip = null;
	if (/^https?:\/\/\S+$/i.test(t)) {
		clip = { kind: "url", value: t };
	} else if (t.length > 280) {
		clip = { kind: "text", value: t };
	}
	c.hidden = !clip || cur === "search";
	if (clip) {
		c.title = clip.kind === "url" ? i18n.t("Prepare a summary of {url}", { url: clip.value }) : i18n.t("Prepare a summary of copied text: {text}…", { text: t.slice(0, 200) });
	}
}
$("chipClip").onclick = () => {
	if (cur !== "chat" || !clip) return;
	const t = clip.kind === "url" ? i18n.t("Summarize this page: {url}", { url: clip.value }) : `${i18n.t("Summarize this text I copied (key points, then anything I should act on):")}\n\n${clip.value}`;
	const box = $("box");
	if (!box.value.includes(t)) box.value = box.value.trim() ? `${box.value}\n\n${t}` : t;
	box.focus();
};

// ---------- input ----------
function renderHomeMode() {
	const files = cur === "search";
	$("homeBrowse").hidden = files;
	$("homeSearch").hidden = !files;
	for (const [id, on] of [["homeAsk", !files], ["homeFiles", files]]) {
		$(id).classList.toggle("on", on);
		$(id).setAttribute("aria-pressed", String(on));
	}
	for (const id of ["chipModel", "chipCtx", "sendTask"]) $(id).hidden = files;
	$("chipClip").hidden = files || !clip;
	$("taskFile").hidden = files || !taskFileContext;
	renderAttachments();
	$("taskFileName").textContent = taskFileContext?.name ?? "";
	$("taskFileName").title = taskFileContext?.text ?? "";
	$("boxLabel").textContent = i18n.t(files ? "Search files on this computer" : "Ask or give a task");
	$("homeFiles").title = i18n.t("Search files on this computer ({key}+K)", { key: commandName });
	$("box").placeholder = files ? i18n.t("Find a file by name, words or a description…") : taskFileContext ? i18n.t("What would you like to do with {name}?", { name: taskFileContext.name }) : i18n.t("Ask a question or give midnight a task…");
	if (files) {
		$("box").maxLength = 1000;
		$("box").setAttribute("aria-controls", "fileResults");
	} else {
		$("box").removeAttribute("maxlength");
		$("box").removeAttribute("aria-controls");
		$("box").removeAttribute("aria-activedescendant");
	}
}
async function submitTask() {
	if (cur !== "chat") return;
	const box = $("box");
	let text = box.value.trim();
	const sending = attached.map((a) => a.id);
	if (!text && sending.length) text = i18n.t("Look at the attached files.");
	if (!text) return;
	const context = taskFileContext;
	if (context && !text.includes(context.text)) text += `\n\nFile context:\n${context.text}`;
	box.value = "";
	if (await startMission(text, sending)) {
		if (taskFileContext === context) taskFileContext = undefined;
		attached = attached.filter((a) => !sending.includes(a.id));
		renderAttachments();
	}
	renderHomeMode();
}

// ---------- files and pictures dropped or pasted into Ask ----------
const fileSize = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
function renderAttachments() {
	const list = $("attachList");
	list.hidden = !attached.length || cur === "search";
	list.replaceChildren(...attached.map((a) => el("div", { class: "attach-chip", role: "listitem", title: a.name },
		a.thumbnail ? el("img", { src: a.thumbnail, alt: "" }) : el("span", { class: "attach-icon", "aria-hidden": "true" }, "▤"),
		el("span", { class: "attach-name" }, a.name),
		el("small", {}, a.truncated ? i18n.t("{size} · first part", { size: fileSize(a.size) }) : fileSize(a.size)),
		el("button", { class: "attach-remove", "aria-label": i18n.t("Remove {name}", { name: a.name }), title: "Remove", onclick: () => removeAttachment(a.id) }, "×"),
	)));
}
function removeAttachment(id) {
	attached = attached.filter((a) => a.id !== id);
	renderAttachments();
	api.attachments.remove(id).catch(() => {});
	$("box").focus({ preventScroll: true });
}
async function attach(promise) {
	try {
		const results = await promise;
		for (const r of Array.isArray(results) ? results : [{ status: "fulfilled", value: results }]) {
			if (r.status === "fulfilled" && r.value?.id) attached.push(r.value);
			else if (r.status === "rejected") showErr(r.reason);
		}
	} catch (err) {
		showErr(err);
	}
	renderAttachments();
	if (cur === "chat") announce(i18n.t("{n} attached", { n: attached.length }));
}
$("box").addEventListener("paste", (e) => {
	if (cur !== "chat") return;
	const files = [...(e.clipboardData?.files ?? [])];
	if (!files.length) return; // plain text pastes normally
	e.preventDefault();
	// A copied file from Explorer has a disk path; a screenshot or copied picture is read from the clipboard by the shell.
	attach(api.attachments.fromFiles(files).then((r) => (r.some((x) => x.status === "fulfilled") || !files.some((f) => f.type.startsWith("image/")) ? r : api.attachments.paste())));
});
let dragDepth = 0;
for (const [type, fn] of Object.entries({
	dragenter: (e) => { if (cur === "chat" && e.dataTransfer?.types?.includes("Files")) { dragDepth++; cap.dataset.drop = "1"; } },
	dragleave: () => { if (--dragDepth <= 0) { dragDepth = 0; delete cap.dataset.drop; } },
	dragover: (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = cur === "chat" ? "copy" : "none"; },
	drop: (e) => {
		e.preventDefault(); // never navigate to a dropped file
		dragDepth = 0;
		delete cap.dataset.drop;
		if (cur === "chat" && e.dataTransfer?.files?.length) attach(api.attachments.fromFiles([...e.dataTransfer.files]));
	},
})) window.addEventListener(type, fn);
$("sendTask").onclick = submitTask;
$("box").onkeydown = (e) => {
	const box = $("box");
	if (e.isComposing) return;
	if (cur === "search" && e.key !== "Escape") return;
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		submitTask();
	} else if (e.key === "Escape") { e.stopPropagation(); hideLauncher(); }
	else if (e.key === "ArrowUp" && (box.selectionStart === 0 || !box.value) && history.length) {
		e.preventDefault();
		hIdx = Math.min(history.length - 1, hIdx + 1);
		box.value = history[hIdx];
	} else if (e.key === "ArrowDown" && hIdx >= 0 && box.selectionStart === box.value.length) {
		e.preventDefault();
		hIdx -= 1;
		box.value = hIdx >= 0 ? history[hIdx] : "";
	}
};
$("reply").onkeydown = async (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		const t = $("reply").value.trim();
		if (!t) return;
		const reply = $("reply");
		const id = current;
		if (reply.disabled) return;
		reply.disabled = true;
		const ok = await followUp(t);
		if (ok && current === id && reply.value.trim() === t) {
			reply.value = "";
			reply.style.height = "";
		}
		reply.disabled = false;
	}
};
$("reply").oninput = () => {
	const r = $("reply");
	r.style.height = "auto";
	r.style.height = `${Math.min(110, r.scrollHeight + 2)}px`;
};

function stepTextSize(dir) {
	let i = TEXT_SIZES.findIndex((v) => v >= prefs.textSize - 0.001);
	if (i < 0) i = TEXT_SIZES.length - 1;
	const next = dir === 0 ? 1 : TEXT_SIZES[Math.max(0, Math.min(TEXT_SIZES.length - 1, i + dir))];
	api.ui.textSize(next).then((v) => applyPrefs({ textSize: v }));
}
const toggleRead = () => {
	if (cur === "read") setState("mission");
	else if (mission()) setState("read");
};
const inMission = () => cur === "mission" || cur === "read";

document.addEventListener("keydown", (e) => {
	const typing = e.target.matches?.("textarea, input");
	if (e.key === "Escape" && !$("uiError").hidden) {
		e.preventDefault();
		$("uiError").hidden = true;
		return;
	}
	if (command(e) && !e.altKey && (e.key === "=" || e.key === "+")) return e.preventDefault(), stepTextSize(1);
	if (command(e) && !e.altKey && e.key === "-") return e.preventDefault(), stepTextSize(-1);
	if (command(e) && !e.altKey && e.key === "0") return e.preventDefault(), stepTextSize(0);
	if (command(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "e" && mission()) return e.preventDefault(), toggleRead();
	if (command(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") return e.preventDefault(), cur === "search" ? window.fileSearch?.focus() : setState("search");
	if (command(e) && !e.altKey && e.shiftKey && e.key.toLowerCase() === "c") return e.preventDefault(), copyAnswer();
	if (command(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "l" && (inMission() || cur === "stack") && !RUNNING.has(mission()?.status)) return e.preventDefault(), newTask();
	if (e.key === "Escape" && (cur === "chat" || cur === "stack" || cur === "settings" || cur === "search" || inMission())) return hideLauncher();
	if (cur === "stack" && !typing && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
		const cards = [...document.querySelectorAll("#stack .card[role=listitem]")].filter((c) => c.tagName === "BUTTON");
		const i = cards.indexOf(document.activeElement);
		cards[Math.max(0, Math.min(cards.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
		return e.preventDefault();
	}
	// 1-9 open the numbered source of a finished answer
	const m = mission();
	if (!typing && !command(e) && !e.altKey && /^[1-9]$/.test(e.key) && m?.answer) {
		const u = md.refs(m.answer)[e.key];
		if (u) api.openExternal(u);
	}
});

function hideLauncher() {
	parked = true;
	api.ui.hide().catch(showErr);
}
for (const id of ["windowMin", "windowClose", "bMin", "bMinStack"]) $(id).onclick = hideLauncher;
$("navHome").onclick = newTask;
$("navMissions").onclick = () => setState("stack");
$("navSettings").onclick = () => openSettings();
for (const [id, state] of [["homeAsk", "chat"], ["homeFiles", "search"]]) $(id).onclick = async () => {
	await setState(state);
	if (cur === state) $("box").focus({ preventScroll: true });
};
$("removeTaskFile").onclick = () => {
	taskFileContext = undefined;
	renderHomeMode();
	$("box").focus({ preventScroll: true });
};
$("bPeek").onclick = () => api.peekBrowser();
$("bRead").onclick = () => (cur === "read" ? toggleEvidence() : toggleRead());
$("bRead").ondblclick = toggleRead;
$("bStack").onclick = () => setState("stack");
$("bStackChat").onclick = () => setState("stack");
$("bNew").onclick = newTask;
$("bLog").onclick = () => {
	if (cap.dataset.log) delete cap.dataset.log;
	else cap.dataset.log = "1";
};
$("stop").onclick = () => {
	const m = mission();
	if (m) api.missions.pause({ missionId: m.id }).catch(showErr);
};
$("pause").onclick = () => {
	const m = mission();
	if (m) api.missions.pause({ missionId: m.id }).catch(showErr);
};
$("again").onclick = newTask;
$("copy").onclick = copyAnswer;
$("saveRecipe").onclick = async () => {
	const m = mission();
	if (!m) return;
	const r = await api.missions.saveRecipe({ missionId: m.id, label: m.title }).catch((err) => ({ ok: false, error: err.message }));
	announce(i18n.t(r.ok ? "Saved as a routine. Review it in Settings → Routines before it runs." : r.error));
	$("saveRecipe").textContent = i18n.t(r.ok ? "Saved ✓" : "Save routine");
};
$("login").onclick = () => openSettings("accounts");
$("gearStack").onclick = () => openSettings();
$("chipModel").onclick = () => openSettings("model");

function openSettings(section) {
	setState("settings");
	window.renderSettings?.(section);
}
function closeSettings() {
	setState(prev === "settings" || prev === "idle" ? (mission() ? "mission" : "chat") : prev);
}
window.closeSettings = closeSettings;

function focusView() {
	if (cur === "chat") checkClipboard();
	api.ui.focus().then(() => {
		if (parked) return;
		if (cur === "chat") $("box").focus({ preventScroll: true });
		else if (cur === "search") window.fileSearch?.focus();
		else if (inMission()) { focusFooter(); acknowledgeVisibleApproval(); }
	}).catch(showErr);
}
function summon() {
	parked = false;
	if (cur === "search") return focusView();
	if (!prefs.onboarded || !signedIn) return openSettings(prefs.onboarded ? "accounts" : "welcome");
	if (cur !== "idle") return focusView();
	const needs = Object.values(snap.missions).filter((m) => NEEDS.has(m.status) && !m.archived);
	if (needs.length === 1) return openMission(needs[0].id);
	if (needs.length > 1) return setState("stack");
	return setState("chat");
}

function setChip(c) {
	$("chipModel").textContent = c.model || "no model";
	mood();
}
window.setAccel = (a) => {
	$("hint").textContent = i18n.t("{key} · Esc hides", { key: a.replace("CommandOrControl", commandName).replace("Control", "Ctrl").replace("Super", "Win") });
};
window.applyPrefs = applyPrefs;
window.missionApi = { openMission, current: () => current };
window.openFileSearch = () => setState("search");
window.fileSearchTask = async (context) => {
	taskFileContext = context;
	await setState("chat");
	renderHomeMode();
	$("box").focus({ preventScroll: true });
};

let pinnedAppsKey = "";
function renderPinnedApps(apps = []) {
	const pinned = apps.filter((a) => a.pinned);
	const key = JSON.stringify(pinned.map(({ id, name, profile }) => ({ id, name, profile })));
	if (key === pinnedAppsKey) return;
	pinnedAppsKey = key;
	$("pinnedApps").replaceChildren(...pinned.map((app) => {
		const button = document.createElement("button");
		button.className = "launcher-app-pin";
		button.append(el("span", { class: "app-icon", "aria-hidden": "true" }, app.name[0]?.toUpperCase() || "W"), el("span", {}, app.name));
		button.title = `${app.name}${app.profile ? ` · ${app.profile}` : ""}`;
		button.setAttribute("aria-label", i18n.t("Open {name}", { name: button.title }));
		button.onclick = () => api.apps.open({ id: app.id }).catch(showErr);
		return button;
	}));
}
$("openApps").onclick = () => api.apps.open({}).catch(showErr);
$("addWebsite").onclick = () => api.apps.open({ add: true }).catch(showErr);

async function init() {
	await i18n.load(api.ui.strings);
	wake();
	api.apps?.state().then((s) => renderPinnedApps(s.apps)).catch(showErr);
	syncLayers();
	await applyDims();
	await api.ui.size("idle");
	await refreshShellState();
	try {
		const s = await api.query.snapshot();
		engine = "ready";
		acceptSnapshot(s);
	} catch {}
	mood();
}
init();
