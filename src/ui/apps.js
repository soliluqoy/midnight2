const $ = (id) => document.getElementById(id);
const api = window.midnightApps;
const end = new Set(["succeeded", "partially-succeeded", "failed", "cancelled"]);
let state = { apps: [], missions: [] }, panelOpen = false, editing, confirming, layoutFrame, lastRevision = -1;
const jobs = new Map(), streams = new Map(), selected = new Map(), prompts = new Map(), submissions = new Map(), sending = new Set();
const currentApp = () => state.apps.find((a) => a.id === state.activeId);
const appJobs = () => [...jobs.values()].filter((m) => m.trigger?.appId === state.activeId && !m.archived).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
const currentJob = () => jobs.get(selected.get(state.activeId));
const busy = () => sending.has(state.activeId) || appJobs().some((m) => !end.has(m.status));
const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const error = (e) => { $("appErrorText").textContent = e.message ?? String(e); $("appError").hidden = false; scheduleLayout(); };
const requestId = () => `req_${crypto.randomUUID()}`;

async function bounds(cover = $("appDialog").open) {
	const rect = $("siteViewport").getBoundingClientRect();
	return api.layout({ x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height, covered: cover || (panelOpen && innerWidth <= 1050) });
}
function scheduleLayout() {
	cancelAnimationFrame(layoutFrame);
	layoutFrame = requestAnimationFrame(() => bounds().catch(() => {}));
}
function setPanel(open) {
	panelOpen = open;
	$("assistant").hidden = !open;
	$("workspace").classList.toggle("assistant-open", open);
	$("assistantToggle").setAttribute("aria-expanded", String(open));
	scheduleLayout();
	if (open) $("appPrompt").focus();
}
function sharingNote() {
	const scope = $("contextScope").value;
	const destination = (currentJob()?.privacy || state.privacy) === "cloud" ? (state.model || "your configured AI model") : "your local model";
	$("sharingNote").textContent = scope === "none"
		? `Your message goes to ${destination}. Earlier shared text stays in this conversation.`
		: (scope === "selection" ? `Selected text goes to ${destination} when you send and is saved in task history. Input fields are excluded.` : `Page text goes to ${destination} when you send and is saved in task history. Input fields are excluded.`);
}
function accept(next) {
	if (next.revision < lastRevision) return;
	lastRevision = next.revision;
	if (state.activeId !== next.activeId) {
		if (state.activeId) prompts.set(state.activeId, $("appPrompt").value);
		$("appPrompt").value = prompts.get(next.activeId) ?? "";
		$("appError").hidden = true;
	}
	state = next;
	jobs.clear();
	for (const m of next.missions ?? []) jobs.set(m.id, m);
	for (const id of streams.keys()) if (!jobs.has(id)) streams.delete(id);
	for (const [id, missionId] of selected) if (missionId && !jobs.has(missionId)) selected.delete(id);
	if (!selected.has(state.activeId)) selected.set(state.activeId, appJobs()[0]?.id);
	render();
}
function render() {
	document.body.classList.toggle("high-contrast", !!state.highContrast);
	document.body.classList.toggle("reduced-motion", !!state.reducedMotion);
	const app = currentApp();
	const pinned = state.apps.filter((a) => a.pinned), saved = state.apps.filter((a) => !a.pinned);
	const appButton = (a) => `<button class="saved-app" data-app="${escape(a.id)}" ${a.id === state.activeId ? 'aria-current="page"' : ""} title="${escape(a.name + (a.profile ? ` · ${a.profile}` : ""))}"><span class="app-initial" aria-hidden="true">${escape(a.name[0]?.toUpperCase() ?? "W")}</span><span class="app-label"><strong>${escape(a.name)}</strong><small>${escape(a.profile || new URL(a.url).hostname)}</small></span></button>`;
	const list = pinned.map(appButton).join("") + (saved.length ? '<p class="saved-heading">Unpinned</p>' + saved.map(appButton).join("") : "");
	if ($("appList").innerHTML !== list) $("appList").innerHTML = list;
	$("emptyState").hidden = !!app;
	$("appTitle").textContent = app ? `${app.name}${app.profile ? ` · ${app.profile}` : ""}` : "Your everyday apps";
	$("siteAddress").textContent = state.page?.url || app?.url || "Add a website to get started";
	$("siteAddress").title = state.page?.url || app?.url || "";
	$("contextLabel").textContent = app ? `${app.name}${app.profile ? ` · ${app.profile}` : ""} · ${state.page?.title || "Current page"}` : "Choose an app";
	$("contextLabel").title = $("contextLabel").textContent;
	for (const id of ["reload", "external", "manage"]) $(id).disabled = !app;
	$("back").disabled = !state.page?.back; $("forward").disabled = !state.page?.forward;
	$("pageError").hidden = !state.page?.error; $("pageError").textContent = state.page?.error || "";
	$("reload").textContent = state.page?.loading ? "…" : "↻";
	sharingNote(); renderConversation(); scheduleLayout();
}
function renderConversation() {
	const m = currentJob(), list = appJobs();
	$("conversationPicker").hidden = list.length === 0;
	const options = '<option value="">New conversation</option>' + list.map((m) => `<option value="${escape(m.id)}">${escape(m.title)}</option>`).join("");
	if ($("conversationSelect").innerHTML !== options) $("conversationSelect").innerHTML = options;
	$("conversationSelect").value = m?.id ?? "";
	const stream = streams.get(m?.id);
	const working = m && !end.has(m.status);
	const answer = working ? stream || "" : m?.answer || stream || "";
	const html = m
		? `<div class="message-question">${escape(m.lastInput || m.goal)}</div><div class="message-answer">${answer ? window.md.render(answer) : '<p class="message-status">' + (working ? escape("Working…") : escape(m.outcome?.summary || "No answer was saved.")) + "</p>"}</div>`
		: `<div class="assistant-empty"><h2>${escape("A little help, right here.")}</h2><p>${escape("Ask about the page or prepare something to copy back into the website.")}</p><button data-prompt="${escape("Summarize this page.")}">${escape("Summarize this page")}</button><button data-prompt="${escape("Help me draft a response to this page.")}">${escape("Help me draft a response")}</button></div>`;
	const box = $("conversation"), nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
	if (box.innerHTML !== html) { box.innerHTML = html; if (nearBottom) box.scrollTop = box.scrollHeight; }
	$("taskActions").hidden = !m;
	$("taskStatus").textContent = m ? ({ succeeded: "Done · answer saved in task history", failed: "Couldn’t finish", "partially-succeeded": "Needs a look", cancelled: "Stopped", paused: "Paused" }[m.status] || "Working…") : "";
	$("stopTask").hidden = !working;
	$("copyAnswer").disabled = !answer || working;
	$("newConversation").disabled = busy();
	$("sendAppPrompt").disabled = !currentApp() || busy();
	$("sendAppPrompt").textContent = sending.has(state.activeId) ? "Sending…" : "Send ↵";
	sharingNote();
}
async function openDialog(item) {
	if ($("appDialog").open) return;
	editing = item?.id;
	confirming = undefined;
	$("dialogTitle").textContent = item ? "App settings" : "Add a website";
	$("dialogNote").textContent = item ? "Rename this app or manage its saved sign-in profile." : "Give it a home in Midnight. Sign in on the website after adding it.";
	$("websiteUrl").value = item?.url ?? ""; $("websiteUrl").disabled = !!item;
	$("websiteName").value = item?.name ?? ""; $("websiteProfile").value = item?.profile ?? "";
	$("manageActions").hidden = !item;
	$("pinApp").textContent = item?.pinned ? "Unpin" : "Pin to launcher";
	$("saveApp").textContent = item ? "Save changes" : "Add website";
	for (const id of ["dialogError", "confirmNote", "confirmDestructive"]) $(id).hidden = true;
	await bounds(true);
	$("appDialog").showModal();
	(item ? $("websiteName") : $("websiteUrl")).focus();
}
function closeDialog() { $("appDialog").close(); scheduleLayout(); }
async function submit(event) {
	event.preventDefault();
	const id = state.activeId, text = $("appPrompt").value.trim(), scope = $("contextScope").value, missionId = currentJob()?.id;
	if (!id || !text || busy()) return;
	sending.add(id); renderConversation();
	const key = JSON.stringify({ text, scope, missionId });
	const pending = submissions.get(id);
	const submission = pending?.key === key ? pending : { key, requestId: requestId() };
	submissions.set(id, submission);
	try {
		const result = await api.ask({ id, text, scope, requestId: submission.requestId, ...(missionId ? { missionId } : {}) });
		selected.set(id, result.missionId); submissions.delete(id); prompts.delete(id);
		if (state.activeId === id && $("appPrompt").value.trim() === text) $("appPrompt").value = "";
		accept(await api.state());
	} catch (err) { error(err); }
	finally { sending.delete(id); renderConversation(); }
}

