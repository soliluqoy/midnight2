import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_CHANNEL } from "./contracts/ipc.mjs";
import { createBrowsers } from "./desktop/browsers.mjs";
import { createAppRegistry } from "./apps/registry.mjs";
import { createAppWorkspace } from "./desktop/app-workspace.mjs";
import { createIpcRouter } from "./desktop/ipc.mjs";
import { createHotkey } from "./desktop/hotkey.mjs";
import { windowBounds, windowDims } from "./desktop/window-layout.mjs";
import { createPlatform } from "./desktop/platform.mjs";
import { previewFile, closeFilePreviews } from "./desktop/file-preview.mjs";
import { createSupervisor } from "./desktop/supervisor.mjs";
import { createUpdater } from "./desktop/updater.mjs";
import { hostSettings, loadSettings } from "./settings.mjs";
import { armHelper, disarmHelper, noteForeground, stopComputer } from "./tools/computer.mjs";
import { userContext } from "./tools/userbrowser.mjs";
import { createWeb } from "./tools/web.mjs";
import { createScreenLease } from "./windows/lease.mjs";

// Isolated profiles for QA and smoke tests (never needed in normal use).
if (process.env.MIDNIGHT_USER_DATA) app.setPath("userData", path.resolve(process.env.MIDNIGHT_USER_DATA));
const settings = loadSettings();

startMissionShell();

