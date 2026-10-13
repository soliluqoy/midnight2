import { BrowserWindow, ipcMain, session } from "electron";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const URL = new globalThis.URL("../voice/ptt-recorder.html", import.meta.url).href;
export function createPttRecorder({ allowed, onError = () => {}, timeoutMs = 30_000 }) {
	let active, closed = false;
	const trusted = (event, entry) => event.sender === entry.window.webContents && event.senderFrame === entry.window.webContents.mainFrame && event.senderFrame?.url === URL;
	function release(entry, reason = new Error("Voice recording cancelled."), notify = false) {
		if (!entry || entry.disposed) return; entry.disposed = true;
		clearTimeout(entry.timer); entry.signal?.removeEventListener("abort", entry.abort); entry.startReject(reason); entry.endReject?.(reason);
		if (active === entry) active = undefined; if (!entry.window.isDestroyed()) entry.window.destroy();
		if (notify) onError(entry.id, reason);
	}
	const reply = (event, message) => {
		const entry = active; if (!entry || !trusted(event, entry) || message?.id !== entry.id) return;
		if (message.kind === "started" && message.sampleRate === 16000 && allowed(entry.id)) { entry.started = true; entry.startResolve(); }
		else if (message.kind === "ended" && entry.ending && message.sampleRate === 16000 && message.samples instanceof Float32Array && message.samples.length <= 480000 && message.samples.every(Number.isFinite)) { entry.endResolve({ samples: message.samples }); release(entry); }
		else if (message.kind === "started" && !allowed(entry.id)) release(entry);
		else if (message.kind === "failed") release(entry, new Error(typeof message.error === "string" ? message.error.slice(0, 300) : "The microphone failed."), true);
	};
	ipcMain.on("midnight:ptt-reply", reply);
	return {
		async begin({ id, signal }) {
			if (closed || active || !/^ptt_[a-f0-9-]{36}$/.test(id) || !allowed(id)) throw new Error("No active push-to-talk gesture permits microphone access.");
			signal?.throwIfAborted();
			const ownSession = session.fromPartition(`ptt-${randomUUID()}`, { cache: false });
			const window = new BrowserWindow({ show: false, width: 1, height: 1, focusable: false, skipTaskbar: true, webPreferences: { session: ownSession, preload: fileURLToPath(new globalThis.URL("../voice/ptt-preload.cjs", import.meta.url)), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required" } });
			const entry = active = { id, window, signal }; const started = new Promise((resolve, reject) => { entry.startResolve = resolve; entry.startReject = reject; });
			ownSession.setPermissionRequestHandler((wc, permission, done, details) => done(active === entry && wc === window.webContents && allowed(id) && permission === "media" && details.mediaTypes?.length > 0 && details.mediaTypes.every(type => type === "audio")));
			ownSession.setPermissionCheckHandler((wc, permission, _origin, details) => active === entry && wc === window.webContents && allowed(id) && permission === "media" && details.mediaType === "audio");
			ownSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith("file:") && !details.url.startsWith("blob:") }));
			window.webContents.on("will-navigate", event => event.preventDefault()); window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
			window.webContents.on("render-process-gone", () => release(entry, new Error("The microphone renderer stopped."), true));
			window.on("closed", () => release(entry, new Error("The microphone renderer closed."), true));
			entry.abort = () => release(entry); signal?.addEventListener("abort", entry.abort, { once: true }); entry.timer = setTimeout(() => release(entry, new Error("Recording reached its deadline."), true), timeoutMs);
			void window.loadURL(URL).then(() => { if (active === entry && !entry.disposed && allowed(id)) window.webContents.send("midnight:ptt-command", { op: "begin", id }); else release(entry); }).catch(error => release(entry, error, true));
			return started;
		},
		end({ id }) { const entry = active; if (!entry || entry.id !== id || !entry.started || entry.ending) return Promise.reject(new Error("This push-to-talk recording is no longer active.")); entry.ending = true; return new Promise((resolve, reject) => { entry.endResolve = resolve; entry.endReject = reject; entry.window.webContents.send("midnight:ptt-command", { op: "end", id }); }); },
		cancel({ id }) { if (active?.id === id) release(active); },
		close() { closed = true; release(active); ipcMain.removeListener("midnight:ptt-reply", reply); },
	};
}
