// Files and pictures the user drops or pastes into Ask. The shell reads them (a dropped file's path only comes from a
// real drag gesture through the preload; a pasted picture is read from the system clipboard here), extracts text or
// prepares an image, and keeps the result until the task is sent. Nothing reaches the engine before Send.
import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { readDocx } from "../tools/documents/docx.mjs";
import { readZip, xmlUnescape } from "../tools/documents/zip.mjs";
import { SECRET_NAME, SECRET_TEXT } from "../search/service.mjs";

const TEXT = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".log", ".xml", ".yaml", ".yml", ".html", ".htm", ".rst", ".ini", ".toml", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".java", ".c", ".h", ".cpp", ".cs", ".go", ".rs", ".rb", ".php", ".sql", ".sh", ".ps1", ".css", ".scss", ".swift", ".kt"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const EXECUTABLE = /\.(exe|bat|cmd|com|msi|msp|lnk|scr|hta|jar|reg|cpl|pif|vbs|vbe|jse|wsf|wsh|appref-ms|dll|sys)$/i;
const MAX_FILE = 25 * 1024 * 1024;
const MAX_TEXT = 200_000;
const MAX_IMAGE_SIDE = 1568; // the long side vision models use; larger images only cost tokens
const MAX_ITEMS = 8;

/**
 * @param {{ nativeImage: object, clipboard: object, readPdfText?: (filePath: string) => Promise<string> }} o
 */
export function createAttachments({ nativeImage, clipboard, readPdfText }) {
	const items = new Map(); // id -> attachment (with content)
	const id = () => `att_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
	const summary = (a) => ({ id: a.id, name: a.name, kind: a.kind, size: a.size, truncated: !!a.truncated, thumbnail: a.thumbnail });
	const keep = (a) => {
		if (items.size >= MAX_ITEMS) throw new Error(`Attach up to ${MAX_ITEMS} files at a time.`);
		items.set(a.id, a);
		return summary(a);
	};

	function image(img, name, source) {
		if (img.isEmpty()) throw new Error(`${name} is not a picture midnight can read.`);
		const { width, height } = img.getSize();
		const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height));
		const sized = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: "best" }) : img;
		const data = sized.toJPEG(85);
		const thumb = img.resize(width >= height ? { width: 96 } : { height: 96 }).toJPEG(70);
		return { id: id(), name, kind: "image", mimeType: "image/jpeg", data: data.toString("base64"), size: data.length, source, hash: `sha256:${createHash("sha256").update(data).digest("hex")}`, thumbnail: `data:image/jpeg;base64,${thumb.toString("base64")}` };
	}

	async function text(filePath, ext, buf) {
		if (ext === ".docx") return readDocx(buf).text;
		if (ext === ".pptx") {
			const zip = readZip(buf);
			const slides = [...zip.entries.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(/slide(\d+)/.exec(a)[1]) - Number(/slide(\d+)/.exec(b)[1]));
			return slides.map((n, i) => `Slide ${i + 1}\n${[...zip.text(n).matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => xmlUnescape(m[1])).join("\n")}`).join("\n\n");
		}
		if (ext === ".pdf") {
			if (!readPdfText) throw new Error("PDF reading is unavailable.");
			return readPdfText(filePath);
		}
		if (buf.includes(0)) throw new Error(`${path.basename(filePath)} is a binary file midnight cannot read as text.`);
		return buf.toString("utf8");
	}

	return {
		/** A file the user dropped (path from the preload's File object). */
		async add(filePath) {
			const p = path.resolve(String(filePath));
			const name = path.basename(p);
			const ext = path.extname(p).toLowerCase();
			if (EXECUTABLE.test(p)) throw new Error(`${name} is a program; midnight does not attach programs.`);
			if (SECRET_NAME.test(name)) throw new Error(`${name} looks like it holds credentials, so it was not attached.`);
			const st = await fsp.stat(p);
			if (!st.isFile()) throw new Error(`${name} is a folder. Add folders in Settings → Folders instead.`);
			if (st.size > MAX_FILE) throw new Error(`${name} is larger than 25 MB.`);
			if (IMAGE.has(ext)) return keep(image(nativeImage.createFromPath(p), name, p));
			if (!TEXT.has(ext) && ![".docx", ".pptx", ".pdf"].includes(ext)) throw new Error(`midnight can attach text, documents, PDFs and pictures; ${ext || "this file type"} is not supported yet.`);
			const buf = await fsp.readFile(p);
			let content = String(await text(p, ext, buf)).replace(/\r\n/g, "\n");
			if (SECRET_TEXT.test(content)) throw new Error(`${name} contains a private key or credential, so it was not attached.`);
			const truncated = content.length > MAX_TEXT;
			if (truncated) content = `${content.slice(0, MAX_TEXT)}\n[… truncated: the file continues]`;
			return keep({ id: id(), name, kind: "text", text: content, size: st.size, truncated, source: p, hash: `sha256:${createHash("sha256").update(buf).digest("hex")}` });
		},
		/** The picture currently on the system clipboard. */
		paste() {
			const img = clipboard.readImage();
			if (img.isEmpty()) throw new Error("The clipboard has no picture.");
			const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
			return keep(image(img, `Pasted picture ${stamp}.jpg`, "clipboard"));
		},
		remove(attachmentId) {
			return { removed: items.delete(attachmentId) };
		},
		/** Hand the attachments over for a send; they leave the shell's memory. */
		take(ids = []) {
			return ids.map((i) => {
				const a = items.get(i);
				if (!a) throw new Error("An attachment is no longer available. Attach it again.");
				items.delete(i);
				const { thumbnail, id: _, ...content } = a;
				return content;
			});
		},
		clear: () => items.clear(),
	};
}
