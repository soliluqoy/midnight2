import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSourceWorkspaceWorker } from "../src/builder/source-workspace.mjs";
import { tempDir } from "./helpers.mjs";
import { until } from "./e2e-helpers.mjs";

function fixture() {
	const root = tempDir("source-workspace"), directory = path.join(root, "job"), source = path.join(root, "public"); fs.mkdirSync(directory);
	for (const name of ["src", "test", "scripts", "vendor"]) fs.mkdirSync(path.join(source, name), { recursive: true });
	for (const [name, content] of [["package.json", '{"version":"1.0.0"}'], ["package-lock.json", "{}"], ["src/main.mjs", "export const ready = false;\r\n"], ["test/fixed.test.mjs", "host-owned checks"], ["scripts/build.mjs", "host-owned build"], ["vendor/PROVENANCE.json", "{}"]]) fs.writeFileSync(path.join(source, name), content);
	return { root, directory, source };
}
test("an actual source worker captures and patches only its candidate without executing source modules", async t => {
	const f = fixture(), outside = path.join(f.root, "executed");
	fs.writeFileSync(path.join(f.source, "src/execute.mjs"), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(outside)},'candidate executed');`);
	const worker = createSourceWorkspaceWorker({ directory: f.directory, sourceRoot: f.source }); t.after(() => worker.close());
	const base = await worker.call("capture"); assert.equal(base.version, "1.0.0"); assert.equal(worker.status().exited, false);
	const file = await worker.call("read", { filename: "src/main.mjs" });
	await worker.call("patch", { filename: file.filename, expectedSha256: file.sha256, find: "ready = false", replace: "ready = true" });
	await assert.rejects(worker.call("write", { filename: "test/fixed.test.mjs", text: "forged checks" }), /src text/);
	const prepared = await worker.call("prepare-validation");
	assert.equal(fs.readFileSync(path.join(prepared.frozen.root, "src/main.mjs"), "utf8"), "export const ready = true;\r\n");
	const result = { ok: true, processesExited: true, digest: prepared.frozen.digest, baseDigest: base.digest };
	const validation = await worker.call("finish-validation", { result }), proposed = await worker.call("propose", { validation });
	assert.equal(proposed.candidate.digest, prepared.frozen.digest); assert.equal(proposed.windowsBuild, "pending"); assert.equal(fs.existsSync(outside), false);
	assert.equal(fs.readFileSync(path.join(f.source, "src/main.mjs"), "utf8"), "export const ready = false;\r\n");
	await worker.close(); assert.equal(worker.status().exited, true);
});
test("a lost capture reply adopts the complete immutable base on resume instead of overwriting it", async t => {
	const f = fixture(), first = createSourceWorkspaceWorker({ directory: f.directory, sourceRoot: f.source });
	const base = await first.call("capture"); await first.close();
	fs.writeFileSync(path.join(f.source, "src/main.mjs"), "a later app version");
	const resumed = createSourceWorkspaceWorker({ directory: f.directory, sourceRoot: f.source }); t.after(() => resumed.close());
	const adopted = await resumed.call("capture"); assert.equal(adopted.digest, base.digest);
	assert.equal((await resumed.call("read", { filename: "src/main.mjs" })).text, "export const ready = false;\r\n");
});
test("a partial capture stays separate and explicit resume captures into a fresh staging directory", async t => {
	const f = fixture(), partial = path.join(f.directory, "source-old.partial"); fs.mkdirSync(partial); fs.writeFileSync(path.join(partial, "incomplete"), "preserved");
	const worker = createSourceWorkspaceWorker({ directory: f.directory, sourceRoot: f.source }); t.after(() => worker.close());
	await worker.call("capture"); assert.equal(fs.readFileSync(path.join(partial, "incomplete"), "utf8"), "preserved");
	assert.equal((await worker.call("read", { filename: "src/main.mjs" })).text, "export const ready = false;\r\n");
});
test("cancelled source operations reject late replies and retain ownership until actual worker exit", async () => {
	const f = fixture(), fake = new EventEmitter(), controller = new AbortController(); let sent, terminateCalls = 0, options;
	fake.postMessage = message => { sent = message; }; fake.terminate = () => { terminateCalls++; return Promise.resolve(1); }; fake.threadId = 55;
	const worker = createSourceWorkspaceWorker({ directory: f.directory, sourceRoot: f.source, signal: controller.signal, workerFactory: value => { options = value; return fake; } });
	let settled = false; const pending = worker.call("capture"), rejected = assert.rejects(pending, /owned cancellation/).then(() => { settled = true; }); await until(() => sent);
	controller.abort(new Error("owned cancellation")); const closing = worker.close(); fake.emit("message", { id: sent.id, ok: true, result: { forged: true } });
	await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.equal(worker.status().exited, false); assert.equal(terminateCalls, 1);
	assert.deepEqual(options.env, {}); assert.deepEqual(options.execArgv, []); assert.equal(options.resourceLimits.maxOldGenerationSizeMb, 128);
	fake.emit("exit", 1); await closing; await rejected; assert.equal(worker.status().exited, true);
});
