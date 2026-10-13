import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, session, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_CHANNEL } from "./contracts/ipc.mjs";
import { createBrowsers } from "./desktop/browsers.mjs";
import { createAppRegistry } from "./apps/registry.mjs";
import { createAppWorkspace } from "./desktop/app-workspace.mjs";
import { createIpcRouter } from "./desktop/ipc.mjs";
import { createMediaDecoder } from "./desktop/media-decoder.mjs";
import { createAttachments } from "./desktop/attachments.mjs";
import { createOcr } from "./desktop/ocr.mjs";
import { openMcpApp } from "./desktop/mcp-app.mjs";
import { startMcpServer } from "./desktop/mcp-server.mjs";
import { execFile, spawn } from "node:child_process";
import { createHotkey } from "./desktop/hotkey.mjs";
import { MARGIN, windowBounds, windowDims } from "./desktop/window-layout.mjs";
import { createPlatform } from "./desktop/platform.mjs";
import { createWordBroker } from "./desktop/word-broker.mjs";
import { createQuickAssist, QUICK_HOTKEY } from "./desktop/quick-assist.mjs";
import { createQuickWindow } from "./desktop/quick-window.mjs";
import { createPluginExecutor } from "./desktop/plugin-executor.mjs";
import { createBuilderRunner } from "./desktop/builder-runner.mjs";
import { createPluginStore } from "./plugins/store.mjs";
import { RECOVERY_HELPER, registerRecoveryProfile } from "./desktop/recovery.mjs";
import { previewFile, closeFilePreviews } from "./desktop/file-preview.mjs";
import { createSupervisor } from "./desktop/supervisor.mjs";
import { createUpdater } from "./desktop/updater.mjs";
import { hostSettings, loadSettings } from "./settings.mjs";
import { armHelper, disarmHelper, noteForeground, stopComputer } from "./tools/computer.mjs";
import { userContext } from "./tools/userbrowser.mjs";
import { createWeb } from "./tools/web.mjs";
import { createScreenLease } from "./windows/lease.mjs";
import { createCaptureEpoch } from "./voice/capture-epoch.mjs";
import { createPushToTalk } from "./voice/ptt.mjs";
import { createPttRecorder } from "./desktop/ptt-recorder.mjs";
import { createPttHotkey, PTT_HOTKEY } from "./desktop/ptt-hotkey.mjs";
import { perceptionSettings } from "./perception/config.mjs";

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
	let mediaDecoder;
	let attachments;
	let mcpServer;
	const voiceFence = createCaptureEpoch();
	const wordBroker = createWordBroker();
	const pluginExecutor = createPluginExecutor();
	let quick, quickWindow;
	let ptt, pttRecorder, pttHotkey;
	let builderRunner;
	const mcpTokenFile = () => path.join(app.getPath("userData"), "mcp-token");
	const mcpManifest = () => dir("./desktop/native/manifest.json").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
	/** midnight's own MCP connector: on only while the setting is on; turning it off revokes every client. */
	async function syncMcpServer() {
		const want = settings.get().mcpServer && process.platform === "win32";
		if (want && !mcpServer) {
			mcpServer = startMcpServer({
				host: (method, params) => supervisor.request(method, params, 120000),
				tokenFile: mcpTokenFile(),
				version: app.getVersion(),
				log,
				onTask: (missionId, client) => {
					if (Notification.isSupported()) {
						const n = new Notification({ title: "midnight", body: `${client} started a task. It will ask you before changing anything.`, silent: true });
						n.on("click", () => (summon({ toggle: false }), toCapsule({ kind: "shell", type: "open-mission", missionId })));
						n.show();
					}
				},
			});
		} else if (!want && mcpServer) {
			await mcpServer.close();
			mcpServer = undefined;
			fs.rmSync(mcpTokenFile(), { force: true });
		}
	}
	let lastSize = "idle";
	let escHeld = false;
	const active = new Set(); // missions that are running (Esc only belongs to midnight while something runs)
	const logFile = path.join(app.getPath("userData"), "logs", "shell.log");
	const dataDir = path.join(app.getPath("userData"), "missions");
	let recoveryPlugins;

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
	try {
		registerRecoveryProfile(app.getPath("userData"));
		recoveryPlugins = createPluginStore({ root: path.join(dataDir, "plugins"), recover: false });
	} catch {
		if (process.env.MIDNIGHT_SMOKE) { console.log("[smoke] startup components need independent recovery"); app.exit(2); }
		else app.whenReady().then(() => {
			if (process.platform === "win32" && fs.existsSync(RECOVERY_HELPER)) {
				const repair = spawn(RECOVERY_HELPER, ["--profile", app.getPath("userData")], { detached: true, stdio: "ignore", windowsHide: false }); repair.on("error", () => {}); repair.unref();
			} else dialog.showErrorBox("Midnight needs recovery", "Midnight could not load its components. Open the recovery helper or use a verified installer.");
			app.exit(1);
		});
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
		voiceFence.setReason("emergency", "The emergency stop is on.");
		pttHotkey?.reset();
		quick?.invalidate();
		toCapsule({ kind: "shell", type: "session-state", blocked: true });
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
		voiceFence.invalidate();
		pttHotkey?.reset();
		supervisor?.signal({ type: "voice-cancel" });
		if (capsule && !capsule.isDestroyed()) {
			capsule.hide();
			toCapsule({ kind: "shell", type: "hidden" });
		}
	}
	function openSettings(section) {
		place("settings", { centre: true });
		if (capsule.isMinimized()) capsule.restore();
		capsule.show();
		capsule.focus();
		toCapsule({ kind: "shell", type: "relayout" });
		toCapsule({ kind: "shell", type: "open-settings", ...(typeof section === "string" ? { section } : {}) });
	}

	// The four-square mark, drawn for every display scale by scripts/build-icons.mjs; Electron picks tray@Nx.png for
	// the monitor's scale. macOS uses a template image it recolors for light and dark menu bars.
	function trayIcon() {
		if (process.platform === "darwin") {
			const img = nativeImage.createFromPath(dir("./assets/tray/trayTemplate.png"));
			img.setTemplateImage(true);
			return img;
		}
		return nativeImage.createFromPath(dir("./assets/tray/tray.png"));
	}
	let proactivePaused = false;
	let trayStopped = false;
	function rebuildTray(stopped = trayStopped, { syncFence = true } = {}) {
		if (!tray) return;
		trayStopped = stopped;
		if (syncFence) {
			voiceFence.setReason("emergency", stopped ? "The emergency stop is on." : undefined);
			if (stopped) pttHotkey?.reset();
			toCapsule({ kind: "shell", type: "session-state", blocked: voiceFence.blocked() });
		}
		tray.setContextMenu(
			Menu.buildFromTemplate([
				{ label: "Ask midnight", click: summon },
				{ label: "Quick edit selection · Ctrl+Alt+Space", enabled: false },
				{ label: "Set up selection help…", click: () => openSettings("assist") },
				{ label: `Hold to speak · ${PTT_HOTKEY}`, enabled: false },
				{ label: "Recent quick edit", enabled: !!quick?.hasRecent(), click: () => quick.recent() },
				{ label: "Restore last good plugins", click: () => { try { recoveryPlugins.rollback("user restored from tray"); toCapsule({ kind: "shell", type: "plugins-restored" }); } catch (err) { log("plugin recovery", err.message); } } },
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
		quick?.onEngine(m).catch(err => log("quick edit", err.message));
		engineHook?.(m);
		appWorkspace?.onEngine(m);
		if (m.kind === "update") {
			const s = m.mission?.status;
			if (m.missionId) {
				if (!m.mission?.targetAssist && ["running", "verifying", "planning", "recovering"].includes(s)) active.add(m.missionId);
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
		// Attachment ids from the renderer become their content here; the engine never sees renderer-supplied files.
		if ((method === "mission.create" || method === "mission.followUp") && params.attachments) params = { ...params, attachments: attachments.take(params.attachments) };
		if ((method === "mission.create" || method === "mission.followUp") && settings.get().shareContext && !appWorkspace?.ownsMission(params.missionId)) {
			params = { ...params, context: await Promise.race([userContext().catch(() => ""), new Promise((r) => setTimeout(() => r(""), 800))]) };
		}
		const result = await supervisor.request(method, params);
		if (method === "data.delete" && ["history", "all"].includes(params.scope)) appWorkspace?.forgetHistory();
		if (method === "data.delete" && ["history", "all"].includes(params.scope)) { quick?.forget(); wordBroker.reset(); }
		return result;
	}

	// ---------- shell-local IPC methods ----------
	const shellMethods = {
		"quick.state": () => quick.state(),
		"quick.submit": p => quick.submit(p),
		"quick.expand": p => quick.expand(p),
		"quick.apply": p => quick.apply(p),
		"quick.undo": p => quick.undo(p),
		"quick.reconcile": p => quick.reconcile(p),
		"quick.dismiss": p => { if (p.panelId !== quick.state().panelId) throw new Error("This quick-edit panel is no longer current."); if (ptt?.isWorking()) return ptt.cancel(); return quick.cancel(p); },
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
		"attachments.add": ({ path: filePath }) => attachments.add(filePath),
		"attachments.paste": () => attachments.paste(),
		"attachments.remove": ({ id }) => attachments.remove(id),
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
			return { settings: settings.get(), accounts, models, current, version: app.getVersion(), dataDir: app.getPath("userData"), engine: supervisor.state(), mcpServer: { running: !!mcpServer, manifest: mcpManifest(), bridge: mcpManifest().replace(/manifest\.json$/, "midnight-mcp.exe") } };
		},
		// Setup readiness for selection help: what the shell actually registered, not what settings intend.
		"assist.status": async () => {
			const office = await Promise.race([wordBroker.status().catch(err => ({ error: String(err.message ?? err) })), new Promise(resolve => setTimeout(() => resolve({ error: "Word/WPS did not answer in time." }), 5000))]);
			return { platform: process.platform, shortcut: QUICK_HOTKEY, shortcutRegistered: globalShortcut.isRegistered(QUICK_HOTKEY), holdShortcut: PTT_HOTKEY, holdListening: !!pttHotkey?.ready(), office: { installed: !!office.installed, provider: office.provider ?? "unknown", chartsQualified: office.provider === "wps" && !!office.chartQualification, error: office.error ?? "" } };
		},
		"settings.set": async ({ patch }) => {
			const before = settings.get();
			let error = "";
			if (typeof patch.hotkey === "string") {
				error = await hotkeys.set(patch.hotkey);
				if (error) delete patch.hotkey;
			}
			const after = settings.set(patch);
			if (["voice", "pushToTalk", "voiceLanguage", "privacy"].some(key => before[key] !== after[key]) || JSON.stringify(before.perception) !== JSON.stringify(after.perception)) { ptt?.cancel(); pttHotkey?.reset(); const pttError = await pttHotkey?.set(after.voice && after.pushToTalk); if (pttError) error = pttError; }
			if (after.launchAtLogin !== before.launchAtLogin && app.isPackaged && process.platform !== "linux") app.setLoginItemSettings({ openAtLogin: after.launchAtLogin });
			if (after.mcpServer !== before.mcpServer) await syncMcpServer();
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
			ptt?.cancel();
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
			ptt?.cancel();
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
		// Adding a connector runs a program or contacts a service: the user confirms the exact details in a system
		// dialog the page cannot draw or click.
		"connector.mcpAdd": async (draft) => {
			const what = draft.kind === "stdio" ? `Run this program as "${draft.name}":\n\n${draft.command} ${(draft.args ?? []).join(" ")}` : `Connect "${draft.name}" at:\n\n${draft.url}`;
			const r = await dialog.showMessageBox(capsule, { type: "warning", buttons: ["Add connector", "Cancel"], defaultId: 1, cancelId: 1, title: "Add a connector", message: `Add the connector "${draft.name}"?`, detail: `${what}\n\nMidnight will offer its tools to your missions. Tools ask before each use unless you review them as read-only. Only add connectors you trust.` });
			if (r.response !== 0) return { canceled: true };
			return supervisor.request("mcp.add", draft);
		},
		// Dictation: the launcher records, the hidden decoder turns it into 16 kHz samples, local Whisper transcribes.
		"voice.transcribe": async ({ audio, type }) => {
			const captureEpoch = voiceFence.begin();
			if (!settings.get().voice) throw new Error("Voice input is off. Turn it on in Settings → General → Voice input.");
			const media = await mediaDecoder.fromBytes(audio, "audio", type);
			try {
				const { samples } = await media.audio({ start: 0, seconds: 300 });
				voiceFence.assert(captureEpoch);
				const result = await supervisor.request("voice.transcribe", { samples, language: settings.get().voiceLanguage === "auto" ? null : settings.get().voiceLanguage }, 180000);
				voiceFence.assert(captureEpoch);
				return result;
			} finally {
				await media.close();
			}
		},
		"mcpapp.open": async ({ artifactId }) => {
			const view = await supervisor.request("artifact.view", { artifactId });
			return openMcpApp(view);
		},
		// Routines as files: the user picks where to save and what to open in the OS dialogs.
		// Register midnight's connector with Windows' on-device agent registry (preview; odr.exe on recent builds).
		"mcpserver.register": () =>
			new Promise((resolve) => {
				if (process.platform !== "win32") return resolve({ ok: false, reason: "Windows only.", manifest: mcpManifest() });
				execFile("odr.exe", ["mcp", "add", mcpManifest()], { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) =>
					resolve(err ? { ok: false, reason: err.code === "ENOENT" ? "This version of Windows has no agent registry (odr.exe). Other MCP clients can use the manifest below." : String(stderr || err.message).slice(0, 400), manifest: mcpManifest() } : { ok: true, output: String(stdout).slice(0, 400), manifest: mcpManifest() }),
				);
			}),
		"recipe.export": async ({ recipeId }) => {
			const routine = await supervisor.request("recipe.exportFile", { recipeId });
			const safe = routine.label.replace(/[^\p{L}\p{N} _.-]+/gu, "").trim().slice(0, 60) || "routine";
			const r = await dialog.showSaveDialog(capsule, { title: "Export routine", defaultPath: path.join(app.getPath("documents"), `${safe}.midnight-routine.json`), filters: [{ name: "midnight routine", extensions: ["json"] }] });
			if (r.canceled || !r.filePath) return { canceled: true };
			fs.writeFileSync(r.filePath, JSON.stringify(routine, null, 2));
			return { file: r.filePath };
		},
		"recipe.import": async () => {
			const r = await dialog.showOpenDialog(capsule, { title: "Import a routine", properties: ["openFile"], filters: [{ name: "midnight routine", extensions: ["json"] }] });
			if (r.canceled || !r.filePaths[0]) return { canceled: true };
			if (fs.statSync(r.filePaths[0]).size > 256 * 1024) throw new Error("This file is too large to be a routine.");
			let routine;
			try {
				routine = JSON.parse(fs.readFileSync(r.filePaths[0], "utf8"));
			} catch {
				throw new Error("This file is not a midnight routine.");
			}
			return supervisor.request("recipe.importFile", { routine });
		},
		"engine.restart": () => supervisor.restart(),
		"update.check": () => updater.check({ force: true }),
		"update.install": () => updater.install(),
	};

	app.whenReady().then(async () => {
		app.setAppUserModelId("midnight.app"); // lets notifications show while the capsule is tucked away
		// The microphone: only the launcher, only audio, and only while voice input is on. Everything else is refused.
		const micAllowed = (wc, permission, mediaTypes = []) => permission === "media" && wc === capsule?.webContents && capsule.isVisible() && !voiceFence.blocked() && settings.get().voice && mediaTypes.length > 0 && mediaTypes.every((t) => t === "audio");
		session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => cb(micAllowed(wc, permission, details?.mediaTypes)));
		session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => permission === "media" && wc === capsule?.webContents && capsule.isVisible() && !voiceFence.blocked() && settings.get().voice && details?.mediaType === "audio");
		if (process.platform === "darwin") app.dock?.hide();
		web = createWeb(settings); // windows are created lazily on first use (plan ch. 09: no eager warmup)
		browsers = createBrowsers();
		mediaDecoder = createMediaDecoder({ log });
		attachments = createAttachments({
			nativeImage,
			clipboard,
			async readPdfText(filePath) {
				const pdf = await mediaDecoder.session(filePath, "pdf");
				try {
					const pages = [];
					for (let page = 1; page <= Math.min(pdf.info.pages ?? 0, 200); page++) pages.push(`Page ${page}\n${(await pdf.text({ page })).text}`);
					return pages.join("\n\n");
				} finally {
					await pdf.close();
				}
			},
		});
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
		quickWindow = createQuickWindow({ getState: () => quick.state(), isBlocked: () => voiceFence.blocked(), onDismiss: () => { ptt?.cancel(); quick.cancel(); }, onReset: id => router?.reset(id), zoom: () => settings.get().textSize });
		quick = createQuickAssist({ word: wordBroker, request: (method, params) => supervisor.request(method, params), settings: () => settings.get(), blocked: () => voiceFence.blocked(),
			publish: state => { quickWindow.publish(state); if (["applied", "unknown", "undone", "closed"].includes(state.phase)) rebuildTray(trayStopped, { syncFence: false }); },
			present: options => quickWindow.present(options).catch(err => log("quick view", err.message)), hide: () => quickWindow.hide() });
		pttRecorder = createPttRecorder({ allowed: id => ptt?.currentId() === id && ptt.canRecord(), onError: (id, error) => { if (ptt?.currentId() === id) ptt.cancel(error.message); } });
		ptt = createPushToTalk({ quick, recorder: pttRecorder, fence: voiceFence, settings: () => settings.get(), prepareSpeech: (params, { signal }) => {
			const cancel = () => supervisor.request("voice.quickCancel", { captureId: params.captureId }).catch(() => {}); signal.addEventListener("abort", cancel, { once: true });
			if (signal.aborted) { cancel(); return Promise.reject(new Error("Voice preparation was cancelled.")); }
			return supervisor.request("voice.quickPrepare", params, 35_000).finally(() => signal.removeEventListener("abort", cancel));
		}, transcribe: (params, { signal }) => {
			const native = perceptionSettings(settings.get().perception).enabled;
			const cancel = () => supervisor.request(native ? "perception.cancel" : "voice.quickCancel", native ? { requestId: params.captureId } : { captureId: params.captureId }).catch(() => {}); signal.addEventListener("abort", cancel, { once: true });
			const capturedAt = params.capturedAt;
			const request = native ? supervisor.request("perception.observe", { requestId: params.captureId, purpose: "audio.intent", instruction: "Identify this spoken request, preserving names, numbers and negation.", capturedAt, expiresAt: params.deadline, media: [{ id: "utterance", kind: "audio", samples: params.samples, startMs: 0 }] }, 40_000).then(result => ({ text: result.instruction })) : supervisor.request("voice.quickTranscribe", params, 40_000);
			return request.finally(() => signal.removeEventListener("abort", cancel));
		}, cancelTranscription: captureId => Promise.allSettled([supervisor.request("voice.quickCancel", { captureId }), supervisor.request("perception.cancel", { requestId: captureId })]), publish: state => { tray?.setToolTip(state.phase === "idle" ? "midnight" : `midnight · ${state.phase === "listening" ? "Listening while the chord is held" : state.phase === "transcribing" ? state.cloudMedia ? "Understanding the utterance in the cloud" : "Transcribing locally" : "Preparing voice request"}`); } });
		pttHotkey = createPttHotkey({ onDown: foreground => ptt.down(foreground), onUp: () => ptt.up(), onCancel: () => ptt.cancel(), onError: error => { log("push to talk", error); toCapsule({ kind: "shell", type: "shortcut-error", error }); } });
		appWorkspace = createAppWorkspace({
			registry: createAppRegistry(path.join(app.getPath("userData"), "apps.json")), settings: () => settings.get(),
			request: (method, params) => supervisor.request(method, params),
			onChanged: (apps) => toCapsule({ kind: "shell", type: "apps", apps }),
			onReset: (id) => router?.reset(id),
			onViewTask: (missionId) => { summon({ toggle: false }); toCapsule({ kind: "shell", type: "open-mission", missionId }); },
		});
		router = createIpcRouter({
			ipcMain,
			isTrusted: (event) => (event.sender === capsule?.webContents && event.senderFrame === capsule.webContents.mainFrame && (event.senderFrame?.url ?? "").split("#")[0] === UI_URL) || quickWindow.isTrusted(event) || appWorkspace.isTrusted(event),
			canCall: (event, method) => quickWindow.isTrusted(event) ? method.startsWith("quick.") : !method.startsWith("quick.") && (event.sender === capsule?.webContents || method.startsWith("apps.")),
			shell: shellMethods,
			host: hostCall,
			log,
		});
		supervisor = createSupervisor({
			dataDir,
			recoveryProfile: app.getPath("userData"),
			settings: () => hostSettings(settings.get()),
			platform: createPlatform({ web, browsers, lease, onAct, allowedOpen, previewFile, mediaDecoder, wordBroker, pluginExecutor, builderRunner: { run: (job, options) => builderRunner.run(job, options) }, appEditAllowed: () => !voiceFence.blocked(), ocr: createOcr({ tempDir: app.getPath("temp") }) }),
			onMessage: onEngineMessage,
			onState: (s) => {
				log("engine", s.state, s.error ?? "");
				if (s.state !== "ready") { pttHotkey.reset(); quick.invalidate(); }
				toCapsule({ kind: "shell", type: "engine", ...s });
			},
			log,
		});
		builderRunner = createBuilderRunner({ maintenance: params => supervisor.request("builder.maintenance", params) });
		supervisor.start();
		supervisor.ready().then(syncMcpServer).catch((err) => log("mcp server", err.message));
		updater = createUpdater({
			version: app.getVersion(),
			isBusy: async () => active.size > 0 || !!lease.current() || !!quick.isWorking() || !!ptt.isWorking() || !!builderRunner?.isBusy() || pluginExecutor.isBusy(),
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
				if (ev === "lock-screen" || ev === "unlock-screen") voiceFence.setReason("lock", ev === "lock-screen" ? "The computer is locked." : undefined);
				if (ev === "suspend" || ev === "resume") voiceFence.setReason("suspend", ev === "suspend" ? "The computer is suspended." : undefined);
				if (["suspend", "lock-screen", "resume", "unlock-screen"].includes(ev)) pttHotkey.reset();
				if (ev === "suspend" || ev === "lock-screen") quick.invalidate();
				supervisor.signal({ type: ev });
				toCapsule({ kind: "shell", type: "session-state", blocked: voiceFence.blocked() });
				if (ev === "suspend" || ev === "lock-screen") await lease.revokeAll(ev);
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
		const pttError = await pttHotkey.set(settings.get().voice && settings.get().pushToTalk); if (pttError) log("push to talk", pttError);
		if (!globalShortcut.register(QUICK_HOTKEY, () => { if (!process.env.MIDNIGHT_SMOKE) quick.open().catch(err => log("quick shortcut", err.message)); })) log("quick shortcut", "Ctrl+Alt+Space is unavailable.");
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

		// The self-test approves what it is asked, so it never runs in an installed app.
		if (process.env.MIDNIGHT_SELFTEST && !app.isPackaged) selftest(process.env.MIDNIGHT_SELFTEST);
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
		const dx = Math.min(30, Math.max(0, Math.floor((wa.x + wa.width - original.x - original.width - MARGIN) / 2)));
		const dy = -Math.min(20, Math.max(0, Math.floor((original.y - wa.y - MARGIN) / 2)));
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
		// Native and archived pieces work in this build (packaged: inside app.asar with fuses, helpers unpacked).
		const native = await supervisor.request("diagnostics.native", {}, 60000).catch((err) => ({ error: err.message }));
		check(`sqlite-vec loads (${JSON.stringify(native)})`, native.vector === true);
		check("ONNX Runtime loads for local search", native.onnx === true);
		const pdfFile = path.join(app.getPath("temp"), `midnight-smoke-${process.pid}.pdf`);
		const stream = "BT /F1 18 Tf 20 100 Td (Smoke check page) Tj ET";
		const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
		let pdf = "%PDF-1.4\n";
		const offsets = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
		const xref = pdf.length;
		pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
		fs.writeFileSync(pdfFile, pdf, "latin1");
		try {
			const s = await mediaDecoder.session(pdfFile, "pdf");
			const text = (await s.text({ page: 1 })).text;
			const frame = await s.frame({ page: 1, max: 400, format: "jpeg" });
			await s.close();
			check(`media decoder reads PDFs (${text})`, text === "Smoke check page" && frame.jpeg.length > 500);
		} catch (err) {
			check(`media decoder reads PDFs (${err.message})`, false);
		} finally {
			fs.rmSync(pdfFile, { force: true });
		}
		if (process.platform === "win32") check("on-device OCR helper is present", createOcr().available());
		const mic = await capsule.webContents.executeJavaScript("navigator.permissions.query({ name: 'microphone' }).then((p) => p.state)").catch((err) => String(err));
		check(`the microphone is refused while voice input is off (${mic})`, settings.get().voice || mic === "denied");
		check("quick-edit shortcut registered", globalShortcut.isRegistered(QUICK_HOTKEY));
		await quickWindow.present({ mode: "notice", focus: false }); // closed state creates only a hidden fixture window
		const quickContents = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === new URL("./quick/index.html", import.meta.url).href);
		const quickState = await quickContents.webContents.executeJavaScript("(async()=>({phase:(await quick.state()).phase,methods:Object.keys(quick).sort(),node:typeof require}))()");
		check("quick view stays hidden without a captured selection", !quickContents.isVisible() && quickState.phase === "closed");
		check("quick preload exposes its limited bridge without Node", quickState.node === "undefined" && JSON.stringify(quickState.methods) === JSON.stringify(["apply", "dismiss", "expand", "on", "reconcile", "state", "submit", "undo"]));
		if (process.env.MIDNIGHT_SMOKE_BUILDER === "1") {
			try {
				const { qualifyBuilder } = await import("./desktop/builder-qualification.mjs");
				const result = await qualifyBuilder({ request: (method, params) => supervisor.request(method, params, 30_000), settings: settings.get(), emit: text => console.log(`[builder-check] ${text}`) });
				console.log(`[builder-check] RESULT ${JSON.stringify(result)}`);
			} catch (error) { console.log(`[builder-check] FAIL ${error.message}`); check("real cloud builder qualification", false); }
		}
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
		quick?.close(); quickWindow?.dispose();
		ptt?.close(); pttRecorder?.close();
		pluginExecutor.close();
		builderRunner?.close();
		wordBroker.close();
	});
	app.on("will-quit", async (e) => {
		hotkeys?.stop();
		const pttStopped = pttHotkey?.close();
		globalShortcut.unregisterAll();
		if (supervisor && supervisor.state() !== "stopped") {
			e.preventDefault();
			await pttStopped;
			await supervisor.stop();
			stopComputer();
			web?.dispose();
			browsers?.dispose();
			mediaDecoder?.dispose();
			await mcpServer?.close();
			app.exit(0);
		}
	});
	app.on("window-all-closed", () => {});
}
