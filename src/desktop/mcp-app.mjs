// The viewer for MCP Apps (interactive views a connector returns with a tool result). The connector's HTML is
// untrusted: it runs in a sandboxed window with its own session, no preload or bridge to midnight, no permissions,
// no navigation or new windows, and no network; the only request it may make is for its own file.
import { BrowserWindow, session } from "electron";
import { pathToFileURL } from "node:url";

const PARTITION = "midnight-mcp-apps"; // in memory: views keep no cookies or storage between openings

// Node writes "~" as %7E (and Chromium does not), so a short 8.3 path like RUNNER~1 must compare decoded.
const decoded = (url) => {
	try {
		return decodeURIComponent(new URL(url).href);
	} catch {
		return url;
	}
};

export function openMcpApp({ path: file, name }) {
	const own = decoded(pathToFileURL(file).href);
	const ses = session.fromPartition(PARTITION);
	ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
	ses.setPermissionCheckHandler(() => false);
	ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(decoded(d.url) === own || d.url.startsWith("data:") || d.url.startsWith("blob:")) }));
	ses.webRequest.onHeadersReceived((d, cb) => cb({ responseHeaders: { ...d.responseHeaders, "Content-Security-Policy": ["default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'"] } }));
	const win = new BrowserWindow({
		width: 900,
		height: 700,
		title: `${name} · connector view`,
		autoHideMenuBar: true,
		webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, spellcheck: false },
	});
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	win.webContents.on("will-navigate", (e) => e.preventDefault());
	win.webContents.on("will-redirect", (e) => e.preventDefault());
	win.loadFile(file);
	return { opened: true };
}
