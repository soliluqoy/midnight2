// Local file search stays in the host; this surface only presents indexed, approved results.
(() => {
	const api = window.midnight;
	const root = document.getElementById("homeSearch");
	const byId = (id) => document.getElementById(id);
	const query = byId("box"), list = byId("fileResults"), preview = byId("filePreview");
	const labels = { document: "Documents", image: "Images", audio: "Audio", video: "Video", other: "Files" };
	let active = false, revision = 0, generation = 0, statusRequest = 0;
	let timer, polling, metadata = {}, sources = [], rows = [], selected, kind = "", mode = "words", warning = "";
	let operation = false, clearing = false, actionError = "";
	const node = (tag, className, text) => {
		const el = document.createElement(tag);
		if (className) el.className = className;
		if (text != null) el.textContent = text;
		return el;
	};
	const checked = (result) => window.checkedResult(result);
	const errorText = (err) => String(err?.message ?? err);
	const clock = (value) => {
		const seconds = Math.max(0, Math.floor(Number(value) || 0));
		return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	};
	function location(row) {
		const loc = row?.locator ?? {};
		if (loc.page != null) return `Page ${loc.page}`;
		if (loc.slide != null) return `Slide ${loc.slide}`;
		if (loc.seconds != null) {
			const time = `${clock(loc.seconds)}${loc.endSeconds != null ? `–${clock(loc.endSeconds)}` : ""}`;
			return loc.modality === "audio" && row.kind === "video" ? `Audio at ${time}` : `At ${time}`;
		}
		if (loc.line != null) return `Line ${loc.line}`;
		return "";
	}
	function reason(row) {
		if (row.match === "filename") return "Matches the file name";
		if (row.match === "words") return "Has your words";
		const loc = row.locator ?? {};
		const meaning = loc.modality === "audio" || row.kind === "audio" ? "Matches what is heard" : loc.modality === "frame" || row.kind === "video" ? "Matches this video moment" : row.kind === "image" ? "Matches the picture" : "Matches the meaning";
		return row.match === "both" ? `${meaning} and your words` : meaning;
	}
	const isVisible = () => active && byId("cap").dataset.s === "search";
	function manage(open) {
		byId("fileManagement").hidden = !open;
		byId("manageSearch").setAttribute("aria-expanded", String(open));
	}
	byId("manageSearch").onclick = () => manage(byId("fileManagement").hidden);
	function statusMessage(text, error = false) {
		byId("fileStatus").textContent = text;
		root.querySelector(".file-progress").dataset.error = String(error);
		if (error) manage(true);
	}
	function renderStatus() {
		const busy = operation || metadata.busy;
		const installed = metadata.runtime?.available || metadata.runtime?.ready;
		const reuse = !installed && metadata.runtime?.cacheReuseAvailable;
		if (busy || !installed || !sources.length || metadata.needsReindex || (!metadata.counts?.segments && metadata.enabled !== false)) manage(true);
		const details = metadata.progress ?? {};
		byId("fileSetup").disabled = !!busy;
		byId("fileIndex").disabled = !!busy || !sources.length || !installed || metadata.enabled === false;
		byId("fileIndex").title = !installed ? "Install local search first" : !sources.length ? "Choose folders first" : metadata.enabled === false ? "Enable meaning search in Settings first" : "Read the selected folders for meaning search";
		byId("fileClear").disabled = !!busy || !(metadata.counts?.segments || metadata.counts?.files);
		byId("fileStop").hidden = !metadata.busy;
		byId("fileSetup").textContent = installed ? "Repair local search" : reuse ? "Use existing Gemma model" : "Install local search";
		byId("fileSetupNote").textContent = installed ? "EmbeddingGemma 2 is installed on this computer. Choose folders, then index them to search their contents by meaning." : reuse ? "Existing Gemma embeddings were found on this computer. Check and reuse them without downloading a model, then index your selected folders. Your previous model cache is preserved; vectors from different versions are kept separate." : "First, install EmbeddingGemma 2 (a one-time download of about 850 MB; nothing else to install). Then choose folders and index them. Indexing and search run on this computer.";
		const progress = byId("fileProgress");
		progress.hidden = !metadata.busy;
		if (details.bytesTotal > 0 && metadata.operation === "setup") {
			progress.max = details.bytesTotal;
			progress.value = Math.min(details.bytesDone ?? 0, details.bytesTotal);
		} else if (details.total > 0) {
			progress.max = details.total;
			progress.value = details.done ?? 0;
		} else progress.removeAttribute("value");
		const activity = byId("fileActivity");
		const notes = [metadata.skipped ? `${metadata.skipped} files skipped` : "", metadata.truncated ? `${metadata.truncated} files partly indexed` : "", ...(metadata.warnings ?? []).slice(0, 1)].filter(Boolean);
		const extra = [];
		if (metadata.busy) {
			if (details.file) extra.push(details.file);
			if (details.locator?.page != null) extra.push(`Page ${details.locator.page}`);
			else if (details.locator?.seconds != null) extra.push(`At ${clock(details.locator.seconds)}`);
			if (details.fileSegments) extra.push(`${details.fileSegments} passages read`);
			if (details.startedAt) extra.push(`${clock((Date.now() - details.startedAt) / 1000)} elapsed`);
		} else extra.push(...notes);
		activity.textContent = extra.join(" · ");
		activity.hidden = !extra.length;
		if (actionError || metadata.error) return statusMessage(actionError || metadata.error, true);
		if (metadata.busy) {
			const phases = { downloading: "Downloading EmbeddingGemma 2", loading: "Loading EmbeddingGemma 2", verifying: "Checking the local model", discovering: "Finding files in your selected folders", embedding: "Reading files for meaning search", cancelled: "Stopping local search" };
			let part = details.total > 0 ? ` · ${details.done ?? 0} of ${details.total} files finished` : "";
			if (details.bytesTotal > 0 && metadata.operation === "setup") {
				const mb = value => (value / 1_000_000).toFixed(1);
				part = ` · ${mb(Math.min(details.bytesDone ?? 0, details.bytesTotal))} / ${mb(details.bytesTotal)} MB`;
			}
			return statusMessage(`${metadata.phase === "cancelled" ? phases.cancelled : details.message || phases[metadata.phase] || (metadata.operation === "setup" ? "Installing local search…" : "Reading selected folders…")}${part}`);
		}
		const count = metadata.counts?.files ?? 0;
		if (metadata.state === "cancelled") return statusMessage("Stopped. Choose Install local search or Index selected folders to continue.");
		if (!installed) return statusMessage(reuse ? "Meaning search needs setup. Click Use existing Gemma model to check the cached model." : "Meaning search needs setup. Click Install local search to begin.");
		if (!sources.length) return statusMessage("Local model installed. Click Choose folders to select what to search.");
		if (metadata.needsReindex && metadata.enabled !== false) return statusMessage("Index selected folders again to use the current local model. Word matches remain available.");
		if (metadata.enabled !== false && !metadata.counts?.segments) return statusMessage("Folders selected. Click Index selected folders to enable meaning search.");
		const ready = metadata.enabled === false ? "Word matches; local meaning search is off" : installed ? "Local meaning search ready" : "Word matches available; local meaning search is not ready";
		statusMessage(`${count} indexed ${count === 1 ? "file" : "files"} in ${sources.length} selected ${sources.length === 1 ? "folder" : "folders"} · ${ready}`);
	}
	async function refreshStatus() {
		const request = ++statusRequest, view = revision;
		try {
			const [next, folders] = await Promise.all([api.files.status(), api.sources.list()]);
			if (!isVisible() || view !== revision || request !== statusRequest) return;
			const wasBusy = metadata.busy;
			metadata = checked(next) ?? {};
			sources = folders ?? [];
			renderStatus();
			if (wasBusy && !metadata.busy && query.value.trim()) schedule(true);
			if (!rows.length && !query.value.trim()) renderResults();
		} catch (err) {
			if (isVisible() && view === revision && request === statusRequest) statusMessage(errorText(err), true);
		}
	}
	function empty(target, title, message) {
		const el = node("div", "file-empty");
		el.append(node("b", "", title), node("span", "", message));
		target.append(el);
	}
	function icon(type) {
		const box = node("span", "file-result-icon");
		box.setAttribute("aria-hidden", "true");
		const paths = { image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>', audio: '<path d="M4 9v6M8 5v14M12 3v18M16 7v10M20 10v4"/>', video: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 8 6 4-6 4Z"/>', document: '<path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V10Z"/><path d="M14 3v7h7M7 14h10M7 18h7"/>' };
		// Icons are fixed application markup, never indexed file contents.
		box.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[type] ?? paths.document}</svg>`;
		return box;
	}
	function renderPreview() {
		preview.replaceChildren();
		const row = rows.find((r) => r.id === selected);
		preview.hidden = !row;
		if (!row) return;
		preview.append(node("h3", "", row.name), node("p", "file-path", row.path));
		const place = location(row);
		if (place) preview.append(node("span", "file-location", place));
		preview.append(node("p", "file-reason", reason(row)));
		const emptyText = row.match === "filename" ? (row.note || "Matches the file name. Its contents have not been searched.") : row.kind === "audio" || row.locator?.modality === "audio" ? "The sound at this moment matched your description. Open it to listen; no transcript was generated." : row.kind === "image" ? "This image matched your description. Open the file to view it." : row.kind === "video" ? "This video frame matched your description. Open the matching moment to view it." : "Open the file to see this result.";
		preview.append(node("p", "file-excerpt", row.text || emptyText));
		const actions = node("div", "file-actions");
		const loc = row.locator ?? {};
		const openTitle = loc.seconds != null ? `Open at ${clock(loc.seconds)}` : loc.page != null ? `Open page ${loc.page}` : "Open";
		for (const [label, fn] of [[openTitle, () => open(false)], ["Show in Explorer", () => open(true)], ["Use in task", useInTask]]) {
			const button = node("button", "sb", label);
			button.type = "button";
			button.onclick = fn;
			actions.append(button);
		}
		preview.append(actions);
	}
	function select(id, scroll = false) {
		selected = id;
		for (const row of list.querySelectorAll(".file-result")) row.setAttribute("aria-selected", String(row.dataset.id === id));
		const chosen = [...list.querySelectorAll(".file-result")].find((r) => r.dataset.id === id);
		if (chosen) {
			list.setAttribute("aria-activedescendant", chosen.id);
			query.setAttribute("aria-activedescendant", chosen.id);
			if (scroll) chosen.scrollIntoView({ block: "nearest" });
		} else {
			list.removeAttribute("aria-activedescendant");
			query.removeAttribute("aria-activedescendant");
		}
		renderPreview();
	}
	function renderResults(searching = false) {
		list.replaceChildren();
		list.setAttribute("aria-busy", String(searching));
		if (!rows.length) {
			empty(list, !sources.length ? "Choose folders to search" : searching ? "Searching…" : query.value.trim() ? "No matches yet" : "Describe what you remember", !sources.length ? "Click Choose folders above. Only the folders you select will be searched." : searching ? "Looking through your selected folders." : query.value.trim() ? "Try a file name, words from it, or a simpler description." : "Index your folders, then search names, text, images, sound or video.");
		} else {
			let group;
			for (const [index, row] of rows.entries()) {
				if (group !== row.kind) { group = row.kind; list.append(node("div", "file-group", labels[group] ?? "Files")); }
				const button = node("button", "file-result");
				button.type = "button";
				button.id = `file-result-${index}`;
				button.dataset.id = row.id;
				button.setAttribute("role", "option");
				button.setAttribute("aria-selected", String(row.id === selected));
				const copy = node("span", "file-result-copy");
				copy.append(node("b", "", row.name), node("small", "", [location(row), reason(row)].filter(Boolean).join(" · ")), node("small", "", row.text || row.path));
				button.append(icon(row.kind), copy);
				button.onclick = () => select(row.id);
				button.ondblclick = () => { select(row.id); open(false); };
				list.append(button);
			}
		}
		select(selected);
		byId("fileSummary").textContent = searching ? "Searching…" : !query.value.trim() ? "Describe what you remember." : `${rows.length} result${rows.length === 1 ? "" : "s"} · ${mode === "hybrid" ? "Words + local meaning" : "Word matches"}${warning ? ` · ${warning}` : ""}`;
		byId("fileSummary").title = byId("fileSummary").textContent;
	}
	function schedule(immediate = false) {
		clearTimeout(timer);
		actionError = "";
		const next = ++generation;
		rows = [];
		selected = undefined;
		warning = "";
		const text = query.value.trim().slice(0, 1000);
		if (!text) return renderResults();
		renderResults(true);
		timer = setTimeout(() => search(next, text), immediate ? 0 : 180);
	}
	async function search(next, text) {
		const view = revision;
		try {
			const result = checked(await api.files.search({ query: text, ...(kind ? { kind } : {}), limit: 40 }));
			if (next !== generation || view !== revision || !isVisible()) return;
			const groups = new Map();
			for (const row of result.results ?? []) { if (!groups.has(row.kind)) groups.set(row.kind, []); groups.get(row.kind).push(row); }
			rows = [...groups.values()].flat();
			selected = rows[0]?.id;
			mode = result.mode ?? "words";
			warning = result.warning ?? "";
			if (result.status) { metadata = result.status; renderStatus(); }
			renderResults();
		} catch (err) {
			if (next !== generation || view !== revision || !isVisible()) return;
			rows = [];
			renderResults();
			actionError = errorText(err); renderStatus();
			byId("fileSummary").textContent = "Search could not finish. Your query is kept; press Enter to retry.";
		}
	}
	async function open(reveal) {
		const row = rows.find((r) => r.id === selected);
		if (!row) return;
		try { checked(await api.files.open({ id: row.id, ...(reveal ? { reveal: true } : {}) })); }
		catch (err) { actionError = errorText(err); renderStatus(); }
	}
	function useInTask() {
		const row = rows.find((r) => r.id === selected);
		if (!row) return;
		const place = location(row);
		window.fileSearchTask({ name: row.name, text: `File: ${row.path}${place ? `\nMatching location: ${place}` : ""}\nI found it by searching: ${query.value.trim()}` });
	}
	async function action(type) {
		if (operation) return;
		operation = true;
		actionError = "";
		renderStatus();
		try {
			if (type === "setup") checked(await api.settings.set({ embedding: { enabled: true } }));
			const result = checked(await api.files[type]());
			if (result?.started === false) actionError = result.reason || "This operation could not start.";
			else await refreshStatus();
		} catch (err) { actionError = errorText(err); }
		finally { operation = false; renderStatus(); }
	}
	query.addEventListener("input", () => { if (isVisible()) schedule(); });
	byId("fileKind").onchange = () => {
		kind = byId("fileKind").value;
		schedule(true);
	};
	byId("l-chat").addEventListener("keydown", (e) => {
		if (e.isComposing || !isVisible() || e.altKey || e.shiftKey || e.key === "Escape") return;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			if (e.ctrlKey || e.metaKey || !rows.length || (e.target !== query && !e.target.closest(".file-result"))) return;
			e.preventDefault();
			const index = rows.findIndex((r) => r.id === selected);
			select(rows[Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))].id, true);
		} else if (e.key === "Enter" && (e.target === query || e.target.closest(".file-result"))) {
			e.preventDefault();
			if (rows.length) open(e.ctrlKey || e.metaKey);
			else schedule(true);
		}
	});
	byId("fileFolders").onclick = async () => {
		try { actionError = ""; checked(await api.sources.pick("source")); await refreshStatus(); if (query.value.trim()) schedule(true); }
		catch (err) { actionError = errorText(err); renderStatus(); }
	};
	byId("fileSetup").onclick = () => action("setup");
	byId("fileIndex").onclick = () => action("index");
	byId("fileStop").onclick = () => action("cancel");
	byId("fileClear").onclick = () => {
		if (clearing) return;
		clearing = true;
		const question = node("span", "file-clear-question", "Remove the local index? Your files stay in place.");
		const yes = node("button", "sb", "Clear"), no = node("button", "sb", "Keep index");
		const close = () => { clearing = false; question.remove(); };
		yes.onclick = async () => { close(); generation++; rows = []; selected = undefined; await action("clear"); renderResults(); };
		no.onclick = close;
		question.append(yes, no);
		byId("fileClear").after(question);
		no.focus();
	};
	window.fileSearch = {
		enter() {
			active = true;
			revision++;
			query.focus({ preventScroll: true });
			renderResults();
			refreshStatus();
			clearInterval(polling);
			polling = setInterval(() => { if (isVisible() && !parked) refreshStatus(); }, 1500);
			if (query.value.trim()) schedule(true);
		},
		leave() { active = false; revision++; generation++; clearTimeout(timer); clearInterval(polling); },
		focus() { query.focus({ preventScroll: true }); refreshStatus(); },
	};
})();
