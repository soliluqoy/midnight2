import assert from "node:assert/strict";
import test from "node:test";
import { paragraphGaps } from "../src/context/paragraph-format.mjs";
import { createTargetCapsules } from "../src/context/capsules.mjs";
import { parseTargetProposal, paragraphPatch } from "../src/context/proposals.mjs";

const before = "Quarterly revenue for North rose by 12% despite higher costs.";
const after = "Revenue for North grew by 12%, even with higher costs.";
const anchors = ["North", "12%", "higher costs"];
const spans = anchors.map(anchor => ({ start: before.indexOf(anchor), end: before.indexOf(anchor) + anchor.length }));
const snapshot = metadata => ({ kind: "paragraph", documentId: "PRIVATE_DOCUMENT", handle: "PRIVATE_RANGE", processId: 5, windowId: "17", connector: { id: "word", api: 1, artifact: `sha256:${"a".repeat(64)}` }, structureHash: `sha256:${"b".repeat(64)}`, text: before, metadata: { supported: true, protectedSpans: spans, ...metadata } });

test("mixed paragraph proposals rewrite multiple gaps while preserving exact ordered styled phrases", () => {
	const capsules = createTargetCapsules(), target = capsules.capture(snapshot());
	const proposal = parseTargetProposal(target, JSON.stringify({ kind: "paragraph.replace", text: after }));
	assert.equal(proposal.directlySupported, true);
	const gaps = paragraphGaps(before, after, spans); let result = before;
	for (const gap of gaps.toReversed()) { const patch = paragraphPatch(gap.before, gap.after); result = result.slice(0, gap.start + patch.start) + patch.after + result.slice(gap.start + patch.end); }
	assert.equal(result, after);
	const packet = JSON.parse(capsules.context(target.id));
	assert.deepEqual(packet.preserveStyledText, anchors);
	assert.equal(packet.metadata.protectedSpans, undefined);
	assert.doesNotMatch(JSON.stringify(packet), /PRIVATE_|sha256|protectedSpans/);
});

test("changed, repeated, reordered and removed styled anchors stay review-only before preparation", () => {
	const target = createTargetCapsules().capture(snapshot());
	for (const text of [after.replace("North", "South"), after.replace("North", "North North"), "Revenue for higher costs grew by 12%, even with North.", after.replace(", even with ", "")]) {
		assert.equal(parseTargetProposal(target, JSON.stringify({ kind: "paragraph.replace", text })).directlySupported, false);
		assert.throws(() => paragraphGaps(before, text, spans));
	}
	const repeated = { ...target, text: "North and North rose.", metadata: { supported: true, protectedSpans: [{ start: 0, end: 5 }] } };
	assert.equal(parseTargetProposal(repeated, JSON.stringify({ kind: "paragraph.replace", text: "North and North grew." })).directlySupported, false);
});

test("leading and trailing plain text can be removed and restored around unchanged styled anchors", () => {
	for (const text of ["North's quarterly revenue rose 12% despite higher costs.", "Revenue for North grew by 12%, even with higher costs"]) {
		assert.equal(parseTargetProposal(createTargetCapsules().capture(snapshot()), JSON.stringify({ kind: "paragraph.replace", text })).directlySupported, true);
		const currentSpans = anchors.map(anchor => ({ start: text.indexOf(anchor), end: text.indexOf(anchor) + anchor.length }));
		assert.doesNotThrow(() => paragraphGaps(text, before, currentSpans));
	}
	assert.throws(() => paragraphGaps(before, anchors.join(""), spans));
});

test("format maps reject oversized, overlapping, forged and split-surrogate spans", () => {
	for (const protectedSpans of [null, {}, [{ start: -1, end: 1 }], [{ start: 0, end: 1000 }], [{ start: 1, end: 1 }], [{ start: 1.5, end: 4 }], [{ start: 3, end: 8 }, { start: 2, end: 9 }], [{ start: 0, end: 1, command: "bold" }], Array.from({ length: 33 }, (_, i) => ({ start: i, end: i + 1 }))]) assert.throws(() => createTargetCapsules().capture(snapshot({ protectedSpans })), { code: "TARGET_INVALID" });
	assert.throws(() => createTargetCapsules().capture({ ...snapshot(), text: "A 😀 name", metadata: { supported: true, protectedSpans: [{ start: 2, end: 3 }] } }), { code: "TARGET_INVALID" });
	const unicode = "A 😀 name grew.", next = "A 😀 name increased.";
	assert.equal(paragraphGaps(unicode, next, [{ start: 2, end: 4 }]).length, 2);
});
