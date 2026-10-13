import { BrowserWindow, screen } from "electron";
import { fileURLToPath } from "node:url";
import { windowBounds } from "./window-layout.mjs";

export const QUICK_URL = new URL("../quick/index.html", import.meta.url).href;
export function createQuickWindow({ getState, isBlocked, onDismiss, onReset, zoom = () => 1 }) {
	let window, loading, disposed = false;
	async function ensure() {
		if (disposed) return;
		if (!window || window.isDestroyed()) {
			window = new BrowserWindow({ width: 492, height: 352, show: false, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, maximizable: false, minimizable: false,
				webPreferences: { preload: fileURLToPath(new URL("../quick/preload.cjs", import.meta.url)), contextIsolation: true, sandbox: true, nodeIntegration: false } });
			const own = window;
			own.webContents.on("will-navigate", event => event.preventDefault());
			own.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
			own.webContents.on("did-start-loading", () => onReset?.(own.webContents.id));
			own.webContents.on("render-process-gone", () => { own.hide(); onDismiss(); });
			own.on("close", event => { if (!disposed) { event.preventDefault(); own.hide(); onDismiss(); } });
			loading = own.loadFile(fileURLToPath(new URL("../quick/index.html", import.meta.url)));
		}
		await loading; return window;
	}
	return {
		async present({ mode, focus = false }) {
			const expected = getState(); const own = await ensure(); const current = getState();
			if (!own || own.isDestroyed() || isBlocked() || current.phase === "closed" || current.panelId !== expected.panelId) return;
			const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
			const area = display.workArea; const factor = zoom();
			const size = mode === "input" ? "quickInput" : mode === "preview" ? "quickPreview" : "quickNotice";
			const anchor = mode === "notice" ? { x: area.x + area.width, y: area.y + area.height } : undefined;
			own.setBounds(windowBounds(size, area, factor, anchor)); own.webContents.setZoomFactor(factor);
			own.webContents.send("midnight:ev", { kind: "quick", state: current });
			if (focus && current.phase === expected.phase && ["input", "preview"].includes(current.phase)) { own.show(); own.focus(); }
			else own.showInactive();
		},
		publish(state) { if (window && !window.isDestroyed()) window.webContents.send("midnight:ev", { kind: "quick", state }); },
		hide() { if (window && !window.isDestroyed()) window.hide(); },
		isTrusted(event) { return !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && (event.senderFrame?.url ?? "").split("#")[0] === QUICK_URL; },
		dispose() { disposed = true; if (window && !window.isDestroyed()) window.destroy(); window = undefined; },
	};
}
