import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Only the trusted app picker writes this file. Session names never come from a URL or label.
export function websiteUrl(value) {
	const input = String(value ?? "").trim();
	if (!input || input.length > 4000) throw new Error("Enter a website address.");
	const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`);
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an http or https website address without a password.");
	return url.href;
}

export const appPartition = (id) => {
	if (!/^app_[a-f\d-]{36}$/.test(id)) throw new Error("Invalid app profile.");
	return `persist:midnight-app-${id}`;
};

export function createAppRegistry(file) {
	let items = [];
	try {
		const data = JSON.parse(fs.readFileSync(file, "utf8"));
		if (data.version !== 1 || !Array.isArray(data.apps)) throw new Error("Unsupported apps file.");
		items = data.apps.map((item) => {
			appPartition(item.id);
			return { id: item.id, name: String(item.name).slice(0, 80), profile: String(item.profile ?? "").slice(0, 60), url: websiteUrl(item.url), pinned: item.pinned !== false, lastOpenedAt: item.lastOpenedAt ?? null };
		});
		if (new Set(items.map((a) => a.id)).size !== items.length) throw new Error("Duplicate app profiles.");
	} catch (error) {
		if (error.code !== "ENOENT") throw new Error(`Could not read saved apps: ${error.message}`);
	}
	function save(next) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, apps: next }, null, 2));
		fs.renameSync(`${file}.tmp`, file);
		items = next;
	}
	const get = (id) => {
		const item = items.find((a) => a.id === id);
		if (!item) throw new Error("This app is no longer saved.");
		return { ...item };
	};
	return {
		list: () => items.map((a) => ({ ...a })), get,
		add({ url, name, profile }) {
			url = websiteUrl(url);
			const item = { id: `app_${randomUUID()}`, url, name: String(name ?? "").trim().slice(0, 80) || new URL(url).hostname.replace(/^www\./, ""), profile: String(profile ?? "").trim().slice(0, 60), pinned: true, lastOpenedAt: null };
			if (items.length >= 50) throw new Error("You can save up to 50 apps.");
			save([...items, item]);
			return { ...item };
		},
		update(id, patch) {
			const item = get(id);
			if (patch.name !== undefined) {
				if (!String(patch.name).trim()) throw new Error("Give this app a name.");
				item.name = String(patch.name).trim().slice(0, 80);
			}
			if (patch.profile !== undefined) item.profile = String(patch.profile).trim().slice(0, 60);
			if (patch.pinned !== undefined) item.pinned = !!patch.pinned;
			save(items.map((a) => a.id === id ? item : a));
			return { ...item };
		},
		opened(id) {
			get(id);
			save(items.map((a) => a.id === id ? { ...a, lastOpenedAt: new Date().toISOString() } : a));
		},
		remove(id) { get(id); save(items.filter((a) => a.id !== id)); },
	};
}
