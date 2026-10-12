// Media decoding for local search without Python (replaces PyAV, pypdfium2 and Pillow). A hidden, sandboxed window
// uses Chromium's own codecs and pdf.js; the shell reads the file and hands it the bytes, so the decoder page never
// touches the file system or the network. The window is created on first use and closed after a quiet minute.
import { BrowserWindow, ipcMain } from "electron";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PAGE = fileURLToPath(new URL("../decoder/media-decoder.html", import.meta.url));
const PRELOAD = fileURLToPath(new URL("../media-preload.cjs", import.meta.url));
const MAX_BYTES = 512 * 1024 * 1024;
const IDLE_MS = 60_000;
const TYPES = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".pdf": "application/pdf" };

export function createMediaDecoder({ log = () => {} } = {}) {
	let win;
	let ready;
	let seq = 0;
	let idle;
	const pending = new Map(); // id -> { resolve, reject, timer }
	const open = new Set();

	function onReply(event, m) {
		if (!win || event.sender !== win.webContents) return;
		const p = pending.get(m?.id);
		if (!p) return;
		pending.delete(m.id);
		clearTimeout(p.timer);
		m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
	}
	ipcMain.on("media-decoder:reply", onReply);

	function ensure() {
		clearTimeout(idle);
		if (win && !win.isDestroyed()) return ready;
		win = new BrowserWindow({
			show: false,
			width: 400,
			height: 300,
			webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: "midnight-media-decoder", spellcheck: false, autoplayPolicy: "no-user-gesture-required" },
		});
		win.webContents.setAudioMuted(true);
		win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		win.webContents.on("will-navigate", (e) => e.preventDefault());
		win.webContents.session.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
		win.webContents.session.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|blob|data):/i.test(d.url) }));
		const w = win;
		w.webContents.on("render-process-gone", () => fail(w, new Error("The media decoder stopped.")));
		w.on("closed", () => fail(w, new Error("The media decoder closed.")));
		ready = new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("The media decoder did not start.")), 20000);
			ipcMain.once("media-decoder:ready", (event) => {
				if (event.sender !== w.webContents) return;
				clearTimeout(t);
				resolve();
			});
		});
		w.loadFile(PAGE).catch((err) => log("media decoder", err.message));
		return ready;
	}

	function fail(w, err) {
		if (win !== w) return;
		win = undefined;
		ready = undefined;
		open.clear();
		for (const [id, p] of pending) {
			clearTimeout(p.timer);
			p.reject(err);
			pending.delete(id);
		}
	}

	async function call(op, args, { timeout = 180_000, transfer } = {}) {
		await ensure();
		const id = ++seq;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`Media decoding timed out (${op}).`));
			}, timeout);
			pending.set(id, { resolve, reject, timer });
			win.webContents.send("media-decoder:request", { id, op, args });
		}).finally(() => scheduleIdle());
	}

	function scheduleIdle() {
		clearTimeout(idle);
		if (open.size || pending.size) return;
		idle = setTimeout(() => {
			if (!open.size && !pending.size && win && !win.isDestroyed()) win.destroy();
		}, IDLE_MS);
		idle.unref?.();
	}

	/** Open a file for decoding. kind: image | pdf | audio | video. */
	async function session(filePath, kind, { signal } = {}) {
		const st = await fsp.stat(filePath);
		if (!st.isFile()) throw new Error("The selected media file is missing.");
		if (st.size > MAX_BYTES) throw new Error("This file is larger than the media size limit.");
		const bytes = await fsp.readFile(filePath, { signal });
		const id = `m${++seq}`;
		const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
		open.add(id);
		let info;
		try {
			info = await call("open", { id, kind, bytes, type: TYPES[ext] ?? "" });
		} catch (err) {
			open.delete(id);
			call("close", { id }).catch(() => {});
			throw err;
		}
		let closed = false;
		return {
			info,
			frame: (o = {}) => call("frame", { id, ...o }),
			text: (o = {}) => call("text", { id, ...o }),
			audio: (o = {}) => call("audio", { id, ...o }),
			async close() {
				if (closed) return;
				closed = true;
				open.delete(id);
				await call("close", { id }).catch(() => {});
			},
		};
	}

	return {
		session,
		dispose() {
			ipcMain.off("media-decoder:reply", onReply);
			clearTimeout(idle);
			if (win && !win.isDestroyed()) win.destroy();
			win = undefined;
		},
	};
}
