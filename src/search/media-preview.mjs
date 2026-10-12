// Media decoding for the engine: a thin proxy over the shell's decoder operations (src/desktop/platform.mjs), plus a
// JPEG render of one selected image, PDF page or video frame for files_view. No model, network or transcript.

/** Returns decodeMedia(filePath, kind) -> session { info, frame, text, audio, close } backed by platform calls. */
export function platformMedia(platform) {
	return async (filePath, kind, { signal } = {}) => {
		const { id, info } = await platform.call("media.open", { path: filePath, kind }, { signal });
		const call = (op, o) => platform.call(op, { id, ...o }, { signal });
		return {
			info,
			frame: (o = {}) => call("media.frame", o),
			text: (o = {}) => call("media.text", o),
			audio: (o = {}) => call("media.audio", o),
			close: () => platform.call("media.close", { id }).catch(() => {}),
		};
	};
}

export async function renderMedia(decodeMedia, hit, { signal } = {}) {
	if (!["image", "document", "video"].includes(hit.kind)) throw new Error("This result has no visual preview. Audio matches identify a moment without generating a transcript.");
	const pdf = hit.path.toLowerCase().endsWith(".pdf");
	if (hit.kind === "document" && !pdf) throw new Error("Export visual slides to PDF to inspect them.");
	const media = await decodeMedia(hit.path, pdf ? "pdf" : hit.kind, { signal });
	try {
		const locator = hit.locator ?? {};
		const frame = await media.frame({ format: "jpeg", max: 1600, page: Number(locator.page ?? 1), seconds: Math.max(0, Number(locator.seconds ?? locator.startSeconds ?? 0)) });
		const data = Buffer.from(frame.jpeg).toString("base64");
		if (data.length > 2_000_000) throw new Error("Media preview exceeds the size limit.");
		return { mimeType: "image/jpeg", data };
	} finally {
		await media.close();
	}
}