function startMissionShell() {
	const dir = (p) => fileURLToPath(new URL(p, import.meta.url));
	const UI_URL = new URL("./ui/index.html", import.meta.url).href;
	const EXECUTABLE = /\.(exe|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|lnk|scr|hta|jar|reg|cpl|pif|appref-ms)$/i;

	let capsule;
	let overlay;
	let tray;
	let web;
	let browsers;
	let appWorkspace;
	let lease;
	let supervisor;
	let router;
	let updater;
	let hotkeys;
	let lastSize = "idle";
	let escHeld = false;
	const active = new Set(); // missions that are running (Esc only belongs to midnight while something runs)
	const logFile = path.join(app.getPath("userData"), "logs", "shell.log");
	const dataDir = path.join(app.getPath("userData"), "missions");

	const log = (...a) => {
		try {
			fs.mkdirSync(path.dirname(logFile), { recursive: true });
			const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`;
			fs.appendFileSync(logFile, line.replace(/(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, "[key]"));
		} catch {}
	};
	const toCapsule = (m) => capsule && !capsule.isDestroyed() && capsule.webContents.send(EVENT_CHANNEL, m);

	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return;
	}
	app.on("second-instance", () => summon());

	// ---------- placement: centre on summon; keep the user's dragged position on view/zoom changes ----------
	let launcherDisplay;
	function display() {
		return launcherDisplay ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
	}
	function dims() {
		return windowDims(display().workArea, settings.get().textSize);
	}
	function place(state, { centre = false } = {}) {
		const bounds = capsule.getBounds();
		if (centre) launcherDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
		else if (bounds.width > 1) launcherDisplay = screen.getDisplayMatching(bounds);
		const anchor = centre || bounds.width <= 1 ? undefined : { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
		lastSize = state;
		capsule.setBounds(windowBounds(state, display().workArea, settings.get().textSize, anchor));
		if (state === "idle") hideCapsule();
	}
	const applyZoom = () => capsule.webContents.setZoomFactor(settings.get().textSize);

	// ---------- Esc takes over, but only while midnight is working, so it never steals Esc from other apps ----------
	function syncEsc() {
		const want = active.size > 0 || !!lease?.current();
		if (want === escHeld) return;
		escHeld = want;
		if (want) globalShortcut.register("Escape", takeOver);
		else globalShortcut.unregister("Escape");
	}
	async function takeOver() {
		const owner = lease.current()?.missionId;
		await lease.revokeAll("esc"); // stop acknowledgment happens here, in the shell, before anything else
		supervisor.signal({ type: "lease-revoked", missionId: owner });
		toCapsule({ kind: "shell", type: "takeover", missionId: owner });
		overlay?.webContents.send("overlay", { type: "off" });
	}
	async function emergencyStop() {
		await lease.revokeAll("emergency");
		overlay?.webContents.send("overlay", { type: "off" });
		const r = await supervisor.request("stop.emergency", {}, 5000).catch((err) => ({ error: err.message }));
		toCapsule({ kind: "shell", type: "emergency", ...r });
		rebuildTray(true);
		return r;
	}

	function summon({ toggle = true } = {}) {
		if (!capsule || capsule.isDestroyed()) return;
		if (toggle && capsule.isVisible() && capsule.isFocused()) return hideCapsule();
		if (!capsule.isFocused() && !process.env.MIDNIGHT_SMOKE) noteForeground(); // where the user was, before the launcher takes focus
		const restore = lastSize !== "idle";
		place(restore ? lastSize : "chat", { centre: true });
		toCapsule({ kind: "shell", type: "relayout" });
		if (capsule.isMinimized()) capsule.restore();
		capsule.show();
		capsule.focus();
		toCapsule({ kind: "shell", type: "summon", restore });
	}
	function hideCapsule() {
		if (capsule && !capsule.isDestroyed()) {
			capsule.hide();
			toCapsule({ kind: "shell", type: "hidden" });
		}
	}
	function openSettings() {
		place("settings", { centre: true });
		if (capsule.isMinimized()) capsule.restore();
		capsule.show();
		capsule.focus();
		toCapsule({ kind: "shell", type: "relayout" });
		toCapsule({ kind: "shell", type: "open-settings" });
	}

	function trayIcon() {
		const n = 16;
		const buf = Buffer.alloc(n * n * 4);
		for (let y = 0; y < n; y++)
			for (let x = 0; x < n; x++) {
				const d = Math.hypot(x - 7.5, y - 7.5);
				const i = (y * n + x) * 4;
				if (d <= 6.5) [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]] = [0xd7, 0x78, 0x00, 255]; // BGRA · Windows blue
			}
		return nativeImage.createFromBuffer(buf, { width: n, height: n });
	}
	let proactivePaused = false;
	function rebuildTray(stopped = false) {
		if (!tray) return;
		tray.setContextMenu(
			Menu.buildFromTemplate([
				{ label: "Ask midnight", click: summon },
				{ label: "Settings…", click: openSettings },
				{ label: "Show background browser", click: () => browsers.peek() },
				{ type: "separator" },
				{
					label: "Pause proactive work",
					type: "checkbox",
					checked: proactivePaused,
					click: (item) => {
						proactivePaused = item.checked;
						supervisor.request("proactive.pause", { paused: proactivePaused }).catch(() => {});
					},
				},
				stopped
					? { label: "Resume after emergency stop", click: () => supervisor.request("stop.clear", {}).then(() => rebuildTray(false)).catch(() => {}) }
					: { label: "Emergency stop", click: emergencyStop },
				{ label: "Restart engine", click: () => supervisor.restart() },
				{
					label: "Check for updates…",
					click: async () => {
						const r = await updater.check({ force: true });
						toCapsule({ kind: "shell", type: "update", ...r });
						if (r.available) summon();
					},
				},
				{ type: "separator" },
				{ label: "Quit", click: () => app.quit() },
			]),
		);
	}

	async function createWindows() {
		capsule = new BrowserWindow({
			width: 1,
			height: 1,
			show: false,
			frame: false,
			transparent: true,
			resizable: false,
			movable: true,
			skipTaskbar: true,
			alwaysOnTop: true,
			hasShadow: false,
			title: "midnight",
			// background throttling on: hidden decorative animation stops (plan ch. 09)
			webPreferences: { preload: dir("./preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: true, spellcheck: false },
		});
		place("idle", { centre: true });
		capsule.on("close", (e) => { if (!app.isQuitting) { e.preventDefault(); hideCapsule(); } });
		capsule.on("minimize", hideCapsule);
		capsule.on("moved", () => {
			const next = screen.getDisplayMatching(capsule.getBounds());
			if (next.id !== launcherDisplay?.id) {
				launcherDisplay = next;
				toCapsule({ kind: "shell", type: "relayout" });
			}
		});
		capsule.webContents.setVisualZoomLevelLimits(1, 1);
		capsule.webContents.on("did-finish-load", applyZoom);
		capsule.webContents.on("did-start-loading", () => router?.reset(capsule.webContents.id));
		capsule.webContents.on("will-navigate", (e) => e.preventDefault()); // the capsule never leaves its page
		capsule.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		capsule.webContents.on("render-process-gone", () => setTimeout(() => !capsule.isDestroyed() && capsule.reload(), 500));
		capsule.webContents.on("before-input-event", (e, input) => {
			const modifier = process.platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
			if (input.type === "keyDown" && modifier && !input.alt && !input.shift && input.key.toLowerCase() === "h") {
				e.preventDefault();
				hideCapsule();
			}
		});
		capsule.webContents.on("context-menu", (_e, p) => {
			const items = p.isEditable
				? [{ role: "cut", enabled: p.editFlags.canCut }, { role: "copy", enabled: p.editFlags.canCopy }, { role: "paste", enabled: p.editFlags.canPaste }, { type: "separator" }, { role: "selectAll" }]
				: p.selectionText
					? [{ role: "copy" }]
					: [];
			if (items.length) items.push({ type: "separator" });
			items.push(
				{ label: "Hide to tray", accelerator: "CommandOrControl+H", registerAccelerator: false, click: hideCapsule },
				{ label: `Show again: ${(hotkeys?.get() || settings.get().hotkey).replace("CommandOrControl", process.platform === "darwin" ? "Cmd" : "Ctrl").replace("Control", "Ctrl").replace("Super", "Win")}`, enabled: false },
			);
			Menu.buildFromTemplate(items).popup({ window: capsule });
		});
		capsule.loadFile(dir("./ui/index.html"));

		// Click-through layer: the purple cursor and frame that show what midnight is doing on screen.
		const db = display().bounds;
		overlay = new BrowserWindow({
			...db,
			frame: false,
			transparent: true,
			focusable: false,
			skipTaskbar: true,
			alwaysOnTop: true,
			hasShadow: false,
			show: false,
			webPreferences: { preload: dir("./preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: true, partition: "midnight-overlay" },
		});
		overlay.setAlwaysOnTop(true, "screen-saver");
		overlay.setIgnoreMouseEvents(true);
		overlay.setContentProtection(true); // never appears in the agent's own screenshots
		overlay.webContents.on("will-navigate", (e) => e.preventDefault());
		overlay.loadFile(dir("./ui/overlay.html"));
		overlay.showInactive();
	}

	function onAct(a) {
		if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay", { type: "act", ...a });
	}

	function allowedOpen(p) {
		if (EXECUTABLE.test(p)) return false;
		return true; // the host only sends artifact paths it staged or published inside selected folders
	}

	// ---------- engine ----------
	let engineHook; // the headless self-test listens here
	function onEngineMessage(m) {
		engineHook?.(m);
		appWorkspace?.onEngine(m);
		if (m.kind === "update") {
			const s = m.mission?.status;
			if (m.missionId) {
				if (["running", "verifying", "planning", "recovering"].includes(s)) active.add(m.missionId);
				else active.delete(m.missionId);
				if (["succeeded", "partially-succeeded", "failed", "cancelled"].includes(s)) browsers?.close(m.missionId);
				syncEsc();
			}
			if (m.type === "notification.created" && m.notifications) {
				const n = m.notifications.find((n) => n.id === m.notificationId);
				if (n && n.status === "queued" && !capsule.isFocused() && Notification.isSupported()) {
					const toast = new Notification({ title: `midnight · ${n.title}`, body: String(n.reason ?? "").slice(0, 180), silent: true });
					toast.on("click", () => (summon(), toCapsule({ kind: "shell", type: "open-mission", missionId: n.missionId })));
					toast.show();
				}
			}
		}
		if (m.kind === "auth-event" && m.event?.type === "auth_url" && /^https:\/\//.test(m.event.url)) shell.openExternal(m.event.url);
		toCapsule(m);
	}

	async function hostCall(method, params) {
		if ((method === "mission.create" || method === "mission.followUp") && settings.get().shareContext && !appWorkspace?.ownsMission(params.missionId)) {
			params = { ...params, context: await Promise.race([userContext().catch(() => ""), new Promise((r) => setTimeout(() => r(""), 800))]) };
		}
		const result = await supervisor.request(method, params);
		if (method === "data.delete" && ["history", "all"].includes(params.scope)) appWorkspace?.forgetHistory();
		return result;
	}

	// ---------- shell-local IPC methods ----------
	const shellMethods = {
		"ui.size": ({ state }) => place(state),
		"ui.dims": () => dims(),
		"ui.focus": () => capsule.isVisible() && capsule.focus(),
		"ui.hide": hideCapsule,
		"ui.show": () => summon({ toggle: false }),
		"ui.textSize": ({ z }) => {
			settings.set({ textSize: z });
			applyZoom();
			toCapsule({ kind: "shell", type: "relayout" });
			return settings.get().textSize;
		},
		"clipboard.read": () => clipboard.readText().slice(0, 30000),
		"clipboard.write": ({ text }) => clipboard.writeText(text),
		"open.external": ({ url }) => (/^https?:\/\//i.test(url) ? shell.openExternal(url) : undefined),
		"browser.peek": () => browsers.peek(),
		"apps.state": () => appWorkspace.state(),
		"apps.open": (p, event) => appWorkspace.open(p, { activate: event?.sender !== capsule?.webContents }),
		"apps.add": (p) => appWorkspace.add(p),
		"apps.update": (p) => appWorkspace.update(p),
		"apps.remove": (p) => appWorkspace.remove(p),
		"apps.layout": (p) => appWorkspace.layout(p),
		"apps.command": (p) => appWorkspace.command(p),
		"apps.ask": (p) => appWorkspace.ask(p),
		"apps.stop": (p) => appWorkspace.stop(p),
		"apps.viewTask": (p) => appWorkspace.viewTask(p),
		"settings.get": async () => {
			const [accounts, models, current] = await Promise.all([supervisor.auth("accounts").catch(() => []), supervisor.auth("models").catch(() => []), supervisor.auth("current").catch(() => ({ provider: "", model: "" }))]);
			return { settings: settings.get(), accounts, models, current, version: app.getVersion(), dataDir: app.getPath("userData"), engine: supervisor.state() };
		},
		"settings.set": async ({ patch }) => {
			const before = settings.get();
			let error = "";
			if (typeof patch.hotkey === "string") {
				error = await hotkeys.set(patch.hotkey);
				if (error) delete patch.hotkey;
			}
			const after = settings.set(patch);
			if (after.launchAtLogin !== before.launchAtLogin && app.isPackaged && process.platform !== "linux") app.setLoginItemSettings({ openAtLogin: after.launchAtLogin });
			if (after.textSize !== before.textSize) {
				applyZoom();
				toCapsule({ kind: "shell", type: "relayout" });
			}
			supervisor.settings(hostSettings(after));
			appWorkspace?.refresh();
			toCapsule({ kind: "shell", type: "settings", settings: after });
			const current = await supervisor.auth("current").catch(() => ({ provider: "", model: "" }));
			toCapsule({ kind: "shell", type: "model", ...current });
			return { settings: after, current, error };
		},
		"auth.login": async ({ provider, type, key }) => {
			try {
				await supervisor.auth("login", { provider, type, key: key?.trim() || undefined });
				const current = await supervisor.auth("current");
				toCapsule({ kind: "shell", type: "model", ...current });
				return { ok: true, current };
			} catch (err) {
				return { ok: false, error: String(err?.message ?? err) };
			}
		},
		"auth.cancel": () => supervisor.auth("cancel"),
		"auth.logout": async ({ provider }) => {
			await supervisor.auth("logout", { provider });
			toCapsule({ kind: "shell", type: "model", ...(await supervisor.auth("current")) });
		},
		"auth.answer": ({ promptId, value }) => supervisor.auth("answer", { promptId, value }),
		"data.clearBrowser": async () => {
			await browsers.clear();
			await web.clear();
			await appWorkspace.clear();
		},
		"data.openFolder": () => shell.openPath(app.getPath("userData")),
		// The only way a folder becomes readable: the user picks it in the OS dialog.
		"sources.pick": async ({ purpose }) => {
			const r = await dialog.showOpenDialog(capsule, { title: purpose === "output" ? "Choose a folder midnight may save drafts to" : "Choose a folder midnight may read", properties: ["openDirectory"] });
			if (r.canceled || !r.filePaths[0]) return { canceled: true };
			return supervisor.request("sources.add", { path: r.filePaths[0], purpose });
		},
		"diagnostics.save": async () => {
			const { preview } = await supervisor.request("diagnostics.preview", {});
			const r = await dialog.showSaveDialog(capsule, { title: "Save support bundle", defaultPath: path.join(app.getPath("downloads"), `midnight-support-${Date.now()}.json`) });
			if (r.canceled || !r.filePath) return { canceled: true };
			let shellLog = "";
			try {
				shellLog = fs.readFileSync(logFile, "utf8").split("\n").slice(-300).join("\n");
			} catch {}
			fs.writeFileSync(r.filePath, JSON.stringify({ ...preview, shellLog }, null, 2));
			return { file: r.filePath };
		},
		"engine.restart": () => supervisor.restart(),
		"update.check": () => updater.check({ force: true }),
		"update.install": () => updater.install(),
	};

	app.whenReady().then(async () => {
		app.setAppUserModelId("midnight.app"); // lets notifications show while the capsule is tucked away
		if (process.platform === "darwin") app.dock?.hide();
		web = createWeb(settings); // windows are created lazily on first use (plan ch. 09: no eager warmup)
		browsers = createBrowsers();
		lease = createScreenLease({
			userIdleMs: () => powerMonitor.getSystemIdleTime() * 1000,
			arm: (epoch) => (process.platform === "win32" ? armHelper(epoch) : Promise.resolve()),
			disarm: () => disarmHelper(),
			onChange: (holder) => {
				toCapsule({ kind: "shell", type: "screen", holder });
				if (!holder) overlay?.webContents.send("overlay", { type: "off" });
				syncEsc();
			},
		});
		await createWindows();
		appWorkspace = createAppWorkspace({
			registry: createAppRegistry(path.join(app.getPath("userData"), "apps.json")), settings: () => settings.get(),
			request: (method, params) => supervisor.request(method, params),
			onChanged: (apps) => toCapsule({ kind: "shell", type: "apps", apps }),
			onReset: (id) => router?.reset(id),
			onViewTask: (missionId) => { summon({ toggle: false }); toCapsule({ kind: "shell", type: "open-mission", missionId }); },
		});
		router = createIpcRouter({
			ipcMain,
			isTrusted: (event) => (event.sender === capsule?.webContents && event.senderFrame === capsule.webContents.mainFrame && (event.senderFrame?.url ?? "").split("#")[0] === UI_URL) || appWorkspace.isTrusted(event),
			canCall: (event, method) => event.sender === capsule?.webContents || method.startsWith("apps."),
			shell: shellMethods,
			host: hostCall,
			log,
		});
		supervisor = createSupervisor({
			dataDir,
			settings: () => hostSettings(settings.get()),
			platform: createPlatform({ web, browsers, lease, onAct, allowedOpen, previewFile }),
			onMessage: onEngineMessage,
			onState: (s) => {
				log("engine", s.state, s.error ?? "");
				toCapsule({ kind: "shell", type: "engine", ...s });
			},
			log,
		});
		supervisor.start();
		updater = createUpdater({
			version: app.getVersion(),
			isBusy: async () => active.size > 0 || !!lease.current(),
			backup: () => supervisor.request("data.backup", {}),
			launch: (file) => {
				shell.openPath(file);
				setTimeout(() => app.quit(), 1500); // the installer replaces the app once it has quit
			},
			openPage: (url) => url && shell.openExternal(url),
		});
		if (settings.get().updates === "notify" && app.isPackaged) setTimeout(() => updater.check().then((r) => r.available && toCapsule({ kind: "shell", type: "update", ...r })), 60000);
		// Start quietly in the tray: there is no resting pill or other visible launcher window.

		// Power, lock and session signals: stop starting actions, give the screen back, catch up after waking.
		for (const ev of ["suspend", "resume", "on-ac", "on-battery", "lock-screen", "unlock-screen"]) {
			powerMonitor.on(ev, async () => {
				if (ev === "suspend" || ev === "lock-screen") await lease.revokeAll(ev);
				supervisor.signal({ type: ev });
			});
		}
		if (powerMonitor.isOnBatteryPower?.()) supervisor.signal({ type: "on-battery" });

		hotkeys = createHotkey({
			globalShortcut,
			onTrigger: summon,
			onError: (error) => { log("shortcut", error); toCapsule({ kind: "shell", type: "shortcut-error", error }); },
		});
		tray = new Tray(trayIcon());
		tray.setToolTip("midnight");
		tray.on("click", summon);
		rebuildTray();
		const shortcutError = await hotkeys.set(settings.get().hotkey);
		if (shortcutError) { log("shortcut", shortcutError); toCapsule({ kind: "shell", type: "shortcut-error", error: shortcutError }); }
		screen.on("display-metrics-changed", (_e, d) => {
			if (d.id === launcherDisplay?.id) launcherDisplay = d;
			toCapsule({ kind: "shell", type: "relayout" });
		});
		screen.on("display-removed", () => {
			launcherDisplay = screen.getDisplayMatching(capsule.getBounds());
			place(lastSize); // never leave the launcher on a monitor that is gone
			toCapsule({ kind: "shell", type: "relayout" });
		});

		if (process.env.MIDNIGHT_SELFTEST) selftest(process.env.MIDNIGHT_SELFTEST);
		if (process.env.MIDNIGHT_SMOKE) smoke();
		if (process.env.MIDNIGHT_PERF) perf(Number(process.env.MIDNIGHT_PERF) || 60);
	});

	// Idle trace (plan ch. 09): every Midnight process, sampled; whole-app CPU normalized to all cores; no model calls.
	async function perf(seconds) {
		await supervisor.ready();
		const t0 = Date.now();
		await new Promise((r) => setTimeout(r, 5000)); // past startup
		const cpu = [];
		const mem = [];
		const types = {};
		while (Date.now() - t0 < seconds * 1000 + 5000) {
			const ms = app.getAppMetrics();
			cpu.push(ms.reduce((a, m) => a + (m.cpu?.percentCPUUsage ?? 0), 0));
			mem.push(ms.reduce((a, m) => a + (m.memory?.privateBytes ?? m.memory?.workingSetSize ?? 0), 0) / 1024);
			for (const m of ms) types[m.type] = Math.round((m.memory?.privateBytes ?? m.memory?.workingSetSize ?? 0) / 1024);
			await new Promise((r) => setTimeout(r, 2000));
		}
		const pct = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];
		const snap = await supervisor.request("resources.status", {});
		const cores = (await import("node:os")).cpus().length;
		console.log(
			`[perf] ${seconds}s idle · ${cores} cores · CPU median ${pct(cpu, 0.5).toFixed(2)}% p95 ${pct(cpu, 0.95).toFixed(2)}% (of one core; machine-normalized median ${(pct(cpu, 0.5) / cores).toFixed(3)}%) · private memory median ${pct(mem, 0.5).toFixed(0)} MB p95 ${pct(mem, 0.95).toFixed(0)} MB · by type ${JSON.stringify(types)} MB · queue ${JSON.stringify(snap.queue)}`,
		);
		await supervisor.stop();
		app.exit(0);
	}

	// Smoke check: the shell starts, the engine comes up in its own process, the capsule renders without errors.
	async function smoke() {
		const errors = [];
		capsule.webContents.on("console-message", (e) => {
			const level = e.level ?? e.params?.level;
			if (level === "error" || level === 3) errors.push(e.message ?? e.params?.message);
		});
		const t0 = Date.now();
		const timeout = setTimeout(() => {
			console.log(`[smoke] engine not ready after 30s (state ${supervisor.state()})`);
			app.exit(2);
		}, 30000);
		await supervisor.ready();
		const ms = Date.now() - t0;
		const snap = await supervisor.request("query.snapshot", {});
		const res = await supervisor.request("resources.status", {});
		await new Promise((r) => setTimeout(r, 2500)); // let the renderer finish its first paint and requests
		const ui = await capsule.webContents.executeJavaScript("({ state: document.getElementById('cap').dataset.s, status: document.getElementById('idleSt').textContent })").catch((err) => ({ error: String(err) }));
		clearTimeout(timeout);
		const checks = [];
		const check = (name, ok) => { checks.push({ name, ok }); if (!ok) errors.push(`window check failed: ${name}`); };
		check("startup is tray-only", !capsule.isVisible());
		check("summon shortcut registered", hotkeys.get() === settings.get().hotkey);
		const centred = () => {
			const b = capsule.getBounds(), wa = display().workArea;
			return Math.abs(b.x + b.width / 2 - (wa.x + wa.width / 2)) <= 1 && Math.abs(b.y + b.height / 2 - (wa.y + wa.height / 2)) <= 1;
		};
		summon();
		await new Promise((r) => setTimeout(r, 600));
		check("summon is visible and centred", capsule.isVisible() && centred());
		const original = capsule.getBounds();
		const wa = display().workArea;
		const dx = Math.min(30, Math.floor((wa.x + wa.width - original.x - original.width) / 2));
		const dy = -Math.min(20, Math.floor((original.y - wa.y) / 2));
		capsule.setPosition(original.x + dx, original.y + dy);
		await capsule.webContents.executeJavaScript("window.midnight.ui.size(document.getElementById('cap').dataset.s)");
		check("relayout preserves dragged position", capsule.getBounds().x === original.x + dx && capsule.getBounds().y === original.y + dy);
		await capsule.webContents.executeJavaScript("window.midnight.apps.open({})");
		await new Promise((r) => setTimeout(r, 150));
		const appsWindow = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/apps.html"));
		check("Apps opens without hiding or taking focus from Midnight", capsule.isVisible() && capsule.isFocused() && appsWindow?.isVisible() && !appsWindow.isFocused() && !appsWindow.isAlwaysOnTop());
		appsWindow.minimize();
		await new Promise((r) => setTimeout(r, 150));
		capsule.focus(); // reopening comes from a click in Midnight
		await capsule.webContents.executeJavaScript("window.midnight.apps.open({})");
		await new Promise((r) => setTimeout(r, 150));
		check("minimized Apps reopens without taking focus", appsWindow.isVisible() && !appsWindow.isMinimized() && capsule.isFocused());
		appsWindow.close();
		check("closing Apps leaves Midnight visible", !appsWindow.isVisible() && capsule.isVisible());
		await capsule.webContents.executeJavaScript("window.midnight.apps.open({add:true})");
		await new Promise((r) => setTimeout(r, 150));
		check("adding a website preserves Midnight focus", capsule.isFocused() && appsWindow.isVisible() && await appsWindow.webContents.executeJavaScript("document.getElementById('appDialog').open"));
		appsWindow.close();
		await capsule.webContents.executeJavaScript("document.getElementById('windowMin').click()");
		await new Promise((r) => setTimeout(r, 100));
		check("minimize hides without destroying", !capsule.isVisible() && !capsule.isDestroyed());
		summon();
		await new Promise((r) => setTimeout(r, 300));
		check("restoring recentres", capsule.isVisible() && centred());
		capsule.minimize();
		await new Promise((r) => setTimeout(r, 100));
		check("native minimize hides to tray", !capsule.isVisible());
		summon();
		await new Promise((r) => setTimeout(r, 300));
		check("native minimize can be restored", capsule.isVisible() && !capsule.isMinimized() && centred());
		capsule.close();
		check("native close hides to tray", !capsule.isDestroyed() && !capsule.isVisible());
		console.log(`[smoke] engine ready in ${ms} ms · seq ${snap.seq} · missions ${Object.keys(snap.missions).length} · weather "${res.weather?.text}" · ui ${JSON.stringify(ui)} · renderer errors ${errors.length}`);
		for (const c of checks) console.log(`[smoke] ${c.ok ? "PASS" : "FAIL"} ${c.name}`);
		for (const e of errors) console.log(`[smoke] renderer error: ${e}`);
		hotkeys.stop();
		await supervisor.stop();
		app.exit(errors.length ? 1 : 0);
	}

	// Headless check: MIDNIGHT_SELFTEST="prompt" runs one mission, approves what it asks (as the UI would), prints, exits.
	async function selftest(prompt) {
		await supervisor.ready();
		const t0 = Date.now();
		const seen = new Set();
		const done = new Promise((resolve) => {
			engineHook = (m) => {
				if (m.kind === "live" && m.type === "text") process.stdout.write(m.delta);
				if (m.kind !== "update" || !m.mission) return;
				for (const a of m.mission.approvals ?? []) {
					if (seen.has(a.id)) continue;
					seen.add(a.id);
					console.log(`\n[approval] ${a.display?.title}`);
					supervisor.request("approval.displayed", { approvalId: a.id, nonce: a.nonce }).then(() => supervisor.request("approval.decide", { approvalId: a.id, nonce: a.nonce, intentHash: a.intentHash, decision: process.env.MIDNIGHT_SELFTEST_ASK === "no" ? "decline" : "approve" }));
				}
				if (m.type === "action.prepared") console.log(`\n[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m.mission.feed.at(-1)?.text}`);
				if (m.type === "mission.completed") resolve(m.mission);
			};
		});
		const r = await supervisor.request("mission.create", { text: prompt, requestId: `selftest-${Date.now()}` });
		console.log(`[mission] ${r.missionId}`);
		const m = await done;
		console.log(`\n[outcome] ${m.outcome?.status} · ${m.outcome?.summary} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
		await supervisor.stop();
		app.exit(m.outcome?.status === "succeeded" ? 0 : 1);
	}
	app.on("before-quit", () => {
		app.isQuitting = true;
		appWorkspace?.dispose();
		closeFilePreviews();
	});
	app.on("will-quit", async (e) => {
		hotkeys?.stop();
		globalShortcut.unregisterAll();
		if (supervisor && supervisor.state() !== "stopped") {
			e.preventDefault();
			await supervisor.stop();
			stopComputer();
			web?.dispose();
			browsers?.dispose();
			app.exit(0);
		}
	});
	app.on("window-all-closed", () => {});
}
