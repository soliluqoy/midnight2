import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const window = {};
vm.runInNewContext(fs.readFileSync(new URL("../src/ui/md.js", import.meta.url), "utf8"), { window });
const md = window.md;

test("Markdown links and citations retain balanced parentheses and escaped query strings", () => {
	const url = "https://example.test/a_(b)?x=1&y=2";
	const html = md.render(`[Page](${url})\n\nSee [1].\n\n1. [Source](${url})`);
	assert.equal((html.match(/href="https:\/\/example.test\/a_\(b\)\?x=1&amp;y=2"/g) ?? []).length, 3);
	assert.equal(md.refs(`1. [Source](${url})`)[1], url);
	assert.match(md.render("See https://example.test/a_(b)."), /href="https:\/\/example.test\/a_\(b\)"/);
});

test("source extraction ignores code and numbered lists preserve their starting value", () => {
	assert.equal(Object.keys(md.refs("```\n1. https://wrong.test\n```\nSee [1]")).length, 0);
	assert.match(md.render("4. Fourth\n5. Fifth"), /^<ol start="4">/);
	assert.match(md.render("[`Code`](https://example.test)"), /<a[^>]*><code>Code<\/code><\/a>/);
});

test("formatting never rewrites link attributes or permits raw HTML and unsafe protocols", () => {
	assert.match(md.render("[Page](https://example.test/**literal**)"), /href="https:\/\/example.test\/\*\*literal\*\*"/);
	const html = md.render('<script>alert(1)</script> [Bad](javascript:alert(1))');
	assert.doesNotMatch(html, /<script|href="javascript:/);
	assert.match(html, /&lt;script&gt;/);
});

test("lists nest to any depth and mix ordered and unordered levels", () => {
	assert.equal(md.render("- a\n  - b\n    1. c\n    2. d\n  - e\n- f"), "<ul><li>a<ul><li>b<ol><li>c</li><li>d</li></ol></li><li>e</li></ul></li><li>f</li></ul>");
	assert.equal(md.render("1. one\n\n2. two\n   more"), "<ol><li>one</li><li>two more</li></ol>", "a loose list stays one list; continuation lines join their item");
	assert.equal(md.render("- a\n1. b"), "<ul><li>a</li></ul><ol><li>b</li></ol>");
});

test("code blocks are highlighted from escaped tokens and carry a copy button", () => {
	const html = md.render('```js\nconst s = "</code><script>alert(1)</script>"; // done\n```');
	assert.doesNotMatch(html, /<script|<\/code><script/);
	assert.match(html, /<span class="tok-k">const<\/span>/);
	assert.match(html, /<span class="tok-s">&quot;&lt;\/code&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;<\/span>/);
	assert.match(html, /<span class="tok-c">\/\/ done<\/span>/);
	assert.match(html, /<button type="button" class="code-copy" aria-label="Copy code">Copy<\/button>/);
	assert.match(md.render("```\n<b>plain</b>\n```"), /<code>&lt;b&gt;plain&lt;\/b&gt;<\/code>/, "unknown languages are escaped, not highlighted");
	assert.match(md.render('```html\n<a href="x">t</a>\n```'), /<span class="tok-a">href<\/span>=<span class="tok-s">&quot;x&quot;<\/span>/);
	assert.match(md.render("```bad\"lang onclick=x\n1\n```"), /class="code-lang">badlang<\/span>.*class="lang-badlang"/, "the language label cannot inject attributes");
});