$("appList").onclick = (event) => { const button = event.target.closest("[data-app]"); if (button) api.open({ id: button.dataset.app }).catch(error); };
$("addApp").onclick = $("emptyAdd").onclick = () => openDialog().catch(error);
$("manage").onclick = () => openDialog(currentApp()).catch(error);
$("closeDialog").onclick = $("cancelDialog").onclick = closeDialog;
$("appDialog").addEventListener("close", scheduleLayout);
$("appForm").onsubmit = async (event) => {
	event.preventDefault(); $("saveApp").disabled = true;
	try {
		const values = { name: $("websiteName").value.trim(), profile: $("websiteProfile").value.trim() };
		if (editing) await api.update({ id: editing, ...values });
		else await api.add({ url: $("websiteUrl").value.trim(), ...values });
		closeDialog(); accept(await api.state());
	} catch (err) { $("dialogError").textContent = err.message; $("dialogError").hidden = false; }
	finally { $("saveApp").disabled = false; }
};
$("pinApp").onclick = async () => {
	try { const item = state.apps.find((a) => a.id === editing); await api.update({ id: item.id, pinned: !item.pinned }); closeDialog(); } catch (err) { error(err); }
};
for (const [id, action, message] of [["signoutApp", "signout", "Close this app’s pages and remove its saved website sign-in?"], ["forgetApp", "forget", "Remove this app and its website data? Saved task conversations remain in history."]]) $(id).onclick = () => {
	confirming = action; $("confirmNote").textContent = message; $("confirmNote").hidden = false; $("confirmDestructive").hidden = false;
};
$("confirmDestructive").onclick = async () => {
	$("confirmDestructive").disabled = true;
	try {
		if (confirming === "forget") await api.remove({ id: editing, forget: true });
		else await api.command({ id: editing, action: "signout" });
		closeDialog(); accept(await api.state());
	} catch (err) { $("dialogError").textContent = err.message; $("dialogError").hidden = false; }
	finally { $("confirmDestructive").disabled = false; }
};
for (const action of ["back", "forward", "reload", "external"]) $(action).onclick = () => api.command({ id: state.activeId, action }).catch(error);
$("assistantToggle").onclick = () => setPanel(!panelOpen);
$("closeAssistant").onclick = () => setPanel(false);
$("contextScope").onchange = sharingNote;
$("askForm").onsubmit = submit;
$("appPrompt").onkeydown = (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) submit(event); };
$("newConversation").onclick = () => { selected.set(state.activeId, ""); renderConversation(); $("appPrompt").focus(); };
$("conversationSelect").onchange = () => { selected.set(state.activeId, $("conversationSelect").value); renderConversation(); };
$("conversation").onclick = (event) => {
	const copy = event.target.closest(".code-copy");
	if (copy) return window.copyCode(copy, (text) => api.command({ action: "copy", text: text.slice(0, 40000) }));
	const prompt = event.target.closest("[data-prompt]");
	if (prompt) { $("appPrompt").value = prompt.dataset.prompt; $("appPrompt").focus(); }
	const link = event.target.closest("a");
	if (link) { event.preventDefault(); api.command({ action: "link", url: link.getAttribute("href") }).catch(error); }
};
$("stopTask").onclick = () => api.stop({ missionId: currentJob().id }).catch(error);
$("viewTask").onclick = () => api.viewTask({ missionId: currentJob().id }).catch(error);
$("copyAnswer").onclick = () => api.command({ action: "copy", text: currentJob()?.answer || streams.get(currentJob()?.id) || "" }).then(() => { $("taskStatus").textContent = "Answer copied"; }).catch(error);
$("dismissError").onclick = () => { $("appError").hidden = true; scheduleLayout(); };
document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "j") { event.preventDefault(); setPanel(!panelOpen); } });
new ResizeObserver(scheduleLayout).observe($("siteViewport"));
window.addEventListener("resize", scheduleLayout);
api.on((message) => {
	if (message.kind === "apps") accept(message.state);
	if (message.kind === "apps-add") openDialog().catch(error);
	if (message.kind === "apps-layout") scheduleLayout();
	if (message.kind === "apps-assistant") setPanel(!panelOpen);
	if (message.kind === "update" && message.mission && message.appRevision >= lastRevision) { lastRevision = message.appRevision; jobs.set(message.mission.id, message.mission); if (message.type === "run.started") streams.delete(message.mission.id); renderConversation(); }
	if (message.kind === "live") {
		if (message.type === "assistant_start") streams.set(message.missionId, "");
		if (message.type === "text") streams.set(message.missionId, (streams.get(message.missionId) || "") + message.delta);
		renderConversation();
	}
});
api.state().then(accept).catch(error);
