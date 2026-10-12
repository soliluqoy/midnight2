// Translations for midnight's windows. English text is the key: `t("Approve")` returns the active language's text,
// or the English when a translation is missing, so untranslated strings stay readable. Placeholders use {name}.
// Static markup opts in with data-i18n (text) and data-i18n-title / -aria-label / -placeholder (attributes).
window.i18n = (() => {
	let table = {};
	let locale = "en";
	const ATTRS = ["title", "aria-label", "placeholder"];
	const format = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);
	const t = (text, vars) => format(typeof text === "string" ? table[text] ?? text : String(text ?? ""), vars);
	function apply(root = document) {
		for (const el of root.querySelectorAll("[data-i18n]")) {
			el.dataset.i18nSource ??= el.textContent.trim();
			const next = t(el.dataset.i18nSource);
			if (el.textContent.trim() !== next) el.textContent = next;
		}
		for (const a of ATTRS) {
			for (const el of root.querySelectorAll(`[data-i18n-${a}]`)) {
				const key = `i18n${a === "aria-label" ? "AriaLabel" : a[0].toUpperCase() + a.slice(1)}Source`;
				el.dataset[key] ??= el.getAttribute(a) ?? "";
				el.setAttribute(a, t(el.dataset[key]));
			}
		}
	}
	async function load(get) {
		try {
			const r = await get();
			locale = r?.locale || "en";
			table = r?.strings && typeof r.strings === "object" ? r.strings : {};
		} catch {
			locale = "en";
			table = {};
		}
		document.documentElement.lang = locale;
		apply();
		return locale;
	}
	return { t, apply, load, get locale() { return locale; } };
})();
window.t = window.i18n.t;
