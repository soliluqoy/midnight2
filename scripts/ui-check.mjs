// Interaction regressions against the actual renderer, with delayed/rejected bridge responses.
import assert from "node:assert/strict";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { windowBounds, windowDims } from "../src/desktop/window-layout.mjs";
import { previewFile } from "../src/desktop/file-preview.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "midnight-ui-check-")));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const color = (css) => css.match(/[\d.]+/g).map(Number);
const over = (foreground, background) => {
	const [r, g, b, a = 1] = color(foreground);
	return [r, g, b].map((v, i) => v * a + background[i] * (1 - a));
};
const luminance = (rgb) => rgb.slice(0, 3).map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
};
ipcMain.handle("fixture:size", () => null);

app.whenReady().then(async () => {
	nativeTheme.themeSource = "dark"; // the checks below are for the default dark appearance; light has its own checks
	const win = new BrowserWindow({ width: 1300, height: 1400, show: false, webPreferences: { preload: path.join(root, "test/visual/preload.cjs"), contextIsolation: true, sandbox: true, offscreen: true } });
	const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
	const errors = [];
	win.webContents.on("console-message", (e) => { if (e.level === "error" || e.level === 3) errors.push(e.message); });
	const reset = async () => { errors.length = 0; win.webContents.setZoomFactor(1); win.setContentSize(1300, 1400); await win.loadFile(path.join(root, "src/ui/index.html")); await sleep(250); };
	const calls = (method) => js(`return __fixture.calls().filter(c => c.method === ${JSON.stringify(method)});`);
	const tests = [
		["app launch targets preserve Midnight and its draft without starting an AI task", async () => {
			await js(`await setState('chat'); __fixture.emit({kind:'shell',type:'summon',restore:true}); document.getElementById('box').value='Still writing this'; __fixture.emit({kind:'shell',type:'apps',apps:[{id:'app1',name:'<img onerror=alert(1)>',profile:'Work',pinned:true},{id:'app2',name:'Personal',pinned:false}]});`);
			assert.equal(await js(`return document.querySelectorAll('.launcher-app-pin').length;`), 1);
			assert.equal(await js(`return document.querySelectorAll('#pinnedApps img').length;`), 0);
			await js(`document.querySelector('.launcher-app-pin').click();`); await sleep(40);
			assert.deepEqual((await calls("apps.open"))[0].args[0], { id: "app1" });
			assert.equal((await calls("missions.create")).length, 0);
			await js(`document.getElementById('addWebsite').click();`); await sleep(40);
			assert.deepEqual((await calls("apps.open"))[1].args[0], { add: true });
			await js(`document.getElementById('openApps').click();`); await sleep(40);
			assert.deepEqual((await calls("apps.open"))[2].args[0], {});
			assert.equal((await calls("ui.hide")).length, 0);
			assert.deepEqual(await js(`return {view:cur,parked,draft:document.getElementById('box').value};`), { view: "chat", parked: false, draft: "Still writing this" });
		}],
		["rounded Start launcher preserves dedicated native drag regions", async () => {
			await js(`await setState('chat');`);
			assert.deepEqual(await js(`return {title:getComputedStyle(document.querySelector('.window-bar')).webkitAppRegion,controls:[...document.querySelectorAll('.window-control')].map(el=>getComputedStyle(el).webkitAppRegion),pill:!!document.getElementById('l-idle')};`), { title: "drag", controls: ["no-drag", "no-drag"], pill: false });
			assert.ok(await js(`return parseFloat(getComputedStyle(cap).borderTopLeftRadius)>0 && getComputedStyle(cap).overflow==='hidden';`));
			assert.equal(await js(`return document.querySelectorAll('.continue-mission').length;`), 3);
			assert.equal(await js(`return cap.clientHeight;`), 458);
			const body = await js(`const el=document.querySelector('.start-body'); return {height:el.clientHeight,content:el.scrollHeight};`);
			assert.ok(body.content <= body.height + 1, `default launcher content fits without scrolling: ${JSON.stringify(body)}`);
			await js(`__fixture.emit({kind:'shell',type:'apps',apps:Array.from({length:6},(_,i)=>({id:'app'+i,name:'Website '+i,pinned:true}))});`);
			assert.ok(await js(`const el=document.querySelector('.start-body'); return el.scrollHeight<=el.clientHeight+1;`), 'saved apps and three recent missions fit without vertical scrolling');
		}],
		["keyboard focus remains visible on navigation, recent missions and task controls", async () => {
			await js(`await setState('chat');`);
			await sleep(400);
			// Hidden offscreen windows need Chromium focus emulation for real keyboard modality.
			win.webContents.debugger.attach("1.3");
			try {
				await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
				await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
				await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
				for (const selector of ["#windowMin", "#navHome", ".continue-mission", "#homeFiles", "#addWebsite", "#box", "#sendTask"]) {
					const marker = await js(`const el=document.querySelector(${JSON.stringify(selector)}); document.activeElement.blur(); const before=getComputedStyle(el); const baseline={border:before.borderColor,shadow:before.boxShadow}; el.focus(); const s=getComputedStyle(el); return {focused:document.activeElement===el,visible:el.matches(':focus-visible'),outline:s.outlineStyle!=='none' && parseFloat(s.outlineWidth)>=2,offset:parseFloat(s.outlineOffset),outlineColor:s.outlineColor,border:s.borderColor,changed:s.borderColor!==baseline.border || s.boxShadow!==baseline.shadow,background:s.backgroundColor,shell:getComputedStyle(cap).backgroundColor};`);
					assert.ok(marker.focused && marker.visible, `${selector} receives keyboard focus: ${JSON.stringify(marker)}`);
					const background = over(marker.background, color(marker.shell));
					const adjacent = marker.offset >= 0 ? color(marker.shell) : background;
					assert.ok(marker.outline ? contrast(over(marker.outlineColor, adjacent), adjacent) >= 3 : marker.changed && contrast(over(marker.border, background), background) >= 3, `${selector} has a distinguishable focus marker`);
				}
			} finally { win.webContents.debugger.detach(); }
		}],
		["light appearance keeps text readable and high-contrast edges visible", async () => {
			nativeTheme.themeSource = "light";
			try {
				await reset();
				await js(`await setState('chat'); document.activeElement.blur();`);
				await sleep(200);
				const scheme = await js(`return matchMedia('(prefers-color-scheme: light)').matches && getComputedStyle(document.documentElement).colorScheme;`);
				assert.equal(scheme, "light", "the light tokens apply");
				const text = await js(`const s=getComputedStyle(document.documentElement),c=k=>s.getPropertyValue(k).trim();return {paper:c('--paper'),surface:c('--surface'),ink:c('--ink'),muted:c('--muted'),faint:c('--faint'),accent:c('--accent'),onAccent:c('--on-accent'),shell:getComputedStyle(cap).backgroundColor};`);
				const hex = (h) => (h.length === 4 ? [...h.slice(1)].map((x) => parseInt(x + x, 16)) : [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
				for (const k of ["ink", "muted", "faint"]) for (const bg of ["paper", "surface"]) assert.ok(contrast(hex(text[k]), hex(text[bg])) >= 4.5, `${k} on ${bg} reaches 4.5:1 in light`);
				assert.ok(contrast(hex(text.onAccent), hex(text.accent)) >= 4.5, "primary button text reaches 4.5:1 in light");
				assert.deepEqual(color(text.shell).slice(0, 3), hex(text.paper), "the launcher surface is the light paper");
				await js(`applyPrefs({highContrast:true});`);
				await sleep(200);
				const edges = await js(`return [...document.querySelectorAll('.continue-mission,.home-mode,#box,#chipModel,#sendTask')].map(el=>{const s=getComputedStyle(el);return {name:el.id || el.textContent.trim(),width:parseFloat(s.borderTopWidth),style:s.borderTopStyle,border:s.borderTopColor,background:s.backgroundColor,shell:getComputedStyle(cap).backgroundColor};});`);
				for (const edge of edges) {
					const shell = color(edge.shell), background = over(edge.background, shell), border = over(edge.border, background);
					assert.ok(edge.width > 0 && edge.style !== "none" && contrast(border, background) >= 3 && contrast(border, shell) >= 3, `${edge.name} has visible edges in light high contrast`);
				}
			} finally {
				nativeTheme.themeSource = "dark";
			}
		}],
		["Windows High Contrast (forced colors) gives every control a system-colored edge", async () => {
			win.webContents.debugger.attach("1.3");
			try {
				await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
				await js(`await setState('chat'); document.activeElement.blur();`);
				await sleep(200);
				assert.equal(await js(`return matchMedia('(forced-colors: active)').matches;`), true);
				const missing = await js(`return [...document.querySelectorAll('#cap button:not([hidden]), #box')].filter(el=>el.offsetParent).filter(el=>{const s=getComputedStyle(el);return !(parseFloat(s.borderTopWidth)>0 && s.borderTopStyle!=='none');}).map(el=>el.id||el.className);`);
				assert.deepEqual(missing, [], "every visible control has a border in forced colors");
			} finally {
				await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
				win.webContents.debugger.detach();
			}
		}],
		["high contrast makes mission and action boundaries distinguishable", async () => {
			await js(`await setState('chat'); applyPrefs({highContrast:true}); document.activeElement.blur();`);
			await sleep(200); // inspect the settled colors after the 160 ms control transition
			const edges = await js(`return [...document.querySelectorAll('.continue-mission,.home-mode,#box,#chipModel,#sendTask')].map(el=>{const s=getComputedStyle(el);return {name:el.id || el.textContent.trim(),width:parseFloat(s.borderTopWidth),style:s.borderTopStyle,border:s.borderTopColor,background:s.backgroundColor,shell:getComputedStyle(cap).backgroundColor};});`);
			for (const edge of edges) {
				const shell = color(edge.shell), background = over(edge.background, shell), border = over(edge.border, background);
				assert.ok(edge.width > 0 && edge.style !== "none" && contrast(border, background) >= 3 && contrast(border, shell) >= 3, `${edge.name} has visible edges in high contrast`);
			}
		}],
		["reduce motion stops prolonged surface and status animations", async () => {
			await js(`__fixture.variant('running'); await setState('mission'); applyPrefs({reducedMotion:true});`);
			assert.ok(await js(`return [...document.querySelectorAll('#cap,#cap *')].every(el=>{const s=getComputedStyle(el),short=list=>list.split(',').every(t=>parseFloat(t)<=.001);return short(s.transitionDuration) && short(s.animationDuration) && (s.animationName==='none' || s.animationIterationCount.split(',').every(n=>Number(n)<=1));});`));
		}],
		["minimize and close hide to tray without losing or cancelling the current mission", async () => {
			await js(`__fixture.variant('running'); await setState('mission'); document.getElementById('bMin').click(); document.getElementById('windowClose').click();`);
			await sleep(60);
			assert.equal((await calls("ui.hide")).length, 2);
			assert.equal((await calls("missions.cancel")).length, 0);
			assert.equal((await calls("missions.pause")).length, 0);
			assert.deepEqual(await js(`return {view:cur,mission:current,parked};`), { view: "mission", mission: "m1", parked: true });
			await js(`__fixture.emit({kind:'shell',type:'summon',restore:true});`);
			await sleep(60);
			assert.deepEqual(await js(`return {view:cur,mission:current,parked};`), { view: "mission", mission: "m1", parked: false });
		}],
		["Esc hides the launcher and summon restores an unsent prompt", async () => {
			await js(`await setState('chat'); const box=document.getElementById('box'); box.value='Still writing this'; box.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);
			await sleep(60);
			assert.equal((await calls("ui.hide")).length, 1);
			await js(`__fixture.emit({kind:'shell',type:'summon',restore:true});`);
			await sleep(60);
			assert.equal(await js(`return document.getElementById('box').value;`), "Still writing this");
			assert.equal(await js(`return document.activeElement.id;`), "box");
		}],
		["one input at the top switches between local search and tasks while retaining both drafts", async () => {
			await js(`await setState('chat'); document.getElementById('box').value='Write a budget proposal'; document.getElementById('homeFiles').click();`);
			await sleep(60);
			assert.equal(await js(`return document.getElementById('box').value;`), 'Write a budget proposal');
			assert.equal(await js(`return document.querySelectorAll('#fileQuery,#l-search,#navSearch,[data-task-action]').length;`), 0);
			assert.equal(await js(`return document.querySelectorAll('#l-chat textarea').length;`), 1);
			assert.equal(await js(`return document.getElementById('sendTask').hidden;`), true);
			await js(`document.getElementById('box').value='budget meeting'; document.getElementById('box').dispatchEvent(new Event('input',{bubbles:true}));`);
			await sleep(250);
			assert.equal((await calls('files.search')).at(-1).args[0].query, 'budget meeting');
			assert.equal((await calls('missions.create')).length, 0);
			await js(`document.getElementById('homeAsk').click();`);
			await sleep(40);
			assert.equal(await js(`return document.getElementById('box').value;`), 'Write a budget proposal');
			assert.ok(await js(`return document.getElementById('box').getBoundingClientRect().bottom <= document.getElementById('homeBrowse').getBoundingClientRect().top;`));
			await js(`document.getElementById('homeFiles').click();`);
			await sleep(40);
			assert.equal(await js(`return document.getElementById('box').value;`), 'budget meeting');
			await js(`document.getElementById('box').value=''; await setState('chat'); await setState('search');`);
			assert.equal(await js(`return document.getElementById('box').value;`), '');
			await js(`await setState('chat'); __fixture.configure({'missions.create':{result:{missionId:'m1'}}}); document.getElementById('sendTask').click();`);
			await sleep(60);
			assert.equal((await calls('missions.create'))[0].args[0].text, 'Write a budget proposal');
		}],
		["Continue prioritizes input requests, limits recent work and opens existing missions", async () => {
			await js(`__fixture.variant('approval'); await setState('chat'); const template=snap.missions.m2; acceptSnapshot({...snap,seq:snap.seq+1,missions:{...snap.missions,old:{...template,id:'old',title:'Older question',status:'waiting-input',updatedAt:'2025-01-01'},recent:{...template,id:'recent',title:'Newest work',updatedAt:'2026-10-12'},archived:{...template,id:'archived',archived:true,status:'waiting-approval',updatedAt:'2026-10-13'}}});`);
			assert.deepEqual(await js(`return [...document.querySelectorAll('.continue-mission')].map(b=>b.dataset.mission);`), ['m1', 'old', 'recent']);
			await sleep(400); // focus the visible launcher after its initial reveal
			await js(`document.querySelector('.continue-mission').focus(); acceptSnapshot({...snap,seq:snap.seq+1,missions:{...snap.missions,m1:{...snap.missions.m1,title:'Updated title'}}});`);
			assert.equal(await js(`return document.activeElement.dataset.mission;`), 'm1');
			assert.equal(await js(`return document.querySelector('.continue-title').textContent;`), 'Updated title');
			await js(`document.querySelector('.continue-mission').click();`);
			await sleep(60);
			assert.deepEqual(await js(`return {view:cur,mission:current,footer:cap.dataset.f};`), {view:'mission',mission:'m1',footer:'ask'});
			assert.equal((await calls("missions.create")).length, 0);
			assert.equal((await calls("approvals.decide")).length, 0);
			await js(`await setState('chat'); document.getElementById('bStackChat').click();`);
			await sleep(60);
			assert.equal(await js(`return cur;`), 'stack');
		}],
		["late task failures restore the task draft without changing a file query", async () => {
			await js(`await setState('chat'); document.getElementById('box').value='Write the budget proposal'; __fixture.configure({'missions.create':{delay:150,error:'Request could not start'}}); document.getElementById('sendTask').click(); await setState('search'); document.getElementById('box').value='budget meeting'; document.getElementById('box').dispatchEvent(new Event('input',{bubbles:true}));`);
			await sleep(250);
			assert.equal(await js(`return document.getElementById('box').value;`), 'budget meeting');
			assert.equal(await js(`return cur;`), 'search');
			await js(`await setState('chat');`);
			assert.equal(await js(`return document.getElementById('box').value;`), 'Write the budget proposal');
		}],
		["selected files attach to an existing task, survive failure and can be removed", async () => {
			await js(`await setState('chat'); document.getElementById('box').value='Explain the budget changes'; await setState('search'); document.getElementById('box').value='budget'; document.getElementById('box').dispatchEvent(new Event('input',{bubbles:true}));`);
			await sleep(250);
			await js(`[...document.querySelectorAll('#filePreview button')].find(b=>b.textContent==='Use in task').click();`);
			await sleep(40);
			assert.equal(await js(`return document.getElementById('box').value;`), 'Explain the budget changes');
			assert.equal(await js(`return document.getElementById('taskFileName').textContent;`), 'Q3 budget.pdf');
			assert.equal((await calls('missions.create')).length, 0);
			await js(`document.getElementById('removeTaskFile').click();`);
			assert.equal(await js(`return document.getElementById('taskFile').hidden;`), true);
			assert.equal(await js(`return document.getElementById('box').value;`), 'Explain the budget changes');
			await js(`await setState('search');`);
			await sleep(60);
			await js(`[...document.querySelectorAll('#filePreview button')].find(b=>b.textContent==='Use in task').click();`);
			await sleep(40);
			await js(`__fixture.configure({'missions.create':{error:'Temporarily unavailable'}}); document.getElementById('sendTask').click();`);
			await sleep(60);
			assert.equal(await js(`return document.getElementById('taskFile').hidden;`), false);
			assert.match(await js(`return document.getElementById('box').value;`), /^Explain the budget changes\n\nFile context:/);
			await js(`__fixture.configure({'missions.create':{result:{missionId:'m1'}}}); document.getElementById('sendTask').click();`);
			await sleep(60);
			const sent = (await calls('missions.create')).at(-1).args[0].text;
			assert.equal(sent.split('File context:').length, 2);
			assert.match(sent, /Q3 budget\.pdf.*\nMatching location: Page 3\nI found it by searching: budget/);
			await js(`newTask();`);
			await sleep(40);
			assert.equal(await js(`return document.getElementById('taskFile').hidden;`), true);
		}],
		["Continue hides when all missions are archived or history is empty", async () => {
			await js(`await setState('chat'); acceptSnapshot({...snap,seq:snap.seq+1,missions:Object.fromEntries(Object.entries(snap.missions).map(([id,m])=>[id,{...m,archived:true}]))});`);
			assert.equal(await js(`return document.getElementById('homeContinue').hidden;`), true);
			await js(`acceptSnapshot({...snap,seq:snap.seq+1,missions:{}});`);
			assert.equal(await js(`return document.querySelectorAll('.continue-mission').length;`), 0);
		}],
		["Summarize appears for usable clipboard content and prepares it without discarding a draft", async () => {
			await js(`await setState('chat'); __fixture.configure({'clipboard.read':{result:'https://example.com/report'}}); await checkClipboard(); document.getElementById('box').value='Focus on the budget'; document.getElementById('chipClip').click(); document.getElementById('chipClip').click();`);
			assert.equal(await js(`return document.getElementById('box').value;`), 'Focus on the budget\n\nSummarize this page: https://example.com/report');
			assert.equal((await calls("missions.create")).length, 0);
			await js(`__fixture.configure({'clipboard.read':{result:'A longer copied passage. '.repeat(20)}}); await checkClipboard(); document.getElementById('box').value=''; document.getElementById('chipClip').click();`);
			assert.match(await js(`return document.getElementById('box').value;`), /^Summarize this text I copied/);
			await js(`__fixture.configure({'clipboard.read':{result:'short'}}); await checkClipboard();`);
			assert.equal(await js(`return document.getElementById('chipClip').hidden;`), true);
			await js(`__fixture.configure({'clipboard.read':{queue:[{delay:100,result:'https://example.com/old'},{delay:10,result:''}]}}); await Promise.all([checkClipboard(),checkClipboard()]);`);
			assert.equal(await js(`return document.getElementById('chipClip').hidden;`), true);
		}],
		["settings can record the modifier-only Ctrl+Win shortcut", async () => {
			await js(`Object.defineProperty(navigator,'platform',{value:'Win32',configurable:true}); openSettings('behaviour');`);
			await sleep(200);
			await js(`document.querySelector('[aria-label="Change summon shortcut"]').click(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Control',ctrlKey:true,bubbles:true})); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Meta',ctrlKey:true,metaKey:true,bubbles:true})); document.dispatchEvent(new KeyboardEvent('keyup',{key:'Meta',ctrlKey:true,bubbles:true}));`);
			await sleep(80);
			assert.equal((await calls("settings.set")).at(-1).args[0].hotkey, "Control+Super");
			assert.match(await js(`return document.getElementById('hint').textContent;`), /Ctrl\+Win/);
		}],
		["file search works without a chat sign-in and restores its query", async () => {
			await js(`signedIn=false; openSettings('accounts'); document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));`);
			await sleep(100);
			assert.equal(await js(`return cur;`), "search");
			assert.equal(await js(`return document.getElementById('navHome').getAttribute('aria-current');`), "page");
			assert.equal(await js(`return document.getElementById('homeFiles').getAttribute('aria-pressed');`), "true");
			assert.ok(await js(`return [...document.querySelectorAll('.lay')].filter(l=>l.id!=='l-chat').every(l=>l.inert);`));
			await js(`const input=document.getElementById('box'); input.value='budget meeting'; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); __fixture.emit({kind:'shell',type:'summon',restore:true});`);
			await sleep(300);
			assert.equal(await js(`return document.getElementById('box').value;`), "budget meeting");
			assert.equal(await js(`return document.activeElement.id;`), "box");
			assert.equal((await calls("missions.create")).length, 0);
			assert.equal((await calls("ui.hide")).length, 1);
		}],
		["file search ignores old replies and presents indexed text safely", async () => {
			await js(`await setState('search'); __fixture.configure({'files.search':{queue:[{delay:400,result:{results:[{id:'old',path:'C:\\\\Approved\\\\old.txt',name:'Old result',kind:'document',text:'OLD',locator:{},match:'words'}],mode:'words'}},{delay:10,result:{results:[{id:'new',path:'C:\\\\Approved\\\\new.txt',name:'New result',kind:'document',text:'<img src=x onerror=alert(1)> remembered words',locator:{line:4},match:'words'}],mode:'words',warning:'Meaning search is disabled'}}]}}); const input=document.getElementById('box'); input.value='old'; input.dispatchEvent(new Event('input',{bubbles:true}));`);
			await sleep(210);
			await js(`const input=document.getElementById('box'); input.value='new'; input.dispatchEvent(new Event('input',{bubbles:true}));`);
			await sleep(600);
			assert.equal(await js(`return document.querySelector('.file-result').dataset.id;`), "new");
			assert.equal(await js(`return document.querySelectorAll('#filePreview img').length;`), 0);
			assert.match(await js(`return document.getElementById('filePreview').textContent;`), /<img src=x/);
			assert.match(await js(`return document.getElementById('fileSummary').textContent;`), /Word matches.*disabled/);
		}],
		["file search keyboard reveals the selected moment and prepares a task", async () => {
			await js(`await setState('search'); const input=document.getElementById('box'); input.value='budget'; input.dispatchEvent(new Event('input',{bubbles:true}));`);
			await sleep(300);
			await js(`const input=document.getElementById('box'); input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}));`);
			await sleep(60);
			assert.deepEqual((await calls("files.open")).at(-1).args[0], { id: "fs2", reveal: true });
			assert.match(await js(`return document.getElementById('filePreview').textContent;`), /Audio at 1:06–1:32/);
			await js(`[...document.querySelectorAll('#filePreview button')].find(b=>b.textContent==='Use in task').click();`);
			await sleep(80);
			assert.equal(await js(`return cur;`), "chat");
			assert.match(await js(`return document.getElementById('taskFileName').title;`), /budget meeting\.mp4.*\nMatching location: Audio at 1:06–1:32\nI found it by searching: budget/);
			assert.match(await js(`return document.getElementById('taskFile').textContent;`), /Shared with your model on Send/);
			assert.equal((await calls("missions.create")).length, 0);
		}],
		["file search filters and retries errors without losing the query", async () => {
			await js(`await setState('search'); const input=document.getElementById('box'); input.value='remember this'; input.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('fileKind').value='image'; document.getElementById('fileKind').dispatchEvent(new Event('change'));`);
			await sleep(250);
			assert.equal((await calls("files.search")).at(-1).args[0].kind, "image");
			assert.equal(await js(`return document.querySelectorAll('.file-result').length;`), 1);
			await js(`__fixture.configure({'files.search':{error:'Local encoder stopped'}}); document.getElementById('fileKind').value='video'; document.getElementById('fileKind').dispatchEvent(new Event('change'));`);
			await sleep(80);
			assert.match(await js(`return document.getElementById('fileStatus').textContent;`), /Local encoder stopped/);
			assert.equal(await js(`return document.getElementById('box').value;`), "remember this");
			await js(`__fixture.configure({'files.search':{result:{results:[],mode:'words'}}}); document.getElementById('box').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
			await sleep(80);
			assert.match(await js(`return document.getElementById('fileSummary').textContent;`), /0 results.*Word matches/);
		}],
		["ready search hides maintenance until requested; empty results use the full pane", async () => {
			await js(`await setState('search');`);
			await sleep(60);
			assert.equal(await js(`return document.getElementById('fileManagement').hidden;`), true);
			assert.equal(await js(`return document.getElementById('filePreview').hidden;`), true);
			await js(`document.getElementById('manageSearch').click();`);
			assert.equal(await js(`return document.getElementById('fileManagement').hidden;`), false);
			await js(`document.getElementById('manageSearch').click();`);
			assert.equal(await js(`return document.getElementById('fileManagement').hidden;`), true);
		}],
		["file search starts background indexing and surfaces setup failure", async () => {
			await js(`await setState('search');`);
			await sleep(60);
			await js(`__fixture.configure({'files.status':{result:{state:'indexing',busy:true,operation:'index',phase:'embedding',progress:{done:3,total:8,file:'budget.pdf',fileSegments:2,locator:{page:2},message:'Reading PDF pages',startedAt:Date.now()-62000},counts:{files:3,segments:7},runtime:{ready:true}}}}); document.getElementById('fileIndex').click();`);
			await sleep(80);
			assert.equal((await calls("files.index")).length, 1);
			assert.equal(await js(`return document.getElementById('fileStop').hidden;`), false);
			assert.equal(await js(`return document.getElementById('fileProgress').value;`), 3);
			assert.match(await js(`return document.getElementById('fileStatus').textContent;`), /Reading PDF pages.*3 of 8 files/);
			assert.match(await js(`return document.getElementById('fileActivity').textContent;`), /budget\.pdf.*Page 2.*2 passages.*1:02 elapsed/);
			await js(`__fixture.configure({'files.status':{result:{state:'idle',busy:false,counts:{files:0,segments:0},runtime:{ready:false}}}}); document.getElementById('fileStop').click();`);
			await sleep(80);
			assert.equal((await calls("files.cancel")).length, 1);
			await js(`__fixture.configure({'files.setup':{result:{started:false,reason:'Python was not found'}}}); document.getElementById('fileSetup').click();`);
			await sleep(80);
			assert.equal((await calls("settings.set")).at(-1).args[0].embedding.enabled, true);
			assert.match(await js(`return document.getElementById('fileStatus').textContent;`), /Python was not found/);
			await sleep(1600);
			assert.match(await js(`return document.getElementById('fileStatus').textContent;`), /Python was not found/, "polling must not erase an action failure");
		}],
		["file search explains setup and folder requirements and displays download progress", async () => {
			await js(`__fixture.configure({'sources.list':{result:[]},'files.status':{result:{state:'idle',busy:false,enabled:true,counts:{files:0,segments:0},runtime:{available:false}}}}); await setState('search');`);
			await sleep(80);
			assert.match(await js(`return document.getElementById('fileStatus').textContent;`), /Install local search/);
			assert.equal(await js(`return document.getElementById('fileIndex').disabled;`), true);
			assert.match(await js(`return document.getElementById('fileResults').textContent;`), /Choose folders to search/);
			await js(`__fixture.configure({'files.status':{result:{state:'setting-up',busy:true,operation:'setup',phase:'downloading',progress:{message:'Downloading EmbeddingGemma 2',bytesDone:250000000,bytesTotal:1500000000,startedAt:Date.now()-30000},counts:{files:0,segments:0},runtime:{available:false}}}}); fileSearch.focus();`);
			await sleep(80);
			assert.match(await js(`return document.getElementById('fileStatus').textContent;`), /Downloading EmbeddingGemma 2.*250\.0 \/ 1500\.0 MB/);
			assert.equal(await js(`return document.getElementById('fileProgress').value;`), 250000000);
			await js(`__fixture.configure({'files.status':{result:{state:'ready',busy:false,enabled:true,counts:{files:0,segments:0},runtime:{available:true}}}}); fileSearch.focus();`);
			await sleep(80);
			assert.match(await js(`return document.getElementById('fileStatus').textContent;`), /Local model installed.*Choose folders/);
			await js(`__fixture.configure({'sources.list':{result:[{id:'root',path:'C:\\\\Selected'}]}}); fileSearch.focus();`);
			await sleep(80);
			assert.match(await js(`return document.getElementById('fileStatus').textContent;`), /Click Index selected folders/);
			assert.equal(await js(`return document.getElementById('fileIndex').disabled;`), false);
			await js(`__fixture.configure({'files.status':{result:{state:'error',busy:false,error:'One file could not be indexed',warnings:['budget.pdf: Could not read the PDF'],counts:{files:0,segments:0},runtime:{available:true}}}}); fileSearch.focus();`);
			await sleep(80);
			assert.match(await js(`return document.getElementById('fileActivity').textContent;`), /budget\.pdf: Could not read the PDF/);
		}],
		["ready refreshes model availability", async () => {
			await js(`signedIn = false; engine = 'starting'; __fixture.variant('done');`);
			await sleep(100);
			assert.equal(await js("return signedIn;"), true);
			assert.notEqual(await js("return document.getElementById('chipModel').textContent;"), "no model");
		}],
		["old snapshot replies cannot undo newer updates", async () => {
			await js(`const old = structuredClone(snap); old.seq = 2; __fixture.configure({'query.snapshot': {result: old, delay: 200}}); resnapshot(); resnapshot(); for(let seq=2;seq<=5;seq++) applyUpdate({kind:'update',seq,type:'mission.titled',missionId:'m1',mission:{...snap.missions.m1,title:'New title'}});`);
			await sleep(300);
			assert.deepEqual(await js("return {seq:snap.seq,title:snap.missions.m1.title};"), { seq: 5, title: "New title" });
			assert.equal((await calls("query.snapshot")).length, 2); // initial load + one coalesced request
		}],
		["update gaps retain events arriving after the snapshot was captured", async () => {
			await js(`const s = structuredClone(snap); s.seq=3; __fixture.configure({'query.snapshot':{result:s,delay:100}}); applyUpdate({seq:3,type:'mission.titled',missionId:'m1',mission:{...s.missions.m1,title:'At snapshot'}}); applyUpdate({seq:4,type:'mission.titled',missionId:'m1',mission:{...s.missions.m1,title:'After snapshot'}});`);
			await sleep(200);
			assert.deepEqual(await js("return {seq:snap.seq,title:snap.missions.m1.title};"), { seq: 4, title: "After snapshot" });
		}],
		["dashboard renders atomically during update bursts", async () => {
			await js(`await setState('stack'); __fixture.configure({'watches.list':{delay:100}}); for(let i=0;i<4;i++) applyUpdate({seq:snap.seq+1,type:'budget.updated',missionId:'m1',mission:{...snap.missions.m1}});`);
			await sleep(200);
			assert.equal(await js("return document.querySelectorAll('#stack h6').length;"), 4);
			assert.equal(await js("return document.querySelectorAll('#stack .card').length;"), 5);
		}],
		["question input and unchanged activity retain their DOM state", async () => {
			await js(`__fixture.variant('question'); await setState('mission');`);
			await sleep(450);
			assert.equal(await js(`const input=document.querySelector('#qOpts textarea'); input.value='Final workbook'; input.focus(); const row=document.querySelector('#feed .fl'); applyUpdate({seq:snap.seq+1,type:'budget.updated',missionId:'m1',mission:{...snap.missions.m1}}); return input===document.querySelector('#qOpts textarea') && input.value==='Final workbook' && document.activeElement===input && row===document.querySelector('#feed .fl');`), true);
		}],
		["quick navigation ignores old size and focus callbacks", async () => {
			await js(`__fixture.configure({'ui.size':{delay:200}}); setState('mission'); setState('idle');`);
			await sleep(1000);
			assert.deepEqual(await js("return {state:cur,rendered:cap.dataset.s};"), { state: "idle", rendered: "idle" });
			await js(`__fixture.configure({'ui.size':{delay:0}}); await setState('chat'); await setState('stack');`);
			await sleep(500);
			assert.notEqual(await js("return document.activeElement.id;"), "box");
			assert.equal(await js("return [...document.querySelectorAll('.lay')].filter(l=>!l.classList.contains('l-stack')).every(l=>l.inert && l.getAttribute('aria-hidden')==='true');"), true);
		}],
		["approval acknowledgments require an open card and retry after failure", async () => {
			await js(`__fixture.variant('approval');`);
			await sleep(100);
			assert.equal((await calls("approvals.displayed")).length, 0);
			await js(`__fixture.configure({'approvals.displayed':{queue:[{error:'Temporary failure'},{result:{ok:true}}]},'approvals.decide':{result:{ok:false,error:'Approval expired'}}}); await setState('mission');`);
			await sleep(450);
			if (!(await calls("approvals.displayed")).length) await js("await ensureDisplayed(visibleApproval).catch(showErr);");
			assert.equal((await calls("approvals.decide")).length, 0);
			assert.match(await js("return document.getElementById('errorText').textContent;"), /Temporary failure/);
			await js("document.getElementById('askYes').click();");
			await sleep(100);
			assert.equal((await calls("approvals.displayed")).length, 2);
			assert.match(await js("return document.getElementById('errorText').textContent;"), /Approval expired/);
			assert.equal(await js("return document.getElementById('uiError').hidden;"), false);
		}],
		["late evidence stays attached to its mission", async () => {
			await js(`__fixture.variant('done'); await setState('read'); __fixture.configure({'query.mission':{queue:[{delay:200,result:{evidence:[{kind:'web',source:'https://old.test',capturedAt:new Date().toISOString(),excerpt:'OLD'}]}},{delay:10,result:{evidence:[{kind:'web',source:'https://new.test',capturedAt:new Date().toISOString(),excerpt:'NEW'}]}}]}}); toggleEvidence(); openMission('m2'); await setState('read'); toggleEvidence();`);
			await sleep(300);
			const text = await js("return document.getElementById('evidence').textContent;");
			assert.match(text, /NEW/);
			assert.doesNotMatch(text, /OLD/);
			await js(`await setState('mission'); await setState('read');`);
			assert.equal(await js("return readEvidence || !document.getElementById('evidence').hidden;"), false);
			await js("await toggleEvidence();");
			assert.equal(await js("return document.getElementById('evidence').hidden;"), false);
		}],
		["failed follow-up preserves text and displays the error", async () => {
			await js(`__fixture.variant('done'); await setState('mission'); __fixture.configure({'missions.followUp':{error:'Engine stopped'}}); const r=document.getElementById('reply'); r.value='Unsent follow-up'; r.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
			await sleep(100);
			assert.equal(await js("return document.getElementById('reply').value;"), "Unsent follow-up");
			assert.equal(await js("return document.getElementById('uiError').hidden;"), false);
		}],
		["copy uses the displayed stream and ignores stale runs", async () => {
			await js(`snap.missions.m1.runId='new'; snap.missions.m1.answer='Previous answer'; await setState('mission'); onLive({missionId:'m1',runId:'new',type:'assistant_start'}); onLive({missionId:'m1',runId:'new',type:'text',delta:'New response'}); onLive({missionId:'m1',runId:'old',type:'text',delta:'Stale response'}); document.dispatchEvent(new KeyboardEvent('keydown',{key:'c',ctrlKey:true,shiftKey:true,bubbles:true}));`);
			await sleep(60);
			assert.equal((await calls("clipboard.write")).at(-1).args[0], "New response");
			assert.equal(await js("return document.getElementById('ans').textContent;"), "New response");
		}],
		["different missions start reading at the top", async () => {
			const answer = JSON.stringify(Array.from({ length: 80 }, (_, i) => `Paragraph ${i} with more content`).join("\n\n"));
			await js(`__fixture.variant('done'); snap.missions.m1.answer=${answer}; snap.missions.m2.answer=${answer}; await setState('mission'); renderMission();`);
			await sleep(150);
			await js(`document.getElementById('ans').scrollTop=600; openMission('m2');`);
			await sleep(100);
			assert.equal(await js("return document.getElementById('ans').scrollTop;"), 0);
		}],
		["rule and watch selections match their submitted values", async () => {
			await js("openSettings();");
			await sleep(200);
			await js(`document.querySelector('#sec-rules [aria-label=Action]').click(); [...document.querySelectorAll('.dd-i')].find(b=>b.textContent==='Save files').click(); document.querySelector('#sec-rules [aria-label=Expires] button').click();`);
			assert.match(await js("return document.querySelector('#sec-rules [aria-label=Action]').textContent;"), /Save files/);
			assert.equal(await js("return document.querySelector('#sec-rules [aria-label=Expires] button').getAttribute('aria-checked');"), "true");
			await js(`document.querySelector('#sec-watches [aria-label="Watch name"]').value='Test'; document.querySelector('#sec-watches [aria-label="What to watch"]').value='https://example.invalid'; document.querySelector('#sec-watches [aria-label="How often"] button').click(); document.querySelectorAll('#sec-watches [aria-label="On change"] button')[1].click();`);
			assert.equal(await js("return document.querySelector('#sec-watches [aria-label=\"How often\"] [aria-checked=true]').textContent;"), "30m");
			assert.equal(await js("return document.querySelector('#sec-watches [aria-label=\"On change\"] [aria-checked=true]').textContent;"), "Prepare an update");
			await js(`document.querySelector('#sec-rules [aria-label=Action]').click(); __fixture.emit({kind:'auth-event',event:{type:'info',message:'Background update'}}); document.querySelector('#sec-rules [aria-label=Action]').click();`);
			assert.equal(await js("return document.querySelectorAll('.dd-menu').length;"), 1);
		}],
		["an approval takes keyboard focus on its card, keeps Tab inside it, and never starts on Approve", async () => {
			await js(`__fixture.variant('approval'); await setState('mission');`);
			await sleep(400);
			assert.equal(await js(`return document.activeElement?.id;`), "fAsk", "focus moves to the approval card itself");
			win.webContents.debugger.attach("1.3");
			try {
				const seen = new Set();
				for (let i = 0; i < 12; i++) {
					await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
					await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
					const at = await js(`const a=document.activeElement; return {inside: document.getElementById('fAsk').contains(a), id: a.id || a.tagName};`);
					assert.ok(at.inside, `Tab ${i + 1} stays in the approval card (${at.id})`);
					seen.add(at.id);
				}
				assert.ok(seen.has("askYes") && seen.has("askNo"), "both decisions are reachable by keyboard");
				await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 });
				assert.ok(await js(`return document.getElementById('fAsk').contains(document.activeElement);`), "Shift+Tab wraps inside too");
			} finally { win.webContents.debugger.detach(); }
			await js(`await setState('chat');`);
			await sleep(100);
			assert.equal(await js(`return focusTrap.active === undefined;`), true, "leaving the mission releases focus");
		}],
		["dropped and pasted files become removable chips and are sent with the task", async () => {
			await js(`await setState('chat'); document.getElementById('box').value='';`);
			await js(`const dt=new DataTransfer(); dt.items.add(new File(['hello'],'notes.txt',{type:'text/plain'})); window.dispatchEvent(new DragEvent('dragenter',{dataTransfer:dt})); window.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,cancelable:true}));`);
			await sleep(100);
			assert.equal(await js(`return [...document.querySelectorAll('#attachList .attach-chip .attach-name')].map(n=>n.textContent).join();`), "notes.txt");
			assert.equal(await js(`return cap.dataset.drop === undefined;`), true, "the drop highlight clears");
			await js(`const dt=new DataTransfer(); dt.items.add(new File([new Uint8Array([137,80,78,71])],'image.png',{type:'image/png'})); __fixture.configure({'attachments.fromFiles':{result:[]}}); document.getElementById('box').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,cancelable:true}));`);
			await sleep(100);
			assert.equal((await calls("attachments.paste")).length, 1, "a pasted picture without a file path is read from the clipboard by the shell");
			assert.equal(await js(`return document.querySelectorAll('#attachList .attach-chip').length;`), 2);
			await js(`document.querySelector('#attachList .attach-remove').click();`);
			await sleep(50);
			assert.deepEqual((await calls("attachments.remove")).map((c) => c.args[0]), ["att_1"]);
			await js(`document.getElementById('box').value=''; document.getElementById('sendTask').click();`);
			await sleep(150);
			const create = (await calls("missions.create")).at(-1).args[0];
			assert.deepEqual(create.attachments, ["att_2"], "only the remaining attachment is sent");
			assert.ok(create.text.length > 0, "a task with only attachments still has a request");
		}],
		["approvals show a file write's diff and the fields a submit would send", async () => {
			await js(`__fixture.variant('approval-diff'); await setState('mission');`);
			await sleep(300);
			const diff = await js(`const p=document.getElementById('askPreview'); return {open:document.getElementById('askPreviewBox').open, add:[...p.querySelectorAll('.diff-add')].map(s=>s.textContent.trim()), del:[...p.querySelectorAll('.diff-del')].map(s=>s.textContent.trim()), sends:document.getElementById('askSends').hidden};`);
			assert.deepEqual(diff, { open: true, add: ["+Ship on Friday"], del: ["-Ship on Thursday"], sends: true });
			await js(`__fixture.variant('approval-submit'); await setState('mission');`);
			await sleep(300);
			const sends = await js(`const s=document.getElementById('askSends'); return {hidden:s.hidden, title:s.querySelector('h6').textContent, rows:[...s.querySelectorAll('dt')].map((d)=>d.textContent+'='+d.nextElementSibling.textContent), extra:s.querySelector('.hint')?.textContent};`);
			assert.equal(sends.hidden, false);
			assert.match(sends.title, /shop\.example · POST/);
			assert.deepEqual(sends.rows, ["Email=you@example.test", "Password=••••••••", "Quantity=2"]);
			assert.match(sends.extra, /3 hidden fields/);
		}],
		["small-screen plans scroll without hiding the header or footer", async () => {
			await js(`document.documentElement.style.setProperty('--h-mission','390px'); __fixture.variant('approval'); await setState('mission');`);
			await sleep(500);
			assert.equal(await js(`const c=cap.getBoundingClientRect(), h=document.querySelector('#l-mission>.mh').getBoundingClientRect(); return h.top>=c.top && h.bottom<c.bottom && cap.scrollTop===0 && document.getElementById('missionBody').scrollHeight>document.getElementById('missionBody').clientHeight;`), true);
		}],
		["small-screen and large-text launchers keep apps, recent work and modes reachable", async () => {
			const area = { x: 0, y: 0, width: 800, height: 600 };
			await js(`__fixture.emit({kind:'shell',type:'apps',apps:Array.from({length:12},(_,i)=>({id:'app'+i,name:'Saved website '+i,pinned:true}))}); __fixture.configure({'clipboard.read':{result:'https://example.com'}}); await checkClipboard();`);
			for (const zoom of [.9, 1, 1.15, 1.3, 1.45, 1.6]) {
				const bounds = windowBounds("chat", area, zoom), dims = windowDims(area, zoom);
				win.webContents.setZoomFactor(zoom);
				win.setContentSize(bounds.width, bounds.height);
				await js(`__fixture.configure({'ui.dims':{result:${JSON.stringify(dims)}}}); await applyDims(); await setState('chat');`);
				await sleep(400);
				const layout = await js(`const c=cap.getBoundingClientRect(), inside=(r,b)=>r.left>=b.left-1 && r.top>=b.top-1 && r.right<=b.right+1 && r.bottom<=b.bottom+1; const viewport={left:0,top:0,right:innerWidth,bottom:innerHeight}; return {shell:inside(c,viewport),controls:['box','sendTask','windowMin','windowClose'].every(id=>inside(document.getElementById(id).getBoundingClientRect(),c)),overflow:document.querySelector('.start-body').scrollWidth<=document.querySelector('.start-body').clientWidth+1};`);
				assert.deepEqual(layout, { shell: true, controls: true, overflow: true }, `${zoom}× text size fits the small work area`);
				for (const selector of ['#addWebsite','#openApps','.continue-mission:last-child','.launcher-app-pin:last-child']) {
					assert.ok(await js(`const el=document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest',inline:'nearest'}); const r=el.getBoundingClientRect(),b=document.querySelector('.start-body').getBoundingClientRect(); return r.top>=b.top-1 && r.bottom<=b.bottom+1 && r.left>=b.left && r.right<=b.right;`), `${selector} is reachable at ${zoom}×`);
				}
				assert.ok(await js(`const b=document.querySelector('.ask-bar').getBoundingClientRect(); return [...document.querySelectorAll('.ask-meta button')].filter(el=>el.offsetParent).every(el=>{const r=el.getBoundingClientRect();return r.top>=b.top && r.bottom<=b.bottom && r.left>=b.left && r.right<=b.right;});`), `mode and task controls fit at ${zoom}×`);
			}
		}],
		["small-screen file search keeps the shared input, filters and file actions reachable", async () => {
			const area = { x: 0, y: 0, width: 800, height: 600 };
			for (const zoom of [.9, 1, 1.15, 1.3, 1.45, 1.6]) {
				const bounds = windowBounds('search', area, zoom), dims = windowDims(area, zoom);
				win.webContents.setZoomFactor(zoom);
				win.setContentSize(bounds.width, bounds.height);
				await js(`__fixture.configure({'ui.dims':{result:${JSON.stringify(dims)}}}); await applyDims(); await setState('search'); document.getElementById('box').value='budget'; document.getElementById('box').dispatchEvent(new Event('input',{bubbles:true}));`);
				await sleep(400);
				assert.ok(await js(`const c=cap.getBoundingClientRect(); return ['box','homeAsk','homeFiles'].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.top>=c.top && r.bottom<=c.bottom && r.left>=c.left && r.right<=c.right;});`), `shared input fits at ${zoom}×`);
				for (const selector of ['#fileKind','#manageSearch','.file-result:last-child','#filePreview .file-actions']) {
					assert.ok(await js(`const el=document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest',inline:'nearest'}); const r=el.getBoundingClientRect(),c=cap.getBoundingClientRect(),h=document.querySelector('.ask-bar').getBoundingClientRect();return r.top>=h.bottom-1 && r.bottom<=c.bottom-1 && r.left>=c.left && r.right<=c.right;`), `${selector} is reachable at ${zoom}×`);
				}
				assert.ok(await js(`const el=document.getElementById('homeSearch'); return el.scrollWidth<=el.clientWidth+1;`), `search has no horizontal overflow at ${zoom}×`);
			}
		}],
		["Command shortcuts open reading view", async () => {
			await js(`await setState('mission'); document.dispatchEvent(new KeyboardEvent('keydown',{key:'e',metaKey:true,bubbles:true}));`);
			await sleep(50);
			assert.equal(await js("return cur;"), "read");
		}],
		["local audio preview seeks to the matching moment inside its sandbox", async () => {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "midnight-preview-test-"));
			const before = new Set(BrowserWindow.getAllWindows().map((window) => window.id));
			let preview;
			try {
				// One second of silent 16-bit mono PCM exercises Chromium's actual media decoder.
				const rate = 8000, samples = rate * 2;
				const wav = Buffer.alloc(44 + samples);
				wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples, 4); wav.write("WAVE", 8);
				wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
				wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
				wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
				wav.write("data", 36); wav.writeUInt32LE(samples, 40);
				const file = path.join(directory, "matching moment.wav");
				fs.writeFileSync(file, wav);
				assert.deepEqual(await previewFile({ path: file, kind: "audio", locator: { seconds: .25 }, show: false }), { ok: true });
				preview = BrowserWindow.getAllWindows().find((window) => !before.has(window.id));
				assert.ok(preview, "preview created its own window");
				assert.equal(preview.isVisible(), false);
				const preferences = preview.webContents.getLastWebPreferences();
				assert.equal(preferences.sandbox, true);
				assert.equal(preferences.nodeIntegration, false);
				assert.equal(preferences.contextIsolation, true);
				assert.ok(!preferences.preload, "preview has no bridge to host capabilities");
				let media;
				const deadline = Date.now() + 4000;
				do {
					media = await preview.webContents.executeJavaScript(`(() => { const audio=document.querySelector('audio'); return {ready:audio?.readyState ?? 0,time:audio?.currentTime ?? 0,duration:audio?.duration ?? 0,error:document.getElementById('error').textContent,require:typeof window.require,process:typeof window.process}; })()`);
					if (media.ready >= 1 && Math.abs(media.time - .25) < .01) break;
					await sleep(50);
				} while (Date.now() < deadline);
				assert.equal(media.error, "");
				assert.ok(media.ready >= 1 && Math.abs(media.duration - 1) < .01 && Math.abs(media.time - .25) < .01, `matching time loads and seeks: ${JSON.stringify(media)}`);
				assert.equal(media.require, "undefined");
				assert.equal(media.process, "undefined");
				const address = preview.webContents.getURL();
				let attempted = false;
				preview.webContents.once("will-navigate", () => { attempted = true; });
				await preview.webContents.executeJavaScript("location.href='https://example.invalid/preview-navigation';");
				for (let index = 0; index < 10 && !attempted; index++) await sleep(20);
				assert.ok(attempted, "navigation guard received the attempted navigation");
				assert.equal(preview.webContents.getURL(), address);
				assert.ok(!win.isDestroyed(), "launcher fixture stays open");
			} finally {
				if (preview && !preview.isDestroyed()) preview.destroy();
				const file = path.join(directory, "matching moment.wav");
				if (fs.existsSync(file)) fs.unlinkSync(file);
				fs.rmdirSync(directory);
			}
		}],
	];
	let failures = 0;
	for (const [name, run] of tests) {
		await reset();
		try { await run(); assert.deepEqual(errors, []); console.log(`[ui] PASS ${name}`); }
		catch (err) { failures++; console.log(`[ui] FAIL ${name}: ${err.stack}`); }
	}
	win.destroy();
	console.log(`[ui] ${tests.length - failures}/${tests.length} passed`);
	app.exit(failures ? 1 : 0);
}).catch((err) => { console.error(err); app.exit(1); });
