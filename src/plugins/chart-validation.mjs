// Host-owned checks. Candidate code cannot edit this policy. SVG is a passive artifact with explicit scale
// metadata: every indexed bar is checked against its actual geometry as well as the supplied source values.
export const CHART_VALIDATION_VERSION = "chart-svg-1.1";
const esc = value => String(value).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export function validateChartInput(input) {
	if (!input || typeof input.title !== "string" || input.title.length > 200 || !Array.isArray(input.categories) || !input.categories.length || input.categories.length > 40 || input.categories.some(c => typeof c !== "string" || c.length > 160) || !Array.isArray(input.series) || !input.series.length || input.series.length > 5 || input.series.some(s => typeof s.name !== "string" || s.name.length > 120 || !Array.isArray(s.values) || s.values.length !== input.categories.length || s.values.some(v => !Number.isFinite(v) || Math.abs(v) > 1e12))) throw new Error("The chart input is outside its bounded schema.");
	if ((input.unit !== undefined && (typeof input.unit !== "string" || input.unit.length > 30)) || (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 200))) throw new Error("The chart annotation exceeds its input schema.");
}
const attributes = {
	svg: new Set("xmlns viewBox width height font-family role aria-label data-domain-min data-domain-max data-plot-top data-plot-bottom".split(" ")),
	rect: new Set("class x y width height rx fill data-series data-category data-value data-si data-ci".split(" ")),
	line: new Set("x1 x2 y1 y2 stroke stroke-width".split(" ")),
	text: new Set("class x y font-size font-weight fill text-anchor transform".split(" ")), title: new Set(),
};
export function validateChartSvg(svg, input) {
	const issues = [], nodes = [], stack = [];
	try { validateChartInput(input); } catch (err) { return { ok: false, issues: [err.message], facts: {} }; }
	if (typeof svg !== "string" || Buffer.byteLength(svg, "utf8") > 1024 * 1024 || !svg.trim().startsWith("<svg")) return { ok: false, issues: ["The renderer must return bounded passive SVG."], facts: {} };
	const tokens = svg.match(/<[^>]*>|[^<]+/g) ?? [];
	for (const token of tokens) {
		if (!token.startsWith("<")) { if (!stack.length && token.trim()) issues.push("Text outside the SVG."); if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(token)) issues.push("Unsupported XML entity."); continue; }
		const tag = /^<(\/?)([a-z]+)([\s\S]*?)(\/?)>$/.exec(token);
		if (!tag || !attributes[tag[2]]) { issues.push("Unsupported SVG element or declaration."); continue; }
		const [, closing, name, rest, selfClosing] = tag;
		if (closing) { if (rest.trim() || selfClosing || stack.pop() !== name) issues.push("Malformed SVG nesting."); continue; }
		if ((name === "svg" && (nodes.length || stack.length)) || (!stack.length && name !== "svg")) issues.push("The artifact must have one SVG root.");
		const attrs = {}; let offset = 0;
		const pattern = /\s+([a-zA-Z][\w-]*)="([^"<>]*)"/gy;
		while (offset < rest.length) {
			if (!rest.slice(offset).trim()) break;
			pattern.lastIndex = offset; const attr = pattern.exec(rest);
			if (!attr) { issues.push("Malformed SVG attributes."); break; }
			offset = pattern.lastIndex;
			if (!attributes[name].has(attr[1]) || Object.hasOwn(attrs, attr[1]) || /&(?!amp;|lt;|gt;|quot;|apos;)/.test(attr[2])) issues.push("Unsupported or duplicate SVG attribute.");
			attrs[attr[1]] = attr[2];
		}
		for (const key of ["fill", "stroke"]) if (attrs[key] && !/^#[a-fA-F0-9]{6}$/.test(attrs[key])) issues.push("Only fixed hexadecimal chart colors are supported.");
		if (attrs.transform && !/^rotate\(-?\d+(?:\.\d+)?(?: -?\d+(?:\.\d+)?){0,2}\)$/.test(attrs.transform)) issues.push("Unsupported label transform.");
		if (attrs["font-family"] && !/^[a-zA-Z ,.-]{1,100}$/.test(attrs["font-family"])) issues.push("Unsupported font family.");
		nodes.push({ name, attrs }); if (!selfClosing) stack.push(name);
	}
	if (stack.length) issues.push("Unclosed SVG elements.");
	const root = nodes[0]?.attrs ?? {}, width = Number(root.width), height = Number(root.height);
	if (root.xmlns !== "http://www.w3.org/2000/svg" || width < 320 || width > 2400 || height < 200 || height > 1600 || root.viewBox !== `0 0 ${width} ${height}`) issues.push("Invalid chart canvas.");
	const lo = Number(root["data-domain-min"]), hi = Number(root["data-domain-max"]), top = Number(root["data-plot-top"]), bottom = Number(root["data-plot-bottom"]);
	const values = input.series.flatMap(s => s.values);
	if (![lo, hi, top, bottom].every(Number.isFinite) || lo > Math.min(0, ...values) || hi < Math.max(0, ...values) || lo >= hi || top < 40 || bottom > height - 30 || top >= bottom) issues.push("The declared chart scale cannot represent its dataset.");
	const y = value => top + (hi - value) / (hi - lo) * (bottom - top);
	const bars = nodes.filter(n => n.name === "rect" && n.attrs.class === "bar"), used = new Set();
	if (bars.length !== input.categories.length * input.series.length) issues.push("The chart must contain exactly one bar for every series/category index.");
	for (const { attrs: a } of bars) {
		const si = Number(a["data-si"]), ci = Number(a["data-ci"]), key = `${si}:${ci}`, series = input.series[si], category = input.categories[ci];
		if (!Number.isInteger(si) || !Number.isInteger(ci) || !series || category === undefined || used.has(key)) { issues.push("A bar has an invalid or duplicate source index."); continue; }
		used.add(key); const value = series.values[ci];
		if (a["data-series"] !== esc(series.name) || a["data-category"] !== esc(category) || Number(a["data-value"]) !== value) issues.push("A bar changed its source label or value.");
		const x = Number(a.x), by = Number(a.y), bw = Number(a.width), bh = Number(a.height);
		if (![x, by, bw, bh].every(Number.isFinite) || x < 0 || x + bw > width || bw <= 0 || bh < 0 || Math.abs(by - y(Math.max(0, value))) > .15 || Math.abs(bh - Math.abs(y(value) - y(0))) > .15) issues.push("A bar's drawn geometry does not match its source value and scale.");
	}
	for (const category of input.categories) if (!svg.includes(`>${esc(category)}</text>`)) issues.push(`Missing category label ${category}`);
	const totals = Object.fromEntries(input.series.map(s => [s.name, Math.round(s.values.reduce((a, b) => a + b, 0) * 1e6) / 1e6]));
	return { ok: issues.length === 0, issues: [...new Set(issues)], facts: { bars: bars.length, totals, validationVersion: CHART_VALIDATION_VERSION } };
}
