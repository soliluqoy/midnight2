// The host accepts a color map, never candidate CSS/HTML. These checks do not assert full UI accessibility.
export const THEME_VALIDATION_VERSION = "ui-colors-1.0";
export const THEME_KEYS = Object.freeze(["accent", "accent-hover", "accent-soft", "accent-line", "highlight", "on-accent"]);
export const THEME_FIXTURES = Object.freeze([{ contrast: "normal", textSize: 1 }, { contrast: "high", textSize: 1 }, { contrast: "normal", textSize: 0.5 }, { contrast: "normal", textSize: 2 }]);
export function validateThemeInput(input) {
	if (!input || Object.keys(input).some(key => !["contrast", "textSize"].includes(key)) || !["normal", "high"].includes(input.contrast) || !Number.isFinite(input.textSize) || input.textSize < 0.5 || input.textSize > 2) throw new Error("The color-theme input is outside its bounded schema.");
}
const luminance = color => {
	const rgb = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
	return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
};
export function colorContrast(a, b) { const left = luminance(a), right = luminance(b); return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05); }
export function validateThemeOutput(output, input = THEME_FIXTURES[0]) {
	try {
		validateThemeInput(input);
		if (typeof output !== "string" || output.length > 2048) throw new Error("Return a bounded JSON color map.");
		const tokens = JSON.parse(output);
		if (!tokens || Array.isArray(tokens) || Object.keys(tokens).length !== THEME_KEYS.length || Object.entries(tokens).some(([key, value]) => !THEME_KEYS.includes(key) || typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value))) throw new Error("Use only the six declared hexadecimal color tokens.");
		const pairs = [["on-accent", "accent"], ["on-accent", "accent-hover"], ["highlight", "accent-soft"]];
		const ratios = pairs.map(([foreground, background]) => ({ foreground, background, ratio: colorContrast(tokens[foreground], tokens[background]) }));
		for (const background of ["#202027", "#292932", "#1d1d24"]) ratios.push({ foreground: "highlight", background, ratio: colorContrast(tokens.highlight, background) });
		for (const foreground of ["#f1f0f5", "#bbb8c8"]) ratios.push({ foreground, background: "accent-soft", ratio: colorContrast(foreground, tokens["accent-soft"]) });
		if (ratios.some(pair => pair.ratio < 4.5)) throw new Error("The proposed colors make a tested text/control pair hard to read.");
		return { ok: true, tokens: Object.fromEntries(THEME_KEYS.map(key => [key, tokens[key]])), ratios, issues: [] };
	} catch (error) { return { ok: false, issues: [error.message] }; }
}

