// Text recognition with the OCR engine built into Windows (midnight-ocr.exe, from src/desktop/native/MidnightOcr.cs).
// Images stay on the computer; nothing is downloaded. Other platforms report OCR as unavailable for now.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OCR_HELPER = fileURLToPath(new URL("./native/midnight-ocr.exe", import.meta.url)).replace(/app\.asar([\\/])/, "app.asar.unpacked$1");

export function createOcr({ helper = OCR_HELPER, tempDir = os.tmpdir(), timeoutMs = 30_000, execImpl = execFile } = {}) {
	const available = () => process.platform === "win32" && fs.existsSync(helper);
	function run(args) {
		return new Promise((resolve, reject) => {
			execImpl(helper, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
				let out;
				try {
					out = JSON.parse(String(stdout).trim().split("\n").pop());
				} catch {
					return reject(new Error(err ? `Text recognition failed: ${err.message}` : "Text recognition returned no result."));
				}
				if (out.error) return reject(new Error(out.error));
				resolve(out);
			});
		});
	}
	const unavailable = () => new Error(process.platform === "win32" ? "Text recognition is not built in this copy of midnight (run npm run build:native)." : "Text recognition uses Windows' built-in OCR and is available on Windows only for now.");
	return {
		available,
		/** OCR an image file: { text, lines: [{ text, x, y, w, h }], language }. */
		async file(filePath, { language } = {}) {
			if (!available()) throw unavailable();
			return run([path.resolve(filePath), ...(language ? [language] : [])]);
		},
		/** OCR image bytes (for example a rendered PDF page) through a private temporary file. */
		async image(bytes, { language, ext = ".jpg" } = {}) {
			if (!available()) throw unavailable();
			const file = path.join(tempDir, `midnight-ocr-${randomUUID()}${ext}`);
			await fsp.writeFile(file, bytes);
			try {
				return await run([file, ...(language ? [language] : [])]);
			} finally {
				await fsp.rm(file, { force: true });
			}
		},
		languages: () => (available() ? run(["--languages"]).then((r) => r.languages ?? []) : Promise.resolve([])),
	};
}
