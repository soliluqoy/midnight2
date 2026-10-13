import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createPttHotkey, PTT_HELPER } from "../src/desktop/ptt-hotkey.mjs";
import { buildNative } from "../scripts/build-native.mjs";

test("compiled PTT chord preserves typed shortcuts and fences repeats, cancellation and reset", { skip: process.platform !== "win32" }, () => {
	buildNative({ quiet: true }); const result = spawnSync(PTT_HELPER, ["--self-test"], { encoding: "utf8", windowsHide: true, timeout: 5000 }); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /PASS PTT press\/release/);
});
test("PTT listener handles split frames and disable waits for physical close", async () => {
	const calls = [], child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {}; child.stderr = new EventEmitter(); child.stdin = { write: value => calls.push(value) }; let killed = false;
	child.kill = () => { killed = true; };
	const hotkey = createPttHotkey({ platform: "win32", onDown: value => calls.push(value), onUp: () => calls.push("up"), onCancel: () => calls.push("cancel"), spawnImpl: (_file, _args, options) => { assert.equal(options.windowsHide, true); assert.equal(options.shell, false); queueMicrotask(() => child.stdout.emit("data", "READY\n")); return child; } });
	assert.equal(await hotkey.set(true), ""); child.stdout.emit("data", "DOWN 123"); child.stdout.emit("data", "45 41\nUP\n"); assert.deepEqual(calls.slice(-2), [{ windowId: "12345", processId: 41 }, "up"]);
	hotkey.reset(); assert.equal(calls.at(-1), "RESET\n"); let finished = false;
	const disabled = hotkey.set(false).then(() => { finished = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(killed, true); assert.equal(finished, false);
	child.emit("close", 0); await disabled; assert.equal(hotkey.ready(), false); await hotkey.close();
});
