import { render as barChartSvg } from "../plugins/builtin/chart/renderer.js";
import { validateChartSvg } from "../plugins/chart-validation.mjs";
// Work tools for verified artifacts (plan ch. 11, 15; T02/T03): read spreadsheet ranges with cell-level evidence,
// calculate deterministically with a recorded formula, and produce charts and reports that are validated by
// parsing them back before they count.
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { fileHash } from "../evidence/store.mjs";
import { parseCsv, parseNumber, toCsv } from "./documents/csv.mjs";
import { validateDocx, writeDocx } from "./documents/docx.mjs";
import { colLetters, readXlsx, sheetRange } from "./documents/xlsx.mjs";
import { assertInside } from "./files.mjs";
import { validatePptx, writePptx } from "./documents/pptx.mjs";

// ---------------- safe arithmetic ----------------
const FUNCS = {
	sum: (...a) => a.reduce((x, y) => x + y, 0),
	avg: (...a) => a.reduce((x, y) => x + y, 0) / a.length,
	min: Math.min,
	max: Math.max,
	abs: Math.abs,
	round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d,
};

/** Evaluate + - * / ^ ( ) with named inputs and a few functions. No property access, no code. */
export function evaluate(expr, inputs = {}) {
	const tokens = String(expr).match(/\d+(?:\.\d+)?(?:e[-+]?\d+)?|[A-Za-z_][\w]*|[-+*/^(),]|\S/gi) ?? [];
	let i = 0;
	const peek = () => tokens[i];
	const take = (t) => {
		if (t && tokens[i] !== t) throw new Error(`expected ${t} near "${tokens.slice(i, i + 3).join(" ")}"`);
		return tokens[i++];
	};
	const primary = () => {
		const t = take();
		if (t === undefined) throw new Error("unexpected end of formula");
		if (t === "(") {
			const v = expr0();
			take(")");
			return v;
		}
		if (t === "-") return -primary();
		if (t === "+") return primary();
		if (/^\d/.test(t)) return Number(t);
		if (/^[A-Za-z_]/.test(t)) {
			if (peek() === "(") {
				const f = FUNCS[t.toLowerCase()];
				if (!f) throw new Error(`unknown function ${t}`);
				take("(");
				const args = [];
				if (peek() !== ")") {
					args.push(expr0());
					while (peek() === ",") {
						take(",");
						args.push(expr0());
					}
				}
				take(")");
				return f(...args);
			}
			if (!Object.hasOwn(inputs, t)) throw new Error(`unknown input ${t}`);
			const v = Number(inputs[t]);
			if (!Number.isFinite(v)) throw new Error(`input ${t} is not a number`);
			return v;
		}
		throw new Error(`unexpected "${t}"`);
	};
	const power = () => {
		const b = primary();
		if (peek() === "^") {
			take("^");
			return b ** power();
		}
		return b;
	};
	const term = () => {
		let v = power();
		while (peek() === "*" || peek() === "/") {
			const op = take();
			const r = power();
			if (op === "/" && r === 0) throw new Error("division by zero");
			v = op === "*" ? v * r : v / r;
		}
		return v;
	};
	const expr0 = () => {
		let v = term();
		while (peek() === "+" || peek() === "-") v = take() === "+" ? v + term() : v - term();
		return v;
	};
	const v = expr0();
	if (i < tokens.length) throw new Error(`unexpected "${tokens[i]}"`);
	return Math.round(v * 1e10) / 1e10;
}

export { render as barChartSvg } from "../plugins/builtin/chart/renderer.js";
export { validateChartSvg } from "../plugins/chart-validation.mjs";

