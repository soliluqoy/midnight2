// Actual sandboxed quick renderer/preload, with a fixed fixture bridge and no document or cloud access.
import assert from "node:assert/strict";
import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createIpcRouter } from "../src/desktop/ipc.mjs";
import { QUICK_METHODS, EVENT_CHANNEL } from "../src/contracts/ipc.mjs";
import { windowBounds } from "../src/desktop/window-layout.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "midnight-quick-ui-")));
app.whenReady().then(async () => {
const win = new BrowserWindow({ show: false, width: 492, height: 352, webPreferences: { preload: path.join(root, "src/quick/preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true } });
const calls = [], errors = []; let fixture = { phase: "closed", panelId: "", revision: 0 }, delayApply;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const router = createIpcRouter({ ipcMain, isTrusted: event => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame,
	canCall: (_event, method) => Object.hasOwn(QUICK_METHODS, method), shell: Object.fromEntries(Object.keys(QUICK_METHODS).map(method => [method, async params => {
		calls.push({ method, params });
		if (method === "quick.state") return fixture;
		if (method === "quick.apply" && delayApply) return delayApply;
		return null;
	}])), host: () => { throw new Error("Quick UI cannot call the host directly."); } });
win.webContents.on("did-start-loading", () => router.reset(win.webContents.id));
win.webContents.on("console-message", event => { if (event.level === "error" || event.level === 3) errors.push(event.message); });
const js = code => win.webContents.executeJavaScript(code);
const emit = async patch => { fixture = { ...fixture, ...patch, revision: fixture.revision + 1 }; win.webContents.send(EVENT_CHANNEL, { kind: "quick", state: fixture }); await sleep(35); };
const reset = async () => { calls.length = 0; errors.length = 0; delayApply = undefined; fixture = { phase: "input", panelId: "quick_fixture", revision: 1, kind: "paragraph", scope: "Current paragraph", source: "Revenue increased by 12%.", privacy: "cloud", canApply: false }; win.webContents.setZoomFactor(1); win.setContentSize(492, 352); await win.loadFile(path.join(root, "src/quick/index.html")); await sleep(100); };
const tests = [
	["voice preparation and listening never expose or focus the typed instruction", async () => {
		await js("document.getElementById('dismiss').focus()");
		await emit({ phase: "input", panelId: "voice_fixture", voicePhase: "listening", message: "Listening · release the chord to finish" });
		assert.equal(await js("document.getElementById('entry').hidden"), true); assert.equal(await js("document.getElementById('submit').disabled"), true); assert.equal(await js("document.activeElement.id"), "dismiss");
	}],
	["bounded instruction uses the actual named preload method", async () => {
		await js("document.getElementById('instruction').value='Make this clearer'; document.getElementById('instruction').dispatchEvent(new Event('input')); document.getElementById('submit').click()"); await sleep(40);
		assert.deepEqual(calls.find(call => call.method === "quick.submit").params, { panelId: "quick_fixture", text: "Make this clearer" });
		assert.equal(await js("typeof quick.invoke"), "undefined");
	}],
	["model and document markup render as text and do not steal field focus", async () => {
		await js("document.getElementById('dismiss').focus()");
		await emit({ phase: "preview", expanded: true, proposalId: "proposal_exact", canApply: true, source: "<img src=x onerror='alert(1)'>", replacement: "<script>window.compromised=true</script>" });
		assert.equal(await js("document.querySelectorAll('img').length"), 0);
		assert.equal(await js("document.getElementById('after').textContent"), "<script>window.compromised=true</script>");
		assert.equal(await js("!!window.compromised"), false);
		assert.equal(await js("document.activeElement.id"), "dismiss");
	}],
	["only the exact reviewed proposal reaches Apply and double clicks stay single", async () => {
		await emit({ phase: "preview", expanded: true, proposalId: "proposal_exact", replacement: "Revenue grew by 12%.", canApply: true });
		let finish; delayApply = new Promise(resolve => { finish = resolve; });
		await js("document.getElementById('apply').click(); document.getElementById('apply').click()"); await sleep(40);
		assert.equal(calls.filter(call => call.method === "quick.apply").length, 1);
		assert.deepEqual(calls.find(call => call.method === "quick.apply").params, { panelId: "quick_fixture", proposalId: "proposal_exact" });
		finish(null); await sleep(40);
	}],
	["old state responses cannot replace a new selection and closing clears its text", async () => {
		await emit({ phase: "preview", expanded: false, proposalId: "proposal_exact", replacement: "Fresh replacement", canApply: true });
		win.webContents.send(EVENT_CHANNEL, { kind: "quick", state: { phase: "input", panelId: "old_panel", source: "Obsolete selection", revision: 0 } }); await sleep(35);
		assert.equal(await js("document.getElementById('after').textContent"), "Fresh replacement");
		await emit({ phase: "closed", panelId: "", source: "", replacement: "", canApply: false });
		assert.equal(await js("document.getElementById('before').textContent+document.getElementById('after').textContent+document.getElementById('instruction').value"), "");
	}],
	["unsupported proposals remain reviewable without an Apply action", async () => {
		await emit({ phase: "preview", expanded: true, proposalId: "proposal_exact", replacement: "Revenue grew by 21%.", canApply: false, message: "Numeric values changed. Review the replacement." });
		assert.equal(await js("document.getElementById('apply').disabled"), true);
		assert.match(await js("document.getElementById('message').textContent"), /Numeric values/);
	}],
	["Undo and uncertain outcome have separate explicit controls", async () => {
		await emit({ phase: "applied", source: "", replacement: "", message: "Selection updated" });
		assert.equal(await js("document.getElementById('undo').hidden"), false); assert.equal(await js("document.getElementById('reconcile').hidden"), true);
		await emit({ phase: "unknown", message: "Check the outcome" });
		assert.equal(await js("document.getElementById('undo').hidden"), true); assert.equal(await js("document.getElementById('reconcile').hidden"), false);
	}],
	["compact views remain inside small displays at every supported text scale", async () => {
		for (const factor of [0.75, 1, 1.5, 2]) for (const [size, phase] of [["quickInput", "input"], ["quickPreview", "preview"], ["quickNotice", "applied"]]) {
			const bounds = windowBounds(size, { x: -1280, y: 0, width: 1280, height: 720 }, factor);
			win.setContentSize(bounds.width, bounds.height); win.webContents.setZoomFactor(factor);
			await emit({ phase, expanded: phase === "preview", source: "A long selected paragraph ".repeat(150), replacement: "A revised paragraph ".repeat(150) });
			assert.equal(await js("document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight"), true);
		}
	}],
];
let failed = 0;
for (const [name, run] of tests) { await reset(); try { await run(); assert.deepEqual(errors, []); console.log(`PASS ${name}`); } catch (err) { failed++; console.error(`FAIL ${name}: ${err.message}`); } }
win.destroy(); app.exit(failed ? 1 : 0);
}).catch(error => { console.error(error); app.exit(1); });
