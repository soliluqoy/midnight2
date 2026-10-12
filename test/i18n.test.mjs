import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { catalog, LANGUAGES, resolveLanguage, translator } from "../src/i18n.mjs";
import { missing, requiredStrings } from "../scripts/i18n-strings.mjs";

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("every shipped language covers the interface strings and keeps their placeholders", () => {
	const required = requiredStrings();
	assert.ok(required.size > 150, "markup and t() strings are found");
	for (const { code } of LANGUAGES.filter((l) => l.code !== "en")) {
		assert.deepEqual(missing(code), [], `${code} is missing translations (node scripts/i18n-strings.mjs ${code})`);
		for (const [en, translated] of Object.entries(catalog(code))) {
			assert.equal(typeof translated, "string");
			assert.ok(translated.trim(), `${code}: empty translation for "${en}"`);
			assert.deepEqual(placeholders(translated), placeholders(en), `${code}: placeholders differ for "${en}"`);
		}
	}
});

test("language follows the setting, then the system's preferred languages, then English", () => {
	assert.equal(resolveLanguage("id", ["en-US"]), "id");
	assert.equal(resolveLanguage("", ["id-ID", "en-US"]), "id");
	assert.equal(resolveLanguage("", ["fr-FR", "en-GB"]), "en");
	assert.equal(resolveLanguage("", ["fr-FR"]), "en");
	assert.equal(resolveLanguage("xx", []), "en");
	const t = translator("id");
	assert.equal(t("Approve"), "Setujui");
	assert.equal(t("Page {n}", { n: 3 }), "Halaman 3");
	assert.equal(t("Something new and untranslated"), "Something new and untranslated", "untranslated text stays English");
	assert.equal(translator("en")("Page {n}", { n: 3 }), "Page 3");
});

test("both windows load the translation script before their own scripts", () => {
	for (const f of ["index.html", "apps.html"]) {
		const html = fs.readFileSync(new URL(`../src/ui/${f}`, import.meta.url), "utf8");
		const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
		assert.equal(scripts[0], "i18n.js", f);
	}
});
