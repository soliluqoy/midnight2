import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createUpdater, trustedInstaller } from "../src/desktop/updater.mjs";

const signer = "CN=midnight Publisher, O=midnight";
const sigs = (map) => async (file) => map[file.endsWith(".exe") && !file.includes("midnight-setup") ? "self" : "installer"];

test("an installer must be signed by the same publisher as the running app", async () => {
	const self = { valid: true, signer };
	assert.deepEqual(await trustedInstaller("C:/t/midnight-setup-1.exe", { current: "C:/app/midnight.exe", verify: sigs({ self, installer: { valid: true, signer } }) }), { ok: true, signer });
	assert.match((await trustedInstaller("C:/t/midnight-setup-1.exe", { current: "C:/app/midnight.exe", verify: sigs({ self, installer: { valid: true, signer: "CN=Someone Else" } }) })).reason, /not by this app's publisher/);
	assert.match((await trustedInstaller("C:/t/midnight-setup-1.exe", { current: "C:/app/midnight.exe", verify: sigs({ self, installer: { valid: false, status: "NotSigned" } }) })).reason, /not signed/);
	assert.match((await trustedInstaller("C:/t/midnight-setup-1.exe", { current: "C:/app/midnight.exe", verify: sigs({ self: { valid: false }, installer: { valid: true, signer } }) })).reason, /this copy of midnight is not signed/);
});

test("updates install only a hash-matching installer from a trusted publisher, never mid-mission", async () => {
	const installer = Buffer.from("installer bytes");
	const sha = createHash("sha512").update(installer).digest("base64");
	let manifest = `version: 9.9.9\nfiles:\n  - url: midnight-setup-x64.exe\n    sha512: ${sha}\n`;
	const fetchImpl = async (url) => {
		if (url.includes("api.github.com")) return { ok: true, json: async () => ({ tag_name: "v9.9.9", html_url: "https://github.com/x/releases/v9.9.9", assets: [{ name: "midnight-setup-x64.exe", browser_download_url: "https://dl/setup.exe" }, { name: "latest.yml", browser_download_url: "https://dl/latest.yml" }] }) };
		if (url.endsWith("latest.yml")) return { ok: true, text: async () => manifest };
		return { ok: true, arrayBuffer: async () => installer.buffer.slice(installer.byteOffset, installer.byteOffset + installer.length) };
	};
	const launched = [];
	const pages = [];
	let busy = false;
	let trusted = { ok: true, signer };
	const u = createUpdater({ version: "0.4.0", fetchImpl, isBusy: async () => busy, backup: async () => {}, launch: (f) => launched.push(f), openPage: (p) => pages.push(p), trust: async () => trusted });
	busy = true;
	assert.match((await u.install()).reason, /working on a mission/);
	busy = false;
	manifest = manifest.replace(sha, "AAAA");
	assert.match((await u.install()).reason, /does not match the release manifest/);
	manifest = manifest.replace("AAAA", sha);
	trusted = { ok: false, reason: 'the installer is signed by "CN=Someone Else", not by this app\'s publisher' };
	assert.match((await u.install()).reason, /Not installed: .*not by this app's publisher/);
	assert.equal(launched.length, 0);
	trusted = { ok: true, signer };
	assert.deepEqual(await u.install(), { ok: true, version: "9.9.9" });
	assert.equal(launched.length, 1);
	assert.match(launched[0], /midnight-update-.*midnight-setup-9\.9\.9\.exe$/, "the installer sits in a private folder");
});
