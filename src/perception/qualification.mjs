// Persist only synthetic fixture outcomes and route identity. Keys and captured media are never written.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { FIXTURE_VERSION, fixtureDigest } from "./fixtures.mjs";
const MAX_AGE = 7 * 24 * 60 * 60_000;
export function qualificationIdentity(route, digest, apiKey) {
	return createHash("sha256").update(JSON.stringify({ provider: route.provider, model: route.model, transport: digest, fixtures: fixtureDigest() })).update("\0").update(apiKey).digest("hex");
}
export function createQualificationStore(file) {
	let records = {};
	try { if (file && fs.statSync(file).size <= 128 * 1024) records = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
	if (!records || typeof records !== "object" || Array.isArray(records)) records = {};
	const persist = () => {
		if (!file) return;
		fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${randomUUID()}.tmp`;
		try { fs.writeFileSync(tmp, JSON.stringify(records), { flag: "wx" }); fs.renameSync(tmp, file); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
	};
	return {
		get(identity, now = Date.now()) {
			const record = records[identity];
			if (!record || record.fixtureVersion !== FIXTURE_VERSION || !Number.isFinite(record.at) || record.at > now || record.at + MAX_AGE <= now || JSON.stringify(record.capabilities) !== '["audio","image","orderedFrames"]' || !Array.isArray(record.checks) || record.checks.length !== 5 || record.checks.some((check, i) => check?.id !== ["spoken-request", "spoken-negation", "silence", "image-bars", "frame-order"][i] || check.passed !== true || !Number.isFinite(check.elapsedMs) || check.elapsedMs < 0 || check.elapsedMs > 20_000)) return undefined;
			return structuredClone(record);
		},
		revoke(identity) { delete records[identity]; persist(); },
		pass(identity, checks) {
			records[identity] = { fixtureVersion: FIXTURE_VERSION, at: Date.now(), capabilities: ["audio", "image", "orderedFrames"], checks };
			const keep = Object.entries(records).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, 20); records = Object.fromEntries(keep); persist();
			return this.get(identity);
		},
	};
}
