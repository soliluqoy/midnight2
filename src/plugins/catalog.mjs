// Host-reviewed contribution contracts. A manifest selects an existing contract; it cannot create authority.
import { CHART_VALIDATION_VERSION } from "./chart-validation.mjs";
import { THEME_VALIDATION_VERSION } from "./theme-validation.mjs";
export const COMPONENTS = Object.freeze([
	{ id: "midnight.chart", label: "Charts", binding: "chart.bar", directory: "chart", method: "render", previewKind: "chart", validation: CHART_VALIDATION_VERSION, contribution: { point: "chart.render", name: "bar", input: "chart-bar-1", output: "chart-svg-1" }, instructions: "Preserve indexed bar source values, declared scale and passive SVG." },
	{ id: "midnight.theme", label: "Accent colors", binding: "ui.colors", directory: "theme", method: "theme", previewKind: "theme", validation: THEME_VALIDATION_VERSION, contribution: { point: "ui.theme", name: "colors", input: "ui-colors-1", output: "ui-colors-json-1" }, instructions: "Return constant JSON containing exactly the six declared hexadecimal color tokens, unchanged across display preferences. Preserve readability and host contrast checks. No CSS, HTML, layouts, fonts or app behavior can be returned." },
].map(component => Object.freeze({ ...component, contribution: Object.freeze(component.contribution) })));
export function componentFor(id) { const value = COMPONENTS.find(component => component.id === id); if (!value) throw new Error("This Midnight component is not registered for customization."); return value; }

