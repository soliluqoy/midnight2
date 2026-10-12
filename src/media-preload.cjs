// Bridge for the hidden media decoder window: it only receives decode requests from the shell and answers them.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("decoder", {
	onRequest: (fn) => ipcRenderer.on("media-decoder:request", (_e, m) => fn(m)),
	reply: (m) => ipcRenderer.send("media-decoder:reply", m),
	ready: () => ipcRenderer.send("media-decoder:ready"),
});
