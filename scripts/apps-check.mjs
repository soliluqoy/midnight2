// Real Electron + Chromium profiles + the production workspace/preload/IPC. No user profile or AI account.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, session, webContents } from "electron";
import { createAppRegistry, appPartition } from "../src/apps/registry.mjs";
import { createAppWorkspace } from "../src/desktop/app-workspace.mjs";
import { createIpcRouter } from "../src/desktop/ipc.mjs";
import { openMcpApp } from "../src/desktop/mcp-app.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "midnight-apps-check-"));
app.setPath("userData", path.join(temp, "profile"));
app.on("window-all-closed", () => {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn) => { for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await wait(30); } throw new Error("Timed out waiting for the app"); };
const fixture = `<!doctype html><title>Project notes</title><style>body{font:16px system-ui;padding:40px;color:#202027}input,textarea{display:block;margin:12px 0} .hidden{display:none}</style><h1>Project notes</h1><p id="selected">The release is ready for review.</p><p>Two issues remain before Friday.</p><input value="private-input"><input type="password" value="private-password"><textarea>private-textarea</textarea><div contenteditable="true">private-draft</div><p hidden>private-hidden</p><p class="hidden">private-css</p><p data-private>private-marked</p><a href="/next">Next page</a>`;
const server = http.createServer((_req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(fixture); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
let workspace, handler, router;
const hostCalls = [], shellErrors = [];
const compat = process.argv.includes("--compat");
const watchdog = setTimeout(() => { process.stderr.write("[apps] FAIL timeout\n"); app.exit(1); }, compat ? 90000 : 45000);

app.whenReady().then(async () => {
	try {
		const registry = createAppRegistry(path.join(temp, "apps.json"));
		const create = () => createAppWorkspace({ registry, showWindow: false, settings: () => ({ privacy: "cloud", model: "Test model" }), onReset: (id) => router?.reset(id),
			request: async (method, params) => {
				hostCalls.push({ method, params });
				if (method === "mission.pageAssist") {
					const id = params.missionId || `msn_${hostCalls.length}`;
					workspace.onEngine({ kind: "update", missionId: id, type: "mission.created", mission: { id, goal: params.text, lastInput: params.text, title: params.text, status: "running", trigger: { kind: "user", appId: params.page.appId }, updatedAt: new Date().toISOString() } });
					return { missionId: id };
				}
				return { ok: true };
			},
		});
		workspace = create();
		const shellMethods = Object.fromEntries(["state", "open", "add", "update", "remove", "layout", "command", "ask", "stop", "viewTask"].map((name) => [`apps.${name}`, (p) => workspace[name](p)]));
		router = createIpcRouter({ ipcMain: { handle: (channel, fn) => { handler = fn; ipcMain.handle(channel, fn); } }, isTrusted: (e) => workspace.isTrusted(e), canCall: (_e, method) => method.startsWith("apps."), shell: shellMethods, host: () => { throw new Error("Unexpected host route"); } });
		await workspace.open();
		let win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/apps.html"));
		if (process.argv.includes("--compact")) win.setContentSize(780, 660);
		const js = (source) => win.webContents.executeJavaScript(`(async () => { ${source} })()`);
		win.webContents.on("console-message", (e) => { if (e.level === "error" || e.level === 3) shellErrors.push(e.message); });
		await until(() => js("return !!window.midnightApps && document.getElementById('appList').children.length === 0;"));
		assert.equal(hostCalls.length, 0);
		process.stdout.write("[apps] PASS opens without AI or reading website content\n");
		await js(`document.getElementById('addApp').click();`);
		await until(() => js("return document.getElementById('appDialog').open;"));
		await js(`document.getElementById('websiteUrl').value=${JSON.stringify(url)}; document.getElementById('websiteName').value='Project notes'; document.getElementById('websiteProfile').value='Work'; document.getElementById('appForm').requestSubmit();`);
		await until(() => workspace.state().apps.length === 1 && !workspace.state().page?.loading);
		await until(() => js("return !document.getElementById('appDialog').open;"));
		const work = registry.list()[0];
		const remote = () => webContents.getAllWebContents().find((wc) => wc.session === session.fromPartition(appPartition(work.id)) && wc.getURL().startsWith(url));
		await until(remote);
		assert.deepEqual(await remote().executeJavaScript("({midnight:typeof midnight, apps:typeof midnightApps, node:typeof require})"), { midnight: "undefined", apps: "undefined", node: "undefined" });
		assert.equal((await handler({ sender: remote(), senderFrame: remote().mainFrame }, { v: 1, seq: 1, method: "apps.state", params: {} })).ok, false);
		assert.equal((await handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, { v: 1, seq: 10000, method: "mission.create", params: { text: "bad", requestId: "bad" } })).ok, false);
		// A rejected request consumed its sequence; reload the shell to reset its real preload.
		await win.webContents.reload(); await until(() => js("return !!window.midnightApps && document.getElementById('appTitle').textContent.includes('Project notes');"));
		process.stdout.write("[apps] PASS real picker, sandbox, and window-specific IPC boundary\n");
		await remote().executeJavaScript("localStorage.setItem('account','work'); document.cookie='session=work; max-age=3600; path=/';");
		const personal = await workspace.add({ url, name: "Project notes", profile: "Personal" });
		await until(() => !workspace.state().page.loading);
		const other = webContents.getAllWebContents().find((wc) => wc.session === session.fromPartition(appPartition(personal.id)) && wc.getURL().startsWith(url));
		assert.equal(await other.executeJavaScript("localStorage.getItem('account')"), null);
		assert.equal(await other.executeJavaScript("document.cookie"), "");
		await other.executeJavaScript("localStorage.setItem('account','personal')");
		await workspace.open({ id: work.id });
		assert.equal(await remote().executeJavaScript("localStorage.getItem('account')"), "work");
		assert.equal(hostCalls.length, 0);
		process.stdout.write("[apps] PASS accounts on the same website stay isolated and restore on switching\n");
		await js("document.getElementById('assistantToggle').click(); document.getElementById('appPrompt').value='Summarize the release'; document.getElementById('askForm').requestSubmit();");
		await until(() => hostCalls.length === 1);
		const shared = hostCalls[0].params.page;
		assert.match(shared.text, /release is ready/);
		assert.doesNotMatch(shared.text, /private-/);
		assert.equal(shared.appId, work.id);
		assert.equal(shared.profile, "Work");
		const missionId = workspace.state().missions[0].id;
		workspace.onEngine({ kind: "update", missionId, type: "mission.completed", mission: { ...workspace.state().missions[0], status: "succeeded", answer: "**Ready for review.** Two issues remain." } });
		await until(() => js("return document.getElementById('conversation').textContent.includes('Ready for review.');"));
		assert.equal(await js("return document.getElementById('viewTask').hidden;"), false);
		process.stdout.write("[apps] PASS explicit page sharing excludes inputs, editors and hidden text; answer appears beside the page\n");
		await remote().executeJavaScript("const range=document.createRange(); range.selectNodeContents(document.getElementById('selected')); const s=getSelection(); s.removeAllRanges(); s.addRange(range);");
		await workspace.ask({ id: work.id, text: "Explain this", scope: "selection", requestId: "selected-only", missionId });
		assert.equal(hostCalls[1].params.page.text.trim(), "The release is ready for review.");
		assert.doesNotMatch(hostCalls[1].params.page.text, /Two issues/);
		await workspace.ask({ id: work.id, text: "Just a question", scope: "none", requestId: "no-page", missionId });
		assert.equal(hostCalls[2].params.page.text, ""); assert.equal(hostCalls[2].params.page.url, "");
		await assert.rejects(workspace.ask({ id: personal.id, text: "wrong app", scope: "page", requestId: "wrong" }), /active app changed/);
		process.stdout.write("[apps] PASS selected-text scope, no-new-text scope, and stale-app rejection\n");
		workspace.onEngine({ kind: "update", missionId, type: "mission.completed", mission: { ...workspace.state().missions[0], status: "succeeded", answer: "A draft for you to review." } });
		// Intentional screenshot of the trusted UI; the hidden native website view is tested separately.
		const out = path.join(root, "test/visual/out"); fs.mkdirSync(out, { recursive: true });
		win.showInactive(); // offscreen window: render native website bounds without disturbing the desktop
		await until(() => win.isVisible());
		// CI may constrain the window to a compact desktop, where the assistant covers the page.
		await js("setPanel(false); await bounds();");
		const visiblePages = win.contentView.children.filter((view) => view.webContents && view.webContents !== win.webContents && view.getVisible());
		assert.equal(visiblePages.length, 1);
		const actualBounds = visiblePages[0].getBounds();
		const expectedBounds = await js("const r=document.getElementById('siteViewport').getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};");
		for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(actualBounds[key] - expectedBounds[key]) <= 1, `native ${key} follows the viewport within one DIP of rounding: ${JSON.stringify({ actualBounds, expectedBounds })}`);
		await js("await openDialog(currentApp());");
		assert.equal(visiblePages[0].getVisible(), false, "native website is hidden behind trusted app settings");
		await js("closeDialog(); setPanel(true); await bounds();");
		await wait(100); fs.writeFileSync(path.join(out, "apps-workspace.png"), (await win.webContents.capturePage()).toPNG());
		win.setContentSize(780, 660); await wait(100);
		await js("await bounds();");
		assert.equal(await js("return getComputedStyle(document.querySelector('.site-region')).visibility;"), "hidden");
		assert.equal(visiblePages[0].getVisible(), false, "the compact assistant covers the native website");
		await js("document.getElementById('closeAssistant').click();");
		await until(() => js("return !panelOpen && document.getElementById('assistant').hidden && getComputedStyle(document.querySelector('.site-region')).visibility === 'visible';")).catch(async (err) => {
			err.message += await js("return JSON.stringify({panelOpen,classes:document.getElementById('workspace').className,dialog:document.getElementById('appDialog').open,visibility:getComputedStyle(document.querySelector('.site-region')).visibility,width:innerWidth});");
			throw err;
		});
		await js("await bounds();");
		assert.equal(visiblePages[0].getVisible(), true, "closing the compact assistant restores the website");
		process.stdout.write("[apps] PASS assistant becomes a drawer on smaller windows\n");
		await workspace.update({ id: work.id, pinned: false });
		assert.equal(registry.get(work.id).pinned, false);
		workspace.dispose();
		assert.equal(workspace.isTrusted({ sender: null }), false, "closed workspaces reject late IPC without accessing a destroyed window");
		workspace = create();
		await workspace.open({ id: work.id });
		await until(() => !workspace.state().page.loading && remote());
		assert.equal(await remote().executeJavaScript("localStorage.getItem('account')"), "work");
		await workspace.command({ id: work.id, action: "signout" });
		await until(() => !workspace.state().page.loading && remote());
		assert.equal(await remote().executeJavaScript("localStorage.getItem('account')"), null);
		assert.equal(await remote().executeJavaScript("document.cookie"), "");
		await workspace.open({ id: personal.id }); await until(() => !workspace.state().page.loading);
		const personalWc = webContents.getAllWebContents().find((wc) => wc.session === session.fromPartition(appPartition(personal.id)) && wc.getURL().startsWith(url));
		assert.equal(await personalWc.executeJavaScript("localStorage.getItem('account')"), "personal");
		await workspace.remove({ id: work.id, forget: true });
		assert.equal(registry.list().length, 1);
		process.stdout.write("[apps] PASS unpinning preserves profiles; sign-out and removal affect only the chosen profile\n");
		// A connector's MCP App view: runs its own script, but cannot reach the network, local files or midnight.
		const viewFile = path.join(temp, "view.html");
		const secretFile = path.join(temp, "secret.txt");
		fs.writeFileSync(secretFile, "top secret");
		let hits = 0;
		const probe = http.createServer((_q, r) => { hits++; r.end("leak"); });
		await new Promise((r) => probe.listen(0, "127.0.0.1", r));
		const probeUrl = `http://127.0.0.1:${probe.address().port}/`;
		const secretUrl = new URL(`file:///${secretFile.replace(/\\/g, "/")}`).href;
		fs.writeFileSync(viewFile, `<!doctype html><h1 id=t>Forecast</h1><script>document.getElementById('t').textContent='Forecast ready'; window.results={net:'pending',file:'pending',img:'pending'}; fetch(${JSON.stringify(probeUrl)}).then(()=>results.net='open',()=>results.net='blocked'); fetch(${JSON.stringify(secretUrl)}).then(r=>r.text()).then(t=>results.file=t,()=>results.file='blocked'); const i=new Image(); i.onload=()=>results.img='open'; i.onerror=()=>results.img='blocked'; i.src=${JSON.stringify(`${probeUrl}pixel.png`)};</script>`);
		const before = new Set(BrowserWindow.getAllWindows());
		openMcpApp({ path: viewFile, name: "Fixture" });
		const viewer = BrowserWindow.getAllWindows().find((w) => !before.has(w));
		await until(async () => (await viewer.webContents.executeJavaScript("document.getElementById('t')?.textContent").catch(() => "")) === "Forecast ready");
		const results = await until(async () => { const r = await viewer.webContents.executeJavaScript("window.results"); return Object.values(r).every((v) => v !== "pending") && r; });
		assert.deepEqual(results, { net: "blocked", file: "blocked", img: "blocked" });
		assert.equal(hits, 0, "nothing reached the network");
		assert.equal(await viewer.webContents.executeJavaScript("typeof window.midnight + typeof window.midnightApps + typeof require"), "undefinedundefinedundefined", "no bridge to midnight or Node");
		viewer.destroy(); probe.close();
		process.stdout.write("[apps] PASS connector views run sandboxed with no network, files or bridge\n");
		assert.deepEqual(shellErrors, []);
		process.stdout.write("[apps] PASS no renderer errors\n");
		if (compat) {
			for (const address of ["https://example.com/", "https://github.com/", "https://www.wikipedia.org/"]) {
				await workspace.add({ url: address });
				try {
					await until(() => !workspace.state().page.loading);
					const page = workspace.state().page;
					process.stdout.write(`[apps] COMPAT ${address} ${JSON.stringify({ title: page.title, error: page.error })}\n`);
				} catch (err) { process.stdout.write(`[apps] COMPAT ${address} ${err.message}\n`); }
			}
		}
		workspace.dispose(); server.close(); clearTimeout(watchdog); app.exit(0);
	} catch (err) {
		process.stderr.write(`[apps] FAIL ${err.stack}\n`);
		workspace?.dispose(); server.close(); clearTimeout(watchdog); app.exit(1);
	}
});
