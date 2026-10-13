// Parent owns read-only source/credential checks and removes its profile after the supervised app exits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { prepareReadOnlyWriter } from "./fixtures/cloud-writer.mjs";
const require = createRequire(import.meta.url), tempBase = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, "midnight-core-cloud-"));
const workspace = fileURLToPath(new URL("..", import.meta.url)), sourceFile = path.join(workspace, "src/scheduler/queue.mjs");
const hash = bytes => createHash("sha256").update(bytes).digest("hex"), sourceBefore = hash(fs.readFileSync(sourceFile));
let writer, child, exited = false, report;
try {
	writer = prepareReadOnlyWriter(root); const credential = await writer.credentials.read(writer.provider);
	if (credential.type === "oauth") assert.ok(credential.expires > Date.now() + 1_500_000, "Core qualification needs twenty-five minutes of already-fresh credentials; refresh is not authorized.");
	fs.writeFileSync(writer.core.authPath, JSON.stringify({ [writer.provider]: credential }), { mode: 0o600 }); const credentialBefore = hash(fs.readFileSync(writer.core.authPath));
	child = spawn(require("electron"), [fileURLToPath(new URL("./core-builder-cloud-runner.mjs", import.meta.url))], { cwd: workspace, windowsHide: true, env: { ...process.env, MIDNIGHT_CORE_CLOUD_ROOT: root, MIDNIGHT_CORE_DIR: writer.core.agentDir, MIDNIGHT_CORE_CLOUD_PROVIDER: writer.provider, MIDNIGHT_CORE_CLOUD_MODEL: writer.model } });
	let output = "", errors = "", buffer = "";
	child.stdout.on("data", bytes => { const text = bytes.toString(); output += text; buffer += text; const lines = buffer.split(/\r?\n/); buffer = lines.pop(); for (const line of lines) if (line.startsWith("[core-check] ") && !line.startsWith("[core-check] RESULT ")) console.log(line); });
	child.stderr.on("data", bytes => { errors += bytes.toString(); });
	let spawnError;
	const code = await new Promise(resolve => { child.once("error", error => { spawnError = error; }); child.once("close", value => { exited = true; resolve(value); }); });
	if (spawnError) throw spawnError;
	assert.equal(code, 0, output.split(/\r?\n/).find(line => line.startsWith("[core-check] FAIL ")) ?? errors.slice(-1500));
	const result = output.split(/\r?\n/).find(line => line.startsWith("[core-check] RESULT ")); assert.ok(result, "actual core builder produced its report");
	report = JSON.parse(result.slice("[core-check] RESULT ".length));
	writer.verifyUnchanged(); assert.equal(hash(fs.readFileSync(writer.core.authPath)), credentialBefore); assert.equal(hash(fs.readFileSync(sourceFile)), sourceBefore);
	report.installedCredentialsUnchanged = true; report.checkoutSourceUnchanged = true;
} catch (error) { report = { at: new Date().toISOString(), passed: false, error: error.message }; console.error(error.message); process.exitCode = 1; }
finally {
	try { writer?.verifyUnchanged(); } catch (error) { report = { ...report, passed: false, error: error.message }; process.exitCode = 1; } finally { writer?.close(); }
	if (exited || !child) { const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), tempBase); assert.match(path.basename(resolved), /^midnight-core-cloud-[^/\\]+$/); fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); if (report) report.disposableProfileRemoved = true; }
	if (report && process.env.MIDNIGHT_TEST_REPORT) { const file = path.resolve(process.env.MIDNIGHT_TEST_REPORT); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2)); }
}
