// The shell's side of the host boundary: a fixed table of operations the agent host may ask for. Nothing here decides
// authority (the host's broker did); desktop input is additionally refused unless it carries the live lease epoch.
import fs from "node:fs";
import path from "node:path";
import { safeStorage, shell } from "electron";
import { COMPUTER_OBSERVE } from "../tools/schemas.mjs";
import { computerTool, inspectComputer } from "../tools/computer.mjs";
import { userBrowserTool } from "../tools/userbrowser.mjs";

/**
 * @param {{ web: object, browsers: object, lease: object, onAct: Function, allowedOpen: (p: string) => boolean, overlay: (m) => void }} d
 */
export function createPlatform(d) {
	const { web, browsers, lease } = d;
	const userBrowser = userBrowserTool(web);
	const computerState = {
		lastScale: 1,
		onAct: d.onAct,
		authorize(p) {
			if (process.platform !== "win32") return "Desktop control is only available on Windows for now.";
			if (COMPUTER_OBSERVE.has(p.action)) return undefined;
			if (!lease.valid(p.missionId, p.epoch)) return "Midnight does not hold the screen (the user took over or the lease expired). Nothing was typed or clicked.";
			return undefined;
		},
	};
	const computer = computerTool(computerState);
	async function inspectClip({ data, mimeType }, { signal } = {}) {
		if (!(data instanceof Uint8Array) || data.length > 8 * 1024 * 1024 || !["video/webm", "video/mp4"].includes(mimeType)) throw new Error("Invalid bounded native-video inspection.");
		signal?.throwIfAborted();
		const clip = await d.mediaDecoder.fromBytes(data, "video", mimeType, { timeout: 15_000 });
		try { signal?.throwIfAborted(); return clip.info; } finally { await clip.close(); }
	}
	const toolByName = (name) => web.tools.find((t) => t.name === name);

	// Media decoding sessions for local search (the host asks; the shell reads the file and decodes it). Sessions the
	// engine forgets (a crash, a cancel) close after ten idle minutes.
	const media = new Map(); // id -> { session, used }
	let mediaSeq = 0;
	const mediaSession = (id) => {
		const e = media.get(id);
		if (!e) throw new Error("This media session is closed.");
		e.used = Date.now();
		return e.session;
	};
	const sweep = setInterval(() => {
		for (const [id, e] of media) if (Date.now() - e.used > 10 * 60_000) (media.delete(id), e.session.close());
	}, 60_000);
	sweep.unref?.();
	const mediaOps = d.mediaDecoder
		? {
				"media.inspectClip": inspectClip,
				"media.open": async (a, c) => {
					if (!["image", "pdf", "audio", "video"].includes(a.kind)) throw new Error("Unsupported media kind");
					const p = path.resolve(String(a.path ?? ""));
					const session = await d.mediaDecoder.session(p, a.kind, { signal: c.signal });
					const id = `ms${++mediaSeq}`;
					media.set(id, { session, used: Date.now() });
					return { id, info: session.info };
				},
				"media.frame": (a) => mediaSession(a.id).frame({ page: a.page, seconds: a.seconds, max: Math.min(2400, Math.max(64, Number(a.max) || 1600)), format: a.format === "jpeg" ? "jpeg" : "rgb" }),
				"media.text": (a) => mediaSession(a.id).text({ page: a.page }),
				// OCR of a decoded page or frame (scanned PDFs, video stills), through Windows' built-in engine.
				"media.ocr": async (a) => {
					if (!d.ocr?.available()) return { text: "", unavailable: true };
					const frame = await mediaSession(a.id).frame({ page: a.page, seconds: a.seconds, max: 2400, format: "jpeg" });
					return d.ocr.image(frame.jpeg);
				},
				"media.audio": (a) => mediaSession(a.id).audio({ start: Number(a.start) || 0, seconds: Math.min(120, Math.max(0.1, Number(a.seconds) || 30)) }),
				"media.close": async (a) => {
					const e = media.get(a.id);
					media.delete(a.id);
					await e?.session.close();
					return {};
				},
			}
		: {};

	const ops = {
		...mediaOps,
		"plugin.execute": (a, c) => d.pluginExecutor.execute(a, c),
		"builder.run": (a, c) => d.builderRunner.run(a, c),
		"word.inspect": (a, c) => {
			if (d.appEditAllowed?.() === false) throw Object.assign(new Error("The app session is blocked."), { code: "TARGET_EDIT_DENIED" });
			return d.wordBroker.inspect(a.handle, c);
		},
		"word.receipt": (a, c) => d.wordBroker.receipt(a.editId, c),
		"word.apply": (a, c) => {
			if (d.appEditAllowed?.() === false) throw Object.assign(new Error("The app session is blocked."), { code: "TARGET_EDIT_DENIED" });
			return d.wordBroker.apply(a, c);
		},
		"tool.search": (a, c) => toolByName("search").execute("s", a, c.signal),
		"tool.read_pages": (a, c) => toolByName("read_pages").execute("r", a, c.signal),
		"tool.browser": (a, c) => {
			const { missionId, ...args } = a;
			return browsers.execute(missionId, args, c.signal);
		},
		"tool.user_browser": (a, c) => userBrowser.execute("u", a, c.signal),
		"tool.computer": async (a, c) => {
			const out = await computer.execute("c", a, c.signal);
			if (!COMPUTER_OBSERVE.has(a.action)) lease.heartbeat(a.missionId, a.epoch);
			// screenshots go back as content; drop the duplicate copy in details
			return { content: out.content, details: { action: a.action } };
		},
		"inspect.browser": (a) => browsers.inspect(a.missionId, a),
		"inspect.computer": (a) => inspectComputer(a),
		"lease.acquire": (a) => lease.acquire(a.missionId, { background: !!a.background, title: a.title }),
		"lease.release": (a) => lease.release(a.missionId, a.epoch),
		"lease.revokeAll": () => lease.revokeAll("stop"),
		"fetch.page": async (a, c) => {
			if (!/^https?:\/\//i.test(a.url ?? "")) throw new Error("only http(s) pages");
			const pg = await web.read(a.url, "", c.signal);
			return { title: pg.title, text: pg.text };
		},
		"open.path": async (a) => {
			const p = path.resolve(String(a.path ?? ""));
			if (!d.allowedOpen(p) || !fs.existsSync(p)) throw new Error("Midnight only opens its own drafts and files in your selected folders");
			if (a.reveal) shell.showItemInFolder(p);
			else {
				const err = await shell.openPath(p);
				if (err) throw new Error(err);
			}
			return { ok: true };
		},
		"open.searchResult": async (a) => {
			const p = path.resolve(String(a.path ?? ""));
			if (!d.allowedOpen(p) || !fs.existsSync(p)) throw new Error("This search result is no longer available");
			if (a.reveal) shell.showItemInFolder(p);
			else if (d.previewFile && ["image", "audio", "video", "pdf"].includes(a.kind)) {
				await d.previewFile({ path: p, kind: a.kind, locator: a.locator });
			} else {
				const err = await shell.openPath(p);
				if (err) throw new Error(err);
			}
			return { ok: true };
		},
		"ocr.file": (a) => {
			if (!d.ocr?.available()) throw new Error("Text recognition uses Windows' built-in OCR and is available on Windows only for now.");
			return d.ocr.file(path.resolve(String(a.path ?? "")));
		},
		"vault.encrypt": (a) => (safeStorage.isEncryptionAvailable() ? { available: true, ciphertext: safeStorage.encryptString(String(a.text)).toString("base64") } : { available: false }),
		"vault.decrypt": (a) => (safeStorage.isEncryptionAvailable() ? { available: true, text: safeStorage.decryptString(Buffer.from(String(a.ciphertext), "base64")) } : { available: false }),
	};

	return async (op, args, ctx) => {
		const fn = Object.hasOwn(ops, op) ? ops[op] : undefined;
		if (!fn) throw new Error(`unknown platform operation ${op}`);
		return fn(args, ctx);
	};
}
