import { BrowserWindow, WebContentsView, clipboard, session, shell } from "electron";
import { fileURLToPath } from "node:url";
import { EVENT_CHANNEL } from "../contracts/ipc.mjs";
import { appPartition, websiteUrl } from "../apps/registry.mjs";
import { PAGE_TEXT_SCRIPT } from "../apps/page-context.mjs";

const local = (p) => fileURLToPath(new URL(p, import.meta.url));
const UI_URL = new URL("../ui/apps.html", import.meta.url).href;
const END = new Set(["succeeded", "partially-succeeded", "failed", "cancelled"]);
const webUrl = (url) => { try { return websiteUrl(url); } catch { return null; } };

// The trusted shell and remote pages are different webContents. Only the shell has a preload.
export function createAppWorkspace({ registry, settings, request, onChanged = () => {}, onViewTask = () => {}, onReset = () => {}, showWindow = true }) {
	let win, opening, activeId, rect, covered = false, disposed = false, revision = 0;
	const views = new Map();
	const sessions = new Set();
	const popups = new Map();
	const missions = new Map();
	const asking = new Set();
	const send = (m) => { if (win && !win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, m); };
	const changed = () => { revision++; send({ kind: "apps", state: state() }); onChanged(registry.list()); };
	function pageState(id) {
		const entry = views.get(id), wc = entry?.view.webContents;
		return wc && !wc.isDestroyed() ? { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), error: entry.error, back: wc.navigationHistory.canGoBack(), forward: wc.navigationHistory.canGoForward() } : null;
	}
	function state() {
		const prefs = settings();
		return { revision, apps: registry.list(), activeId, page: pageState(activeId), missions: [...missions.values()], model: prefs.taskModel || "your configured AI model", privacy: prefs.privacy, highContrast: prefs.highContrast, reducedMotion: prefs.reducedMotion };
	}
	function layout() {
		if (!win || win.isDestroyed()) return;
		const [width, height] = win.getContentSize();
		for (const [id, { view }] of views) {
			const visible = id === activeId && !covered && !!rect && win.isVisible();
			view.setVisible(visible);
			if (!visible) continue;
			const x = Math.max(0, Math.min(width, Math.round(rect.x)));
			const y = Math.max(0, Math.min(height, Math.round(rect.y)));
			view.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(rect.width))), height: Math.max(0, Math.min(height - y, Math.round(rect.height))) });
		}
	}
	async function ensureWindow() {
		if (opening) return opening;
		if (win && !win.isDestroyed()) return;
		win = new BrowserWindow({ width: 1240, height: 820, minWidth: 700, minHeight: 520, show: false, title: "midnight · Apps", backgroundColor: "#202027", autoHideMenuBar: true,
			webPreferences: { preload: local("../apps-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, partition: "midnight-apps-shell", offscreen: !showWindow } });
		win.webContents.on("will-navigate", (e) => e.preventDefault());
		win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		win.webContents.on("did-start-loading", () => { rect = null; layout(); onReset(win.webContents.id); });
		win.on("resize", () => { layout(); send({ kind: "apps-layout" }); });
		win.on("show", layout);
		win.on("hide", layout);
		win.on("close", (event) => { if (!disposed) { event.preventDefault(); win.hide(); } });
		opening = win.loadFile(local("../ui/apps.html")).finally(() => { opening = null; });
		await opening;
	}
	function configureSession(id) {
		const ses = session.fromPartition(appPartition(id));
		if (sessions.has(id)) return ses;
		sessions.add(id);
		// Site permissions are separate from asking Midnight for help. No implicit grants.
		ses.setPermissionCheckHandler(() => false);
		ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
		ses.on("will-download", (_event, item) => {
			item.setSaveDialogOptions({ title: "Save website download", defaultPath: item.getFilename() });
		});
		return ses;
	}
	function protectRemote(wc, id) {
		for (const event of ["will-navigate", "will-redirect", "will-frame-navigate"]) wc.on(event, (e, url) => {
			const target = typeof url === "string" ? url : e.url;
			if (target && target !== "about:blank" && !webUrl(target)) e.preventDefault();
		});
		wc.setWindowOpenHandler(({ url }) => {
			if ((!webUrl(url) && url !== "about:blank") || (popups.get(id)?.size ?? 0) >= 3) return { action: "deny" };
			return { action: "allow", overrideBrowserWindowOptions: { width: 800, height: 720, autoHideMenuBar: true, show: showWindow, parent: win,
				webPreferences: { partition: appPartition(id), contextIsolation: true, sandbox: true, nodeIntegration: false } } };
		});
		wc.on("did-create-window", (child) => {
			const set = popups.get(id) ?? new Set(); popups.set(id, set); set.add(child);
			child.on("closed", () => set.delete(child));
			protectRemote(child.webContents, id);
		});
	}
	function ensureView(id) {
		let entry = views.get(id);
		if (entry && !entry.view.webContents.isDestroyed()) return entry;
		const item = registry.get(id);
		configureSession(id);
		const view = new WebContentsView({ webPreferences: { partition: appPartition(id), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: true } });
		entry = { view, error: "", generation: 0 };
		views.set(id, entry);
		win.contentView.addChildView(view);
		view.setVisible(false);
		const wc = view.webContents;
		protectRemote(wc, id);
		wc.on("did-start-navigation", (_e, _url, _inPlace, isMainFrame) => { if (isMainFrame) { entry.generation++; entry.error = ""; changed(); } });
		for (const ev of ["did-stop-loading", "did-navigate-in-page", "page-title-updated"]) wc.on(ev, changed);
		wc.on("did-fail-load", (_e, code, description, _url, isMainFrame) => { if (isMainFrame && code !== -3) { entry.error = `This page could not load (${description}). Try Reload or Open in browser.`; changed(); } });
		wc.on("render-process-gone", () => { entry.error = "This page stopped responding. Reload to reopen it."; changed(); });
		wc.on("before-input-event", (e, input) => {
			if (input.type === "keyDown" && (input.control || input.meta) && input.key.toLowerCase() === "j") { e.preventDefault(); send({ kind: "apps-assistant" }); }
		});
		wc.loadURL(item.url).catch(() => {});
		return entry;
	}
	async function open({ id, add = false } = {}, { activate = true } = {}) {
		if (id) registry.get(id);
		await ensureWindow();
		if (id) { activeId = id; ensureView(id); registry.opened(id); }
		if (showWindow) {
			// Launching from Midnight keeps its main window in control until the user switches.
			if (activate) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
			else win.showInactive();
		}
		layout(); changed();
		if (add) send({ kind: "apps-add" });
		return state();
	}
	function closeView(id) {
		for (const popup of popups.get(id) ?? []) if (!popup.isDestroyed()) popup.destroy();
		popups.delete(id);
		const entry = views.get(id);
		if (entry) {
			views.delete(id);
			if (win && !win.isDestroyed()) win.contentView.removeChildView(entry.view);
			if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
		}
	}
	async function clearProfile(id) {
		registry.get(id);
		closeView(id);
		const ses = configureSession(id);
		await ses.clearStorageData(); await ses.clearCache(); await ses.clearAuthCache(); await ses.closeAllConnections();
	}
	async function capture(id, scope) {
		const item = registry.get(id);
		if (id !== activeId) throw new Error("The active app changed. Review the page and send again.");
		const entry = views.get(id), wc = entry?.view.webContents;
		if (!wc || wc.isDestroyed()) throw new Error("Open this app first.");
		const url = webUrl(wc.getURL());
		if (!url || wc.isLoading() || entry.error) throw new Error("Wait for the page to finish loading, then try again.");
		const generation = entry.generation;
		const result = scope === "none" ? {} : await wc.executeJavaScriptInIsolatedWorld(999, [{ code: PAGE_TEXT_SCRIPT }]);
		if (activeId !== id || wc.isDestroyed() || entry.generation !== generation || wc.getURL() !== url) throw new Error("The page changed while it was being read. Review it and send again.");
		const text = scope === "selection" ? result.selection : scope === "page" ? result.page : "";
		if (scope !== "none" && !text?.trim()) throw new Error(scope === "selection" ? "Select some page text first, or choose Page text." : "No readable page text was found. Try selecting text or ask without page text.");
		return { appId: id, appName: item.name, profile: item.profile, url: scope === "none" ? "" : url, title: scope === "none" ? "" : wc.getTitle().slice(0, 300), scope, text: String(text ?? "").slice(0, 18000), truncated: !!result.truncated, capturedAt: new Date().toISOString() };
	}
	return {
		state, open,
		ownsMission: (id) => missions.has(id),
		isTrusted: (event) => !disposed && !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === UI_URL,
		async add(p) { const item = registry.add(p); changed(); await open({ id: item.id }); return item; },
		update({ id, ...patch }) { const item = registry.update(id, patch); changed(); return item; },
		async remove({ id, forget }) {
			if (asking.has(id) || [...missions.values()].some((m) => m.trigger?.appId === id && !END.has(m.status) && !m.archived)) throw new Error("Finish or stop this app’s task before removing its profile.");
			if (!forget) registry.update(id, { pinned: false });
			else { await clearProfile(id); registry.remove(id); if (activeId === id) activeId = undefined; }
			layout(); changed(); return state();
		},
		layout(p) { rect = p; covered = !!p.covered; layout(); return null; },
		async command({ id, action, text, url }) {
			if (action === "copy") { clipboard.writeText(text ?? ""); return; }
			if (action === "link") { await shell.openExternal(websiteUrl(url)); return; }
			registry.get(id);
			const wc = views.get(id)?.view.webContents;
			if (!wc || wc.isDestroyed()) throw new Error("Open this app first.");
			if (action === "external") { await shell.openExternal(websiteUrl(wc.getURL())); return; }
			if (action === "signout") { await clearProfile(id); ensureView(id); layout(); changed(); return; }
			if (action === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
			if (action === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
			if (action === "reload") wc.reload();
			if (action === "home") await wc.loadURL(registry.get(id).url);
		},
		async ask({ id, text, scope, requestId, missionId }) {
			if (!text.trim()) throw new Error("Write a question or describe the draft you need.");
			if (asking.has(id)) throw new Error("Your request is already being sent.");
			asking.add(id);
			try {
				const page = await capture(id, scope);
				const result = await request("mission.pageAssist", { text: text.trim(), requestId, missionId, page });
				if (result?.ok === false) throw new Error(result.error ?? result.reason ?? "The task could not start.");
				return result;
			} finally { asking.delete(id); }
		},
		async stop({ missionId }) {
			if (!missions.has(missionId)) throw new Error("This app task is unavailable.");
			return request("mission.cancel", { missionId });
		},
		viewTask({ missionId }) { if (!missions.has(missionId)) throw new Error("This app task is unavailable."); onViewTask(missionId); },
		onEngine(m) {
			if (m.kind === "ready") {
				missions.clear();
				for (const mission of Object.values(m.snapshot?.missions ?? {})) if (mission.trigger?.appId) missions.set(mission.id, mission);
				changed();
			} else if (m.kind === "update" && m.mission?.trigger?.appId) {
				missions.set(m.mission.id, m.mission); send({ ...m, appRevision: ++revision });
			} else if (m.kind === "live" && missions.has(m.missionId)) send(m);
		},
		refresh: changed,
		forgetHistory() { for (const [id, m] of missions) if (END.has(m.status)) missions.delete(id); changed(); },
		async clear() { for (const item of registry.list()) await clearProfile(item.id); activeId = undefined; changed(); },
		dispose() {
			disposed = true;
			for (const id of [...views.keys()]) closeView(id);
			if (win && !win.isDestroyed()) win.destroy();
		},
	};
}
