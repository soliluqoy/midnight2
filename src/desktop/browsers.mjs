// Per-mission semantic browser (plan ch. 12, B01). Each mission drives its own hidden window, so two missions never
// share page state; windows share the persistent sign-in partition the user set up in midnight's browser. Windows are
// created on first use, capped, and destroyed when a mission ends. Before a click or Enter, `inspect` reports what is
// under the pointer so the host can treat a likely commit (Buy, Send, Submit) as an authorized action.
import { BrowserWindow } from "electron";
import { browserTool } from "../tools/browser.mjs";
import { COMMIT_WORDS } from "../tools/schemas.mjs";

const PARTITION = "persist:midnight-browser";
const MAX_WINDOWS = 3;

export function createBrowsers() {
	const wins = new Map(); // missionId -> { win, tool, used }
	let visible; // the one the user asked to see

	function forMission(missionId) {
		let e = wins.get(missionId);
		if (e && !e.win.isDestroyed()) {
			e.used = Date.now();
			return e;
		}
		if (wins.size >= MAX_WINDOWS) {
			const oldest = [...wins.entries()].sort((a, b) => a[1].used - b[1].used)[0];
			close(oldest[0]);
		}
		const win = new BrowserWindow({
			width: 1280,
			height: 800,
			show: false,
			title: "midnight browser",
			webPreferences: { partition: PARTITION, backgroundThrottling: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
		});
		win.setMenuBarVisibility(false);
		win.webContents.setWindowOpenHandler(({ url }) => {
			if (/^https?:\/\//i.test(url)) win.webContents.loadURL(url);
			return { action: "deny" };
		});
		win.webContents.on("will-navigate", (ev, url) => {
			if (!/^(https?:|about:blank)/i.test(url)) ev.preventDefault(); // no file:, no custom protocols
		});
		win.on("close", (ev) => {
			if (wins.has(missionId) && !win.isDestroyed() && win.isVisible()) {
				ev.preventDefault();
				win.hide();
			}
		});
		win.loadURL("about:blank");
		e = { win, tool: browserTool(() => win.webContents), used: Date.now() };
		wins.set(missionId, e);
		return e;
	}

	function close(missionId) {
		const e = wins.get(missionId);
		wins.delete(missionId);
		if (e && !e.win.isDestroyed()) e.win.destroy();
	}

	return {
		execute(missionId, args, signal) {
			return forMission(missionId).tool.execute(`b-${Date.now()}`, args, signal);
		},
		async inspect(missionId, { action, x, y, key }) {
			const e = wins.get(missionId);
			if (!e || e.win.isDestroyed()) return {};
			const wc = e.win.webContents;
			let origin = "";
			try {
				origin = new URL(wc.getURL()).host;
			} catch {}
			const probe = `(() => {
				const el = ${action === "click" ? `document.elementFromPoint(${Number(x) || 0}, ${Number(y) || 0})` : "document.activeElement"};
				if (!el) return {};
				const btn = el.closest('button, input[type=submit], input[type=button], a, [role=button]') || el;
				const form = el.closest('form');
				const label = (btn.innerText || btn.value || btn.getAttribute('aria-label') || btn.title || '').trim().slice(0, 80);
				const submit = !!(btn.matches && btn.matches('button[type=submit], input[type=submit], form button:not([type])'));
				// What this form would send: visible fields with their label and value (passwords masked).
				const fields = [];
				let hidden = 0;
				if (form) for (const f of form.elements) {
					if (!f.name || f.disabled || ['submit', 'button', 'reset', 'image'].includes(f.type)) continue;
					if (f.type === 'hidden') { hidden++; continue; }
					if ((f.type === 'checkbox' || f.type === 'radio') && !f.checked) continue;
					const named = (f.labels && f.labels[0] && f.labels[0].innerText) || f.getAttribute('aria-label') || f.placeholder || f.name;
					const value = f.type === 'password' ? (f.value ? '•'.repeat(8) : '') : f.type === 'file' ? [...(f.files || [])].map((x) => x.name).join(', ') : f.tagName === 'SELECT' ? [...f.selectedOptions].map((o) => o.text).join(', ') : (f.value || '');
					if (fields.length < 25) fields.push({ label: String(named).trim().slice(0, 60), value: String(value).slice(0, 160) });
				}
				let to = '';
				try { to = form ? new URL(form.action || location.href).host + ' · ' + (form.method || 'get').toUpperCase() : ''; } catch {}
				return { label, submit, inForm: !!form, form: form ? (form.getAttribute('aria-label') || form.name || form.action || '').toString().slice(0, 120) : '', fields, hidden, to };
			})()`;
			const r = await wc.executeJavaScript(probe, true).catch(() => ({}));
			const commit = !!(r.submit || COMMIT_WORDS.test(r.label ?? "")) || (action === "key" && /^enter$/i.test(key ?? "") && r.inForm);
			return { ...r, origin, commit };
		},
		close,
		closeAllExcept(keep) {
			for (const id of [...wins.keys()]) if (!keep.has(id)) close(id);
		},
		/** Show the background browser of a mission (or the most recent one) for the user to watch or sign in. */
		peek(missionId) {
			const e = missionId ? wins.get(missionId) : [...wins.values()].sort((a, b) => b.used - a.used)[0];
			const win = e?.win ?? forMission("signin").win;
			if (win.isVisible()) win.hide();
			else win.show();
			visible = win;
			return win.isVisible();
		},
		async clear() {
			const { session } = await import("electron");
			const s = session.fromPartition(PARTITION);
			await s.clearStorageData();
			await s.clearCache();
		},
		dispose() {
			for (const id of [...wins.keys()]) close(id);
			if (visible && !visible.isDestroyed()) visible.destroy();
		},
		count: () => wins.size,
	};
}
