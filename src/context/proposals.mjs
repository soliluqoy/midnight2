// Model output is a proposal, never native edit authority. Only a bounded, typed response can become a
// paragraph patch; a later effect broker must still inspect the original handle and persist its intent.
import { createHash } from "node:crypto";
import { TARGET_LIMITS } from "./capsules.mjs";
import { paragraphGaps } from "./paragraph-format.mjs";

const fail = message => Object.assign(new Error(message), { code: "TARGET_PROPOSAL_INVALID" });
const hash = text => createHash("sha256").update(text).digest("hex");
const invalidBoundary = /[\u0000-\u001f\u007f\u2028\u2029]/u;
const numbers = text => [...text.matchAll(/[+\-\u2212]?\p{Nd}+(?:[.,]\p{Nd}+)*(?:[%‰])?/gu)].map(m => m[0]).sort();
const references = text => [...text.matchAll(/https?:\/\/[^\s<>]+|\[[^\]\r\n]{1,200}\]/gu)].map(m => m[0]).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const splitsSurrogate = (text, index) => index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]);

/** One contiguous replacement in UTF-16 offsets relative to the captured range, never the document. */
export function paragraphPatch(before, after) {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	if (splitsSurrogate(before, start) || splitsSurrogate(after, start)) start--;
	let end = before.length, nextEnd = after.length;
	while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
	if (splitsSurrogate(before, end) || splitsSurrogate(after, nextEnd)) { end++; nextEnd++; }
	return { start, end, before: before.slice(start, end), after: after.slice(start, nextEnd) };
}

export function parseTargetProposal(target, answer) {
	if (typeof answer !== "string" || Buffer.byteLength(answer, "utf8") > 32_768) throw fail("The quick-edit response is too large or missing.");
	let proposal;
	try { proposal = JSON.parse(answer); } catch { throw fail("The model did not return a typed quick-edit proposal. No edit was prepared."); }
	if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) throw fail("The quick-edit proposal must be an object.");
	if (proposal.kind === "needsContext") {
		if (Object.keys(proposal).some(key => !["kind", "question"].includes(key)) || typeof proposal.question !== "string" || !proposal.question.trim() || proposal.question.length > 500) throw fail("The model returned an invalid request for context.");
		return { kind: "needsContext", targetId: target.id, question: proposal.question.trim() };
	}
	if (target.kind !== "paragraph" || proposal.kind !== "paragraph.replace" || Object.keys(proposal).some(key => !["kind", "text"].includes(key))) throw fail("This proposal cannot change the selected target.");
	const text = proposal.text;
	if (typeof text !== "string" || !text.trim() || text.length > TARGET_LIMITS.textChars || Buffer.byteLength(text, "utf8") > TARGET_LIMITS.textChars * 2 || invalidBoundary.test(text) || !text.isWellFormed()) throw fail("The replacement must be bounded text inside the original paragraph.");
	const reviewReasons = [];
	if (target.metadata.supported !== true) reviewReasons.push("The selected formatting or structure is not qualified for direct replacement.");
	try { paragraphGaps(target.text, text, target.metadata.protectedSpans); }
	catch (error) { reviewReasons.push(error.message); }
	if (!same(numbers(target.text), numbers(text))) reviewReasons.push("Numeric values changed. Review the replacement before preparing a different edit.");
	if (!same(references(target.text), references(text))) reviewReasons.push("Citations or links changed. Review the replacement before preparing a different edit.");
	return {
		id: `proposal_${hash(`${target.id}\n${text}`)}`,
		kind: "paragraph.replace", targetId: target.id, text,
		expected: { textHash: target.textHash, structureHash: target.structureHash, connector: structuredClone(target.connector) },
		patch: paragraphPatch(target.text, text),
		unchanged: target.text === text,
		directlySupported: reviewReasons.length === 0,
		reviewReasons,
	};
}
