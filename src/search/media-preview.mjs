import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./media-preview.py", import.meta.url));
// Rendering uses installed readers in a separate process; no embedding or chat model is loaded.
export function renderMedia(runtime, hit, { signal, spawnImpl = spawn } = {}) {
	const info = runtime.status();
	if (!info.available) throw new Error("Install local search to view media sources.");
	if (!["image", "document", "video"].includes(hit.kind)) throw new Error("This result has no visual preview. Audio matches identify a moment without generating a transcript.");
	const python = path.join(info.runtimeDir, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
		let output = "", tail = "", done = false;
		const proc = spawnImpl(python, ["-u", script, hit.path, hit.kind, JSON.stringify(hit.locator)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		const finish = (err, data) => {
			if (done) return;
			done = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel);
			err ? reject(err) : resolve(data);
		};
		const cancel = () => { proc.kill(); finish(Object.assign(new Error("Cancelled"), { name: "AbortError" })); };
		const timer = setTimeout(() => { proc.kill(); finish(new Error("Media preview timed out.")); }, 10000);
		signal?.addEventListener("abort", cancel, { once: true });
		proc.stdout.on("data", chunk => {
			output += chunk.toString();
			if (output.length > 3_000_000) { proc.kill(); finish(new Error("Media preview exceeds the size limit.")); }
		});
		proc.stderr.on("data", chunk => { tail = (tail + chunk.toString()).slice(-2000); });
		proc.once("error", err => finish(err));
		proc.once("close", code => {
			if (code !== 0) return finish(new Error("Could not render this media source: " + tail));
			try {
				const data = JSON.parse(output);
				if (data.mimeType !== "image/jpeg" || typeof data.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.data) || data.data.length > 2_000_000) throw new Error("Invalid media preview");
				finish(undefined, data);
			} catch (err) { finish(err); }
		});
	});
}
