const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("recorder", { on: callback => { ipcRenderer.on("midnight:ptt-command", (_event, command) => callback(command)); }, reply: value => ipcRenderer.send("midnight:ptt-reply", value) });
