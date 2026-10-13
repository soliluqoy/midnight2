// Styled spans remain exact, ordered anchors. Rewrites touch only the uniform-format gaps between them.
// This data is connector metadata, never a model-supplied formatting instruction.
export function validProtectedSpans(text, spans) {
	if (!Array.isArray(spans) || spans.length > 32) return false;
	let end = 0;
	return spans.every(span => {
		if (!span || Object.keys(span).some(key => !["start", "end"].includes(key)) || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < end || span.end <= span.start || span.end > text.length || !text.slice(span.start, span.end).isWellFormed()) return false;
		end = span.end; return true;
	});
}
export function paragraphGaps(before, after, spans = []) {
	if (!validProtectedSpans(before, spans)) throw new Error("The selected text's formatting is unavailable. Select it again.");
	const gaps = []; let source = 0, destination = 0;
	for (const span of spans) {
		const anchor = before.slice(span.start, span.end), found = after.indexOf(anchor);
		if (before.indexOf(anchor) !== span.start || before.lastIndexOf(anchor) !== span.start || found < destination || after.lastIndexOf(anchor) !== found) throw new Error("Keep each styled phrase unchanged, once, and in its original order.");
		gaps.push({ start: source, end: span.start, before: before.slice(source, span.start), after: after.slice(destination, found) });
		source = span.end; destination = found + anchor.length;
	}
	gaps.push({ start: source, end: before.length, before: before.slice(source), after: after.slice(destination) });
	if (spans.length && (gaps.every(gap => gap.after.length === 0) || gaps.slice(1, -1).some(gap => (gap.before.length === 0) !== (gap.after.length === 0)))) throw new Error("Keep the text between styled phrases so their formatting boundaries remain intact.");
	return gaps;
}