// ---------------- tools ----------------
export function workTools({ roots, evidence, commit, repo, plugins, pluginRuntime }) {
	const sheetRead = {
		name: "sheet_read",
		label: "Read spreadsheet",
		description:
			"Read a range from an .xlsx or .csv file in a selected folder. Returns values with cell references, marks hidden rows and formulas (the workbook's cached result is shown; Midnight does not recompute formulas). Records evidence for each read.",
		parameters: Type.Object({
			path: Type.String(),
			sheet: Type.Optional(Type.String()),
			range: Type.Optional(Type.String({ description: "e.g. A1:D20; default the used range (first 200 rows)" })),
		}),
		classify: (a) => ({ effect: "read.local", paths: [a.path], target: `${path.basename(a.path)}${a.sheet ? ` › ${a.sheet}` : ""}${a.range ? `!${a.range}` : ""}`, canonical: { path: path.resolve(a.path), sheet: a.sheet ?? "", range: a.range ?? "" }, feed: `sheet › ${path.basename(a.path)}${a.range ? ` ${a.range}` : ""}` }),
		async execute(a, ctx) {
			const { real } = assertInside(roots.list(), a.path, "file");
			const st = fs.statSync(real);
			if (st.size > 50 * 1024 * 1024) throw new Error("spreadsheet is larger than 50 MB");
			const buf = fs.readFileSync(real);
			const hash = fileHash(buf);
			let sheetName;
			let rows;
			let range;
			const notes = [];
			if (/\.(csv|tsv|txt)$/i.test(real)) {
				const data = parseCsv(buf.toString("utf8"));
				sheetName = path.basename(real);
				rows = data.slice(0, 200).map((r, ri) => ({ row: ri + 1, hidden: false, cells: r.map((v, ci) => ({ ref: `${colLetters(ci + 1)}${ri + 1}`, v })) }));
				range = `A1:${colLetters(Math.max(1, ...data.map((r) => r.length)))}${Math.min(200, data.length)}`;
			} else {
				const book = readXlsx(buf);
				if (book.macros) notes.push("The workbook contains macros; they were not run.");
				const sheet = a.sheet ? book.sheets.find((s) => s.name.toLowerCase() === a.sheet.toLowerCase()) : book.sheets.find((s) => !s.hidden) ?? book.sheets[0];
				if (!sheet) throw new Error(`no sheet ${a.sheet}; sheets: ${book.sheets.map((s) => s.name).join(", ")}`);
				sheetName = sheet.name;
				const r = sheetRange(sheet, a.range ?? (sheet.maxRow > 200 ? `A1:${colLetters(sheet.maxCol)}200` : undefined));
				rows = r.rows;
				range = r.range;
				if (book.sheets.length > 1) notes.push(`Other sheets: ${book.sheets.filter((s) => s !== sheet).map((s) => `${s.name}${s.hidden ? " (hidden)" : ""}`).join(", ")}.`);
			}
			const formulas = [];
			const lines = rows.map((r) => {
				const cells = r.cells.map((c) => {
					if (c.f) formulas.push(`${c.ref}: =${c.f} (cached ${c.v ?? "none"})`);
					const v = c.v === undefined ? "" : typeof c.v === "object" ? `#${c.v.error}` : String(c.v);
					return `${c.ref}=${v}`;
				});
				return `${r.hidden ? "[hidden row] " : ""}${cells.filter((x) => !x.endsWith("=")).join(" | ")}`;
			});
			const hidden = rows.filter((r) => r.hidden).length;
			if (hidden) notes.push(`${hidden} hidden row${hidden > 1 ? "s" : ""} in range; check whether they belong in totals.`);
			if (formulas.length) notes.push(`Formulas (cached values; unsupported recalculation): ${formulas.slice(0, 20).join("; ")}`);
			const units = rows[0]?.cells.map((c) => String(c.v ?? "")).filter((h) => /\((k|m|\$|%|usd|eur|000s?)\)|thousand|million/i.test(h));
			if (units?.length) notes.push(`Units in headers: ${units.join(", ")}.`);
			const evId = commit(() => evidence.record(ctx.missionId, { kind: "sheet", source: real, sourceVersion: hash, hash, locator: { sheet: sheetName, range }, excerpt: lines.slice(0, 15).join("\n") }));
			return {
				content: [{ type: "text", text: `${path.basename(real)} › ${sheetName}!${range} (evidence ${evId}, file ${hash.slice(0, 19)}…)\n${lines.join("\n")}${notes.length ? `\n\nNotes: ${notes.join(" ")}` : ""}` }],
				details: { evidenceId: evId, sheet: sheetName, range },
			};
		},
	};

	const calculate = {
		name: "calculate",
		label: "Calculate",
		description:
			"Compute a number deterministically and record it as evidence with its inputs and formula, e.g. inputs {q2: 1287, q3: 1421}, formula \"(q3 - q2) / q2 * 100\". Use for totals, differences and percentages; never do arithmetic in your head.",
		parameters: Type.Object({
			label: Type.String({ description: "what this number is, e.g. Total Q3 revenue (k$)" }),
			inputs: Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()])),
			formula: Type.String({ description: "+ - * / ^ ( ) and sum avg min max round abs; names are input keys" }),
			sources: Type.Optional(Type.Array(Type.String(), { description: "evidence ids the inputs came from" })),
		}),
		classify: (a) => ({ effect: "compute", target: a.label, canonical: a, feed: `calculate › ${a.label}`, icon: "∑" }),
		async execute(a, ctx) {
			const inputs = {};
			for (const [k, v] of Object.entries(a.inputs)) {
				const n = parseNumber(v);
				if (!n) throw new Error(`input ${k} (${v}) is not a number`);
				inputs[k] = n.value;
			}
			const result = evaluate(a.formula, inputs);
			const id = commit(() => evidence.record(ctx.missionId, { kind: "calculation", source: a.label, derived: { inputs, formula: a.formula, result, sources: a.sources ?? [] }, excerpt: `${a.label} = ${a.formula} = ${result}` }));
			return { content: [{ type: "text", text: `${a.label} = ${result}  (formula ${a.formula} with ${Object.entries(inputs).map(([k, v]) => `${k}=${v}`).join(", ")}; evidence ${id})` }], details: { result, evidenceId: id } };
		},
	};

	const chart = {
		name: "chart_create",
		label: "Create chart",
		description: "Create a bar chart (SVG) and its dataset (CSV) as validated drafts in the mission workspace. Values must come from sheet_read/calculate evidence.",
		parameters: Type.Object({
			title: Type.String(),
			categories: Type.Array(Type.String(), { minItems: 1, maxItems: 40 }),
			series: Type.Array(Type.Object({ name: Type.String(), values: Type.Array(Type.Number()) }), { minItems: 1, maxItems: 5 }),
			unit: Type.Optional(Type.String({ description: "suffix such as k or %" })),
			filename: Type.Optional(Type.String()),
			sources: Type.Optional(Type.Array(Type.String())),
		}),
		classify: (a, { mission }) => {
			const pin = mission.scope?.pluginBindings?.bindings?.["chart.bar"] ?? plugins?.base;
			if (pin) plugins.get(pin.digest);
			return { effect: "artifact.stage", target: a.title, canonical: pin ? { args: a, renderer: pin, generation: mission.scope?.pluginBindings?.generation ?? 0 } : a, toolVersion: pin?.digest ?? "1", feed: `chart › ${a.title}` };
		},
		async execute(a, ctx) {
			for (const s of a.series) if (s.values.length !== a.categories.length) throw new Error(`series ${s.name} has ${s.values.length} values for ${a.categories.length} categories`);
			const name = a.filename ?? `${a.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "chart"}.svg`;
			const pin = repo?.get(ctx.missionId)?.scope.pluginBindings?.bindings?.["chart.bar"] ?? plugins?.base;
			const rendered = pluginRuntime && pin ? await pluginRuntime.render(pin, { title: a.title, categories: a.categories, series: a.series, unit: a.unit ?? "", note: "midnight" }, { signal: ctx.signal }) : undefined;
			const svg = rendered?.svg ?? barChartSvg({ ...a, note: "midnight" });
			const validation = rendered?.validation ?? validateChartSvg(svg, a);
			if (!validation.ok) throw new Error(`Chart failed host validation: ${validation.issues.join("; ")}`);
			const dataset = toCsv([["category", ...a.series.map((s) => s.name)], ...a.categories.map((c, i) => [c, ...a.series.map((s) => s.values[i])])]);
			const { art, data } = commit(() => {
				const d = evidence.stage(ctx.missionId, ctx.runId, { name: name.replace(/\.svg$/i, ".csv"), type: "dataset", data: dataset, sources: a.sources ?? [], validation: { ok: true, issues: [], facts: { rows: a.categories.length } } });
				const c = evidence.stage(ctx.missionId, ctx.runId, { name: name.endsWith(".svg") ? name : `${name}.svg`, type: "chart", data: svg, toolVersion: pin?.digest ?? "1", sources: [...(a.sources ?? []), d.id], validation: { ...validation, facts: { ...validation.facts, datasetHash: d.hash } } });
				return { art: c, data: d };
			});
			return {
				content: [{ type: "text", text: `Chart ${art.name} r${art.revision} (${art.id}) ${validation.ok ? "validated" : `FAILED validation: ${validation.issues.join("; ")}`}; totals ${JSON.stringify(validation.facts.totals)}. Dataset ${data.name} (${data.id}).` }],
				details: { artifactId: art.id, datasetId: data.id },
			};
		},
	};

	const report = {
		name: "report_create",
		label: "Create report",
		description: "Write a report as a validated Word document (or Markdown) in the mission workspace: title, sections with text, bullets and tables. Reference charts by name.",
		parameters: Type.Object({
			title: Type.String(),
			subtitle: Type.Optional(Type.String()),
			sections: Type.Array(
				Type.Object({
					heading: Type.String(),
					text: Type.Optional(Type.String()),
					bullets: Type.Optional(Type.Array(Type.String())),
					table: Type.Optional(Type.Array(Type.Array(Type.String()), { description: "first row is the header" })),
				}),
				{ minItems: 1, maxItems: 30 },
			),
			format: Type.Optional(Type.Union([Type.Literal("docx"), Type.Literal("md")])),
			filename: Type.Optional(Type.String()),
			sources: Type.Optional(Type.Array(Type.String())),
		}),
		classify: (a) => ({ effect: "artifact.stage", target: a.title, canonical: a, feed: `report › ${a.title}` }),
		async execute(a, ctx) {
			const blocks = a.sections.flatMap((s) => [{ type: "heading", level: 1, text: s.heading }, ...(s.text ? s.text.split(/\n{2,}/).map((t) => ({ type: "p", text: t })) : []), ...(s.bullets?.length ? [{ type: "bullets", items: s.bullets }] : []), ...(s.table?.length ? [{ type: "table", rows: s.table }] : [])]);
			const fmtName = a.format ?? "docx";
			const base = a.filename ?? `${a.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "report"}.${fmtName}`;
			let data;
			let validation;
			if (fmtName === "docx") {
				const doc = { title: a.title, subtitle: a.subtitle, footer: `Prepared by midnight · ${new Date().toISOString().slice(0, 10)}`, blocks };
				data = writeDocx(doc);
				validation = validateDocx(data, doc);
			} else {
				data = `# ${a.title}\n\n${a.subtitle ? `_${a.subtitle}_\n\n` : ""}${a.sections.map((s) => `## ${s.heading}\n\n${s.text ?? ""}${s.bullets ? `\n${s.bullets.map((b) => `- ${b}`).join("\n")}` : ""}${s.table ? `\n\n${s.table.map((r, i) => `| ${r.join(" | ")} |${i === 0 ? `\n|${r.map(() => "---").join("|")}|` : ""}`).join("\n")}` : ""}`).join("\n\n")}\n`;
				const heads = (data.match(/^## /gm) ?? []).length;
				validation = { ok: heads === a.sections.length, issues: heads === a.sections.length ? [] : ["section count differs"], facts: { headings: heads } };
			}
			const art = commit(() => evidence.stage(ctx.missionId, ctx.runId, { name: base, type: "report", data, sources: a.sources ?? [], validation }));
			return { content: [{ type: "text", text: `Report ${art.name} r${art.revision} (${art.id}) ${validation.ok ? "validated" : `FAILED validation: ${validation.issues.join("; ")}`}.` }], details: { artifactId: art.id } };
		},
	};

	const slides = {
		name: "slide_create",
		label: "Create slides",
		description: "Write a PowerPoint deck (.pptx, 16:9) in the mission workspace: a title slide, then slides with a title, bullets (level 0 or 1), an optional table (first row is the header) and short speaker notes. Keep about 3–6 bullets per slide. The deck is read back and validated; publish it with file_publish.",
		parameters: Type.Object({
			title: Type.String({ minLength: 1, maxLength: 200 }),
			subtitle: Type.Optional(Type.String({ maxLength: 300 })),
			slides: Type.Array(
				Type.Object({
					title: Type.String({ minLength: 1, maxLength: 200 }),
					bullets: Type.Optional(Type.Array(Type.Union([Type.String({ maxLength: 400 }), Type.Object({ text: Type.String({ maxLength: 400 }), level: Type.Optional(Type.Integer({ minimum: 0, maximum: 1 })) })]), { maxItems: 12 })),
					table: Type.Optional(Type.Array(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 8 }), { maxItems: 15 })),
					notes: Type.Optional(Type.String({ maxLength: 1000 })),
				}),
				{ minItems: 1, maxItems: 40 },
			),
			filename: Type.Optional(Type.String()),
			sources: Type.Optional(Type.Array(Type.String())),
		}),
		classify: (a) => ({ effect: "artifact.stage", target: a.title, canonical: a, feed: `slides › ${a.title} (${a.slides.length})` }),
		async execute(a, ctx) {
			const deck = { title: a.title, subtitle: a.subtitle, footer: `midnight · ${new Date().toISOString().slice(0, 10)}`, slides: a.slides };
			const data = writePptx(deck);
			const validation = validatePptx(data, deck);
			const base = (a.filename ?? `${a.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "slides"}`).replace(/\.pptx$/i, "");
			const art = commit(() => evidence.stage(ctx.missionId, ctx.runId, { name: `${base}.pptx`, type: "slides", data, sources: a.sources ?? [], validation }));
			return { content: [{ type: "text", text: `Slides ${art.name} r${art.revision} (${art.id}), ${a.slides.length + 1} slides, ${validation.ok ? "validated" : `FAILED validation: ${validation.issues.join("; ")}`}.` }], details: { artifactId: art.id } };
		},
	};

	return { all: [sheetRead, calculate, chart, report, slides] };
}
