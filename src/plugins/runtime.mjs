import { render as builtinRender } from "./builtin/chart/renderer.js";
import { validateChartInput, validateChartSvg } from "./chart-validation.mjs";
import { render as builtinTheme } from "./builtin/theme/renderer.js";
import { validateThemeInput, validateThemeOutput, THEME_FIXTURES } from "./theme-validation.mjs";
import { componentFor } from "./catalog.mjs";
export { THEME_FIXTURES } from "./theme-validation.mjs";

export const CHART_FIXTURES = [
	{ title: "Quarterly budget", categories: ["North", "South", "West"], series: [{ name: "Budget", values: [120, 90, 60] }], unit: " RM" },
	{ title: "Positive and negative", categories: ["A", "B", "C"], series: [{ name: "Net", values: [-4, 0, 6] }, { name: "Previous", values: [2, -1, 4] }] },
	{ title: "All zero", categories: ["Zero", "Zero"], series: [{ name: "Values", values: [0, 0] }] },
	{ title: "Escaped <title> & unicode", categories: ["Long category label for readability", "Café — 中文"], series: [{ name: "Name & <literal>", values: [1.25, 3.5] }] },
];
export function createPluginRuntime({ store, execute, arbiter }) {
	async function invoke(pin, input, { signal, priority = 0, validateOnly = false } = {}) {
		const artifact = store.get(pin.digest), component = componentFor(artifact.manifest.id), chart = component.method === "render";
		(chart ? validateChartInput : validateThemeInput)(input);
		if (pin.api !== artifact.pin.api || pin.schema !== artifact.pin.schema || pin.id !== artifact.pin.id || pin.input !== artifact.pin.input || pin.output !== artifact.pin.output || store.isQuarantined(pin.digest)) throw new Error("The pinned plugin contract is unavailable or quarantined.");
		const operation = async (admittedSignal = signal) => {
			const output = pin.digest === store.bases[component.binding].digest ? (chart ? builtinRender : builtinTheme)(input) : await execute({ source: artifact.source, input, digest: pin.digest }, { signal: admittedSignal });
			const report = (chart ? validateChartSvg : validateThemeOutput)(output, input);
			if (!report.ok) throw new Error(`Plugin output failed host validation: ${report.issues.slice(0, 3).join("; ")}`);
			return { ...(chart ? { svg: output } : { tokens: report.tokens }), validation: report, pin };
		};
		try { return await (arbiter ? arbiter.run({ role: validateOnly ? "builder-validation" : `${component.previewKind}-render`, priority, signal, preemptible: priority >= 2 }, operation) : operation()); }
		catch (err) { if (!signal?.aborted && err.name !== "AbortError" && !validateOnly && pin.digest !== store.bases[component.binding].digest) store.quarantine(pin, err.message); throw err; }
	}
	return {
		render: async (pin, input, options) => { if (pin.output !== "chart-svg-1") throw new Error("This pin is not a chart renderer."); return invoke(pin, input, options); },
		theme: async (pin, input, options) => { if (pin.output !== "ui-colors-json-1") throw new Error("This pin is not a color-theme contribution."); return invoke(pin, input, options); },
		themePreset(pin) {
			const artifact = store.get(pin.digest);
			if (pin.id !== artifact.pin.id || pin.output !== "ui-colors-json-1" || Object.keys(artifact.pin).some(key => artifact.pin[key] !== pin[key]) || store.isQuarantined(pin.digest)) throw new Error("The exact color preset is unavailable.");
			const tokens = pin.digest === store.bases["ui.colors"].digest ? JSON.parse(builtinTheme({})) : store.qualification(pin).tokens;
			const checked = validateThemeOutput(JSON.stringify(tokens)); if (!checked.ok) { store.quarantine(pin, "Stored color preset failed host validation"); throw new Error("The color preset failed host validation."); }
			return { pin, tokens: checked.tokens };
		},
		async validate(pin, options = {}) {
			const component = componentFor(store.get(pin.digest).manifest.id), results = [], fixtures = component.method === "render" ? CHART_FIXTURES : THEME_FIXTURES;
			for (const input of fixtures) { const result = await invoke(pin, input, { ...options, priority: 4, validateOnly: true }); results.push(result.validation); }
			if (component.method === "theme" && results.some(result => JSON.stringify(result.tokens) !== JSON.stringify(results[0].tokens))) throw new Error("A color preset must remain constant across display preferences.");
			const report = { digest: pin.digest, version: component.validation, ok: true, checked: results.length, results, ...(component.method === "theme" ? { tokens: results[0].tokens } : {}), at: new Date().toISOString() };
			store.qualify(pin, report); return report;
		},
	};
}
