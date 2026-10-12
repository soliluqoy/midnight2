// Safe updates (plan ch. 23, D01). Checks the public release feed at most once a day (or when asked), never installs
// in the middle of work: only at a checkpoint with no mission running or waiting, after a fresh backup, and only an
// installer whose SHA-512 matches the release manifest and whose Authenticode signature is valid. Unsigned builds are
// never auto-installed; the release page opens instead.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = "soliluqoy/midnight2";
const newer = (a, b) => {
	const pa = a.replace(/^v/, "").split(".").map(Number);
	const pb = b.replace(/^v/, "").split(".").map(Number);
	for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
	return false;
};

export function verifySignature(file) {
	if (process.platform !== "win32") return Promise.resolve({ valid: false, reason: "signature checks run on Windows" });
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", `(Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}') | Select-Object Status,@{n='Signer';e={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress`],
			{ windowsHide: true, timeout: 30000 },
			(err, out) => {
				if (err) return resolve({ valid: false, reason: err.message });
				try {
					const j = JSON.parse(out);
					resolve({ valid: j.Status === 0 || j.Status === "Valid", signer: j.Signer, status: j.Status });
				} catch {
					resolve({ valid: false, reason: "could not read the signature" });
				}
			},
		);
	});
}

/**
 * An installer may only replace this app if it is validly signed by the same publisher that signed the running
 * app: a release asset signed by anyone else (a stolen release token with its own certificate) is refused.
 */
export async function trustedInstaller(file, { current = process.execPath, verify = verifySignature } = {}) {
	const [mine, theirs] = await Promise.all([verify(current), verify(file)]);
	if (!theirs.valid) return { ok: false, reason: `the installer is not signed (${theirs.reason ?? theirs.status})` };
	if (!mine.valid || !mine.signer) return { ok: false, reason: "this copy of midnight is not signed, so a signed installer cannot be matched to it" };
	if (theirs.signer !== mine.signer) return { ok: false, reason: `the installer is signed by "${theirs.signer}", not by this app's publisher` };
	return { ok: true, signer: theirs.signer };
}

/**
 * @param {{ version: string, fetchImpl?: typeof fetch, isBusy: () => Promise<boolean>, backup: () => Promise<any>, launch: (file: string) => void, openPage: (url: string) => void, trust?: typeof trustedInstaller }} o
 */
export function createUpdater(o) {
	const fetchImpl = o.fetchImpl ?? fetch;
	const trust = o.trust ?? trustedInstaller;
	let last = { checkedAt: 0, latest: undefined, error: undefined };

	async function check({ force = false } = {}) {
		if (!force && Date.now() - last.checkedAt < 24 * 3600000) return last;
		try {
			const r = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "midnight-updater" }, signal: AbortSignal.timeout(10000) });
			if (!r.ok) throw new Error(`release feed answered ${r.status}`);
			const rel = await r.json();
			const version = String(rel.tag_name ?? "").replace(/^v/, "");
			const asset = (n) => rel.assets?.find((a) => a.name === n)?.browser_download_url;
			last = { checkedAt: Date.now(), latest: version, available: newer(version, o.version), page: rel.html_url, installer: asset("midnight-setup-x64.exe"), manifest: asset("latest.yml") };
		} catch (err) {
			last = { ...last, checkedAt: Date.now(), error: String(err.message ?? err) };
		}
		return last;
	}

	async function install() {
		const info = await check({ force: true });
		if (!info.available) return { ok: false, reason: "You have the latest version." };
		if (await o.isBusy()) return { ok: false, reason: "Midnight is working on a mission; it will update when it is idle." };
		if (!info.installer || !info.manifest) {
			o.openPage(info.page);
			return { ok: false, reason: "This release has no verified installer; the release page is open." };
		}
		const manifestRes = await fetchImpl(info.manifest, { signal: AbortSignal.timeout(30_000) });
		if (!manifestRes.ok) return { ok: false, reason: `The release manifest could not be read (${manifestRes.status}).` };
		const want = /sha512:\s*(\S+)/.exec(await manifestRes.text())?.[1];
		// A private folder per attempt, so another program cannot swap the file between the check and the launch.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "midnight-update-"));
		const file = path.join(dir, `midnight-setup-${info.latest}.exe`);
		const res = await fetchImpl(info.installer, { signal: AbortSignal.timeout(15 * 60_000) });
		if (!res.ok) return { ok: false, reason: `The installer could not be downloaded (${res.status}).` };
		const buf = Buffer.from(await res.arrayBuffer());
		const got = createHash("sha512").update(buf).digest("base64");
		if (!want || got !== want) return { ok: false, reason: "The download does not match the release manifest; nothing was installed." };
		fs.writeFileSync(file, buf);
		const sig = await trust(file);
		if (!sig.ok) {
			fs.rmSync(dir, { recursive: true, force: true });
			o.openPage(info.page);
			return { ok: false, reason: `Not installed: ${sig.reason}. The release page is open.` };
		}
		await o.backup(); // a consistent copy of the mission store before the new version migrates it
		o.launch(file);
		return { ok: true, version: info.latest };
	}

	return { check, install, status: () => last };
}
