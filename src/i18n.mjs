// Languages for midnight's interface. Catalogs in src/locales/<code>.json map English text to the translation;
// English needs no catalog. The setting "" follows the system's preferred languages.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const LANGUAGES = [
	{ code: "en", name: "English" },
	{ code: "id", name: "Bahasa Indonesia" },
];
const catalogs = new Map();

export function catalog(code) {
	if (code === "en") return {};
	if (!catalogs.has(code)) {
		try {
			catalogs.set(code, JSON.parse(fs.readFileSync(fileURLToPath(new URL(`./locales/${code}.json`, import.meta.url)), "utf8")));
		} catch {
			catalogs.set(code, {});
		}
	}
	return catalogs.get(code);
}

/** The interface language: the setting when supported, else the first supported system language, else English. */
export function resolveLanguage(setting, preferred = []) {
	const supported = new Set(LANGUAGES.map((l) => l.code));
	for (const tag of [setting, ...preferred]) {
		const base = String(tag ?? "").toLowerCase().split(/[-_]/)[0];
		if (supported.has(base)) return base;
	}
	return "en";
}

export function translator(code) {
	const table = catalog(code);
	return (text, vars) => (table[text] ?? text).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
}
