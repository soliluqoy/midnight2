// Node parent owns cleanup after Electron and its supervised workers exit.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url), temporaryRoot = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(temporaryRoot, "midnight-builder-scheduling-"));
const result = spawnSync(require("electron"), [fileURLToPath(new URL("./builder-scheduling-runner.mjs", import.meta.url))], { env: { ...process.env, MIDNIGHT_SCHEDULING_ROOT: root }, encoding: "utf8", windowsHide: true, timeout: 30_000 });
process.stdout.write(result.stdout ?? "");
if (result.status !== 0) { process.stderr.write(result.stderr ?? ""); process.exitCode = 1; }
const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), temporaryRoot); assert.match(path.basename(resolved), /^midnight-builder-scheduling-[^/\\]+$/);
fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
