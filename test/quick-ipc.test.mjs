import assert from "node:assert/strict";
import test from "node:test";
import { createIpcRouter } from "../src/desktop/ipc.mjs";
import { validateRequest, QUICK_METHODS } from "../src/contracts/ipc.mjs";

test("quick IPC accepts bounded requests and rejects native handles, permissions and old schemas", () => {
	const request = params => validateRequest({ v: 1, seq: 1, method: "quick.submit", params });
	assert.equal(request({ panelId: "quick_1", text: "Improve this" }).ok, true);
	for (const params of [{ panelId: "quick_1", text: "Improve", target: { handle: "forged" } }, { panelId: "quick_1", text: "x".repeat(1001) }, { panelId: "quick_1", text: "Improve", permission: true }]) assert.equal(request(params).ok, false);
	assert.equal(validateRequest({ v: 1, seq: 1, method: "mission.targetApply", params: { intentId: "act_1" } }).ok, false, "native effect entry is absent from renderer IPC");
});

test("quick window's closed capability set cannot reach broad mission, clipboard or settings APIs", async () => {
	let invoke; const calls = [];
	createIpcRouter({ ipcMain: { handle(channel, fn) { invoke = fn; } }, isTrusted: () => true,
		canCall: (event, method) => event.sender.id === 2 ? Object.hasOwn(QUICK_METHODS, method) : !Object.hasOwn(QUICK_METHODS, method),
		shell: { "quick.state": () => { calls.push("quick"); return { phase: "closed" }; }, "clipboard.read": () => calls.push("clipboard"), "settings.get": () => calls.push("settings") }, host: () => calls.push("host") });
	const quick = { sender: { id: 2 } }, main = { sender: { id: 1 } };
	assert.equal((await invoke(quick, { v: 1, seq: 1, method: "quick.state", params: {} })).ok, true);
	assert.equal((await invoke(quick, { v: 1, seq: 2, method: "clipboard.read", params: {} })).ok, false);
	assert.equal((await invoke(quick, { v: 1, seq: 3, method: "settings.get", params: {} })).ok, false);
	assert.equal((await invoke(main, { v: 1, seq: 1, method: "quick.state", params: {} })).ok, false);
	assert.deepEqual(calls, ["quick"]);
});
