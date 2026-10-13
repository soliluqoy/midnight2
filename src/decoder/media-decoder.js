// Hidden media decoder (no file system, no network): the shell hands it a file's bytes and it returns what local
// search needs from Chromium's own codecs: RGB pixels of an image, PDF page or video frame, a PDF page's text, and
// mono 16 kHz audio. One session per file; the shell closes it when indexing or preview of that file ends.
import * as pdfjs from "../../node_modules/pdfjs-dist/build/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;

const RATE = 16000;
const sessions = new Map(); // id -> { kind, blob, url, pdf, video, audio }

function fit(w, h, max) {
	const k = Math.min(1, max / Math.max(w, h, 1));
	return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

function pixels(source, w, h, max, format) {
	const [cw, ch] = fit(w, h, max);
	const canvas = new OffscreenCanvas(cw, ch);
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, cw, ch);
	ctx.drawImage(source, 0, 0, cw, ch);
	if (format === "jpeg") return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 }).then(async (b) => ({ width: cw, height: ch, jpeg: new Uint8Array(await b.arrayBuffer()) }));
	const rgba = ctx.getImageData(0, 0, cw, ch).data;
	const rgb = new Uint8Array(cw * ch * 3);
	for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
		rgb[j] = rgba[i];
		rgb[j + 1] = rgba[i + 1];
		rgb[j + 2] = rgba[i + 2];
	}
	return { width: cw, height: ch, rgb };
}

function withTimeout(promise, ms, what) {
	return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);
}

async function videoElement(s) {
	if (s.video) return s.video;
	const v = document.createElement("video");
	v.muted = true;
	v.preload = "auto";
	v.src = s.url;
	await withTimeout(new Promise((resolve, reject) => {
		v.onloadeddata = resolve;
		v.onerror = () => reject(new Error("This video format cannot be decoded."));
	}), 20000, "Opening the video");
	s.video = v;
	return v;
}

async function seek(v, seconds) {
	const t = Math.max(0, Math.min(seconds, Math.max(0, v.duration - 0.05)));
	if (Math.abs(v.currentTime - t) < 0.01 && v.readyState >= 2) return;
	await withTimeout(new Promise((resolve, reject) => {
		v.onseeked = resolve;
		v.onerror = () => reject(new Error("Could not read this video frame."));
		v.currentTime = t;
	}), 15000, "Reading a video frame");
}

async function decodedAudio(s) {
	if (s.audio !== undefined) {
		if (s.audio === null) throw new Error("This file has no readable audio track.");
		return s.audio;
	}
	try {
		const bytes = await s.blob.arrayBuffer();
		const probe = new OfflineAudioContext(1, 1, RATE);
		const decoded = await withTimeout(probe.decodeAudioData(bytes), 120000, "Decoding audio");
		const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * RATE)), RATE);
		const src = ctx.createBufferSource();
		src.buffer = decoded;
		src.connect(ctx.destination); // multi-channel input is down-mixed to the mono destination
		src.start();
		s.audio = (await ctx.startRendering()).getChannelData(0);
		return s.audio;
	} catch (err) {
		s.audio = null;
		throw new Error("This file has no readable audio track.");
	}
}

async function pdfDocument(s) {
	if (!s.pdf) s.pdf = await withTimeout(pdfjs.getDocument({ data: new Uint8Array(await s.blob.arrayBuffer()), isEvalSupported: false, disableFontFace: false }).promise, 60000, "Opening the PDF");
	return s.pdf;
}

async function pdfPage(s, number, max, format) {
	const doc = await pdfDocument(s);
	if (!(number >= 1 && number <= doc.numPages)) throw new Error("This PDF page is unavailable.");
	const page = await doc.getPage(number);
	const base = page.getViewport({ scale: 1 });
	const scale = Math.min(2, max / Math.max(base.width, base.height, 1));
	const viewport = page.getViewport({ scale });
	const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	await withTimeout(page.render({ canvasContext: ctx, canvas, viewport }).promise, 60000, "Rendering the PDF page");
	page.cleanup();
	return pixels(canvas, canvas.width, canvas.height, max, format);
}

const ops = {
	async open({ id, kind, bytes, type }) {
		const blob = new Blob([bytes], { type: type || "" });
		const s = { kind, blob, url: URL.createObjectURL(blob) };
		sessions.set(id, s);
		if (kind === "image") {
			const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" }).catch(() => { throw new Error("This image format cannot be decoded."); });
			s.bitmap = bmp;
			return { width: bmp.width, height: bmp.height };
		}
		if (kind === "pdf") return { pages: (await pdfDocument(s)).numPages };
		if (kind === "video") {
			const v = await videoElement(s);
			return { duration: Number.isFinite(v.duration) ? v.duration : 0, width: v.videoWidth, height: v.videoHeight };
		}
		if (kind === "audio") return { duration: (await decodedAudio(s)).length / RATE };
		throw new Error(`Unsupported media kind ${kind}`);
	},
	async frame({ id, page, seconds, max = 1600, format = "rgb" }) {
		const s = sessions.get(id);
		if (!s) throw new Error("This media session is closed.");
		if (s.kind === "image") return pixels(s.bitmap, s.bitmap.width, s.bitmap.height, max, format);
		if (s.kind === "pdf") return pdfPage(s, Number(page ?? 1), max, format);
		if (s.kind === "video") {
			const v = await videoElement(s);
			await seek(v, Number(seconds ?? 0));
			return pixels(v, v.videoWidth, v.videoHeight, max, format);
		}
		throw new Error("This media has no picture.");
	},
	async text({ id, page }) {
		const s = sessions.get(id);
		if (s?.kind !== "pdf") throw new Error("Text extraction needs an open PDF.");
		const p = await (await pdfDocument(s)).getPage(Number(page));
		const content = await p.getTextContent();
		let out = "";
		for (const item of content.items) out += (item.str ?? "") + (item.hasEOL ? "\n" : " ");
		return { text: out.replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").trim() };
	},
	async audio({ id, start = 0, seconds = 30 }) {
		const s = sessions.get(id);
		if (!s) throw new Error("This media session is closed.");
		const all = await decodedAudio(s);
		const from = Math.max(0, Math.floor(start * RATE));
		const to = Math.min(all.length, from + Math.floor(seconds * RATE));
		return { samples: all.slice(from, to), rate: RATE, total: all.length / RATE };
	},
	async close({ id }) {
		const s = sessions.get(id);
		sessions.delete(id);
		if (!s) return {};
		s.bitmap?.close?.();
		if (s.video) {
			s.video.removeAttribute("src");
			s.video.load();
		}
		await s.pdf?.destroy?.();
		URL.revokeObjectURL(s.url);
		return {};
	},
};

window.decoder.onRequest(async ({ id, op, args }) => {
	try {
		if (!Object.hasOwn(ops, op)) throw new Error(`unknown decoder op ${op}`);
		window.decoder.reply({ id, ok: true, result: await ops[op](args ?? {}) });
	} catch (err) {
		window.decoder.reply({ id, ok: false, error: String(err?.message ?? err) });
	}
});
window.decoder.ready();
