const { contextBridge, ipcRenderer } = require("electron");
let seq = 0;
async function call(method, params = {}) {
	const result = await ipcRenderer.invoke("midnight:v1", { v: 1, seq: ++seq, method, params });
	if (!result?.ok) throw new Error(result?.error ?? "Quick edit failed.");
	return result.result;
}
const m = method => params => call(method, params);
contextBridge.exposeInMainWorld("quick", {
	state: m("quick.state"), submit: m("quick.submit"), expand: m("quick.expand"), apply: m("quick.apply"), undo: m("quick.undo"), reconcile: m("quick.reconcile"), dismiss: m("quick.dismiss"),
	on(fn) { const listener = (_event, data) => { if (data?.kind === "quick") fn(data.state); }; ipcRenderer.on("midnight:ev", listener); return () => ipcRenderer.removeListener("midnight:ev", listener); },
});
