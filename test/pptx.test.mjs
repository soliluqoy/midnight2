import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readPptxText, validatePptx, writePptx } from "../src/tools/documents/pptx.mjs";
import { readZip } from "../src/tools/documents/zip.mjs";
import { fauxAssistantMessage, fauxText, fauxToolCall, makeModel, settled, startHost } from "./e2e-helpers.mjs";

const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const deck = {
	title: "Q3 sales brief",
	subtitle: "Prepared for Sam",
	footer: "midnight · 2026-10-13",
	slides: [
		{ title: "Revenue rose 10.4%", bullets: ["Q3 revenue $1,421k", { text: "East differs: CRM 398 vs workbook 401", level: 1 }], notes: "Mention the East discrepancy" },
		{ title: "By region", table: [["Region", "Q2", "Q3"], ["North", "412", "486"]] },
		{ title: 'Risks & <next> "steps"', bullets: ["</a:t><script>x</script>"] },
	],
};

test("decks are valid PowerPoint packages that read back exactly, with text escaped and nothing embedded", () => {
	const buf = writePptx(deck);
	const zip = readZip(buf);
	const names = [...zip.entries.keys()];
	for (const part of ["[Content_Types].xml", "ppt/presentation.xml", "ppt/slideMasters/slideMaster1.xml", "ppt/slideLayouts/slideLayout1.xml", "ppt/theme/theme1.xml", "ppt/slides/slide4.xml"]) assert.ok(names.includes(part), part);
	assert.equal(names.some((n) => /vbaProject|oleObject|externalLink|\.bin$/i.test(n)), false, "no macros, embedded objects or external links");
	const slides = readPptxText(buf);
	assert.equal(slides.length, 4);
	assert.deepEqual(slides[2].slice(0, 7), ["By region", "Region", "Q2", "Q3", "North", "412", "486"]);
	assert.ok(slides[3].includes("</a:t><script>x</script>"), "markup in text stays text");
	assert.match(zip.text("ppt/slides/slide4.xml"), /&lt;\/a:t&gt;&lt;script&gt;/);
	assert.deepEqual(validatePptx(buf, deck), { ok: true, issues: [], facts: { slides: 4 } });
	assert.equal(validatePptx(buf, { ...deck, slides: [...deck.slides, { title: "Missing" }] }).ok, false, "validation notices a missing slide");
	assert.deepEqual(writePptx(deck), buf, "output is reproducible");
});

test("a mission makes a validated deck with slide_create", async () => {
	const model = await makeModel();
	const { host } = await startHost({ model });
	model.faux.setResponses([
		call("slide_create", { title: deck.title, subtitle: deck.subtitle, slides: deck.slides }),
		fauxAssistantMessage([fauxText("Your deck is ready: q3-sales-brief.pptx.")]),
	]);
	const { missionId } = await host.handle("mission.create", { text: "make slides for the Q3 brief", requestId: "s1" });
	const m = await settled(host, missionId);
	assert.equal(m.status, "succeeded");
	const [art] = host.evidence.artifacts(missionId);
	assert.equal(art.name, "q3-sales-brief.pptx");
	assert.equal(art.validation.ok, true);
	assert.equal(readPptxText(fs.readFileSync(art.path)).length, 4);
	await host.close();
});
