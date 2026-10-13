// Text-only rendering: source and model output cannot create markup, links, commands or bridge calls.
const $ = id => document.getElementById(id);
let view = { phase: "closed", panelId: "" }, busy = false;
function render(next) {
	if (Number.isInteger(next.revision) && next.revision < (view.revision ?? 0)) return;
	if (next.panelId !== view.panelId) { $("error").hidden = true; $("error").textContent = ""; }
	const entering = next.phase === "input" && !next.voicePhase && (view.phase !== "input" || view.panelId !== next.panelId);
	view = next; $("panel").dataset.phase = next.phase;
	if (["closed", "expired"].includes(next.phase)) $("instruction").value = "";
	$("scope").textContent = next.scope ?? ""; $("message").textContent = next.message ?? "";
	$("entry").hidden = next.phase !== "input" || !!next.voicePhase;
	$("captured").textContent = next.source ?? "";
	$("preview").hidden = next.phase !== "preview" || !next.expanded;
	$("before").textContent = next.source ?? ""; $("after").textContent = next.replacement ?? "";
	$("privacy").textContent = next.kind === "chart" ? "This exact chart command runs locally." : next.privacy === "cloud" ? "The selected text, formatting context and your instruction go to your cloud model." : `This request follows your ${next.privacy ?? "local"} model policy.`;
	$("expand").hidden = next.phase !== "preview" || next.expanded;
	$("apply").disabled = busy || !next.canApply;
	$("undo").hidden = next.phase !== "applied";
	$("reconcile").hidden = next.phase !== "unknown";
	$("notice").hidden = !["preview", "applied", "unknown"].includes(next.phase) || (next.phase === "preview" && next.expanded);
	$("submit").disabled = busy || next.phase !== "input" || !!next.voicePhase || !$("instruction").value.trim();
	if (entering) { $("instruction").value = ""; $("instruction").placeholder = next.kind === "chart" ? "Change this bar chart to pie" : "Make this paragraph clearer…"; $("instruction").focus(); }
}
async function act(fn) {
	if (busy) return; busy = true; const panelId = view.panelId;
	$("error").hidden = true; render(view);
	try { await fn(); } catch (err) { if (view.panelId === panelId) { $("error").textContent = err.message; $("error").hidden = false; } }
	finally { busy = false; render(view); }
}
$("instruction").addEventListener("input", () => render(view));
$("submit").addEventListener("click", () => act(() => quick.submit({ panelId: view.panelId, text: $("instruction").value })));
$("expand").addEventListener("click", () => act(() => quick.expand({ panelId: view.panelId })));
$("apply").addEventListener("click", () => act(() => quick.apply({ panelId: view.panelId, proposalId: view.proposalId })));
$("undo").addEventListener("click", () => act(() => quick.undo({ panelId: view.panelId })));
$("reconcile").addEventListener("click", () => act(() => quick.reconcile({ panelId: view.panelId })));
$("dismiss").addEventListener("click", () => quick.dismiss({ panelId: view.panelId }).catch(() => {}));
document.addEventListener("keydown", event => {
	if (event.key === "Escape") { event.preventDefault(); quick.dismiss({ panelId: view.panelId }).catch(() => {}); }
	else if (event.key === "Enter" && !event.shiftKey && !event.isComposing && view.phase === "input" && $("instruction").value.trim()) { event.preventDefault(); $("submit").click(); }
});
quick.on(render);
quick.state().then(render).catch(err => { $("error").textContent = err.message; $("error").hidden = false; });
