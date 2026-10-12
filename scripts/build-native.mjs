// Builds midnight's small native Windows helpers with the C# compiler that ships with Windows (.NET Framework 4),
// so no SDK or download is needed: `node scripts/build-native.mjs`. A no-op on other platforms. The outputs are
// ignored by git and packaged with the app (CI signs them with the app when a certificate is configured).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TARGETS = [{ source: "src/desktop/native/MidnightHotkey.cs", out: "src/desktop/native/midnight-hotkey.exe", refs: ["System.Windows.Forms.dll"] }];

export function compiler() {
	const windir = process.env.WINDIR ?? "C:\\Windows";
	for (const dir of ["Framework64", "Framework"]) {
		const csc = path.join(windir, "Microsoft.NET", dir, "v4.0.30319", "csc.exe");
		if (fs.existsSync(csc)) return csc;
	}
	return undefined;
}

export function buildNative({ quiet = false } = {}) {
	if (process.platform !== "win32") return [];
	const csc = compiler();
	if (!csc) throw new Error("The .NET Framework 4 C# compiler (csc.exe) was not found; it ships with Windows 10 and 11.");
	const built = [];
	for (const t of TARGETS) {
		const source = path.join(root, t.source);
		const out = path.join(root, t.out);
		if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(source).mtimeMs) continue;
		execFileSync(csc, ["/nologo", "/optimize+", "/platform:anycpu", "/target:exe", `/out:${out}`, ...t.refs.map((r) => `/reference:${r}`), source], { stdio: quiet ? "pipe" : "inherit", windowsHide: true });
		built.push(out);
	}
	return built;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const built = buildNative();
	console.log(built.length ? `built ${built.map((f) => path.relative(root, f)).join(", ")}` : "native helpers are up to date");
}
