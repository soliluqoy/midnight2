// Read-only existing credentials for opt-in real-provider qualifications. No refresh, login, fallback or writes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { corePaths } from "../../src/runtime/paths.mjs";

export function prepareReadOnlyWriter(directory) {
	assert.equal(process.env.MIDNIGHT_TEST_CLOUD, "1", "Set MIDNIGHT_TEST_CLOUD=1 to use the configured writer on synthetic fixture text.");
	const installed = corePaths(), authBytes = fs.readFileSync(installed.authPath);
	const settingsFile = process.env.MIDNIGHT_TEST_SETTINGS ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "midnight", "settings.json");
	const settingsBytes = fs.readFileSync(settingsFile), selected = JSON.parse(settingsBytes.toString("utf8"));
	const { provider, model } = selected, credential = JSON.parse(authBytes.toString("utf8"))[provider];
	assert.equal(selected.privacy, "cloud", "qualification respects the configured privacy route");
	assert.ok(provider && model && credential, "an exact configured writer and credential are required");
	const hash = bytes => createHash("sha256").update(bytes).digest("hex"), authHash = hash(authBytes), settingsHash = hash(settingsBytes);
	let closed = false;
	function fresh(signal) {
		signal?.throwIfAborted();
		assert.equal(closed, false, "the qualification credential store is closed");
		if (credential.type === "oauth" && !(credential.expires > Date.now() + 600_000)) throw new Error("The existing OAuth credential is too near expiry for a read-only qualification.");
	}
	fresh();
	const credentials = {
		async read(id, options) { fresh(options?.signal); return id === provider ? structuredClone(credential) : undefined; },
		async list(options) { fresh(options?.signal); return [{ providerId: provider, type: credential.type }]; },
		async modify() { throw new Error("Credential refresh/modification is disabled in this qualification."); },
		async delete() { throw new Error("Credential deletion is disabled in this qualification."); },
	};
	const core = corePaths(path.join(directory, "core"));
	fs.mkdirSync(core.agentDir, { recursive: true });
	for (const key of ["modelsPath", "modelsStorePath"]) if (fs.existsSync(installed[key])) fs.copyFileSync(installed[key], core[key]);
	return {
		core, provider, model, credentials, authType: credential.type,
		verifyUnchanged() { assert.equal(hash(fs.readFileSync(installed.authPath)), authHash, "installed credential bytes stay unchanged"); assert.equal(hash(fs.readFileSync(settingsFile)), settingsHash, "installed settings stay unchanged"); },
		close() { closed = true; authBytes.fill(0); settingsBytes.fill(0); },
	};
}
