// Own the disposable profile outside Electron so Chromium's files can be removed after actual process exit.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

assert.equal(process.env.MIDNIGHT_TEST_CLOUD, "1", "Set MIDNIGHT_TEST_CLOUD=1 to qualify one synthetic paragraph with the configured cloud writer.");
assert.ok(process.env.MIDNIGHT_TEST_VOICE_DATA, "Set MIDNIGHT_TEST_VOICE_DATA to an existing prepared voice cache; downloads are refused.");
const require = createRequire(import.meta.url), temporaryRoot = fs.realpathSync(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, "midnight-word-voice-cloud-")), resultFile = path.join(profile, "result.json");
let report = { at: new Date().toISOString(), passed: false, failedStage: "electron-runner", limitations: ["Raw runner/provider errors are suppressed."] };
try {
	const runner = spawnSync(require("electron"), [fileURLToPath(new URL("./word-voice-cloud-runner.mjs", import.meta.url))], { env: { ...process.env, MIDNIGHT_TEST_WORKFLOW_PROFILE: profile, MIDNIGHT_TEST_REPORT: resultFile }, cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 150_000, maxBuffer: 2 * 1024 * 1024 });
	for (const line of (runner.stdout ?? "").split(/\r?\n/)) if (line.startsWith("PASS ")) console.log(line);
	if (fs.existsSync(resultFile)) report = JSON.parse(fs.readFileSync(resultFile, "utf8"));
	if (runner.status !== 0 || runner.error) { report.passed = false; report.runnerExit = runner.status; report.runnerErrorCode = runner.error?.code; }
} catch (error) {
	report.passed = false; report.runnerErrorCode = error.code;
} finally {
	const resolved = fs.realpathSync(profile); assert.equal(path.dirname(resolved), temporaryRoot); assert.ok(path.basename(resolved).startsWith("midnight-word-voice-cloud-"));
	try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); report.disposableProfileRemoved = true; }
	catch (error) { report.passed = false; report.cleanupFailures = [...(report.cleanupFailures ?? []), { stage: "parent-profile-cleanup", type: error.name, code: error.code }]; }
}
if (process.env.MIDNIGHT_TEST_REPORT) { const file = path.resolve(process.env.MIDNIGHT_TEST_REPORT); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report)); process.exitCode = report.passed ? 0 : 1;
