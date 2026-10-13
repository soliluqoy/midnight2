import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
export const PTT_HOTKEY = "Ctrl+Alt+Shift+Space";
export const PTT_HELPER = fileURLToPath(new URL("./native/midnight-ptt.exe", import.meta.url)).replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
export function createPttHotkey({ onDown, onUp, onCancel, onError = () => {}, spawnImpl = spawn, platform = process.platform, readyTimeoutMs = 5000 }) {
	let current, pending, changes = Promise.resolve(), closed = false;
	async function dispose(entry) { if (!entry?.child) return; entry.disposed = true; entry.child.kill(); await entry.exited; }
	async function set(enabled) {
		if (closed) return "Push-to-talk listener is closed.";
		if (!enabled) { const old = current; current = undefined; onCancel(); await dispose(old); return ""; }
		if (current && !current.disposed && current.ready) return "";
		if (platform !== "win32") return "The held push-to-talk chord is currently available on Windows.";
		const entry = { disposed: false, ready: false }; pending = entry;
		try {
			entry.child = spawnImpl(PTT_HELPER, ["--parent-pid", String(process.pid)], { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
			entry.exited = new Promise(resolve => entry.child.once("close", () => { entry.disposed = true; if (current === entry) { current = undefined; onCancel(); onError("The push-to-talk listener stopped. Enable it again in Settings."); } resolve(); }));
			await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("The push-to-talk listener did not start.")), readyTimeoutMs); let buffer = "";
				entry.child.once("error", () => { clearTimeout(timer); reject(new Error("Cannot start the push-to-talk listener.")); });
				entry.child.once("close", () => { clearTimeout(timer); if (!entry.ready) reject(new Error("The push-to-talk listener stopped during startup.")); });
				entry.child.stdout.setEncoding("utf8"); entry.child.stderr.on("data", () => {});
				entry.child.stdout.on("data", bytes => {
					buffer += bytes; if (buffer.length > 1024) { buffer = ""; onCancel(); return; }
					let at; while ((at = buffer.indexOf("\n")) >= 0) {
						const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
						if (line === "READY" && !entry.ready) { entry.ready = true; clearTimeout(timer); resolve(); }
						else if (current === entry && !entry.disposed) {
							const down = /^DOWN ([1-9][0-9]{0,18}) ([1-9][0-9]{0,9})$/.exec(line);
							if (down) onDown({ windowId: down[1], processId: Number(down[2]) }); else if (line === "UP") onUp(); else if (line === "CANCEL") onCancel();
						}
					}
				});
			});
			if (closed || entry.disposed) throw new Error("The push-to-talk listener stopped."); current = entry; return "";
		} catch (error) { await dispose(entry); return error.message; } finally { if (pending === entry) pending = undefined; }
	}
	return { set(enabled) { changes = changes.then(() => set(enabled)); return changes; }, ready: () => !!current?.ready && !current.disposed, reset() { onCancel(); current?.child.stdin.write("RESET\n"); }, async close() { closed = true; onCancel(); await Promise.all([dispose(current), dispose(pending)]); current = undefined; } };
}
