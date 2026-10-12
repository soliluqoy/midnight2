// Starts the real app against a throwaway profile and credential folder, waits for the engine, checks the capsule
// rendered without errors, and exits. Never touches your real settings or sign-ins.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "midnight-smoke-"));
fs.mkdirSync(path.join(tmp, "core"));
// `node scripts/smoke.mjs --packaged release/win-unpacked/midnight.exe` checks a built app (asar, fuses, unpacked helpers).
const packaged = process.argv.includes("--packaged") ? path.resolve(process.argv[process.argv.indexOf("--packaged") + 1]) : undefined;
const r = spawnSync(packaged ?? require("electron"), packaged ? [] : ["."], {
	cwd: path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([a-z]:)/i, "$1")),
	env: { ...process.env, MIDNIGHT_SMOKE: "1", MIDNIGHT_USER_DATA: path.join(tmp, "profile"), MIDNIGHT_CORE_DIR: path.join(tmp, "core") },
	encoding: "utf8",
	timeout: 90000,
});
process.stdout.write((r.stdout ?? "").split("\n").filter((l) => l.startsWith("[smoke]")).join("\n") + "\n");
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(r.status ?? 1);
