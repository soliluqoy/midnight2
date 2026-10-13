// Freeze the current public source, then run its host-owned unit suite without production profiles/networking.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { createSourceCapsule } from "../src/builder/source-capsule.mjs";
import { createBuildSandbox } from "../src/builder/build-sandbox.mjs";
import { CORE_VALIDATION_IMAGE } from "../src/builder/core-validation.mjs";
const workspace = fileURLToPath(new URL("..", import.meta.url)), temporaryRoot = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(temporaryRoot, "midnight-source-validation-"));
const docker = args => { const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 20_000 }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const image = docker(["image", "inspect", "--format", "{{.Id}}", process.env.MIDNIGHT_BUILD_IMAGE ?? CORE_VALIDATION_IMAGE]);
let report, sourceIdentity;
try {
	const lock = JSON.parse(fs.readFileSync(path.join(workspace, "package-lock.json"), "utf8")), dependency = lock.packages["node_modules/sqlite-vec-linux-x64"];
	const target = path.join(workspace, "node_modules/sqlite-vec-linux-x64");
	if (!fs.existsSync(target)) {
		const url = new URL(dependency.resolved); assert.equal(url.origin, "https://registry.npmjs.org"); assert.equal(url.username + url.password, "");
		const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" }); assert.equal(response.ok, true);
		const archive = Buffer.from(await response.arrayBuffer()); assert.ok(archive.length < 8 * 1024 * 1024);
		assert.equal(`sha512-${createHash("sha512").update(archive).digest("base64")}`, dependency.integrity, "declared Linux SQLite artifact matches the existing lockfile");
		const tar = gunzipSync(archive, { maxOutputLength: 16 * 1024 * 1024 }), files = new Map();
		for (let offset = 0; offset + 512 <= tar.length; ) {
			const header = tar.subarray(offset, offset + 512), name = header.subarray(0, 100).toString().split("\0")[0]; if (!name) break;
			const size = parseInt(header.subarray(124, 136).toString().replace(/\0/g, "").trim(), 8); assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length);
			if (["package/vec0.so", "package/package.json"].includes(name)) { assert.ok(header[156] === 0 || header[156] === 48); files.set(name.slice(8), tar.subarray(offset + 512, offset + 512 + size)); }
			offset += 512 + Math.ceil(size / 512) * 512;
		}
		assert.equal(files.size, 2); assert.equal(JSON.parse(files.get("package.json")).version, dependency.version);
		fs.mkdirSync(target); for (const [name, bytes] of files) fs.writeFileSync(path.join(target, name), bytes);
		console.log("PASS prepared the already-declared Linux SQLite dependency with its pinned integrity; no install scripts or lockfile changes");
	}
	const capsule = createSourceCapsule({ workspace, destination: path.join(root, "capsule") }), frozen = capsule.freeze(path.join(root, "frozen"));
	sourceIdentity = { sourceBase: capsule.digest, candidate: frozen.digest, files: frozen.files.length };
	fs.mkdirSync(path.join(frozen.root, "node_modules"));
	const proof = path.join(root, "proof"); fs.mkdirSync(proof);
	fs.writeFileSync(path.join(proof, "run-tests.mjs"), `import fs from 'node:fs'; import {run} from 'node:test'; import {spec} from 'node:test/reporters';
const files=[...fs.globSync('test/**/*.test.mjs',{cwd:'/work'})].map(name=>'/work/'+name);
const stream=run({files,concurrency:2,timeout:60000}); let summary;
stream.on('test:summary',value=>{if(value.file===undefined)summary=value});
stream.compose(spec()).pipe(process.stdout);
await new Promise(resolve=>stream.once('end',resolve));
console.log('SOURCE_VALIDATION_SUMMARY '+JSON.stringify(summary));
process.exitCode=summary?.success===true?0:1;
`);
	const sandbox = createBuildSandbox({ image, timeoutMs: 540_000, ownershipRoot: path.join(root, "ownership") });
	const result = await sandbox.run({ source: frozen.root, dependencies: path.join(workspace, "node_modules"), validation: proof, entry: "/proof/run-tests.mjs" });
	process.stdout.write(result.stdout); if (result.exitCode !== 0) process.stderr.write(result.stderr);
	const summaryLine = result.stdout.split(/\r?\n/).find(line => line.startsWith("SOURCE_VALIDATION_SUMMARY "));
	assert.ok(summaryLine, "host-owned suite produced its summary"); const summary = JSON.parse(summaryLine.slice("SOURCE_VALIDATION_SUMMARY ".length));
	assert.ok(summary?.counts?.tests >= 300, "the full current unit suite ran");
	assert.equal(capsule.inspect().digest, frozen.digest, "the candidate still matches its tested frozen bytes");
	report = { at: new Date().toISOString(), passed: result.exitCode === 0 && summary.success === true && summary.counts.failed === 0 && summary.counts.cancelled === 0, sourceBase: capsule.digest, candidate: frozen.digest, files: frozen.files.length, sourceBytes: frozen.files.reduce((sum, file) => sum + file.bytes, 0), image, policy: result.policy, counts: summary.counts, processesExited: result.processesExited, limitations: ["Current public source in a Linux container and existing declared dependencies; no Windows native/renderer build, signed installation or full core-repair UX claim.", "Host-owned tests/source/dependencies mount read-only and production profiles/credentials are absent; passing tests is not hostile-code certification or a general correctness proof.", "Source jobs and official patch proposals are connected separately; candidate Windows builds, native compilation, installed-source delivery and preview remain unfinished."] };
	assert.equal(report.passed, true, "the isolated current-source baseline passed");
} catch (error) {
	report ??= { at: new Date().toISOString(), passed: false, ...sourceIdentity, image, error: error.message, processesExited: error.diagnostics?.processesExited ?? false, diagnosticsTail: error.diagnostics?.stdout?.slice(-6000) };
	if (error.diagnostics) { process.stdout.write(error.diagnostics.stdout.slice(-6000)); process.stderr.write(error.diagnostics.stderr.slice(-2000)); }
	console.error(error.message); process.exitCode = 1;
} finally {
	const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), temporaryRoot); assert.match(path.basename(resolved), /^midnight-source-validation-[^/\\]+$/);
	fs.rmSync(root, { recursive: true, force: true });
	if (report && process.env.MIDNIGHT_TEST_REPORT) { const file = path.resolve(process.env.MIDNIGHT_TEST_REPORT); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2)); }
}
