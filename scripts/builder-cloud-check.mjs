// Exercise the actual source or packaged app with synthetic builder requests and an owned disposable profile.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { prepareReadOnlyWriter } from "./fixtures/cloud-writer.mjs";
import { createPluginStore } from "../src/plugins/store.mjs";
import { createPluginRuntime } from "../src/plugins/runtime.mjs";

const workspace = fileURLToPath(new URL("..", import.meta.url)), require = createRequire(import.meta.url);
const index = process.argv.indexOf("--packaged"), packaged = index < 0 ? undefined : path.resolve(process.argv[index + 1]);
const executable = packaged ?? require("electron"), temporaryRoot = fs.realpathSync(os.tmpdir());
assert.equal(process.env.MIDNIGHT_TEST_CLOUD, "1", "Set MIDNIGHT_TEST_CLOUD=1 to run four real-model synthetic builder jobs.");
const root = fs.mkdtempSync(path.join(temporaryRoot, "midnight-builder-cloud-")), profile = path.join(root, "profile");
const hash = bytes => createHash("sha256").update(bytes).digest("hex"), checks = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); };
let writer, child, childExited = false, report, stdout = "";
try {
	writer = prepareReadOnlyWriter(root);
	// Only the selected route is copied. The source credential store is never handed to either app process.
	const credential = await writer.credentials.read(writer.provider);
	fs.writeFileSync(writer.core.authPath, JSON.stringify({ [writer.provider]: credential }), { mode: 0o600 });
	const credentialHash = hash(fs.readFileSync(writer.core.authPath));
	fs.mkdirSync(profile);
	fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ provider: writer.provider, model: writer.model, privacy: "cloud", thinking: "low", voice: false, pushToTalk: false, updates: "off", local: { enabled: false } }));
	const artifactFiles = packaged ? [packaged, path.join(path.dirname(packaged), "resources/app.asar")] : [];
	const artifactHashes = artifactFiles.map(file => hash(fs.readFileSync(file)));
	let lineBuffer = "";
	child = spawn(executable, packaged ? [] : [workspace], { cwd: root, windowsHide: true, env: { ...process.env, MIDNIGHT_SELFTEST: "", MIDNIGHT_PERF: "", MIDNIGHT_SMOKE: "1", MIDNIGHT_SMOKE_BUILDER: "1", MIDNIGHT_USER_DATA: profile, MIDNIGHT_CORE_DIR: writer.core.agentDir } });
	child.stdout.on("data", bytes => {
		const text = bytes.toString(); stdout += text; lineBuffer += text;
		const lines = lineBuffer.split(/\r?\n/); lineBuffer = lines.pop();
		for (const line of lines) if (/^\[builder-check\]/.test(line) && !line.startsWith("[builder-check] RESULT ")) console.log(line);
	});
	child.stderr.on("data", () => {});
	const result = await new Promise((resolve, reject) => {
		let spawnError;
		const timer = setTimeout(() => { child.kill(); }, 9 * 60_000);
		child.once("error", error => { spawnError = error; });
		child.once("close", (code, signal) => { childExited = true; clearTimeout(timer); spawnError ? reject(spawnError) : resolve({ code, signal }); });
	});
	assert.equal(result.code, 0, `Actual app qualification failed (${result.signal ?? result.code}); ${stdout.split(/\r?\n/).filter(line => /^\[builder-check\] FAIL/.test(line)).join(" ") || "inspect the builder job artifacts"}`);
	const line = stdout.split(/\r?\n/).find(value => value.startsWith("[builder-check] RESULT "));
	assert.ok(line, "the actual app completed its fixed qualification");
	const outcome = JSON.parse(line.slice("[builder-check] RESULT ".length));
	check("four real-model jobs complete through the actual app engine and separate builder process", outcome.jobs.length === 4);
	const data = path.join(profile, "missions"), store = createPluginStore({ root: path.join(data, "plugins") });
	const runtime = createPluginRuntime({ store, execute: () => { throw new Error("A persisted color preset must not execute generated code to paint."); } });
	check("accepted private components survive process exit and store restart", store.bindings().bindings["chart.bar"].digest === outcome.activeChart.digest && store.bindings().bindings["ui.colors"].digest === outcome.activeTheme.digest);
	check("persisted private colors load without generated-code execution", runtime.themePreset(outcome.activeTheme).tokens.accent === "#176b65");
	const tools = new Set(["builder_read", "builder_write", "builder_validate", "builder_diff"]);
	for (const job of outcome.jobs) {
		const directory = path.join(data, "changes", job.id), persisted = JSON.parse(fs.readFileSync(path.join(directory, "job.json"), "utf8"));
		const candidateVersion = store.get(persisted.candidate.digest).manifest.version, baseVersion = store.get(persisted.base.digest).manifest.version;
		check(`${job.scope} ${job.pluginId} used the exact configured route and changed its version`, persisted.route.provider === writer.provider && persisted.route.model === writer.model && candidateVersion !== baseVersion);
		const session = fs.readFileSync(persisted.sessionFile, "utf8").trim().split(/\r?\n/).map(value => JSON.parse(value));
		const assistants = session.map(value => value.message).filter(value => value?.role === "assistant"), calls = assistants.flatMap(value => value.content ?? []).filter(value => value.type === "toolCall");
		check(`${job.scope} ${job.pluginId} used only maintenance tools with actual provider usage`, calls.length > 0 && calls.every(value => tools.has(value.name)) && persisted.usage?.modelCalls > 0 && persisted.usage?.tokens > 0);
		check(`${job.scope} ${job.pluginId} provider messages match the configured model`, assistants.length > 0 && assistants.every(value => value.provider === writer.provider && value.model === writer.model));
		if (job.scope === "official") {
			const proposal = JSON.parse(fs.readFileSync(path.join(persisted.officialPath, "candidate.json"), "utf8"));
			check(`official ${job.pluginId} has an exact source patch and candidate`, proposal.candidate.digest === job.candidate.digest && fs.readFileSync(path.join(persisted.officialPath, "source.patch"), "utf8").includes(`+++ b/${proposal.target}/renderer.js`));
		}
		job.modelCalls = persisted.usage.modelCalls; job.tokens = persisted.usage.tokens; job.baseVersion = baseVersion; job.candidateVersion = candidateVersion;
	}
	const other = createPluginStore({ root: path.join(root, "other-profile/plugins") });
	check("customizations remain isolated from another profile", other.bindings().bindings["ui.colors"].digest === other.bases["ui.colors"].digest && other.bindings().bindings["chart.bar"].digest === other.bases["chart.bar"].digest);
	writer.verifyUnchanged(); check("installed settings/credentials and the disposable copied credential stay unchanged", hash(fs.readFileSync(writer.core.authPath)) === credentialHash);
	check("packaged executable and archive stay unchanged", artifactFiles.every((file, i) => hash(fs.readFileSync(file)) === artifactHashes[i]));
	report = { at: new Date().toISOString(), passed: true, packagedDirectory: !!packaged, provider: writer.provider, model: writer.model, authType: writer.authType, checks: [...outcome.checks, ...checks], jobs: outcome.jobs, limitations: ["Four synthetic requests on two registered components; no arbitrary core/build/dependency repair or broad coding-quality claim.", "Actual app/engine/utility process and Chromium sandbox run with a disposable profile; no production activation, source merge, installation or publication.", "Existing credentials are copied only for the selected route and checked unchanged; no login, refresh or account modification is authorized.", "Directory build qualification does not establish signed installation, upgrades, recovery UI, physical microphone/Word use or full-day performance."] };
} catch (error) {
	report = { at: new Date().toISOString(), passed: false, packagedDirectory: !!packaged, checks: [...stdout.split(/\r?\n/).filter(line => line.startsWith("[builder-check] PASS ")).map(line => line.slice("[builder-check] PASS ".length)), ...checks], error: error.message };
	console.error(error.message); process.exitCode = 1;
} finally {
	try { writer?.verifyUnchanged(); }
	catch (error) { process.exitCode = 1; report = { ...report, passed: false, error: error.message }; }
	finally { writer?.close(); }
	if (!child || childExited) {
		const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), temporaryRoot); assert.match(path.basename(resolved), /^midnight-builder-cloud-[^/\\]+$/);
		fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		if (report) report.disposableProfileRemoved = true;
	}
	if (report && process.env.MIDNIGHT_TEST_REPORT) { const file = path.resolve(process.env.MIDNIGHT_TEST_REPORT); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2)); }
}
