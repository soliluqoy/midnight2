const { contextBridge, ipcRenderer } = require("electron");
let seq = 0;
const call = (method) => async (params = {}) => {
	const result = await ipcRenderer.invoke("midnight:v1", { v: 1, seq: ++seq, method, params });
	if (!result?.ok) throw new Error(result?.error ?? "The request failed.");
	return result.result;
};
contextBridge.exposeInMainWorld("midnightApps", {
	state: call("apps.state"), open: call("apps.open"), add: call("apps.add"), update: call("apps.update"), remove: call("apps.remove"),
	layout: call("apps.layout"), command: call("apps.command"), ask: call("apps.ask"), stop: call("apps.stop"), viewTask: call("apps.viewTask"),
	on: (fn) => ipcRenderer.on("midnight:ev", (_event, value) => fn(value)),
});
