// Small, safe Markdown renderer for answers: everything is escaped first, only http(s) links survive.
// Handles headings, nested lists, tables, highlighted code with a copy button, quotes, bold/italic, links and [n]
// citations tied to the Sources list.
window.md = (() => {
	const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
	const esc = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);
	const trimUrl = (s) => {
		s = s.replace(/[.,;]+$/, "");
		for (const [open, close] of [["(", ")"], ["[", "]"]]) {
			while (s.endsWith(close) && s.split(close).length > s.split(open).length) s = s.slice(0, -1);
		}
		return s;
	};
	function links(s, replace) {
		const pattern = /\[([^\]]+)\]\((https?:\/\/)/g;
		let out = "", cursor = 0, match;
		while ((match = pattern.exec(s))) {
			const start = match.index + match[1].length + 3;
			let depth = 0;
			let end = start;
			for (; end < s.length; end++) {
				if (/\s/.test(s[end])) break;
				if (s[end] === "(") depth++;
				if (s[end] === ")" && depth-- === 0) break;
			}
			if (s[end] !== ")") continue;
			out += s.slice(cursor, match.index) + replace(match[1], s.slice(start, end));
			cursor = end + 1;
			pattern.lastIndex = cursor;
		}
		return out + s.slice(cursor);
	}

	// "1. [Title](https://…)" or "[1] Title — https://…" -> {1: url}
	function refs(text) {
		const out = {};
		let fence;
		for (const line of text.split("\n")) {
			const f = line.match(/^\s*(`{3,}|~{3,})/);
			if (f) {
				if (!fence) fence = f[1][0];
				else if (f[1][0] === fence) fence = undefined;
				continue;
			}
			if (fence) continue;
			const m = line.match(/^\s*(?:[-*]\s*)?\[?(\d{1,2})\]?[.):]?\s+(.*)$/);
			if (!m) continue;
			let url;
			const content = m[2].replace(/`[^`]*`/g, "");
			links(content, (_label, u) => { url ??= u; return ""; });
			url ??= content.match(/https?:\/\/[^\s<>]+/)?.[0];
			if (url) out[m[1]] = trimUrl(url);
		}
		return out;
	}

	function inline(s, r) {
		const tokens = [];
		const protect = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
		const restore = (text) => text.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[+i]);
		const format = (text) => text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, "$1<em>$2</em>").replace(/~~(.+?)~~/g, "<del>$1</del>");
		s = s.replace(/\u0000/g, "\ufffd");
		s = s.replace(/`([^`]+)`/g, (_, c) => protect(`<code>${esc(c)}</code>`));
		s = links(s, (label, url) => protect(`<a href="${esc(url)}" title="${esc(url)}">${restore(format(esc(label)))}</a>`));
		s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>\u0000]+)/g, (_, pre, raw) => {
			const url = trimUrl(raw);
			return pre + protect(`<a href="${esc(url)}" title="${esc(url)}">${esc(url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48))}</a>`) + raw.slice(url.length);
		});
		s = esc(s);
		s = s.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?!\()/g, (_, list) =>
			list
				.split(/\s*,\s*/)
				.map((n) => protect(r[n] ? `<a class="cite" href="${esc(r[n])}" title="${esc(r[n])}">${n}</a>` : `<sup class="cite">${n}</sup>`))
				.join(""),
		);
		return restore(format(s));
	}

	// ---------- code: a small, dependency-free highlighter (escaped tokens only, never HTML from the answer) ----------
	const KEYWORDS = {
		js: "async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of package private protected public readonly return set static super switch this throw true try type typeof undefined var void while with yield",
		py: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield",
		sh: "case do done elif else esac export fi for function if in local return select set then unset until while echo cd exit source",
		ps: "begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using var while $true $false $null",
		sql: "add all alter and as asc between by case create delete desc distinct drop else end exists false from group having in index inner insert into is join key left like limit not null on or order outer primary references right select set table then true union unique update values view when where with",
		go: "break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var",
		rs: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
		c: "abstract auto bool boolean break byte case catch char class const continue default delete do double else enum extends extern false final finally float for fun goto if implements import int interface internal long namespace new null nullptr object override package private protected public readonly return short signed sizeof static string struct super switch template this throw throws true try typedef typename union unsigned using val var virtual void volatile when while",
		css: "important inherit initial none auto unset",
		yaml: "true false null yes no on off",
		json: "true false null",
	};
	const LANG = { js: "js", javascript: "js", ts: "js", typescript: "js", jsx: "js", tsx: "js", mjs: "js", node: "js", json: "json", jsonc: "json", py: "py", python: "py", sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "sh", ps1: "ps", powershell: "ps", pwsh: "ps", sql: "sql", html: "html", xml: "html", svg: "html", vue: "html", css: "css", scss: "css", less: "css", go: "go", golang: "go", rust: "rs", rs: "rs", java: "c", c: "c", h: "c", cpp: "c", "c++": "c", cs: "c", csharp: "c", kotlin: "c", kt: "c", swift: "c", dart: "c", php: "c", yaml: "yaml", yml: "yaml", toml: "yaml", ini: "yaml" };
	const COMMENT = { js: "//|/\\*[\\s\\S]*?\\*/", c: "//|/\\*[\\s\\S]*?\\*/", go: "//|/\\*[\\s\\S]*?\\*/", rs: "//|/\\*[\\s\\S]*?\\*/", css: "/\\*[\\s\\S]*?\\*/", py: "#", sh: "#", ps: "#|<#[\\s\\S]*?#>", yaml: "#", sql: "--|/\\*[\\s\\S]*?\\*/", json: "" };
	function highlight(code, lang) {
		const family = LANG[String(lang).toLowerCase()];
		if (!family) return esc(code);
		if (family === "html") {
			return code.replace(/(<!--[\s\S]*?-->)|(<\/?)([\w:-]+)|([\w:-]+)(=)("[^"]*"|'[^']*')|([^<\w]+|[\s\S])/g, (m, comment, open, tag, attr, eq, value, rest) =>
				comment ? `<span class="tok-c">${esc(comment)}</span>` : open ? `${esc(open)}<span class="tok-t">${esc(tag)}</span>` : attr ? `<span class="tok-a">${esc(attr)}</span>=<span class="tok-s">${esc(value)}</span>` : esc(rest),
			);
		}
		const words = new Set(KEYWORDS[family].split(" "));
		const comment = COMMENT[family];
		// One pass: comments (to end of line unless block), strings, numbers, words, anything else.
		const pattern = new RegExp(`${comment ? `(${comment.split("|").map((c) => (c.includes("[\\s\\S]") ? c : `${c}[^\\n]*`)).join("|")})|` : "()"}("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|(\\b\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b|\\b0x[\\da-f]+\\b)|([$@]?[A-Za-z_][\\w$]*)|([\\s\\S])`, "gi");
		let out = "";
		for (const m of code.matchAll(pattern)) {
			if (m[1]) out += `<span class="tok-c">${esc(m[1])}</span>`;
			else if (m[2]) out += `<span class="tok-s">${esc(m[2])}</span>`;
			else if (m[3]) out += `<span class="tok-n">${esc(m[3])}</span>`;
			else if (m[4]) out += words.has(family === "sql" ? m[4].toLowerCase() : m[4]) ? `<span class="tok-k">${esc(m[4])}</span>` : family === "json" && /^"/.test(m[4]) ? esc(m[4]) : esc(m[4]);
			else out += esc(m[5] ?? m[0]);
		}
		return out;
	}
	function codeBlock(code, lang) {
		const name = String(lang || "").replace(/[^\w#+.-]/g, "").slice(0, 20);
		return `<div class="code-block"><div class="code-head"><span class="code-lang">${esc(name || "Code")}</span><button type="button" class="code-copy" aria-label="Copy code">Copy</button></div><pre><code${name ? ` class="lang-${esc(name.toLowerCase())}"` : ""}>${highlight(code, name)}</code></pre></div>`;
	}

	// ---------- lists: a tree by indentation; ordered and unordered lists nest to any depth ----------
	function renderList(items, r) {
		let i = 0;
		const level = (base) => {
			const first = items[i];
			const tag = first.ordered ? "ol" : "ul";
			let html = `<${tag}${first.ordered && first.start !== 1 ? ` start="${first.start}"` : ""}>`;
			while (i < items.length && items[i].indent >= base) {
				const item = items[i];
				if (item.indent === base && (item.ordered ? "ol" : "ul") !== tag) break; // a sibling list of the other kind
				i++;
				let li = inline(item.text, r);
				while (i < items.length && items[i].indent > base) li += level(items[i].indent);
				html += `<li>${li}</li>`;
			}
			return `${html}</${tag}>`;
		};
		let html = "";
		while (i < items.length) html += level(items[i].indent);
		return html;
	}

	const cells = (line) =>
		line
			.trim()
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((c) => c.trim());

	function render(text) {
		const r = refs(text);
		const lines = text.replace(/\r/g, "").split("\n");
		const out = [];
		let para = [];
		let list = null; // [{ indent, ordered, start, text }]
		const flushPara = () => {
			if (para.length) out.push(`<p>${para.map((l) => inline(l, r)).join("<br>")}</p>`);
			para = [];
		};
		const flushList = () => {
			if (list) out.push(renderList(list, r));
			list = null;
		};
		const flush = () => {
			flushPara();
			flushList();
		};

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			let m;
			if ((m = line.match(/^\s*```(\S*)/))) {
				flush();
				const code = [];
				while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
				out.push(codeBlock(code.join("\n"), m[1]));
			} else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
				flush();
				const lvl = Math.min(5, Math.max(3, m[1].length + 1));
				out.push(`<h${lvl}>${inline(m[2].replace(/\s#+$/, ""), r)}</h${lvl}>`);
			} else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
				flush();
				const head = cells(line);
				i++;
				const rows = [];
				while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) rows.push(cells(lines[++i]));
				out.push(
					`<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${inline(c, r)}</th>`).join("")}</tr></thead><tbody>${rows
						.map((row) => `<tr>${row.map((c) => `<td>${inline(c, r)}</td>`).join("")}</tr>`)
						.join("")}</tbody></table></div>`,
				);
			} else if ((m = line.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/))) {
				flushPara();
				const ordered = /\d/.test(m[2]);
				(list ??= []).push({ indent: m[1].replace(/\t/g, "    ").length, ordered, start: ordered ? parseInt(m[2], 10) : 1, text: m[3] });
			} else if ((m = line.match(/^\s*>\s?(.*)$/))) {
				flush();
				out.push(`<blockquote>${inline(m[1], r)}</blockquote>`);
			} else if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
				flush();
				out.push("<hr>");
			} else if (!line.trim()) {
				// A blank line inside a list keeps it open when the list continues (a "loose" list).
				const next = lines.slice(i + 1).find((l) => l.trim());
				if (!(list && next && /^\s*([-*+]|\d{1,3}[.)])\s+/.test(next))) flush();
			} else if (list && /^\s{2,}\S/.test(line)) {
				list[list.length - 1].text += ` ${line.trim()}`;
			} else {
				flushList();
				para.push(line);
			}
		}
		flush();
		return out.join("");
	}

	return { render, refs };
})();

/** A code block's copy button: copies the block's text and confirms on the button. */
window.copyCode = (button, write) => {
	const code = button.closest(".code-block")?.querySelector("code")?.textContent ?? "";
	Promise.resolve(write(code)).then(
		() => (button.textContent = "Copied ✓"),
		() => (button.textContent = "Copy failed"),
	).finally(() => setTimeout(() => (button.textContent = "Copy"), 1400));
};
