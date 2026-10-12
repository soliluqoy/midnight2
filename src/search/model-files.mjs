// The exact EmbeddingGemma 2 files local search downloads, pinned to one commit with their hashes (from the Hugging
// Face file listing at that commit). Large files carry their LFS SHA-256; small ones their git blob SHA-1. A file is
// only moved into place after its size and hash match, so a tampered or truncated download never loads.
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";
export const MODEL_REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";
export const MODEL_FILES = [
	{ path: "config.json", size: 5031, git: "b267dcb270ba41f67a8d14001bf470f23a9525fb" },
	{ path: "chat_template.jinja", size: 1016, git: "8df4ab8961aa08b66b470c5adbdc51374aabb63b" },
	{ path: "preprocessor_config.json", size: 560, git: "97ebeb96191bcc96d5ea299ad16c2952eb9e36c9" },
	{ path: "processor_config.json", size: 1788, git: "63043a5a2fd2e25a2fc5336fcdaf24e515d12289" },
	{ path: "tokenizer_config.json", size: 1599, git: "a9afd12fb3ca2c418fd405320ace85ad46748d03" },
	{ path: "tokenizer.json", size: 32170510, sha256: "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4" },
	{ path: "onnx/model_quantized.onnx", size: 495165, sha256: "d06edd601f851c633a2519304cbeb8dc6170d7ceb61b436625c17fb9b6e74953" },
	{ path: "onnx/model_quantized.onnx_data", size: 313724928, sha256: "278a7ff1248c3618e4bd11a607fc54f7bdc7778854230f3956d3f86bd9db4f3b" },
	{ path: "onnx/vision_encoder_quantized.onnx", size: 162495, sha256: "bb0de2df53a2448a32dc7908a187c168c8afd514d4d6f674f7f46024875fa4e3" },
	{ path: "onnx/vision_encoder_quantized.onnx_data", size: 195228672, sha256: "3dabd69c0a36e9a8771ad82030dde74daa5a0e02b7047a5d3f3382b1137bab89" },
	{ path: "onnx/audio_encoder_quantized.onnx", size: 249330, sha256: "04a9a9094ba76fb169e4c69be45a4b621580188654d6be59eab860eadcd42d3c" },
	{ path: "onnx/audio_encoder_quantized.onnx_data", size: 340058624, sha256: "aa6361d898e1f1d6303f8dd2b5fabf4fd3629e15fd709e9cb06ac5cb9416a030" },
];
export const MODEL_BYTES = MODEL_FILES.reduce((n, f) => n + f.size, 0);

/** Where Transformers.js looks for MODEL_ID's files when loading offline from `cacheDir`. */
export const modelDir = (cacheDir) => path.join(cacheDir, ...MODEL_ID.split("/"));

function hasher(file) {
	if (file.sha256) return { h: createHash("sha256"), want: file.sha256 };
	const h = createHash("sha1");
	h.update(`blob ${file.size}\0`);
	return { h, want: file.git };
}

async function verified(file, target) {
	try {
		const st = await fsp.stat(target);
		if (st.size !== file.size) return false;
		const { h, want } = hasher(file);
		for await (const chunk of fs.createReadStream(target, { highWaterMark: 1 << 20 })) h.update(chunk);
		return h.digest("hex") === want;
	} catch {
		return false;
	}
}

/**
 * Download every pinned file that is missing or does not match. Files that already verify are kept (a retried
 * setup resumes). Progress reports bytes across all files.
 */
export async function downloadModel({ cacheDir, signal, onProgress, fetchImpl = fetch, files = MODEL_FILES, baseUrl = "https://huggingface.co" }) {
	const dir = modelDir(cacheDir);
	const total = files.reduce((n, f) => n + f.size, 0);
	let done = 0;
	const report = () => onProgress?.({ phase: "downloading", message: "Downloading EmbeddingGemma 2", bytesDone: done, bytesTotal: total });
	for (const file of files) {
		signal?.throwIfAborted();
		const target = path.join(dir, ...file.path.split("/"));
		if (await verified(file, target)) {
			done += file.size;
			report();
			continue;
		}
		await fsp.mkdir(path.dirname(target), { recursive: true });
		const part = `${target}.part`;
		const res = await fetchImpl(`${baseUrl}/${MODEL_ID}/resolve/${MODEL_REVISION}/${file.path}`, { signal, redirect: "follow", headers: { "user-agent": "midnight-local-search" } });
		if (!res.ok || !res.body) throw Object.assign(new Error(`Downloading ${file.path} failed (${res.status}).`), { code: "SEARCH_DOWNLOAD_FAILED" });
		const { h, want } = hasher(file);
		const out = fs.createWriteStream(part);
		let size = 0;
		try {
			for await (const chunk of res.body) {
				signal?.throwIfAborted();
				h.update(chunk);
				size += chunk.length;
				done += chunk.length;
				if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
				report();
			}
		} finally {
			await new Promise((r) => out.end(r));
		}
		if (size !== file.size || h.digest("hex") !== want) {
			await fsp.rm(part, { force: true });
			throw Object.assign(new Error(`${file.path} did not match its pinned hash; it was discarded. Try setup again.`), { code: "SEARCH_DOWNLOAD_FAILED" });
		}
		await fsp.rm(target, { force: true });
		await fsp.rename(part, target);
	}
	return { dir, bytes: total };
}
