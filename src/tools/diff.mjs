// Line diff for approval previews: shows what a file write changes before the user approves it. Myers' O(ND)
// algorithm on lines, rendered as a unified diff with context, bounded in size so a preview stays readable.

/** Edit script between two line arrays: [{ op: " " | "-" | "+", line }]. */
export function diffLines(a, b, { maxEdits = 2000 } = {}) {
	const n = a.length;
	const m = b.length;
	const max = n + m;
	const v = new Map([[1, 0]]);
	const trace = [];
	for (let d = 0; d <= max; d++) {
		trace.push(new Map(v));
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? v.get(k + 1) ?? 0 : (v.get(k - 1) ?? 0) + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v.set(k, x);
			if (x >= n && y >= m) return backtrack(trace, a, b, d);
		}
		if (d > maxEdits) return null; // too different to preview usefully
	}
	return [];
}

function backtrack(trace, a, b, dEnd) {
	const out = [];
	let x = a.length;
	let y = b.length;
	for (let d = dEnd; d > 0; d--) {
		const v = trace[d];
		const k = x - y;
		const prevK = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? k + 1 : k - 1;
		const prevX = v.get(prevK) ?? 0;
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) out.push({ op: " ", line: a[--x], at: --y });
		if (x === prevX) out.push({ op: "+", line: b[--y] });
		else out.push({ op: "-", line: a[--x] });
	}
	while (x > 0 && y > 0) out.push({ op: " ", line: a[--x], at: --y });
	return out.reverse();
}

/** Unified diff text with `context` lines around changes, capped at `maxChars`; null when nothing changes. */
export function unifiedDiff(before, after, { context = 3, maxChars = 4000, labels = ["before", "after"] } = {}) {
	const a = String(before).replace(/\r\n/g, "\n").split("\n");
	const b = String(after).replace(/\r\n/g, "\n").split("\n");
	const edits = diffLines(a, b);
	if (edits === null) return `The file changes almost entirely (${a.length} → ${b.length} lines).`;
	if (!edits.some((e) => e.op !== " ")) return null;
	const keep = new Set();
	edits.forEach((e, i) => {
		if (e.op === " ") return;
		for (let j = Math.max(0, i - context); j <= Math.min(edits.length - 1, i + context); j++) keep.add(j);
	});
	const lines = [`--- ${labels[0]}`, `+++ ${labels[1]}`];
	let last = -1;
	let added = 0;
	let removed = 0;
	edits.forEach((e, i) => {
		if (e.op === "+") added++;
		if (e.op === "-") removed++;
		if (!keep.has(i)) return;
		if (last >= 0 && i > last + 1) lines.push("…");
		lines.push(`${e.op}${e.line}`);
		last = i;
	});
	let text = lines.join("\n");
	if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… (diff continues)`;
	return `${text}\n(${added} line${added === 1 ? "" : "s"} added, ${removed} removed)`;
}
