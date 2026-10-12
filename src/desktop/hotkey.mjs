import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const WINDOWS_HOTKEY = "Control+Super";
export const LEGACY_HOTKEY = "CommandOrControl+Alt+M";
export const defaultHotkey = (platform = process.platform) => platform === "win32" ? WINDOWS_HOTKEY : LEGACY_HOTKEY;
export const migrateHotkey = (data, platform = process.platform) => platform === "win32" && (data.version ?? 0) < 3 && [LEGACY_HOTKEY, "Control+Alt+M"].includes(data.hotkey) ? WINDOWS_HOTKEY : data.hotkey;

const HELPER = fileURLToPath(new URL("./hotkey-helper.ps1", import.meta.url));
// Packaged apps use the asar-unpacked copy: Windows cannot execute a file inside an archive.
export const NATIVE_HELPER = fileURLToPath(new URL("./native/midnight-hotkey.exe", import.meta.url)).replace(/app\.asar([\\/])/, "app.asar.unpacked$1");

/** The native listener (no PowerShell, no execution-policy bypass); the script is a fallback for unbuilt checkouts. */
export function listenerCommand(parentPid = process.pid, exists = fs.existsSync) {
	if (exists(NATIVE_HELPER)) return { command: NATIVE_HELPER, args: ["--parent-pid", String(parentPid)] };
	return { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-MTA", "-ExecutionPolicy", "Bypass", "-File", HELPER, "-ParentPid", String(parentPid)] };
}

// Electron accelerators require a non-modifier key. Ctrl+Win uses a small, unprivileged Windows hook instead.
// Changing shortcuts is transactional: don't release the working shortcut until the replacement is ready.
export function createHotkey({ globalShortcut, onTrigger, onError = () => {}, platform = process.platform, spawnImpl = spawn, readyTimeout = 10000 }) {
	let current;
	let stopped = false;
	let pending;
	let changes = Promise.resolve();
	const release = (entry) => {
		if (!entry) return;
		entry.disposed = true;
		if (entry.process) entry.process.kill();
		else globalShortcut.unregister(entry.accelerator);
	};
	async function nativeListener(accelerator) {
		const entry = { accelerator, disposed: false };
		await new Promise((resolve, reject) => {
			let ready = false;
			let buffer = "";
			const fail = (err) => {
				clearTimeout(timeout);
				if (!ready) reject(err);
				else if (!entry.disposed && !entry.failed) {
					entry.failed = true;
					if (current === entry) onError(err.message);
				}
			};
			const timeout = setTimeout(() => { fail(new Error("The Ctrl+Win listener did not start. Use the tray icon to open midnight.")); release(entry); }, readyTimeout);
			try {
				const listener = listenerCommand();
				entry.process = spawnImpl(listener.command, listener.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
				pending = entry;
				entry.process.stdout.setEncoding("utf8");
				entry.process.stdout.on("data", (chunk) => {
					buffer += chunk;
					let i;
					while ((i = buffer.indexOf("\n")) >= 0) {
						const line = buffer.slice(0, i).trim();
						buffer = buffer.slice(i + 1);
						if (line === "READY" && !ready) { ready = true; clearTimeout(timeout); resolve(); }
						else if (line === "TRIGGER" && current === entry && !entry.disposed) onTrigger();
					}
				});
				entry.process.stderr.on("data", () => {}); // drain compiler/runtime diagnostics; only protocol tokens reach the UI
				entry.process.on("error", () => fail(new Error("Cannot start the Ctrl+Win listener. Use the tray icon or choose another shortcut.")));
				entry.process.on("exit", () => fail(new Error("The Ctrl+Win listener stopped. Use the tray icon or choose another shortcut.")));
			} catch (err) { clearTimeout(timeout); reject(err); }
		}).catch((err) => { release(entry); throw err; }).finally(() => { if (pending === entry) pending = undefined; });
		if (entry.failed) { release(entry); throw new Error("The Ctrl+Win listener stopped during startup."); }
		return entry;
	}
	async function change(accelerator) {
		if (stopped) return "Shortcut listener is stopped.";
		if (accelerator === current?.accelerator && !current.disposed && !current.failed) return "";
		let next;
		try {
			if (platform === "win32" && accelerator === WINDOWS_HOTKEY) next = await nativeListener(accelerator);
			else {
				if (!globalShortcut.register(accelerator, onTrigger)) return "That shortcut is taken or not valid.";
				next = { accelerator };
			}
		} catch (err) { return String(err.message ?? err); }
		if (stopped) { release(next); return "Shortcut listener is stopped."; }
		release(current);
		current = next;
		return "";
	}
	return {
		set(accelerator) {
			changes = changes.then(() => change(accelerator));
			return changes;
		},
		get: () => current?.accelerator ?? "",
		stop() { stopped = true; release(current); release(pending); current = undefined; },
	};
}
