// PowerPoint (.pptx) writer and validator for slide_create: title slide, then slides with a title, bullets (one
// level of sub-bullets), an optional native table and speaker notes as plain text in the slide. No macros, no
// external links, no embedded objects: a deck midnight writes contains only what the mission put in it.
import { readZip, writeZip, xmlUnescape } from "./zip.mjs";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const EMU = 12700; // per point
const W = 12192000; // 16:9, 13.333 in
const H = 6858000; // 7.5 in
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const ACCENT = "6B52D6";
const INK = "2A2150";
const MUTED = "6F6890";

const run = (text, { size, bold, color } = {}) => `<a:r><a:rPr lang="en-US"${size ? ` sz="${size * 100}"` : ""}${bold ? ' b="1"' : ""} dirty="0">${color ? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` : ""}</a:rPr><a:t>${esc(text)}</a:t></a:r>`;
const para = (text, o = {}, { level = 0, bullet = false, align } = {}) => `<a:p><a:pPr lvl="${level}"${align ? ` algn="${align}"` : ""}${bullet ? ` marL="${342900 + level * 342900}" indent="-285750"` : ' marL="0" indent="0"'}>${bullet ? `<a:buFont typeface="Arial"/><a:buChar char="${level ? "–" : "•"}"/>` : "<a:buNone/>"}</a:pPr>${run(text, o)}</a:p>`;
const box = (id, name, [x, y, w, h], body, { anchor = "t" } = {}) =>
	`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`;
const bar = (id, [x, y, w, h], color) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Accent"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;

function table(id, rows, [x, y, w, h]) {
	const cols = Math.max(...rows.map((r) => r.length));
	const colW = Math.floor(w / cols);
	const rowH = Math.min(Math.floor(h / rows.length), 457200);
	const cell = (text, header) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${run(text, { size: rows.length > 8 ? 11 : 14, bold: header, color: header ? "FFFFFF" : INK })}</a:p></a:txBody><a:tcPr marL="91440" marR="91440" marT="45720" marB="45720">${header ? `<a:solidFill><a:srgbClr val="${ACCENT}"/></a:solidFill>` : `<a:solidFill><a:srgbClr val="F4F2FB"/></a:solidFill>`}</a:tcPr></a:tc>`;
	return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${colW * cols}" cy="${rowH * rows.length}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${Array.from({ length: cols }, () => `<a:gridCol w="${colW}"/>`).join("")}</a:tblGrid>${rows.map((r, ri) => `<a:tr h="${rowH}">${Array.from({ length: cols }, (_, ci) => cell(r[ci] ?? "", ri === 0)).join("")}</a:tr>`).join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

const slideXml = (shapes) => `${XML}<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
const M = 685800; // 0.75 in margin

function titleSlide(deck) {
	return slideXml([
		bar(2, [0, 0, W, 91440], ACCENT),
		box(3, "Title", [M, 2286000, W - 2 * M, 1143000], para(deck.title, { size: 40, bold: true, color: INK }), { anchor: "b" }),
		box(4, "Subtitle", [M, 3520440, W - 2 * M, 914400], [deck.subtitle, deck.footer].filter(Boolean).map((t, i) => para(t, { size: i ? 12 : 20, color: MUTED })).join("") || para("", {})),
	]);
}

function contentSlide(s, index, total, footer) {
	const shapes = [bar(2, [M, 548640, 731520, 54864], ACCENT), box(3, "Title", [M, 640080, W - 2 * M, 685800], para(s.title, { size: 28, bold: true, color: INK }), { anchor: "t" })];
	const top = 1508760;
	const bottom = H - 640080;
	const bullets = (s.bullets ?? []).map((b) => (typeof b === "string" ? { text: b, level: 0 } : { text: b.text, level: Math.min(1, b.level ?? 0) }));
	const hasTable = Array.isArray(s.table) && s.table.length;
	const textH = hasTable ? (bullets.length ? Math.floor((bottom - top) * 0.4) : 0) : bottom - top;
	if (bullets.length) shapes.push(box(4, "Content", [M, top, W - 2 * M, textH], bullets.map((b) => para(b.text, { size: b.level ? 16 : 20, color: b.level ? MUTED : INK }, { level: b.level, bullet: true })).join("")));
	if (hasTable) shapes.push(table(5, s.table.map((r) => r.map(String)), [M, top + textH + (bullets.length ? 182880 : 0), W - 2 * M, bottom - top - textH]));
	if (s.notes) shapes.push(box(6, "Notes", [M, bottom, W - 2 * M - 1371600, 365760], para(s.notes, { size: 10, color: MUTED })));
	shapes.push(box(7, "Footer", [W - M - 1371600, bottom + 91440, 1371600, 274320], para(`${footer ? `${footer} · ` : ""}${index + 1}/${total}`, { size: 10, color: MUTED }, { align: "r" })));
	return slideXml(shapes);
}

const THEME = `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="midnight"><a:themeElements><a:clrScheme name="midnight"><a:dk1><a:srgbClr val="1D1B24"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="${INK}"/></a:dk2><a:lt2><a:srgbClr val="F4F2FB"/></a:lt2><a:accent1><a:srgbClr val="${ACCENT}"/></a:accent1><a:accent2><a:srgbClr val="2B8A5A"/></a:accent2><a:accent3><a:srgbClr val="C47A12"/></a:accent3><a:accent4><a:srgbClr val="2B5AA8"/></a:accent4><a:accent5><a:srgbClr val="B3261E"/></a:accent5><a:accent6><a:srgbClr val="6F6890"/></a:accent6><a:hlink><a:srgbClr val="2B5AA8"/></a:hlink><a:folHlink><a:srgbClr val="6B52D6"/></a:folHlink></a:clrScheme><a:fontScheme name="midnight"><a:majorFont><a:latin typeface="Segoe UI Semibold"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Segoe UI"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="midnight"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
const EMPTY_TREE = '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>';
const MASTER = `${XML}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
const LAYOUT = `${XML}<p:sldLayout ${NS} type="blank" preserve="1">${EMPTY_TREE.replace("<p:cSld>", '<p:cSld name="Blank">')}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

/**
 * @param {{ title: string, subtitle?: string, footer?: string, slides: Array<{ title: string, bullets?: Array<string | { text: string, level?: number }>, table?: string[][], notes?: string }> }} deck
 */
export function writePptx(deck) {
	const slides = [titleSlide(deck), ...deck.slides.map((s, i) => contentSlide(s, i, deck.slides.length, deck.footer))];
	const files = [
		{
			name: "[Content_Types].xml",
			data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`,
		},
		{ name: "_rels/.rels", data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
		{ name: "docProps/core.xml", data: `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(deck.title)}</dc:title><dc:creator>midnight</dc:creator></cp:coreProperties>` },
		{
			name: "ppt/presentation.xml",
			data: `${XML}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:lvl1pPr><a:defRPr lang="en-US"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>`,
		},
		{
			name: "ppt/_rels/presentation.xml.rels",
			data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="theme/theme1.xml"/>${slides.map((_, i) => `<Relationship Id="rId${i + 3}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`,
		},
		{ name: "ppt/slideMasters/slideMaster1.xml", data: MASTER },
		{ name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>` },
		{ name: "ppt/slideLayouts/slideLayout1.xml", data: LAYOUT },
		{ name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>` },
		{ name: "ppt/theme/theme1.xml", data: THEME },
		...slides.flatMap((data, i) => [
			{ name: `ppt/slides/slide${i + 1}.xml`, data },
			{ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>` },
		]),
	];
	return writeZip(files);
}

/** Text of each slide, in order (for validation, search and files_read). */
export function readPptxText(buf) {
	const zip = readZip(buf);
	return [...zip.entries.keys()]
		.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
		.sort((a, b) => Number(/slide(\d+)/.exec(a)[1]) - Number(/slide(\d+)/.exec(b)[1]))
		.map((n) => [...zip.text(n).matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => xmlUnescape(m[1])));
}

/** Read the deck back and compare it with what was asked for. */
export function validatePptx(buf, deck) {
	const issues = [];
	let slides;
	try {
		slides = readPptxText(buf);
	} catch (err) {
		return { ok: false, issues: [`does not open: ${err.message}`] };
	}
	if (slides.length !== deck.slides.length + 1) issues.push(`expected ${deck.slides.length + 1} slides, found ${slides.length}`);
	if (slides[0]?.[0] !== deck.title) issues.push("the title slide does not show the title");
	deck.slides.forEach((s, i) => {
		const text = slides[i + 1] ?? [];
		if (text[0] !== s.title) issues.push(`slide ${i + 2} title differs`);
		for (const b of s.bullets ?? []) if (!text.includes(typeof b === "string" ? b : b.text)) issues.push(`slide ${i + 2} is missing a bullet`);
		for (const row of s.table ?? []) for (const c of row) if (String(c) && !text.includes(String(c))) issues.push(`slide ${i + 2} table is missing "${String(c).slice(0, 30)}"`);
	});
	return { ok: issues.length === 0, issues: [...new Set(issues)], facts: { slides: slides.length } };
}
