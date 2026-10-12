// Trusted host results only. The preview has no preload, Node, navigation, or external network access.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow } from "electron";

const windows = new Set();
const KINDS = {
	image: /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif)$/i,
	audio: /\.(mp3|wav|m4a|aac|flac|ogg|opus|aiff?|wma)$/i,
	video: /\.(mp4|mkv|mov|webm|avi|m4v|wmv|mpeg|mpg)$/i,
	pdf: /\.pdf$/i,
};

export async function previewFile({ path: file, kind, locator = {}, show = true }) {
	if (!KINDS[kind]?.test(file)) throw new Error("This file format cannot be previewed here");
	const win = new BrowserWindow({
		show,
		width: 960, height: 720, minWidth: 480, minHeight: 320,
		title: path.basename(file), backgroundColor: "#202126", autoHideMenuBar: true,
		webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, plugins: kind === "pdf", partition: "midnight-file-preview" },
	});
	windows.add(win);
	win.on("closed", () => windows.delete(win));
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	win.webContents.on("will-navigate", (event) => event.preventDefault());
	win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
	win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
	try {
		if (kind === "pdf") {
			const page = Math.max(1, Math.floor(Number(locator.page) || 1));
			await win.loadURL(`${pathToFileURL(file).href}#page=${page}`);
		} else {
			await win.loadFile(fileURLToPath(new URL("../ui/file-preview.html", import.meta.url)), {
				query: { url: pathToFileURL(file).href, kind, name: path.basename(file), seconds: String(Math.max(0, Number(locator.startSeconds ?? locator.seconds ?? locator.start) || 0)) },
			});
		}
	} catch (error) {
		win.destroy();
		throw error;
	}
	return { ok: true };
}

export function closeFilePreviews() {
	for (const win of windows) if (!win.isDestroyed()) win.destroy();
}
