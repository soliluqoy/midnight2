import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers.mjs";
import { createSourceCapsule, openSourceCapsule } from "../src/builder/source-capsule.mjs";
function fixture() {
	const root = tempDir("source-capsule"), workspace = path.join(root, "workspace");
	for (const directory of ["src", "test", "scripts", "vendor"]) fs.mkdirSync(path.join(workspace, directory), { recursive: true });
	for (const [name, text] of [["package.json", '{"version":"1.2.3"}'], ["package-lock.json", "{}"], ["src/main.mjs", "export const ready=true;"], ["src/helper.cs", "class Helper {}"], ["test/protected.test.mjs", "host-owned tests"], ["scripts/build.mjs", "host-owned build"], ["vendor/sdk.tgz", "fixed dependency"]]) fs.writeFileSync(path.join(workspace, name), text);
	fs.writeFileSync(path.join(workspace, "auth.json"), "PRIVATE_CREDENTIAL_SENTINEL"); fs.mkdirSync(path.join(workspace, "reports")); fs.writeFileSync(path.join(workspace, "reports/private.json"), "PRIVATE_MISSION_SENTINEL");
	return { root, workspace, capsule: createSourceCapsule({ workspace, destination: path.join(root, "capsule") }) };
}
test("exact source bases exclude unrelated profiles, isolate edits and retain identities across restart", () => {
	const { workspace, capsule } = fixture(); assert.equal(capsule.version, "1.2.3"); assert.equal(capsule.inspect().changed.length, 0);
	assert.equal(capsule.list().some(file => /auth|reports/.test(file.path)), false);
	capsule.write("src/main.mjs", "export const ready=false;"); capsule.write("src/new-feature.mjs", "export const enabled=true;");
	assert.equal(fs.readFileSync(path.join(workspace, "src/main.mjs"), "utf8"), "export const ready=true;");
	const restarted = openSourceCapsule(capsule.root); assert.equal(restarted.digest, capsule.digest); assert.equal(restarted.inspect().digest, capsule.inspect().digest);
	assert.deepEqual(restarted.inspect().changed, ["src/main.mjs", "src/new-feature.mjs"]); assert.deepEqual(restarted.inspect().kernelChanges, ["src/main.mjs"]);
});
test("source maintenance refuses path escapes, host validation, dependencies, binary edits and linked replacements", () => {
	const { root, capsule } = fixture();
	for (const name of ["../auth.json", "src/../auth.json", "src\\main.mjs", "C:/auth.json", "/src/main.mjs", "src/CON.js", "src/foo.js:", "test/protected.test.mjs", "package.json", "vendor/sdk.tgz", "src/helper.exe"]) assert.throws(() => capsule.write(name, "escaped"));
	const outside = path.join(root, "outside.mjs"); fs.writeFileSync(outside, "UNCHANGED_OUTSIDE"); fs.unlinkSync(path.join(capsule.candidate, "src/main.mjs")); fs.linkSync(outside, path.join(capsule.candidate, "src/main.mjs"));
	assert.throws(() => capsule.write("src/main.mjs", "mutated"), /linked/); assert.throws(() => capsule.inspect(), /linked/); assert.equal(fs.readFileSync(outside, "utf8"), "UNCHANGED_OUTSIDE");
});
test("stale base bytes and out-of-band validation changes cannot acquire a candidate identity", () => {
	const first = fixture().capsule; fs.writeFileSync(path.join(first.base, "src/main.mjs"), "forged base"); assert.throws(() => first.inspect(), /base bytes/);
	const second = fixture().capsule; fs.writeFileSync(path.join(second.candidate, "test/protected.test.mjs"), "forged pass"); assert.throws(() => second.inspect(), /host-owned/);
	const third = fixture().capsule; third.write("src/helper.cs", "class ChangedHelper {}"); assert.equal(third.inspect().requiresNativeBuild, true);
});
test("capture refuses linked origins, over-budget sources and a destination in the checkout", () => {
	const { root, workspace } = fixture(); assert.throws(() => createSourceCapsule({ workspace, destination: path.join(workspace, "capture") }), /outside/);
	assert.throws(() => createSourceCapsule({ workspace, destination: path.join(root, "tiny"), maxBytes: 1 }), /byte budget/); assert.equal(fs.existsSync(path.join(root, "tiny")), false);
	const outside = path.join(root, "external.mjs"); fs.writeFileSync(outside, "outside"); fs.linkSync(outside, path.join(workspace, "src/linked.mjs"));
	assert.throws(() => createSourceCapsule({ workspace, destination: path.join(root, "linked") }), /linked/);
});
test("source deletions, case aliases, recorded-base identity and frozen candidates remain exact", () => {
	const { root, capsule } = fixture(); assert.throws(() => capsule.write("src/Main.mjs", "alias"), /alias/);
	assert.throws(() => openSourceCapsule(capsule.root, { expectedDigest: `sha256:${"a".repeat(64)}` }), /recorded repair base/);
	capsule.remove("src/main.mjs"); assert.deepEqual(capsule.inspect().changed, ["src/main.mjs"]); assert.throws(() => capsule.remove("test/protected.test.mjs"), /src text/);
	capsule.write("src/replacement.mjs", "export const ready=true;"); const frozen = capsule.freeze(path.join(root, "frozen"));
	capsule.write("src/replacement.mjs", "export const ready=false;"); assert.equal(fs.readFileSync(path.join(frozen.root, "src/replacement.mjs"), "utf8"), "export const ready=true;");
	fs.writeFileSync(path.join(capsule.candidate, "unexpected-auth.json"), "private outside index"); assert.throws(() => capsule.inspect(), /file set/);
});
test("literal source patches preserve unrelated bytes and line endings, refusing stale and ambiguous matches", () => {
	const { capsule } = fixture();
	capsule.write("src/new.mjs", "// unchanged\r\nexport const ready = false;\r\n// unchanged tail\r\n");
	const before = capsule.read("src/new.mjs"), digest = capsule.inspect().files.find(file => file.path === "src/new.mjs").sha256;
	capsule.patch("src/new.mjs", { expectedSha256: digest, find: "ready = false", replace: "ready = true" });
	assert.equal(capsule.read("src/new.mjs"), before.replace("ready = false", "ready = true"));
	assert.throws(() => capsule.patch("src/new.mjs", { expectedSha256: digest, find: "ready = true", replace: "ready = false" }), /changed after/);
	const current = capsule.inspect().files.find(file => file.path === "src/new.mjs").sha256;
	assert.throws(() => capsule.patch("src/new.mjs", { expectedSha256: current, find: "unchanged", replace: "changed" }), /exactly one/);
	assert.throws(() => capsule.patch("src/new.mjs", { expectedSha256: current, find: "", replace: "injected" }), /bounded literal/);
	capsule.write("src/new.mjs", capsule.read("src/new.mjs").replace(/\r\n/g, "\n")); assert.equal(capsule.read("src/new.mjs").includes("\r\n"), true);
});
