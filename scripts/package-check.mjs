// Inspect an actual built archive/executable, then launch it from outside the checkout with disposable data.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import asar from "@electron/asar";
import { getCurrentFuseWire, FuseV1Options, FuseState } from "@electron/fuses";
import { loadComponentCatalog } from "../src/inference/registry.mjs";

const workspace = fileURLToPath(new URL("..", import.meta.url));
const executable = path.resolve(process.argv[2] ?? "release/goal-packaging-v0.5.0/win-unpacked/midnight.exe"), archive = path.join(path.dirname(executable), "resources", "app.asar");
const sha = bytes => createHash("sha256").update(bytes).digest("hex"), checks = [];
const packed = filename => asar.extractFile(archive, path.normalize(filename));
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`); };
const required = ["src/main.mjs", "src/runtime/host-process.mjs", "src/desktop/recovery.mjs", "src/recovery/profile.mjs", "src/builder/process.mjs", "src/builder/turn.mjs", "src/desktop/plugin-executor.mjs", "src/plugins/catalog.mjs", "src/plugins/builtin/chart/manifest.json", "src/plugins/builtin/chart/renderer.js", "src/plugins/builtin/theme/manifest.json", "src/plugins/builtin/theme/renderer.js", "src/inference/components.json", "src/inference/components-public-key.pem", "src/voice/ptt-recorder.html", "src/voice/ptt-recorder.js", "src/voice/ptt-preload.cjs", "src/quick/index.html", "src/quick/preload.cjs"];
for (const filename of required) check(`current packaged ${filename}`, sha(packed(filename)) === sha(fs.readFileSync(path.join(workspace, filename))));
for (const filename of ["midnight-word.exe", "midnight-ptt.exe", "midnight-hotkey.exe", "midnight-ocr.exe", "midnight-mcp.exe", "midnight-recovery.exe"]) {
	const relative = `src/desktop/native/${filename}`, physical = path.join(`${archive}.unpacked`, relative);
	check(`owned native helper unpacked: ${filename}`, asar.statFile(archive, path.normalize(relative)).unpacked === true && sha(fs.readFileSync(physical)) === sha(fs.readFileSync(path.join(workspace, relative))));
}
const files = asar.listPackage(archive, {});
const runtimeFiles = files.filter(filename => /^[/\\]src[/\\]/.test(filename)).map(filename => filename.replace(/^[/\\]+/, "")).filter(filename => !Object.hasOwn(asar.statFile(archive, path.normalize(filename)), "files"));
check("every packaged runtime source and asset matches the current workspace", runtimeFiles.length > 100 && runtimeFiles.every(filename => sha(packed(filename)) === sha(fs.readFileSync(path.join(workspace, filename)))));
check("archive contains only runtime source, package metadata and dependencies", files.every(filename => /^[/\\](src|node_modules)([/\\]|$)/.test(filename) || /^[/\\]package\.json$/.test(filename)));
check("no development fixture or native compiler source shipped", !files.some(filename => /^[/\\]test[/\\]/.test(filename) || /[/\\]desktop[/\\]native[/\\].*\.cs$/.test(filename)));
const wordHelperBytes = fs.readFileSync(path.join(`${archive}.unpacked`, "src/desktop/native/midnight-word.exe"));
check("shipping Word helper excludes all development fixture modes and document markers", ["--fixture-paragraph", "--fixture-workflow", "--fixture-chart-probe", "PRIVATE_UNRELATED_LEAD"].every(marker => !wordHelperBytes.includes(Buffer.from(marker, "utf16le")) && !wordHelperBytes.includes(Buffer.from(marker, "utf8"))));
const recoveryExecutable = path.join(path.dirname(executable), "midnight-recovery.exe"), recoveryBytes = fs.readFileSync(recoveryExecutable);
check("standalone recovery executable is outside ASAR and matches its shipping source build", sha(recoveryBytes) === sha(fs.readFileSync(path.join(workspace, "src/desktop/native/midnight-recovery.exe"))));
check("shipping recovery helper excludes automated fixture mutation modes", ["--fixture-reset", "--fixture-signature"].every(marker => !recoveryBytes.includes(Buffer.from(marker, "utf16le"))));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "midnight-package-catalog-"));
let catalog;
try {
	const manifest = path.join(temporary, "catalog.json"), publicKey = path.join(temporary, "key.pem");
	fs.writeFileSync(manifest, packed("src/inference/components.json")); fs.writeFileSync(publicKey, packed("src/inference/components-public-key.pem"));
	catalog = loadComponentCatalog({ manifest, publicKey }); check("packaged local-model catalog has its valid signature", catalog.components.length > 0);
	const standalone = spawnSync(recoveryExecutable, ["--inspect", "--profile", temporary], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
	check("actual standalone packaged recovery runs without the main app or Node", standalone.status === 0 && JSON.parse(standalone.stdout).format === 1);
} finally { fs.rmSync(path.join(temporary, "catalog.json"), { force: true }); fs.rmSync(path.join(temporary, "key.pem"), { force: true }); fs.rmdirSync(temporary); }
const fuses = await getCurrentFuseWire(executable);
for (const name of ["RunAsNode", "EnableNodeOptionsEnvironmentVariable", "EnableNodeCliInspectArguments"]) check(`packaged fuse disabled: ${name}`, fuses[FuseV1Options[name]] === FuseState.DISABLE);
for (const name of ["EnableEmbeddedAsarIntegrityValidation", "OnlyLoadAppFromAsar"]) check(`packaged fuse enabled: ${name}`, fuses[FuseV1Options[name]] === FuseState.ENABLE);
const before = { archive: sha(fs.readFileSync(archive)), executable: sha(fs.readFileSync(executable)) };
const smoke = spawnSync(process.execPath, [fileURLToPath(new URL("./smoke.mjs", import.meta.url)), "--packaged", executable], { cwd: workspace, encoding: "utf8", timeout: 100_000 });
process.stdout.write(smoke.stdout ?? "");
check("actual packaged app starts from a disposable working directory", smoke.status === 0 && !smoke.error);
check("packaged archive/executable remain byte-identical after runtime checks", sha(fs.readFileSync(archive)) === before.archive && sha(fs.readFileSync(executable)) === before.executable);
const report = { at: new Date().toISOString(), passed: true, version: JSON.parse(packed("package.json").toString("utf8")).version, artifact: path.relative(workspace, executable), hashes: before, runtimeFiles: runtimeFiles.length, signedCatalogComponents: catalog.components.length, checks, smoke: (smoke.stdout ?? "").trim().split(/\r?\n/), limitations: ["Unsigned local directory build; not a signed installer, installed upgrade, publisher validation or release.", "Smoke uses synthetic data and disposable credentials/profile; it does not qualify real-provider repair quality or physical Word/microphone interactions."] };
if (process.env.MIDNIGHT_TEST_REPORT) { const file = path.resolve(process.env.MIDNIGHT_TEST_REPORT); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2)); }
