// Pure plugin entry. It receives bounded chart data and returns SVG; the host stages and validates the result.
export function render({ title, categories, series, unit = "", note = "" }) {
	const palette = ["#8068e8", "#ff9fc7", "#5fb39a", "#e0a23d", "#5c9fd9"];
	const esc = value => String(value).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	const fmt = value => Math.abs(value) >= 1000 ? value.toLocaleString("en-US", { maximumFractionDigits: 1 }) : String(Math.round(value * 100) / 100);
	const L = 64, R = 24, T = 64, B = 72, W = Math.max(760, L + R + categories.length * series.length * 8), H = 420;
	const max = Math.max(0, ...series.flatMap(s => s.values)), min = Math.min(0, ...series.flatMap(s => s.values));
	const span = max - min || 1, step = 10 ** Math.floor(Math.log10(span / 4 || 1));
	const tick = [1, 2, 2.5, 5, 10].map(m => m * step).find(t => span / t <= 6) ?? step * 10;
	const top = Math.ceil(max / tick) * tick || tick, bottom = Math.floor(min / tick) * tick;
	const y = v => T + ((top - v) / (top - bottom)) * (H - T - B);
	const groupW = (W - L - R) / categories.length, barW = Math.min(36, groupW * 0.7 / series.length);
	const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Segoe UI, sans-serif" role="img" aria-label="${esc(title)}" data-domain-min="${bottom}" data-domain-max="${top}" data-plot-top="${T}" data-plot-bottom="${H - B}">`];
	parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`, `<text x="${L}" y="34" font-size="18" font-weight="600" fill="#1f1a3a">${esc(title)}</text>`);
	for (let v = bottom; v <= top + 1e-9; v += tick) parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#e6e2f3"/>`, `<text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="#6f6890">${fmt(v)}${unit}</text>`);
	categories.forEach((category, ci) => {
		const gx = L + ci * groupW + (groupW - barW * series.length) / 2;
		series.forEach((s, si) => {
			const value = s.values[ci], y0 = y(Math.max(0, value)), height = Math.abs(y(value) - y(0));
			parts.push(`<rect class="bar" x="${(gx + si * barW).toFixed(1)}" y="${y0.toFixed(1)}" width="${(barW - 3).toFixed(1)}" height="${height.toFixed(1)}" rx="3" fill="${palette[si % palette.length]}" data-series="${esc(s.name)}" data-category="${esc(category)}" data-value="${value}" data-si="${si}" data-ci="${ci}"><title>${esc(`${s.name} · ${category}: ${fmt(value)}${unit}`)}</title></rect>`);
		});
		parts.push(`<text class="cat" x="${(L + ci * groupW + groupW / 2).toFixed(1)}" y="${H - B + 20}" font-size="12" text-anchor="middle" fill="#2a2150">${esc(category)}</text>`);
	});
	series.forEach((s, si) => parts.push(`<rect x="${L + si * 140}" y="${H - 30}" width="12" height="12" rx="2" fill="${palette[si % palette.length]}"/><text class="legend" x="${L + si * 140 + 18}" y="${H - 20}" font-size="12" fill="#2a2150">${esc(s.name)}</text>`));
	if (note) parts.push(`<text x="${W - R}" y="${H - 20}" font-size="10" text-anchor="end" fill="#8b86aa">${esc(note)}</text>`);
	parts.push("</svg>"); return parts.join("\n");
}
