(() => {
	const root = document.getElementById("l-settings");
	const api = window.midnight;
	let S; // latest snapshot from main
	let q = ""; // account search
	let busy = ""; // provider id being logged in
	let showAll = false;
	let keyFor = ""; // provider id whose API-key box is open
	let modal; // open auth prompt; kept across re-renders
	let page = "main"; // main | welcome
	let extra = { sources: [], grants: [], watches: [], memory: [], recipes: [], connectors: [], skills: [], changes: [] };
	let changeText = "", changeScope = "user", changeComponent = "midnight.chart";
	const POPULAR = ["openai-codex", "anthropic", "github-copilot", "openai", "google", "xai", "openrouter", "mistral", "deepseek", "groq"];
	let status = { text: "", err: false };
	let updateReady = false;
	let scrollTo;
	let cancelHotkeyCapture;

	const h = (tag, props = {}, ...kids) => {
		const el = document.createElement(tag);
		for (const [k, v] of Object.entries(props)) {
			if (k === "class") el.className = v;
			else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
			else if (v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : v);
		}
		for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(k));
		return el;
	};

	const pretty = (acc) => acc.replace("CommandOrControl", /Mac/.test(navigator.platform) ? "Cmd" : "Ctrl").replace("Control", "Ctrl").replace("Super", "Win");
	const save = async (patch) => {
		try {
			const r = window.checkedResult(await api.settings.set(patch));
			S.settings = r.settings;
			S.current = r.current;
			if (r.error) setStatus(r.error, true);
			if (patch.hotkey && !r.error) window.setAccel(r.settings.hotkey);
			window.applyPrefs?.(r.settings);
			if (patch.perception) extra.perception = await api.perception.status().catch(() => ({}));
			render();
		} catch (err) { setStatus(String(err.message ?? err), true); }
	};
	function setStatus(text, err = false) {
		status = { text, err };
		render();
	}
	const attempt = (fn, ok) => async () => {
		try {
			window.checkedResult(await fn());
			if (ok) setStatus(ok);
		} catch (err) {
			setStatus(String(err.message ?? err), true);
		}
		await loadExtra();
		render();
	};

	async function loadExtra() {
		const safe = (p) => p.catch(() => []);
		const [sources, grants, watches, memory, recipes, connectors, mcp, skills, changes, perception, components] = await Promise.all([
			safe(api.sources.list()),
			safe(api.grants.list()),
			safe(api.watches.list()),
			safe(api.memory.list({})),
			safe(api.recipes.list()),
			safe(api.connectors.list()),
			safe(api.connectors.mcpList()),
			safe(api.skills.list()),
			safe(api.builder?.list() ?? Promise.resolve([])),
			(api.perception?.status() ?? Promise.resolve({})).catch(() => ({})),
			safe(api.builder?.components?.() ?? Promise.resolve([])),
		]);
		extra = { sources, grants, watches, memory, recipes, connectors, mcp, skills, changes, perception, components };
	}
	async function refresh() {
		S = await api.settings.get();
		await loadExtra();
		render();
	}

	// In-page dropdown: native <select> popups don't open reliably in a transparent frameless window.
	let openMenu;
	const closeMenu = () => {
		openMenu?.remove();
		openMenu = undefined;
	};
	document.addEventListener("pointerdown", (e) => {
		if (openMenu && !e.target.closest(".dd-menu, .dd")) closeMenu();
	});
	function dropdown({ value, groups, onPick, empty = "—", label }) {
		const all = groups.flatMap((g) => g.items);
		const cur = all.find((i) => i.value === value);
		const btn = h("button", { class: "dd", type: "button", "aria-haspopup": "listbox", "aria-label": label }, h("span", {}, cur ? cur.label : empty), h("i", { "aria-hidden": "true" }, "▾"));
		btn.onclick = () => {
			if (openMenu && !openMenu.isConnected) closeMenu();
			if (openMenu) return closeMenu();
			const menu = h("div", { class: "dd-menu", role: "listbox" });
			for (const g of groups) {
				if (g.label) menu.append(h("div", { class: "dd-g" }, g.label));
				for (const it of g.items) {
					menu.append(
						h("button", { class: `dd-i${it.value === value ? " sel" : ""}`, type: "button", role: "option", "aria-selected": String(it.value === value), onclick: () => { closeMenu(); value = it.value; btn.querySelector("span").textContent = it.label; onPick(it.value); } }, it.label, it.hint ? h("small", {}, it.hint) : null),
					);
				}
			}
			root.append(menu);
			openMenu = menu;
			const r = btn.getBoundingClientRect(), rr = root.getBoundingClientRect();
			const room = rr.bottom - r.bottom - 8;
			const up = room < 200 && r.top - rr.top > room;
			menu.style.maxHeight = `${Math.max(120, Math.min(260, up ? r.top - rr.top - 8 : room))}px`;
			menu.style.right = `${rr.right - r.right}px`;
			menu.style.minWidth = `${Math.max(160, r.width)}px`;
			if (up) menu.style.bottom = `${rr.bottom - r.top + 4}px`;
			else menu.style.top = `${r.bottom - rr.top + 4}px`;
			(menu.querySelector(".sel") ?? menu.querySelector("button"))?.focus();
		};
		return btn;
	}
	function toggle(on, fn, label) {
		return h("button", { class: `switch${on ? " on" : ""}`, role: "switch", "aria-checked": String(on), "aria-label": label, onclick: fn });
	}
	function segmented(value, items, onPick, label) {
		const group = h(
			"div",
			{ class: "seg", role: "radiogroup", "aria-label": label },
			...items.map((it) => h("button", { class: it.value === value ? "on" : "", role: "radio", "aria-checked": String(it.value === value), title: it.title ?? "", onclick: () => {
				value = it.value;
				[...group.children].forEach((button, i) => {
					button.classList.toggle("on", items[i].value === value);
					button.setAttribute("aria-checked", String(items[i].value === value));
				});
				onPick(it.value);
			} }, it.label)),
		);
		return group;
	}
	const field = (label, sub, control) => h("div", { class: "field" }, h("label", {}, label, sub ? h("small", {}, sub) : null), control);
	const sec = (id, title, ...kids) => h("div", { class: "sec", id: `sec-${id}` }, h("h6", {}, title), ...kids);

	// ---------- first run: what goes where, model, folders, autonomy ----------
	function welcome() {
		const signedIn = !!S.current?.model;
		return h(
			"div",
			{ class: "sbody", "data-tab": "welcome" },
			sec(
				"welcome",
				"WELCOME",
				h("p", { class: "hint" }, "midnight runs on this computer: your missions, rules, files and memory stay here. When it works on a task, your request and the parts of files you let it read go to the AI model you choose. A cloud model's provider receives that text; a local model keeps it on this computer."),
				h("p", { class: "hint" }, "Nothing is sent, saved over, bought or posted without either a rule you created or your OK on the exact action."),
			),
			sec("w-model", "1 · CHOOSE A MODEL", signedIn ? h("p", { class: "hint" }, `Ready: ${S.current.model}.`) : h("p", { class: "hint warn" }, "Sign in below (Accounts) or set up a local model under Models."), modelSection(true)),
			sec(
				"w-folders",
				"2 · CHOOSE FOLDERS (OPTIONAL)",
				h("p", { class: "hint" }, "midnight can only read folders you pick here. Skip this for web-only use."),
				h("div", { class: "row" }, h("button", { class: "sb", onclick: attempt(() => api.sources.pick("source"), "Folder added.") }, "Add a folder to read"), h("button", { class: "sb", onclick: attempt(() => api.sources.pick("output"), "Folder added.") }, "Add a folder for drafts")),
				...extra.sources.map((s) => h("p", { class: "hint" }, `${s.purpose === "output" ? "drafts → " : "reads "}${s.path}`)),
			),
			sec("w-mode", "3 · HOW MUCH MIDNIGHT DOES ON ITS OWN", autonomyField()),
			h("div", { class: "row2" }, h("button", { class: "sb pri", onclick: async () => { await save({ onboarded: true }); page = "main"; window.closeSettings(); } }, signedIn ? "Start" : "Finish later")),
			accountsSection(),
		);
	}

	function autonomyField() {
		const st = S.settings;
		return h(
			"div",
			{},
			segmented(st.mode, [{ value: "ask", label: "Ask me" }, { value: "prepare", label: "Prepare for me" }, { value: "rules", label: "Act within my rules" }], (v) => save({ mode: v }), "Autonomy"),
			h("p", { class: "hint" }, st.mode === "ask" ? "Reads run freely. Anything that changes files or leaves the computer asks first." : st.mode === "prepare" ? "Also saves drafts into your drafts folders. Sending or posting still asks unless a rule covers it." : "Actions a rule covers run without asking, and watches may prepare drafts. Everything else asks."),
		);
	}

	// A list's "Add…" button, or its form once opened. The form closes on Cancel or after a successful add.
	const adding = {};
	function adder(key, label, form) {
		if (!adding[key]) return h("div", { class: "row" }, h("button", { class: "sb", onclick: () => { adding[key] = true; render(); } }, label));
		return h("div", { class: "sform" }, ...form(), h("div", { class: "row2" }, h("button", { class: "sb", onclick: () => { adding[key] = false; render(); } }, "Cancel"), h("button", { class: "sb pri", "data-submit": key, onclick: attempt(async () => { const r = window.checkedResult(await form.submit()); adding[key] = false; return r; }, form.done) }, form.action)));
	}

	// ---------- General ----------
	function autonomySection() {
		const st = S.settings;
		return sec(
			"autonomy",
			"AUTONOMY",
			autonomyField(),
			field("Desktop control", "Mouse and keyboard, only through a plan you approve. Esc takes over.", toggle(st.computerUse !== "never", () => save({ computerUse: st.computerUse === "never" ? "ask" : "never" }), "Desktop control")),
		);
	}

	function answersSection() {
		const st = S.settings;
		const ta = h("textarea", { class: "sta", placeholder: "e.g. Reply in Spanish. Prefer official sources. Keep answers under 5 lines.", "aria-label": "Standing instructions", onchange: (e) => save({ instructions: e.target.value }) });
		ta.value = st.instructions;
		return sec(
			"answers",
			"ANSWERS",
			field("Length", "", segmented(st.answerLength, [{ value: "brief", label: "Brief" }, { value: "normal", label: "Normal" }, { value: "detailed", label: "Detailed" }], (v) => save({ answerLength: v }), "Answer length")),
			field("Standing instructions", "Added to every mission", null),
			ta,
		);
	}

	function launcherSection() {
		const st = S.settings;
		return sec(
			"launcher",
			"LAUNCHER",
			field("Summon shortcut", "For Ctrl+Win, press both keys and release", hotkeyButton()),
			field("Know where I was", "Share the window or page you were on when you opened midnight", toggle(st.shareContext, () => save({ shareContext: !st.shareContext }), "Know where I was")),
			field("Start with Windows", "Installed app only", toggle(st.launchAtLogin, () => save({ launchAtLogin: !st.launchAtLogin }), "Start with Windows")),
		);
	}

	// One place that says whether selection help will work right now, and what to do when it won't.
	let assist, assistLoading = false;
	const loadAssist = async () => {
		if (assistLoading) return;
		assistLoading = true;
		try { assist = await api.assist.status(); } catch (err) { assist = { error: String(err.message ?? err) }; }
		assistLoading = false;
		render();
	};
	function assistSection() {
		const st = S.settings;
		if (!assist && !assistLoading) loadAssist();
		if (st.voice && !voiceLoaded && !voicePolling) pollVoice();
		const a = assist ?? {}, office = a.office ?? {};
		const check = (ok, label, detail, action) => h("div", { class: "field" }, h("label", {}, `${ok ? "✓" : "!"} ${label}`, detail ? h("small", { class: ok ? "" : "hint warn" }, detail) : null), action ?? null);
		const model = S.current?.model;
		const rows = !assist
			? [h("p", { class: "hint" }, "Checking this computer…")]
			: a.error
				? [h("p", { class: "hint warn" }, a.error)]
				: [
					check(a.shortcutRegistered, `Shortcut ${pretty(a.shortcut ?? "")}`, a.shortcutRegistered ? "Select a paragraph or chart, then press it." : "Another app has taken this shortcut. Close that app or change its shortcut, then restart midnight."),
					check(office.installed, office.provider === "wps" ? "WPS Office" : office.provider === "microsoft-word" ? "Microsoft Word" : "Word or WPS", office.error || (!office.installed ? "Install WPS Office or Microsoft Word. Other apps aren't supported yet." : office.chartsQualified ? "Paragraphs and single-series bar/column charts → pie." : "Paragraphs only. Chart changes are tested on WPS Office only.")),
					check(!!model, "Writing model", model ? `${model}. Only the selected text and your instruction are sent.` : "Choose a model first.", model ? null : h("button", { class: "sb", onclick: () => window.renderSettings("model") }, "Choose")),
				];
		const whisperReady = !!voice.available;
		const holdOn = !!(st.voice && st.pushToTalk);
		const mb = (n) => Math.round((n ?? 0) / 1e6);
		return sec(
			"assist",
			"HELP WITH THE SELECTION",
			h("p", { class: "hint" }, "Rewrite a paragraph or change a chart in the document you're working on. Nothing changes until you review and apply it, and you can undo it afterwards."),
			...rows,
			field("Hold to speak instead of typing", `Hold ${pretty(a.holdShortcut ?? "Ctrl+Alt+Shift+Space")} while you say what to change, then release. ${st.perception?.enabled ? "Native cloud hearing is on (Voice input), so audio goes to that provider." : "Speech is turned into text on this computer."} Also turns on the Ask microphone.`, toggle(holdOn, () => save(holdOn ? { pushToTalk: false } : { voice: true, pushToTalk: true }).then(loadAssist), "Hold to speak about the selection")),
			holdOn
				? whisperReady
					? check(!!a.holdListening, "Listening for the held shortcut", a.holdListening ? "" : "The listener isn't running. Turn this off and on again.")
					: h("div", { class: "row" },
						h("button", { class: "sb pri", disabled: !!voice.setup, onclick: attempt(async () => { const r = await api.voice.setup(); setTimeout(pollVoice, 500); return r; }) }, voice.setup ? `Installing… ${mb(voice.progress?.done)} / ${mb(voice.progress?.total ?? voice.bytes)} MB` : `Install speech recognition (${mb(voice.bytes ?? 81e6)} MB)`),
						voice.error ? h("small", { class: "hint warn" }, voice.error) : h("small", { class: "hint" }, "Needed once before holding to speak works."))
				: null,
			h("div", { class: "row" }, h("button", { class: "sb", disabled: assistLoading, onclick: loadAssist }, assistLoading ? "Checking…" : "Check again")),
		);
	}

	let voice = {};
	let voiceLoaded = false, voicePolling = false;
	const pollVoice = async () => {
		if (voicePolling) return;
		voicePolling = true;
		voice = (await api.voice.status().catch(() => ({}))) ?? {}; voiceLoaded = true; voicePolling = false;
		render();
		if (voice.setup || voice.progress?.total && !voice.available && !voice.error) setTimeout(pollVoice, 1000);
	};
	let checkingMedia = false;
	function voiceSection() {
		const st = S.settings;
		const media = st.perception ?? { enabled: false, provider: "google", model: "gemini-3.8-flash" }, mediaStatus = extra.perception ?? {};
		const probe = async () => {
			checkingMedia = true; render();
			try { window.checkedResult(await api.perception.qualify()); setStatus("The five synthetic media checks passed. Broader speech quality and live video still need testing."); }
			catch (err) { setStatus(String(err.message ?? err), true); }
			finally { checkingMedia = false; extra.perception = await api.perception.status().catch(() => ({})); render(); }
		};
		const poll = pollVoice;
		if (st.voice && !voiceLoaded && !voicePolling) poll();
		const mb = (n) => Math.round((n ?? 0) / 1e6);
		return sec(
			"voice",
			"VOICE INPUT",
			field("Dictate into Ask", "Microphone button and Ctrl+Shift+Space. Whisper runs on this computer; audio is never uploaded.", toggle(!!st.voice, () => save({ voice: !st.voice }), "Dictate into Ask")),
			st.voice ? field("Spoken language", "Select your usual language or let Whisper detect it.", dropdown({ label: "Spoken language", value: st.voiceLanguage ?? "en", groups: [{ items: [["en", "English"], ["auto", "Auto detect"], ["ms", "Malay"], ["zh", "Chinese"], ["ta", "Tamil"], ["hi", "Hindi"]].map(([value, label]) => ({ value, label })) }], onPick: value => save({ voiceLanguage: value }) })) : null,
			st.voice ? h("p", { class: "hint" }, "Hold-to-speak edits for the selected paragraph or chart are under Help with the selection.") : null,
			field("Use native cloud hearing", "Preview for the held shortcut. Sends up to 30 seconds of raw audio to the media API instead of local Whisper. Requires cloud privacy and a separate API key. Your text model and local Gemma embeddings keep their own settings.", toggle(media.enabled, () => save({ perception: { ...media, enabled: !media.enabled } }), "Use native cloud hearing")),
			media.enabled ? field("Media provider", "Used only for bounded native media. Connect its API key under Models.", dropdown({ label: "Media provider", value: media.provider, groups: [{ items: [{ value: "google", label: "Google Gemini", hint: "Audio, images and native video API" }, { value: "openai", label: "OpenAI Realtime", hint: "Audio and images" }] }], onPick: provider => save({ perception: { ...media, provider, model: provider === "openai" ? "gpt-realtime-2.1" : "gemini-3.8-flash" } }) })) : null,
			media.enabled ? h("p", { class: "hint" }, `When you hold to speak, the utterance goes to this provider after its synthetic checks pass; no document goes to that provider. Your text model receives the instruction and selection. ${media.model} · ${mediaStatus.qualification === "fixtures-passed" ? "Synthetic fixtures passed" : "Awaiting synthetic checks"}. ${mediaStatus.reason ?? "Checking API connection…"} Native video capture and continuous listening are not enabled by this preview.`) : null,
			media.enabled ? h("div", { class: "row" }, h("button", { id: "checkNativeMedia", class: "sb", disabled: checkingMedia || mediaStatus.busy || !mediaStatus.available || st.privacy !== "cloud", onclick: probe }, checkingMedia ? "Checking synthetic media…" : "Run synthetic media checks"), h("small", { class: "hint" }, "Five small API requests using bundled speech, silence and images. Uses your API quota; no microphone or document is read.")) : null,
			st.voice
				? voice.available
					? h("p", { class: "hint" }, "Whisper is ready on this computer.")
					: h("div", { class: "row" },
						h("button", { class: "sb pri", disabled: !!voice.setup, onclick: attempt(async () => { const r = await api.voice.setup(); setTimeout(poll, 500); return r; }) }, voice.setup ? `Installing… ${mb(voice.progress?.done)} / ${mb(voice.progress?.total ?? voice.bytes)} MB` : `Install Whisper (${mb(voice.bytes ?? 81e6)} MB)`),
						voice.error ? h("small", { class: "hint warn" }, voice.error) : h("small", { class: "hint" }, "Needed once before the microphone button appears."))
				: null,
		);
	}

	function webSection() {
		const st = S.settings;
		return sec(
			"web",
			"WEB",
			field("Search engine", "The others are tried if one blocks", dropdown({ label: "Search engine", value: st.searchEngine, groups: [{ items: [{ value: "google", label: "Google" }, { value: "bing", label: "Bing" }, { value: "duckduckgo", label: "DuckDuckGo" }] }], onPick: (v) => save({ searchEngine: v }) })),
			field("Fast page reading", "Skip images, video, fonts and trackers", toggle(st.fastPages, () => save({ fastPages: !st.fastPages }), "Fast page reading")),
		);
	}

	// ---------- Models ----------
	function modelSection(compact = false) {
		const groups = new Map();
		for (const m of S.models) {
			if (!groups.has(m.providerName)) groups.set(m.providerName, []);
			groups.get(m.providerName).push(m);
		}
		const sel = dropdown({
			label: "Model",
			value: `${S.current.provider}|${S.current.model}`,
			empty: S.models.length ? "Choose a model" : "Sign in to see models",
			groups: [...groups].map(([name, list]) => ({ label: name, items: list.map((m) => ({ value: `${m.provider}|${m.id}`, label: m.name, hint: m.local ? "local" : m.vision ? "" : "no vision" })) })),
			onPick: (v) => {
				const [provider, ...id] = v.split("|");
				save({ provider, model: id.join("|") });
			},
		});
		const cur = S.models.find((m) => m.provider === S.current.provider && m.id === S.current.model);
		if (compact) return h("div", {}, field("Model", "", sel));
		const st = S.settings;
		return sec(
			"model",
			"MODELS",
			field("Model", "Answers, tasks, research and computer use", sel),
			cur && !cur.vision ? h("p", { class: "hint warn" }, "This model can't see images, so browser and screen screenshots won't work.") : null,
			field("Thinking", "More is slower and costs more", segmented(st.thinking, [{ value: "off", label: "Off" }, { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }], (v) => save({ thinking: v }), "Thinking")),
		);
	}

	function privacySection() {
		const st = S.settings;
		const local = st.local ?? {};
		return sec(
			"privacy",
			"PRIVACY",
			field(
				"Where missions run",
				st.privacy === "cloud" ? "Your request and the file text midnight reads go to your model's provider" : st.privacy === "local" ? "Only the local model. Public web pages may still be fetched; never falls back to the cloud." : "Local model and local files only. No network.",
				segmented(st.privacy, [{ value: "cloud", label: "Cloud" }, { value: "local", label: "Local only" }, { value: "offline", label: "Offline" }], (v) => save({ privacy: v }), "Where missions run"),
			),
			field("Local model", "An Ollama or compatible server on this computer", toggle(!!local.enabled, () => save({ local: { enabled: !local.enabled } }), "Use a local model")),
			local.enabled
				? h("div", { class: "keyrow" },
					h("input", { class: "sinp", value: local.baseUrl ?? "", placeholder: "http://localhost:11434/v1", "aria-label": "Local endpoint address", onchange: (e) => save({ local: { baseUrl: e.target.value.trim() } }) }),
					h("input", { class: "sinp", value: local.model ?? "", placeholder: "model name, e.g. qwen3:8b", "aria-label": "Local model name", onchange: (e) => save({ local: { model: e.target.value.trim() } }) }))
				: null,
		);
	}

	function usageSection() {
		const st = S.settings;
		return sec(
			"usage",
			"USAGE",
			field("Budget per mission", "At the cap, midnight stops starting new work and keeps what's done", segmented(st.budget?.costUsd ?? 2, [{ value: 0.5, label: "$0.50" }, { value: 2, label: "$2" }, { value: 10, label: "$10" }], (v) => save({ budget: { costUsd: v } }), "Budget")),
			field(
				"Pace",
				st.profile === "quiet" ? "Only your direct requests run; background work and local models rest" : st.profile === "focused" ? "Your active mission first; background work waits" : st.profile === "burst" ? "More at once, for 30 minutes" : "One model task and limited web work at a time",
				segmented(st.profile, [{ value: "quiet", label: "Quiet" }, { value: "balanced", label: "Balanced" }, { value: "focused", label: "Focused" }, { value: "burst", label: "Burst" }], (v) => save({ profile: v }), "Pace"),
			),
		);
	}

	function keyRow(a) {
		const input = h("input", { class: "sinp", type: "password", placeholder: `Paste ${a.name} API key`, autocomplete: "off", spellcheck: "false", "aria-label": `${a.name} API key` });
		const go = () => {
			const key = input.value.trim();
			if (key) login(a.id, "api_key", key);
		};
		input.onkeydown = (e) => {
			if (e.key === "Enter") go();
			else if (e.key === "Escape") {
				e.stopPropagation();
				keyFor = "";
				render();
			}
		};
		setTimeout(() => !document.activeElement?.matches("input, textarea") && input.focus(), 30);
		return h(
			"div",
			{ class: "keyrow" },
			input,
			h("button", { class: "sb", title: "Paste from clipboard", onclick: async () => { input.value = (await api.clipboard.read()).trim(); input.focus(); } }, "Paste"),
			h("button", { class: "sb pri", onclick: go }, "Save"),
		);
	}

	// Signed-in accounts are listed; every other provider waits behind "Add account…" so the tab isn't a wall of sign-ins.
	let picking = false;
	function accountsSection() {
		const all = S.accounts;
		const mine = all.filter((a) => a.configured);
		const open = picking || !mine.length || all.some((a) => !a.configured && (busy === a.id || keyFor === a.id));
		const others = all.filter((a) => !a.configured);
		const popular = (a) => POPULAR.includes(a.id);
		const list = q ? others.filter((a) => `${a.name} ${a.id}`.toLowerCase().includes(q.toLowerCase())) : showAll ? others : others.filter(popular);
		const hidden = others.filter((a) => !popular(a)).length;
		const row = (a) => {
			const isBusy = busy === a.id;
			const canOut = a.configured && (a.source === "stored" || a.source === "runtime");
			const r = h(
				"div",
				{ class: "acct" },
				h("i", { class: `sdot${a.configured ? " on" : ""}`, "aria-hidden": "true" }),
				h("div", { class: "n" }, a.name, a.configured ? h("small", {}, a.source === "environment" ? `via ${a.label ?? "environment"}` : "signed in") : null),
				isBusy
					? h("span", { class: "mono" }, "signing in…")
					: [
							!a.configured && a.oauth ? h("button", { class: "sb", onclick: () => login(a.id, "oauth") }, "Sign in") : null,
							a.apiKey ? h("button", { class: `sb${keyFor === a.id ? " on" : ""}`, onclick: () => { keyFor = keyFor === a.id ? "" : a.id; render(); } }, a.configured ? "Use API key" : "API key") : null,
							canOut ? h("button", { class: "sb danger", onclick: () => logout(a.id) }, "Sign out") : null,
						],
			);
			return keyFor === a.id && !isBusy ? [r, keyRow(a)] : [r];
		};
		const search = h("input", {
			class: "sinp",
			placeholder: "Search providers…",
			"aria-label": "Search providers",
			value: q,
			oninput: (e) => {
				q = e.target.value;
				const pos = e.target.selectionStart;
				render();
				const i = root.querySelector("#sec-accounts .sinp");
				i.focus();
				i.setSelectionRange(pos, pos);
			},
		});
		return sec(
			"accounts",
			"ACCOUNTS",
			...mine.flatMap(row),
			open
				? h("div", { class: "sform" },
					h("p", { class: "hint" }, "Sign in with a subscription in your browser, or paste an API key. Keys are stored where midnight.server keeps them."),
					search,
					h("div", {}, list.length ? list.flatMap(row) : h("p", { class: "hint" }, "No providers match.")),
					h("div", { class: "row2" },
						!q && hidden ? h("button", { class: "sb", onclick: () => { showAll = !showAll; render(); } }, showAll ? "Show fewer" : `Show ${hidden} more`) : null,
						mine.length ? h("button", { class: "sb", onclick: () => { picking = false; q = ""; showAll = false; keyFor = ""; render(); } }, "Done") : null))
				: h("div", { class: "row" }, h("button", { class: "sb", onclick: () => { picking = true; render(); root.querySelector("#sec-accounts .sinp")?.focus(); } }, "Add account…")),
		);
	}

	// ---------- Files ----------
	function sourcesSection() {
		return sec(
			"sources",
			"FOLDERS",
			h("p", { class: "hint" }, "midnight reads only these folders. Drafts folders also receive the drafts it saves."),
			...extra.sources.map((s) => h("div", { class: "acct" }, h("div", { class: "n", title: s.path }, s.path, h("small", {}, s.purpose === "output" ? "reads and saves drafts" : "reads")), h("button", { class: "sb danger", onclick: attempt(() => api.sources.remove(s.id), "Removed.") }, "Remove"))),
			h("div", { class: "row" }, h("button", { class: "sb", onclick: attempt(() => api.sources.pick("source"), "Folder added.") }, "Add folder to read"), h("button", { class: "sb", onclick: attempt(() => api.sources.pick("output"), "Folder added.") }, "Add drafts folder")),
		);
	}

	function fileSearchSection() {
		const embedding = S.settings.embedding ?? {};
		return sec(
			"file-search",
			"SEARCH",
			field("Search by meaning", "Find files by what they say, not only their names. EmbeddingGemma 2 runs on this computer.", toggle(!!embedding.enabled, () => save({ embedding: { enabled: !embedding.enabled } }), "Enable local meaning search")),
			embedding.enabled ? field("Use the graphics card", "Faster indexing where supported; otherwise the processor is used", toggle(embedding.device === "gpu", () => save({ embedding: { device: embedding.device === "gpu" ? "cpu" : "gpu" } }), "Use the graphics card for local search")) : null,
			field("Give the model relevant context", "Related memories, past tasks and files are added to requests. A cloud provider receives these excerpts.", toggle(embedding.assist !== false, () => save({ embedding: { assist: embedding.assist === false } }), "Use relevant context for AI")),
		);
	}

	let editing = ""; // memory id being corrected
	function correctRow(m) {
		const input = h("input", { class: "sinp", value: m.text, "aria-label": "Correct this memory" });
		const go = () => input.value.trim() && attempt(() => api.memory.correct({ memoryId: m.id, text: input.value.trim() }), "Corrected.")().then(() => (editing = ""));
		input.onkeydown = (e) => e.key === "Enter" && go();
		setTimeout(() => input.focus(), 30);
		return h("div", { class: "keyrow" }, input, h("button", { class: "sb pri", onclick: go }, "Save"));
	}
	function memorySection() {
		const input = h("input", { class: "sinp", placeholder: "Something to remember, e.g. Save reports in Documents\\Reports", "aria-label": "Remember" });
		return sec(
			"memory",
			"MEMORY",
			h("p", { class: "hint" }, "Only memories you keep are used, and only when relevant. A memory never grants permission."),
			...extra.memory.flatMap((m) => [
				h(
					"div",
					{ class: "acct" },
					h("div", { class: "n", title: `${m.why}${m.uses ? ` · used ${m.uses}×` : ""}` }, m.text, h("small", {}, m.confirmed ? `${m.kind}${m.uses ? ` · used ${m.uses}×` : ""}` : "suggested · not used yet")),
					m.confirmed ? null : h("button", { class: "sb pri", onclick: attempt(() => api.memory.confirm(m.id)) }, "Keep"),
					h("button", { class: "sb", onclick: () => { editing = editing === m.id ? "" : m.id; render(); } }, "Edit"),
					h("button", { class: "sb danger", onclick: attempt(() => api.memory.forget(m.id), "Forgotten.") }, "Forget"),
				),
				editing === m.id ? correctRow(m) : null,
			]),
			h("div", { class: "keyrow" }, input, h("button", { class: "sb pri", onclick: attempt(() => input.value.trim() && api.memory.remember({ text: input.value.trim(), kind: "preference" }), "Remembered.") }, "Remember")),
		);
	}

	// ---------- Automation ----------
	const EFFECT_LABEL = { "external.communication": "Send email", "local.write": "Save files", "local.move": "Move files", "read.connector": "Read connected accounts", "connector.write": "Change connected records", "browser.commit": "Submit on websites" };
	let ruleDraft = { effect: "external.communication", days: 30 };
	function rulesSection() {
		const form = () => {
			const label = h("input", { class: "sinp", placeholder: "Rule name, e.g. Weekly report to Sam", "aria-label": "Rule name" });
			const dest = h("input", { class: "sinp", placeholder: "Exact recipients or sites, comma separated", "aria-label": "Allowed recipients or sites" });
			form.submit = () => {
				const d = { label: label.value.trim() || EFFECT_LABEL[ruleDraft.effect], actionClasses: [ruleDraft.effect], destinations: dest.value.split(",").map((x) => x.trim()).filter(Boolean), expiresInDays: ruleDraft.days, limits: { maxActions: 50 } };
				if (["external.communication", "browser.commit"].includes(ruleDraft.effect) && !d.destinations.length) throw new Error("List the exact recipients or sites this rule allows.");
				return api.grants.create(d);
			};
			return [
				label,
				h("div", { class: "row" },
					dropdown({ label: "Action", value: ruleDraft.effect, groups: [{ items: Object.entries(EFFECT_LABEL).map(([value, l]) => ({ value, label: l })) }], onPick: (v) => (ruleDraft.effect = v) }),
					h("span", { class: "hint" }, "for"),
					segmented(ruleDraft.days, [{ value: 1, label: "1 day" }, { value: 7, label: "7 days" }, { value: 30, label: "30 days" }], (v) => (ruleDraft.days = v), "Expires")),
				dest,
			];
		};
		form.action = "Create rule";
		form.done = "Rule created.";
		return sec(
			"rules",
			"RULES",
			h("p", { class: "hint" }, "A rule lets midnight do one kind of action without asking, only for the recipients or sites you list, until it expires. Revoking takes effect immediately."),
			...extra.grants.map((g) =>
				h(
					"div",
					{ class: "acct" },
					h("div", { class: "n", title: `${g.actionClasses.join(", ")}${g.destinations.length ? ` → ${g.destinations.join(", ")}` : ""}` }, g.label, h("small", {}, `${g.missionId ? "this mission only" : `${g.used}${g.limits?.maxActions ? `/${g.limits.maxActions}` : ""} used`}${g.expiresAt ? ` · until ${new Date(g.expiresAt).toLocaleDateString()}` : ""}`)),
					h("button", { class: "sb danger", onclick: attempt(() => api.grants.revoke(g.id), "Rule revoked.") }, "Revoke"),
				),
			),
			adder("rule", "New rule…", form),
		);
	}

	let watchDraft = { every: "6h", onChange: "notify" };
	const EVERY = { "30m": { unit: "minutes", n: 30 }, "6h": { unit: "hours", n: 6 }, "1d": { unit: "days", n: 1, at: "09:00" }, wd: { unit: "weekdays", n: 1, at: "08:30" } };
	function watchesSection() {
		const qh = S.settings.quietHours ?? {};
		const form = () => {
			const label = h("input", { class: "sinp", placeholder: "Name, e.g. Pricing page", "aria-label": "Watch name" });
			const target = h("input", { class: "sinp", placeholder: "https://… or a folder inside your folders", "aria-label": "What to watch" });
			form.submit = () => {
				const t = target.value.trim();
				const source = /^https?:\/\//i.test(t) ? { kind: "url", url: t } : { kind: "folder", path: t };
				return api.watches.create({ label: label.value.trim() || t.slice(0, 60), source, every: EVERY[watchDraft.every], onChange: watchDraft.onChange, cooldownMinutes: 60 });
			};
			return [
				label,
				target,
				h("div", { class: "row" },
					segmented(watchDraft.every, [{ value: "30m", label: "30m" }, { value: "6h", label: "6h" }, { value: "1d", label: "daily" }, { value: "wd", label: "weekdays" }], (v) => (watchDraft.every = v), "How often"),
					segmented(watchDraft.onChange, [{ value: "notify", label: "Tell me" }, { value: "prepare", label: "Prepare an update" }], (v) => (watchDraft.onChange = v), "On change")),
			];
		};
		form.action = "Add watch";
		form.done = "Watching.";
		return sec(
			"watches",
			"WATCHES",
			h("p", { class: "hint" }, "A watch checks a page, folder or connected account on a schedule without using the model, and tells you only when something changes."),
			...extra.watches.map((w) => h("div", { class: "acct" }, h("div", { class: "n", title: JSON.stringify(w.source) }, w.label, h("small", {}, w.status)), h("button", { class: "sb", onclick: attempt(() => api.watches.setPaused({ watchId: w.id, paused: !w.paused })) }, w.paused ? "Resume" : "Pause"), h("button", { class: "sb danger", onclick: attempt(() => api.watches.remove(w.id), "Watch removed.") }, "Delete"))),
			adder("watch", "New watch…", form),
			field("Quiet hours", `${qh.from ?? "22:00"}–${qh.to ?? "07:00"} · changes wait until morning`, toggle(!!qh.enabled, () => save({ quietHours: { enabled: !qh.enabled } }), "Quiet hours")),
		);
	}

	function routinesSection() {
		return sec(
			"routines",
			"ROUTINES",
			h("p", { class: "hint" }, "Save a finished mission as a routine, or import one someone shared. Imported routines start unreviewed and in Ask me mode."),
			...extra.recipes.map((r) =>
				h(
					"div",
					{ class: "acct" },
					h("div", { class: "n", title: `${r.template.goal}\nUses: ${r.template.tools.join(", ")}\nEffects: ${r.template.effects.join(", ")}` }, r.label, h("small", {}, r.reviewed ? "reviewed" : "review the steps before running")),
					r.reviewed ? null : h("button", { class: "sb", onclick: attempt(() => api.recipes.review({ recipeId: r.id }), "Reviewed.") }, "Mark reviewed"),
					r.reviewed ? h("button", { class: "sb pri", onclick: attempt(() => api.recipes.run({ recipeId: r.id, requestId: `req_${Date.now()}` }), "Started.") }, "Run") : null,
					h("button", { class: "sb", title: "Save this routine as a file to share", onclick: attempt(async () => { const x = await api.recipes.export(r.id); if (x?.file) setStatus(`Saved ${x.file}`); return x; }) }, "Export"),
				),
			),
			h("div", { class: "row" }, h("button", { class: "sb", onclick: attempt(async () => { const x = await api.recipes.import(); if (x?.recipe) setStatus(`Imported “${x.recipe.label}”. Review it before it runs.`); return x; }) }, "Import routine…")),
		);
	}

	let mcpTools = {}; // connector id -> inspected tools, while their list is open
	let windowsConnectors; // what Windows' agent registry offers, looked up once per Settings visit
	function connectorsSection() {
		const servers = extra.mcp ?? [];
		if (windowsConnectors === undefined) {
			windowsConnectors = null;
			api.connectors.windowsConnectors().then((r) => ((windowsConnectors = r), render())).catch(() => {});
		}
		const form = () => {
			const name = h("input", { class: "sinp", placeholder: "Name, e.g. GitHub", "aria-label": "Connector name" });
			const target = h("input", { class: "sinp", placeholder: "npx -y @modelcontextprotocol/server-github   or   https://mcp.example.com/mcp", "aria-label": "Command or address" });
			const token = h("input", { class: "sinp", type: "password", placeholder: "Access token for a remote service (optional, stored encrypted)", "aria-label": "Access token" });
			form.submit = () => {
				const t = target.value.trim();
				const remote = /^https?:\/\//i.test(t);
				const parts = t.match(/"[^"]*"|\S+/g)?.map((x) => x.replace(/^"|"$/g, "")) ?? [];
				return api.connectors.mcpAdd(remote ? { name: name.value.trim() || new URL(t).host, kind: "http", url: t, ...(token.value ? { token: token.value } : {}) } : { name: name.value.trim() || parts[0] || "connector", kind: "stdio", command: parts[0] ?? "", args: parts.slice(1) });
			};
			return [name, target, token];
		};
		form.action = "Add connector";
		form.done = "Connector added.";
		const suggested = (windowsConnectors?.connectors ?? []).filter((c) => !servers.some((s) => s.kind === "stdio" && s.command === c.command && JSON.stringify(s.args) === JSON.stringify(c.args)));
		return sec(
			"connectors",
			"CONNECTORS",
			h("p", { class: "hint" }, "Give midnight tools from any Model Context Protocol server, on this computer or remote. Each use asks first; read-only tools you review can run without asking."),
			...servers.map((s) => h("div", { class: "mcp-server" },
				h("div", { class: "acct" },
					h("div", { class: "n", title: s.kind === "stdio" ? `${s.command} ${s.args.join(" ")}` : s.url }, s.name, h("small", {}, s.kind === "stdio" ? "program on this computer" : `remote · ${new URL(s.url).host}`)),
					toggle(s.enabled, attempt(() => api.connectors.mcpSetEnabled(s.id, !s.enabled)), `Use ${s.name}`),
					h("button", { class: "sb", onclick: attempt(async () => { mcpTools[s.id] = mcpTools[s.id] ? undefined : await api.connectors.mcpInspect(s.id); return { ok: true }; }) }, mcpTools[s.id] ? "Hide tools" : "Show tools"),
					h("button", { class: "sb danger", onclick: attempt(() => api.connectors.mcpRemove(s.id), "Removed.") }, "Remove"),
				),
				mcpTools[s.id] ? h("div", { class: "mcp-tools" },
					h("p", { class: "hint" }, `${mcpTools[s.id].server.info?.name ?? s.name} · protocol ${mcpTools[s.id].server.protocol ?? "?"}`),
					...mcpTools[s.id].tools.map((t) => h("div", { class: "acct" },
						h("div", { class: "n", title: t.description }, t.title ?? t.name, h("small", {}, t.review?.readOnly && t.review.current ? "reviewed · runs without asking" : t.review && !t.review.current ? "changed since review · asks" : t.readOnlyHint ? "read-only · asks until reviewed" : "may change data · always asks")),
						t.app ? h("small", { class: "mono" }, "app view") : null,
						t.readOnlyHint ? toggle(!!(t.review?.readOnly && t.review.current), attempt(async () => { const r = await api.connectors.mcpReview(s.id, t.name, t.digest, !(t.review?.readOnly && t.review.current)); mcpTools[s.id] = await api.connectors.mcpInspect(s.id); return r; }), `Run ${t.name} without asking`) : null,
					)),
				) : null,
			)),
			// Windows' own agent connectors (File Explorer, Settings and apps that registered one), when this Windows has the registry.
			...suggested.map((c) =>
				h("div", { class: "acct" }, h("div", { class: "n", title: c.description }, c.name, h("small", {}, "offered by Windows")), h("button", { class: "sb", onclick: attempt(() => api.connectors.mcpAdd({ name: c.name, kind: "stdio", command: c.command, args: c.args }), "Connector added.") }, "Add"))),
			adder("connector", "Add connector…", form),
		);
	}

	function shareSection() {
		const on = !!S.settings.mcpServer;
		return sec(
			"share",
			"OTHER APPS",
			field("Let other apps use midnight", "Windows agents, Claude Desktop and other MCP clients on this computer can search your folders and start tasks. Changes still wait for your approval.", toggle(on, () => save({ mcpServer: !on }), "Let other apps use midnight")),
			on ? h("div", { class: "row" },
				h("button", { class: "sb", onclick: attempt(async () => { const r = await api.connectors.registerWithWindows(); setStatus(r.ok ? "Registered with Windows." : r.reason, !r.ok); return { ok: true }; }) }, "Register with Windows"),
				h("button", { class: "sb", title: S.mcpServer?.bridge, onclick: attempt(async () => { await api.clipboard.write(JSON.stringify({ mcpServers: { midnight: { command: S.mcpServer?.bridge, args: [] } } }, null, 2)); setStatus("Client settings copied."); return { ok: true }; }) }, "Copy client settings"),
			) : null,
		);
	}

	// ---------- Display ----------
	function displaySection() {
		const st = S.settings;
		const sizes = [0.9, 1, 1.15, 1.3, 1.45, 1.6].map((value, i) => ({ value, label: ["S", "M", "L", "XL", "2X", "3X"][i] }));
		const near = sizes.reduce((a, b) => (Math.abs(b.value - st.textSize) < Math.abs(a.value - st.textSize) ? b : a)).value;
		return sec(
			"display",
			"DISPLAY",
			field("Text size", "Also Ctrl + and Ctrl −; Ctrl 0 resets", segmented(near, sizes, (v) => save({ textSize: v }), "Text size")),
			field("High contrast", "Brighter text, stronger edges", toggle(st.highContrast, () => save({ highContrast: !st.highContrast }), "High contrast")),
			field("Reduce motion", "No animations or pulsing status light", toggle(st.reducedMotion, () => save({ reducedMotion: !st.reducedMotion }), "Reduce motion")),
			field("Reading view for long answers", "Opens the wide view automatically. Ctrl+E toggles it.", toggle(st.autoExpand, () => save({ autoExpand: !st.autoExpand }), "Reading view for long answers")),
		);
	}

	// ---------- Data ----------
	function dataSection() {
		return sec(
			"data",
			"YOUR DATA",
			field("Export everything", "Missions, receipts, rules, watches and memory as JSON", h("button", { class: "sb", onclick: attempt(async () => { const r = await api.data.export(); setStatus(`Exported to ${r.file}`); }) }, "Export")),
			field("Delete finished missions' content", "Answers, evidence, drafts and transcripts. Records of actions that left the computer stay.", h("button", { class: "sb danger", onclick: () => confirm("Delete the content of finished missions?") && attempt(() => api.data.remove("history"), "Deleted.")() }, "Delete")),
			field("Delete all memory", "", h("button", { class: "sb danger", onclick: () => confirm("Forget everything midnight remembers?") && attempt(() => api.data.remove("memory"), "Memory deleted.")() }, "Delete")),
			field("Website data", "Cookies, logins and cache for saved apps and the background browser", h("button", { class: "sb danger", onclick: attempt(() => api.data.clearBrowser(), "Website data cleared. Saved apps are still pinned.") }, "Clear")),
			field("App data folder", "", h("button", { class: "sb", onclick: () => api.data.openFolder() }, "Open")),
		);
	}

	function aboutSection() {
		const st = S.settings;
		return sec(
			"about",
			"ABOUT",
			field(
				"Updates",
				"Checks at most once a day. Installs only signed builds, only when you say so.",
				h(
					"div",
					{ class: "row" },
					segmented(st.updates ?? "notify", [{ value: "notify", label: "Tell me" }, { value: "off", label: "Off" }], (v) => save({ updates: v }), "Updates"),
					h("button", { class: "sb", onclick: attempt(async () => { const r = await api.updates.check(); updateReady = !!r.available; setStatus(r.error ? `Couldn't check: ${r.error}` : r.available ? `Version ${r.latest} is available.` : "You have the latest version."); }) }, "Check"),
					updateReady ? h("button", { class: "sb pri", onclick: attempt(async () => { const r = await api.updates.install(); setStatus(r.ok ? "Installing…" : r.reason, !r.ok); }) }, "Install") : null,
				),
			),
			field("Support bundle", "Preview it, then save. No prompts, files, screenshots or secrets.", h("button", { class: "sb", onclick: attempt(async () => { const p = await api.data.diagnostics(); if (confirm(`${p.note}\n\n${JSON.stringify(p.preview, null, 1).slice(0, 1500)}…\n\nSave it?`)) await api.data.saveDiagnostics(); }) }, "Preview")),
			field("Demo connectors", "Pretend CRM and mail for trying the sales-brief workflow. Nothing is really sent.", toggle(!!st.demoConnectors, () => save({ demoConnectors: !st.demoConnectors }).then(() => setStatus("Restart the engine (tray → Restart engine) to apply.")), "Demo connectors")),
			h("p", { class: "hint" }, "Shortcuts: ? quick · ?? deep research · ↑ last prompt · Ctrl+E reading view · Ctrl+Shift+C copy · 1–9 open a source · Ctrl+L new task · Esc takes over"),
			h("p", { class: "hint mono" }, `midnight ${S.version} · engine ${S.engine} · ${S.dataDir}`),
		);
	}

	function hotkeyButton() {
		const b = h("button", { class: "sb", "aria-label": "Change summon shortcut" }, h("kbd", {}, pretty(S.settings.hotkey)), " · change");
		b.onclick = () => {
			cancelHotkeyCapture?.();
			b.textContent = "Press shortcut… (Esc cancels)";
			let chord = false;
			const done = () => {
				document.removeEventListener("keydown", onKey, true);
				document.removeEventListener("keyup", onRelease, true);
				cancelHotkeyCapture = undefined;
			};
			const onKey = (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) {
					chord = /Win/.test(navigator.platform) && e.ctrlKey && e.metaKey && !e.altKey && !e.shiftKey;
					return;
				}
				done();
				if (e.key === "Escape") return render();
				const mods = [e.ctrlKey && "CommandOrControl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
				const names = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", " ": "Space" };
				const key = names[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
				if (!mods.length) return setStatus("Use at least one of Ctrl, Alt, Shift or Win.", true);
				save({ hotkey: [...mods, key].join("+") });
			};
			const onRelease = (e) => {
				if (!chord || !["Control", "Meta"].includes(e.key)) return;
				e.preventDefault(); e.stopPropagation(); done();
				save({ hotkey: "Control+Super" });
			};
			cancelHotkeyCapture = done;
			document.addEventListener("keydown", onKey, true);
			document.addEventListener("keyup", onRelease, true);
		};
		return b;
	}

	function changesSection() {
		const prompt = h("textarea", { id: "changePrompt", class: "sinp", rows: "3", maxlength: "4000", placeholder: "Improve or repair Midnight's charts…", "aria-label": "Describe a Midnight improvement", oninput: event => { changeText = event.target.value; } }); prompt.value = changeText;
		const placeholder = () => prompt.placeholder = changeComponent === "midnight.core" ? "Describe the app bug, how to reproduce it, and the expected behavior…" : changeComponent === "midnight.theme" ? "Make Midnight's launcher accent colors teal…" : "Improve or repair Midnight's charts…"; placeholder();
		const components = extra.components?.length ? extra.components : [{ id: "midnight.chart", label: "Charts" }];
		const component = segmented(changeComponent, components.map(item => ({ value: item.id, label: item.label })), value => { changeComponent = value; if (value === "midnight.core") changeScope = "official"; render(); }, "Midnight component to improve");
		const selectedComponent = components.find(item => item.id === changeComponent), core = changeComponent === "midnight.core";
		const scope = segmented(changeScope, core ? [{ value: "official", label: "Official proposal" }] : [{ value: "user", label: "My Midnight" }, { value: "official", label: "Official proposal" }], value => { changeScope = value; }, "Where the improvement belongs");
		const build = h("button", { id: "requestChange", class: "sb pri", onclick: async () => {
			if (!changeText.trim()) return setStatus("Describe the improvement first.", true);
			build.disabled = true;
			try { const job = await api.builder.request({ scope: changeScope, text: changeText, pluginId: changeComponent }); changeText = ""; await loadExtra(); setStatus(`Change job ${job.status}. You can review its preview when ready.`); }
			catch (error) { setStatus(error.message, true); }
		} }, "Build candidate");
		if (selectedComponent?.available === false) build.disabled = true;
		const jobs = (extra.changes ?? []).slice(0, 10).map(job => {
			const card = h("div", { class: "change-card" }, h("strong", {}, job.request), h("p", { class: "hint" }, `${job.component ?? "Charts"} · ${job.scope === "user" ? "My Midnight" : "Official proposal"} · ${job.status}`));
			if (job.waitingReason) card.append(h("p", { class: "hint" }, job.waitingReason));
			if (job.error) card.append(h("p", { class: "hint" }, job.error));
			if (job.kind === "core") {
				if (job.changed?.length) card.append(h("p", { class: "hint" }, `${job.changed.length} source files changed${job.kernelChanges?.length ? ` · ${job.kernelChanges.length} kernel files require review` : ""}`));
				if (job.sourceDiff) card.append(h("pre", { class: "source-diff" }, job.sourceDiff), ...(job.diffTruncated ? [h("p", { class: "hint" }, "The complete patch is in the candidate folder.")] : []));
				if (job.validation?.counts) card.append(h("p", { class: "hint" }, `Source checks: ${job.validation.counts.passed ?? 0} passed · ${job.validation.counts.skipped ?? 0} platform skips`));
				if (job.windowsBuild === "pending" || job.appPreview === "pending") card.append(h("p", { class: "hint" }, "Source proposal prepared. Windows build and app preview are pending."));
			}
			if (job.previewSvg) card.append(h("img", { class: "change-preview", alt: "Candidate chart preview", src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(job.previewSvg)}` }));
			if (job.previewTokens && ["accent", "accent-hover", "accent-soft", "accent-line", "highlight", "on-accent"].every(key => /^#[0-9a-f]{6}$/i.test(job.previewTokens[key] ?? ""))) {
				const colors = job.previewTokens, preview = h("div", { class: "change-theme-preview", "aria-label": "Candidate accent color preview" }, h("span", {}, "Selected text color"), h("span", { class: "sample-button" }, "Button color"));
				preview.style.backgroundColor = colors["accent-soft"]; preview.style.color = colors.highlight; preview.style.borderColor = colors["accent-line"];
				preview.lastChild.style.backgroundColor = colors.accent; preview.lastChild.style.color = colors["on-accent"]; card.append(preview);
			}
			const actions = h("div", { class: "row2" });
			if (job.status === "preview-ready" && job.scope === "user") actions.append(h("button", { class: "sb pri", onclick: attempt(() => api.builder.activate({ jobId: job.id, digest: job.candidate.digest, expectedGeneration: job.baseGeneration }), "This private version is active.") }, "Use this version"));
			if (["requested", "waiting", "preparing", "patching", "validating"].includes(job.status)) actions.append(h("button", { class: "sb", onclick: attempt(() => api.builder.cancel({ jobId: job.id }), "Change job cancelled.") }, "Cancel"));
			if (["interrupted", "failed", "cancelled"].includes(job.status)) actions.append(h("button", { class: "sb", onclick: attempt(() => api.builder.resume({ jobId: job.id }), "Resuming the same candidate.") }, "Resume"));
			if (job.officialPath) actions.append(h("button", { class: "sb", onclick: attempt(() => api.clipboard.write(job.officialPath), "Official candidate folder copied.") }, "Copy candidate location"));
			card.append(actions); return card;
		});
		return sec("changes", "IMPROVE MIDNIGHT", h("p", { class: "hint" }, "Choose a component and describe its improvement. A separate builder prepares a preview and checks. My Midnight creates a private version; an official proposal produces source files for review."), component, scope, ...(selectedComponent?.available === false ? [h("p", { class: "hint" }, selectedComponent.reason ?? "Matching source files are required for app repairs.")] : []), prompt,
			h("div", { class: "row2" }, build, h("button", { class: "sb", onclick: attempt(async () => { await loadExtra(); }, "Change jobs refreshed.") }, "Refresh")), h("p", { class: "hint" }, "Restore the last good plugins from the tray if a customization breaks."), ...jobs);
	}
	// ---------- tabs ----------
	const TABS = [
		{ id: "general", label: "General", sections: () => [assistSection(), autonomySection(), answersSection(), launcherSection(), voiceSection(), webSection()] },
		{ id: "models", label: "Models", sections: () => [modelSection(), accountsSection(), privacySection(), usageSection()] },
		{ id: "files", label: "Files & memory", sections: () => [sourcesSection(), fileSearchSection(), memorySection()] },
		{ id: "automation", label: "Automation", sections: () => [rulesSection(), watchesSection(), routinesSection(), connectorsSection(), shareSection()] },
		{ id: "display", label: "Display", sections: () => [displaySection()] },
		{ id: "changes", label: "Changes", sections: () => [changesSection()] },
		{ id: "data", label: "Data", sections: () => [dataSection(), aboutSection()] },
	];
	const SECTION_TAB = { assist: "general", autonomy: "general", answers: "general", launcher: "general", voice: "general", web: "general", accounts: "models", model: "models", privacy: "models", usage: "models", sources: "files", "file-search": "files", memory: "files", rules: "automation", watches: "automation", routines: "automation", connectors: "automation", share: "automation", display: "display", changes: "changes", data: "data", about: "data" };
	let tab = "general";
	function tabBar() {
		const pick = (id) => {
			tab = id;
			render();
			root.querySelector(`.stabs [data-tab="${id}"]`)?.focus();
		};
		const bar = h("div", { class: "stabs", role: "tablist", "aria-label": "Settings sections" },
			...TABS.map((t) => h("button", { type: "button", role: "tab", "data-tab": t.id, "aria-selected": String(t.id === tab), tabindex: t.id === tab ? "0" : "-1", class: t.id === tab ? "on" : "", onclick: () => pick(t.id) }, t.label)));
		bar.onkeydown = (e) => {
			const i = TABS.findIndex((t) => t.id === tab);
			const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
			if (next === undefined) return;
			e.preventDefault();
			pick(TABS[(next + TABS.length) % TABS.length].id);
		};
		return bar;
	}

	// ---------- actions ----------
	async function login(id, type, key) {
		busy = id;
		setStatus(key ? "Saving key…" : "Starting sign-in…");
		try {
			const r = window.checkedResult(await api.auth.login(id, type, key));
			if (r.ok) keyFor = "";
			status = { text: "Signed in.", err: false };
		} catch (err) {
			status = { text: err.message === "Cancelled" ? "" : String(err.message ?? err), err: true };
		} finally {
			busy = "";
			modal?.remove();
			modal = undefined;
		}
		try { await refresh(); } catch (err) { setStatus(String(err.message ?? err), true); }
	}
	async function logout(id) {
		await api.auth.logout(id);
		status = { text: "Signed out.", err: false };
		await refresh();
	}

	function promptModal(m) {
		const p = m.prompt;
		let value = "";
		const done = (v) => {
			focusTrap.release(box);
			modal.remove();
			modal = undefined;
			api.auth.answer(m.id, v);
		};
		const message = h("p", { id: `authPrompt${m.id}` }, p.message);
		const box = h("div", { class: "box", role: "dialog", "aria-modal": "true", "aria-labelledby": message.id }, message);
		if (p.kind === "select") box.append(h("div", { class: "opts" }, ...p.options.map((o) => h("button", { class: "sb", onclick: () => done(o.id) }, o.label, o.description ? h("small", { class: "mono" }, `  ${o.description}`) : null))));
		else {
			const input = h("input", { class: "sinp", type: p.kind === "secret" ? "password" : "text", placeholder: p.placeholder ?? "" });
			input.oninput = () => (value = input.value.trim());
			input.onkeydown = (e) => e.key === "Enter" && value && done(value);
			box.append(input, h("button", { class: "sb", onclick: async () => { input.value = (await api.clipboard.read()).trim(); value = input.value; input.focus(); } }, "Paste from clipboard"));
			setTimeout(() => input.focus(), 50);
		}
		const row = h("div", { class: "row2" }, h("button", { class: "sb", onclick: () => done(null) }, "Cancel"));
		if (p.kind !== "select") row.append(h("button", { class: "sb pri", onclick: () => value && done(value) }, "OK"));
		box.append(row);
		modal?.remove();
		modal = h("div", { class: "modal" }, box);
		root.append(modal);
		focusTrap.contain(box, { focus: p.kind === "select" }); // a text prompt focuses its input instead
	}

	api.on((m) => {
		if (m.kind === "auth-prompt") promptModal(m);
		else if (m.kind === "auth-event") {
			const e = m.event;
			if (e.type === "auth_url") setStatus("Finish signing in in your browser…");
			else if (e.type === "device_code") setStatus(`Go to ${e.verificationUri} and enter ${e.userCode}`);
			else if (e.type === "info" || e.type === "progress") setStatus(e.message);
		}
	});

	// ---------- render ----------
	function render() {
		if (!S) return;
		cancelHotkeyCapture?.();
		closeMenu();
		const keep = root.querySelector(`.sbody[data-tab="${page === "welcome" ? "welcome" : tab}"]`)?.scrollTop ?? 0;
		root.textContent = "";
		root.append(
			h("div", { class: "sh" }, h("button", { class: "ib", title: "Back", "aria-label": "Back", onclick: () => window.closeSettings() }, "←"), h("b", {}, page === "welcome" ? "Welcome to midnight" : "Settings")),
			page === "welcome" ? null : tabBar(),
			h(
				"div",
				{ id: "sStatus", class: `${status.text ? "on" : ""}${status.err ? " err" : ""}`, role: "status" },
				h("span", {}, status.text),
				busy ? h("button", { class: "sb", onclick: () => api.auth.cancel() }, "Cancel") : h("button", { class: "sb", "aria-label": "Dismiss", onclick: () => setStatus("") }, "✕"),
			),
			page === "welcome" ? welcome() : h("div", { class: "sbody", role: "tabpanel", "data-tab": tab, "aria-label": TABS.find((t) => t.id === tab).label }, ...TABS.find((t) => t.id === tab).sections()),
		);
		if (modal) root.append(modal);
		const body = root.querySelector(".sbody");
		if (body) body.scrollTop = keep;
		if (scrollTo) {
			// Scroll only the settings panel; scrollIntoView would also nudge the window's own layout.
			const target = root.querySelector(`#sec-${scrollTo}`);
			if (body && target) body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top;
			scrollTo = undefined;
		}
	}

	window.renderSettings = async (section) => {
		page = section === "welcome" ? "welcome" : "main";
		scrollTo = section === "welcome" ? undefined : section;
		if (SECTION_TAB[section]) tab = SECTION_TAB[section];
		picking = section === "accounts";
		q = "";
		showAll = false;
		Object.keys(adding).forEach((k) => delete adding[k]);
		status = { text: "", err: false };
		assist = undefined;
		try { await refresh(); } catch (err) { setStatus(String(err.message ?? err), true); }
	};
})();
