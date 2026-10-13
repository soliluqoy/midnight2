// Generated code runs in its own Chromium sandbox, without Node, a preload, networking or app permissions.
import { BrowserWindow, session } from "electron";
import { randomUUID } from "node:crypto";

const PAGE = "data:text/html;charset=utf-8," + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src blob:; connect-src \'none\'; img-src \'none\'; style-src \'none\'; object-src \'none\'; frame-src \'none\'; base-uri \'none\'; form-action \'none\'">');
export function createPluginExecutor({ timeoutMs = 5000 } = {}) {
	const running = new Set();
	return {
		isBusy: () => running.size > 0,
		async execute({ source, input }, { signal } = {}) {
			if (typeof source !== "string" || Buffer.byteLength(source) > 128 * 1024) throw new Error("Plugin source exceeds its execution budget.");
			signal?.throwIfAborted();
			const isolated = session.fromPartition(`plugin-${randomUUID()}`, { cache: false });
			isolated.setPermissionRequestHandler((_wc, _permission, done) => done(false)); isolated.setPermissionCheckHandler(() => false);
			isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith("blob:") && !details.url.startsWith("data:text/html") }));
			isolated.on("will-download", (event, item) => { event.preventDefault(); item.cancel(); });
			const window = new BrowserWindow({ show: false, width: 1, height: 1, focusable: false, skipTaskbar: true, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, webSecurity: true, backgroundThrottling: false } });
			running.add(window); let timer, cancel;
			const failure = new Promise((_, reject) => {
				cancel = () => { if (!window.isDestroyed()) window.destroy(); reject(signal?.reason ?? new Error("Plugin execution cancelled.")); };
				signal?.addEventListener("abort", cancel, { once: true });
				timer = setTimeout(() => { if (!window.isDestroyed()) { window.webContents.forcefullyCrashRenderer(); window.destroy(); } reject(new Error("The plugin renderer exceeded its deadline.")); }, timeoutMs);
				window.webContents.once("render-process-gone", () => reject(new Error("The plugin renderer stopped.")));
			});
			try {
				const work = (async () => {
					await window.loadURL(PAGE);
					window.webContents.on("will-navigate", event => event.preventDefault()); window.webContents.on("will-frame-navigate", event => event.preventDefault()); window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
					const expression = `(async()=>{const url=URL.createObjectURL(new Blob([${JSON.stringify(source)}],{type:'text/javascript'}));try{const plugin=await import(url);if(typeof plugin.render!=='function')throw Error('Missing render export');const result=await plugin.render(${JSON.stringify(input)});if(typeof result!=='string'||result.length>1048576)throw Error('Invalid plugin result');return result;}finally{URL.revokeObjectURL(url);}})()`;
					return window.webContents.executeJavaScript(expression, false);
				})();
				return await Promise.race([work, failure]);
			} finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); running.delete(window); if (!window.isDestroyed()) window.destroy(); }
		},
		close() { for (const window of running) if (!window.isDestroyed()) window.destroy(); running.clear(); },
	};
}
