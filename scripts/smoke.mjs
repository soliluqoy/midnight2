// Starts the real app against a throwaway profile and credential folder, waits for the engine, checks the capsule
// rendered without errors, and exits. Never touches your real settings or sign-ins.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const temporaryRoot = fs.realpathSync(os.tmpdir());
const tmp = fs.mkdtempSync(path.join(temporaryRoot, "midnight-smoke-"));
fs.mkdirSync(path.join(tmp, "core"));
fs.mkdirSync(path.join(tmp, "profile"));
fs.writeFileSync(path.join(tmp, "profile", "settings.json"), JSON.stringify({ privacy: "offline", voice: false, pushToTalk: false, updates: "off", local: { enabled: false } }));
// `node scripts/smoke.mjs --packaged release/win-unpacked/midnight.exe` checks a built app (asar, fuses, unpacked helpers).
const packaged = process.argv.includes("--packaged") ? path.resolve(process.argv[process.argv.indexOf("--packaged") + 1]) : undefined;
const r = spawnSync(packaged ?? require("electron"), packaged ? [] : ["."], {
	cwd: packaged ? tmp : path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([a-z]:)/i, "$1")),
	env: { ...process.env, MIDNIGHT_SMOKE: "1", MIDNIGHT_USER_DATA: path.join(tmp, "profile"), MIDNIGHT_CORE_DIR: path.join(tmp, "core") },
	encoding: "utf8",
	timeout: 90000,
});
process.stdout.write((r.stdout ?? "").split("\n").filter((l) => l.startsWith("[smoke]")).join("\n") + "\n");
if (r.status !== 0) { process.stderr.write(r.stderr ?? ""); if (r.error) console.error(r.error.message); }
assert.match(path.relative(temporaryRoot, fs.realpathSync(tmp)), /^midnight-smoke-[^/\\]+$/, "Cleanup must stay in the owned disposable profile directory.");
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(r.status ?? 1);
