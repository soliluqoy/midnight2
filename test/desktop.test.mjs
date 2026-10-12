import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createHotkey, defaultHotkey, LEGACY_HOTKEY, migrateHotkey, WINDOWS_HOTKEY } from "../src/desktop/hotkey.mjs";
import { GUTTER, windowBounds, windowDims } from "../src/desktop/window-layout.mjs";

const area = { x: 0, y: 0, width: 1920, height: 1040 };
const centre = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

test("launcher centres on the requested work area, including secondary monitors with negative coordinates", () => {
	for (const wa of [area, { x: -2560, y: -200, width: 2560, height: 1400 }, { x: 1920, y: 400, width: 1280, height: 680 }]) {
		for (const state of ["chat", "mission", "settings", "stack", "read"]) {
			const b = windowBounds(state, wa);
			assert.ok(Math.abs(centre(b).x - (wa.x + wa.width / 2)) <= 0.5);
			assert.ok(Math.abs(centre(b).y - (wa.y + wa.height / 2)) <= 0.5);
		}
	}
});

test("resizing and zooming preserve the dragged centre when there is room", () => {
	const anchor = { x: 850, y: 500 };
	for (const state of ["chat", "mission", "settings", "stack", "read"]) {
		const b = windowBounds(state, area, 1, anchor);
		assert.deepEqual(centre(b), anchor);
	}
	const zoomed = centre(windowBounds("mission", area, 1.15, anchor));
	assert.ok(Math.abs(zoomed.x - anchor.x) <= 0.5 && Math.abs(zoomed.y - anchor.y) <= 0.5);
});

test("every view and text size fits small screens, taskbars and changed display geometry", () => {
	for (const wa of [area, { x: 300, y: -500, width: 800, height: 600 }, { x: 0, y: 0, width: 320, height: 240 }]) {
		for (const z of [0.9, 1, 1.15, 1.6]) {
			const dims = windowDims(wa, z);
			for (const state of Object.keys(dims)) {
				const b = windowBounds(state, wa, z, { x: -9999, y: 9999 });
				assert.ok(b.x >= wa.x && b.y >= wa.y);
				assert.ok(b.x + b.width <= wa.x + wa.width && b.y + b.height <= wa.y + wa.height);
				assert.equal(b.width, Math.round((dims[state][0] + GUTTER * 2) * z));
			}
		}
	}
});

test("upgrade replaces the old default shortcut on Windows but preserves custom and non-Windows shortcuts", () => {
	assert.equal(defaultHotkey("win32"), WINDOWS_HOTKEY);
	assert.equal(defaultHotkey("darwin"), LEGACY_HOTKEY);
	assert.equal(migrateHotkey({ version: 2, hotkey: LEGACY_HOTKEY }, "win32"), WINDOWS_HOTKEY);
	assert.equal(migrateHotkey({ hotkey: "Control+Alt+M" }, "win32"), WINDOWS_HOTKEY);
	assert.equal(migrateHotkey({ version: 2, hotkey: "Control+Shift+K" }, "win32"), "Control+Shift+K");
	assert.equal(migrateHotkey({ version: 3, hotkey: LEGACY_HOTKEY }, "win32"), LEGACY_HOTKEY);
	assert.equal(migrateHotkey({ version: 2, hotkey: LEGACY_HOTKEY }, "darwin"), LEGACY_HOTKEY);
});

test("native Ctrl+Win chord handles either key order without stealing other Windows shortcuts", { skip: process.platform !== "win32" }, () => {
	const helper = fileURLToPath(new URL("../src/desktop/hotkey-helper.ps1", import.meta.url));
	const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-SelfTest"], { encoding: "utf8", timeout: 20000, windowsHide: true });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /PASS modifier-only chord/);
});

function fixture({ ready = true, readyTimeout = 100 } = {}) {
	const processes = [];
	const registered = new Map();
	const errors = [];
	let triggers = 0;
	const controller = createHotkey({
		platform: "win32", readyTimeout,
		onTrigger: () => triggers++, onError: (s) => errors.push(s),
		globalShortcut: {
			register: (acc, fn) => { if (acc === "taken") return false; registered.set(acc, fn); return true; },
			unregister: (acc) => registered.delete(acc),
		},
		spawnImpl: (_file, _args, options) => {
			assert.equal(options.windowsHide, true);
			const p = new EventEmitter();
			p.stdout = new EventEmitter(); p.stdout.setEncoding = () => {};
			p.stderr = new EventEmitter(); p.killed = false;
			p.kill = () => { p.killed = true; p.emit("exit", 0); };
			processes.push(p);
			if (ready) queueMicrotask(() => p.stdout.emit("data", "READY\r\n"));
			return p;
		},
	});
	return { controller, processes, registered, errors, triggers: () => triggers };
}

test("Ctrl+Win uses the native listener; switching shortcuts releases it only after successful registration", async () => {
	const f = fixture();
	assert.equal(await f.controller.set(WINDOWS_HOTKEY), "");
	assert.equal(f.registered.size, 0);
	f.processes[0].stdout.emit("data", "TRIG"); f.processes[0].stdout.emit("data", "GER\r\n");
	assert.equal(f.triggers(), 1);
	assert.match(await f.controller.set("taken"), /taken/);
	assert.equal(f.controller.get(), WINDOWS_HOTKEY);
	assert.equal(f.processes[0].killed, false);
	assert.equal(await f.controller.set("Control+Shift+M"), "");
	assert.equal(f.processes[0].killed, true);
	f.processes[0].stdout.emit("data", "TRIGGER\n");
	assert.equal(f.triggers(), 1);
	f.controller.stop();
	assert.equal(f.registered.size, 0);
	assert.deepEqual(f.errors, []);
});

test("native startup timeout retains the working shortcut and stops the failed helper", async () => {
	const f = fixture({ ready: false, readyTimeout: 20 });
	assert.equal(await f.controller.set("Control+Shift+M"), "");
	assert.match(await f.controller.set(WINDOWS_HOTKEY), /did not start/);
	assert.equal(f.controller.get(), "Control+Shift+M");
	assert.equal(f.registered.has("Control+Shift+M"), true);
	assert.equal(f.processes[0].killed, true);
	f.controller.stop();
});

test("unexpected helper exit is reported and the same shortcut can be retried", async () => {
	const f = fixture();
	await f.controller.set(WINDOWS_HOTKEY);
	f.processes[0].emit("exit", 1);
	assert.equal(f.errors.length, 1);
	assert.match(f.errors[0], /listener stopped/);
	assert.equal(await f.controller.set(WINDOWS_HOTKEY), "");
	assert.equal(f.processes.length, 2);
	f.controller.stop();
});

test("rapid shortcut changes serialize and shutdown removes all listeners", async () => {
	const f = fixture();
	const first = f.controller.set(WINDOWS_HOTKEY);
	const second = f.controller.set("Control+Shift+M");
	assert.equal(await first, ""); assert.equal(await second, "");
	assert.equal(f.controller.get(), "Control+Shift+M");
	assert.equal(f.processes[0].killed, true);
	assert.equal(f.registered.size, 1);
	f.controller.stop();
	assert.equal(f.registered.size, 0);
	assert.match(await f.controller.set(WINDOWS_HOTKEY), /stopped/);
});
