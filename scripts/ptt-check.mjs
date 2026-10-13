// Actual hidden recorder, synthetic Chromium microphone, no personal audio/app data and no cloud request.
import assert from "node:assert/strict";
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createPttRecorder } from "../src/desktop/ptt-recorder.mjs";
import { createWordBroker } from "../src/desktop/word-broker.mjs";
import { createPttHotkey } from "../src/desktop/ptt-hotkey.mjs";

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "midnight-ptt-check-")));
app.commandLine.appendSwitch("use-fake-device-for-media-stream"); app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
	const hotkey = createPttHotkey({ onDown: () => {}, onUp: () => {}, onCancel: () => {} });
	assert.equal(await hotkey.set(true), ""); assert.equal(hotkey.ready(), true); hotkey.reset(); await hotkey.close(); assert.equal(hotkey.ready(), false); console.log("PASS actual held-chord listener starts, resets and exits independently");
	const foreground = new BrowserWindow({ width: 260, height: 80, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
	await foreground.loadURL("data:text/html,<input autofocus value='typing fixture'>"); foreground.show(); foreground.focus();
	const native = createWordBroker();
	try { await assert.rejects(native.capture({ expectedWindowId: "1", expectedProcessId: process.pid }), /foreground changed/); console.log("PASS actual native capture refuses a changed gesture window before reading Word"); } finally { native.close(); }
	let current; const failures = []; const recorder = createPttRecorder({ allowed: id => id === current, onError: (id, error) => failures.push({ id, message: error.message }) });
	await assert.rejects(recorder.begin({ id: `ptt_${randomUUID()}` }), /No active/); console.log("PASS inactive gestures cannot request the microphone");
	current = `ptt_${randomUUID()}`; await recorder.begin({ id: current });
	const hidden = BrowserWindow.getAllWindows().find(window => window !== foreground);
	assert.equal(hidden.isVisible(), false); assert.equal(foreground.isFocused(), true);
	const bridge = await hidden.webContents.executeJavaScript("({node:typeof require,app:typeof midnight,methods:Object.keys(recorder).sort()})");
	assert.deepEqual(bridge, { node: "undefined", app: "undefined", methods: ["on", "reply"] }); console.log("PASS hidden sandbox captures without foreground focus or an app bridge");
	await new Promise(resolve => setTimeout(resolve, 250)); const result = await recorder.end({ id: current }); current = undefined;
	assert.ok(result.samples instanceof Float32Array); assert.ok(result.samples.length >= 1600 && result.samples.length <= 480000); assert.equal(result.samples.some(value => !Number.isFinite(value)), false); assert.equal(hidden.isDestroyed(), true); assert.equal(foreground.isFocused(), true); result.samples.fill(0);
	console.log("PASS actual AudioWorklet returns bounded 16 kHz PCM and releases its hidden renderer");
	current = `ptt_${randomUUID()}`; const controller = new AbortController(), start = recorder.begin({ id: current, signal: controller.signal }); const rejected = assert.rejects(start, /cancel/); current = undefined; controller.abort(); await rejected;
	assert.equal(BrowserWindow.getAllWindows().length, 1); console.log("PASS cancellation during recorder startup destroys the late permission target");
	current = `ptt_${randomUUID()}`; await recorder.begin({ id: current });
	const crashed = BrowserWindow.getAllWindows().find(window => window !== foreground); crashed.webContents.forcefullyCrashRenderer();
	const until = Date.now() + 5000; while (!failures.length) { if (Date.now() > until) throw new Error("Recorder crash did not revoke the capture."); await new Promise(resolve => setTimeout(resolve, 10)); }
	assert.equal(failures[0].id, current); assert.equal(crashed.isDestroyed(), true); assert.equal(foreground.isFocused(), true); console.log("PASS renderer failure revokes the microphone capture without stealing focus");
	recorder.close(); foreground.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
