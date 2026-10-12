// Lists the interface strings that translations must cover: static markup marked with data-i18n*, and literal
// strings passed to t() / i18n.t() in the windows' scripts. `node scripts/i18n-strings.mjs [locale]` prints the
// strings a catalog is missing; the test suite runs the same check for every shipped locale.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const UI = path.join(root, "src", "ui");
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const unescapeJs = (s) => s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");

export function markupStrings() {
	const out = new Set();
	for (const f of fs.readdirSync(UI).filter((x) => x.endsWith(".html"))) {
		const html = fs.readFileSync(path.join(UI, f), "utf8");
		for (const m of html.matchAll(/<[a-z0-9]+\s[^<>]*\bdata-i18n(?=[\s>])[^<>]*>([^<>]+)</g)) out.add(decode(m[1].trim()));
		for (const m of html.matchAll(/<[a-z0-9]+(\s[^<>]*)>/g)) {
			for (const a of ["title", "aria-label", "placeholder"]) {
				if (!new RegExp(`\\sdata-i18n-${a}(?=[\\s/>])`).test(m[1])) continue;
				const v = new RegExp(`\\s${a}="([^"]+)"`).exec(m[1])?.[1];
				if (v) out.add(decode(v));
			}
		}
	}
	return out;
}

export function scriptStrings() {
	const out = new Set();
	for (const f of fs.readdirSync(UI).filter((x) => x.endsWith(".js"))) {
		const js = fs.readFileSync(path.join(UI, f), "utf8");
		// t("…") / i18n.t("…") with a plain string literal, including each branch of a simple a ? "x" : "y" choice
		for (const m of js.matchAll(/\b(?:i18n\.)?t\(((?:[^()"]|"(?:[^"\\]|\\.)*")*?)[,)]/g)) {
			for (const lit of m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
				// Comparison operands (m.status === "succeeded") are values, not text.
				if (/[=!]==?\s*$/.test(m[1].slice(0, lit.index)) || /^\s*[=!]==?/.test(m[1].slice(lit.index + lit[0].length))) continue;
				if (/[A-Za-z]/.test(lit[1])) out.add(unescapeJs(lit[1]));
			}
		}
	}
	return out;
}

export const requiredStrings = () => new Set([...markupStrings(), ...scriptStrings()]);

export function missing(locale) {
	const catalog = JSON.parse(fs.readFileSync(path.join(root, "src", "locales", `${locale}.json`), "utf8"));
	return [...requiredStrings()].filter((s) => !(s in catalog));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const locale = process.argv[2];
	const list = locale ? missing(locale) : [...requiredStrings()];
	process.stdout.write(JSON.stringify(list, null, 1) + "\n");
}
