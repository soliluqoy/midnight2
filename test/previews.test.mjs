import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { unifiedDiff } from "../src/tools/diff.mjs";
import { writePreview } from "../src/tools/files.mjs";
import { shellTools } from "../src/tools/shell-tools.mjs";
import { tempDir } from "./helpers.mjs";

test("a file write's approval shows a diff of the file it replaces, or the opening of a new file", () => {
	const dir = tempDir("preview");
	const draft = path.join(dir, "draft.md");
	const dest = path.join(dir, "plan.md");
	fs.writeFileSync(draft, "# Plan\nShip on Friday\nOwner: Sam\n");
	fs.writeFileSync(dest, "# Plan\nShip on Thursday\nOwner: Sam\n");
	const replace = writePreview(draft, dest, { overwrite: true });
	assert.equal(replace.kind, "diff");
	assert.match(replace.text, /^--- plan\.md \(now\)\n\+\+\+ plan\.md \(after saving\)/);
	assert.match(replace.text, /\n-Ship on Thursday\n\+Ship on Friday\n/);
	assert.match(replace.text, /1 line added, 1 removed/);
	const fresh = writePreview(draft, path.join(dir, "new.md"), { overwrite: false });
	assert.deepEqual(fresh, { kind: "text", text: "# Plan\nShip on Friday\nOwner: Sam\n" });
	fs.writeFileSync(path.join(dir, "chart.png"), Buffer.from([137, 80, 78, 71, 0, 0]));
	assert.equal(writePreview(path.join(dir, "chart.png"), dest, { overwrite: true }), undefined, "binary files have no text preview");
	assert.match(writePreview(dest, dest, { overwrite: true }).text, /identical/);
	const long = unifiedDiff(Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n"), Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n"));
	assert.match(long, /changes almost entirely|diff continues/, "huge rewrites stay bounded");
});

test("a click that may submit lists what the form would send, with passwords masked by the page probe", async () => {
	const probe = { label: "Place order", submit: true, commit: true, inForm: true, origin: "shop.example", form: "checkout", fields: [{ label: "Email", value: "you@example.test" }, { label: "Password", value: "••••••••" }], hidden: 2, to: "shop.example · POST" };
	const platform = { call: async (op) => (op === "inspect.browser" ? probe : {}) };
	const { browser } = shellTools({ platform, evidence: {}, commit: (fn) => fn() });
	const cls = await browser.classify({ action: "click", x: 10, y: 10 }, { mission: { id: "m1" } });
	assert.equal(cls.effect, "browser.commit");
	assert.deepEqual(cls.display.sends, probe.fields);
	assert.equal(cls.display.sendsHidden, 2);
	assert.equal(cls.display.sendsTo, "shop.example · POST");
	const plain = await shellTools({ platform: { call: async () => ({ label: "Next", submit: false, inForm: false }) }, evidence: {}, commit: (fn) => fn() }).browser.classify({ action: "click", x: 1, y: 1 }, { mission: { id: "m1" } });
	assert.equal(plain.effect, "browser.navigate", "ordinary clicks need no approval or send list");
});
