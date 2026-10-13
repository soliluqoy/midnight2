// Supervise owned Electron utility-process qualification, optionally loading the shipped ASAR modules.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const workspace = fileURLToPath(new URL("..", import.meta.url)), temporary = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(temporary, "midnight-source-worker-")), packaged = process.argv.indexOf("--packaged");
const runtimeRoot = packaged < 0 ? workspace : path.join(path.dirname(path.resolve(process.argv[packaged + 1])), "resources/app.asar");
let exited = false, report;
try {
	const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(new URL("./fixtures/source-worker-bootstrap.mjs", import.meta.url))], { cwd: root, windowsHide: true, env: { ...process.env, MIDNIGHT_SOURCE_QUAL_ROOT: root, MIDNIGHT_SOURCE_QUAL_ORIGIN: workspace, MIDNIGHT_SOURCE_QUAL_RUNTIME: runtimeRoot, MIDNIGHT_CORE_DIR: path.join(root, "core") } });
	let output = "", errors = "", buffer = "", spawnError;
	child.stdout.on("data", bytes => { const text = bytes.toString(); output += text; buffer += text; const lines = buffer.split(/\r?\n/); buffer = lines.pop(); for (const line of lines) if (line.startsWith("[source-worker] ") && !line.startsWith("[source-worker] RESULT ")) console.log(line); });
	child.stderr.on("data", bytes => { errors = (errors + bytes.toString()).slice(-2000); });
	const code = await new Promise(resolve => { child.once("error", error => { spawnError = error; }); child.once("close", value => { exited = true; resolve(value); }); });
	if (spawnError) throw spawnError;
	const result = output.split(/\r?\n/).find(line => line.startsWith("[source-worker] RESULT ")); if (result) report = JSON.parse(result.slice("[source-worker] RESULT ".length));
	assert.equal(code, 0, output.split(/\r?\n/).find(line => line.startsWith("[source-worker] FAIL ")) ?? errors); assert.ok(result, "source worker qualification produced its result");
} catch (error) { report = { ...report, at: new Date().toISOString(), passed: false, error: error.message }; console.error(error.message); process.exitCode = 1; }
finally {
	if (exited) { const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), temporary); assert.match(path.basename(resolved), /^midnight-source-worker-[^/\\]+$/); fs.rmSync(resolved, { recursive: true, force: true }); if (report) report.disposableProfileRemoved = true; }
	if (report && process.env.MIDNIGHT_TEST_REPORT) { const file = path.resolve(process.env.MIDNIGHT_TEST_REPORT); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2)); }
}
