import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerRecoveryProfile } from "../src/recovery/profile.mjs";

function owned(t) {
	const temporaryRoot = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(temporaryRoot, "midnight-recovery-unit-"));
	t.after(() => { const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), temporaryRoot); assert.ok(path.basename(resolved).startsWith("midnight-recovery-unit-")); fs.rmSync(resolved, { recursive: true, force: true }); });
	const profile = path.join(root, "profile"); fs.mkdirSync(profile); return { root, profile };
}
test("recovery profile registration owns a released lease and never replaces a newer owner", t => {
	const { profile } = owned(t), release = registerRecoveryProfile(profile), owner = path.join(profile, "recovery/shell-owner.json");
	assert.equal(fs.readFileSync(path.join(profile, "recovery/app-id"), "utf8").trim(), "app.midnight.capsule");
	assert.equal(JSON.parse(fs.readFileSync(owner, "utf8")).pid, process.pid);
	fs.writeFileSync(owner, JSON.stringify({ format: 1, pid: process.pid, token: "newer-owner" })); release(); release();
	assert.equal(JSON.parse(fs.readFileSync(owner, "utf8")).token, "newer-owner");
});
test("linked recovery directories cannot redirect registration outside the profile", t => {
	const { root, profile } = owned(t), outside = path.join(root, "other"); fs.mkdirSync(outside);
	fs.symlinkSync(outside, path.join(profile, "recovery"), process.platform === "win32" ? "junction" : "dir");
	assert.throws(() => registerRecoveryProfile(profile), /escaped/); assert.deepEqual(fs.readdirSync(outside), []);
});
test("shared hard-linked recovery lease files are refused without changing their target", t => {
	const { root, profile } = owned(t), outside = path.join(root, "sentinel"); fs.writeFileSync(outside, "untouched");
	fs.mkdirSync(path.join(profile, "recovery")); fs.linkSync(outside, path.join(profile, "recovery/operation.lock"));
	assert.throws(() => registerRecoveryProfile(profile), /private ordinary file/); assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
});
