// Real configured provider, synthetic selected paragraphs, and a disposable host. No document/media access.
// Explicit opt-in; credential storage is read-only and an OAuth refresh is refused before it can run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createModelRuntime } from "../src/runtime/adapter.mjs";
import { corePaths } from "../src/runtime/paths.mjs";
import { createHost } from "../src/runtime/host.mjs";
import { sha256 } from "../src/policy/canonical.mjs";

if (process.env.MIDNIGHT_TEST_CLOUD !== "1") throw new Error("Set MIDNIGHT_TEST_CLOUD=1 to send four synthetic paragraph requests through the configured cloud writer.");
const installed = corePaths(), authBytes = fs.readFileSync(installed.authPath), authHash = createHash("sha256").update(authBytes).digest("hex"), auth = JSON.parse(authBytes.toString("utf8"));
const settingsFile = process.env.MIDNIGHT_TEST_SETTINGS ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "midnight", "settings.json");
const selected = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
const provider = selected.provider, model = selected.model, credential = auth[provider];
assert.equal(selected.privacy, "cloud", "this qualification respects the configured privacy policy");
assert.ok(provider && model && credential, "a configured writer and stored credential are required");
function fresh(signal) {
	signal?.throwIfAborted();
	if (credential.type === "oauth" && !(credential.expires > Date.now() + 600_000)) throw new Error("The existing OAuth credential is too near expiry for a read-only qualification.");
}
fresh();
const credentials = {
	async read(id, options) { fresh(options?.signal); return id === provider ? structuredClone(credential) : undefined; },
	async list(options) { fresh(options?.signal); return [{ providerId: provider, type: credential.type }]; },
	async modify() { throw new Error("Credential refresh/modification is disabled in this qualification."); },
	async delete() { throw new Error("Credential deletion is disabled in this qualification."); },
};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "midnight-cloud-writing-")), core = corePaths(path.join(temporary, "core"));
fs.mkdirSync(core.agentDir, { recursive: true });
for (const key of ["modelsPath", "modelsStorePath"]) if (fs.existsSync(installed[key])) fs.copyFileSync(installed[key], core[key]);
let host, activeFixture, lastProposal, lastMissionStatus;
const results = [];
try {
	const rt = await createModelRuntime({ core, credentials });
	assert.ok(rt.getModel(provider, model), "the exact configured model must exist; this qualification never substitutes another model");
	const packets = [], original = rt.streamSimple.bind(rt);
	rt.streamSimple = (routed, context, options) => {
		assert.equal(routed.provider, provider); assert.equal(routed.id, model); assert.ok(options.maxTokens <= 2048);
		assert.deepEqual(context.tools ?? [], []);
		const serialized = JSON.stringify(context);
		assert.doesNotMatch(serialized, /PRIVATE_DOCUMENT|PRIVATE_HANDLE|PRIVATE_WINDOW|UNRELATED_CONTEXT|STANDING_INSTRUCTION|data:audio|data:image/);
		packets.push({ inputBytes: Buffer.byteLength(serialized), maxOutputTokens: options.maxTokens });
		return original(routed, context, options);
	};
	host = await createHost({ dataDir: path.join(temporary, "data"), core, modelRuntime: rt, settings: { provider, model, privacy: "cloud", instructions: "STANDING_INSTRUCTION", embedding: { enabled: false }, voice: false }, platform: { async call() { throw new Error("No platform effects or context are allowed in this qualification."); }, lease: { acquire: async () => ({ epoch: 1, release() {} }), revokeAll: async () => {} } } });
	await host.start();
	const rich = "Quarterly revenue for North rose by 12% despite higher costs.";
	const fixtures = [
		{ id: "negation-names-date", text: "The team did not approve the launch. Amina will review the revised plan on 18 October 2026; the budget remains MYR 12,500.", instruction: "Make this paragraph clearer and more concise, preserving its facts and negation.", check: proposal => { assert.equal(proposal.directlySupported, true); assert.match(proposal.text, /Amina/); assert.match(proposal.text, /October/); assert.match(proposal.text, /did not approve|not approved|has not approved|unapproved/i); } },
		{ id: "numbers-citation", text: "Revenue from North increased by 12% in 2026 [Report 7]. Higher costs reduced the margin by 3%.", instruction: "Improve the flow of this paragraph. Keep every fact, number, name and citation.", check: proposal => { assert.equal(proposal.directlySupported, true); assert.match(proposal.text, /North/); assert.match(proposal.text, /\[Report 7\]/); } },
		{ id: "styled-phrases", text: rich, spans: ["North", "12%", "higher costs"].map(anchor => ({ start: rich.indexOf(anchor), end: rich.indexOf(anchor) + anchor.length })), instruction: "Make this clearer and more concise. Keep the styled phrases exactly unchanged.", check: proposal => assert.equal(proposal.directlySupported, true) },
		{ id: "unsupported-factual-change", text: "Revenue grew by 12% [Report 7].", instruction: "Change the revenue increase to 21%. I have no source to support that new figure.", check: proposal => assert.ok(proposal.kind === "needsContext" || proposal.directlySupported === false, "unsupported factual change cannot become an applicable proposal") },
	];
	for (const fixture of fixtures) {
		activeFixture = fixture.id; lastProposal = undefined; lastMissionStatus = undefined;
		const snapshot = { kind: "paragraph", documentId: "PRIVATE_DOCUMENT", handle: "PRIVATE_HANDLE", processId: 5, windowId: "PRIVATE_WINDOW", connector: { id: "word", api: 1, artifact: sha256("synthetic-connector") }, structureHash: sha256(fixture.text), text: fixture.text, metadata: { supported: true, ...(fixture.spans ? { protectedSpans: fixture.spans } : {}) } };
		const began = Date.now(), callsBefore = packets.length;
		const { missionId } = await host.handle("mission.targetAssist", { text: fixture.instruction, requestId: host.newRequestId(), target: snapshot, expectedPrivacy: "cloud" });
		for (;;) {
			const mission = host.repo.get(missionId);
			if (!["created", "queued", "running", "waiting-resource"].includes(mission.status) && !host.runtime.isRunning(missionId)) break;
			if (Date.now() - began > 65_000) throw new Error("A bounded cloud writing fixture did not settle.");
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		lastMissionStatus = host.repo.get(missionId).status;
		assert.equal(lastMissionStatus, "succeeded", "real provider must return a complete typed proposal");
		const proposal = lastProposal = await host.handle("mission.targetProposal", { missionId }); fixture.check(proposal);
		assert.equal(packets.length - callsBefore, 1, "one real provider call per request");
		assert.equal(host.ledger.forMission(missionId).length, 0, "proposals have no native effect authority");
		results.push({ fixture: fixture.id, latencyMs: Date.now() - began, ...packets.at(-1), kind: proposal.kind, text: proposal.text, question: proposal.question, directlySupported: proposal.directlySupported, reviewReasons: proposal.reviewReasons });
		await host.handle("mission.targetRelease", { missionId });
		console.log(`PASS ${fixture.id}`);
	}
	assert.equal(createHash("sha256").update(fs.readFileSync(installed.authPath)).digest("hex"), authHash, "installed credential bytes remain unchanged");
	const report = { at: new Date().toISOString(), passed: true, provider, model, authType: credential.type, results, nativeEffect: false, credentialStorageChanged: false, limitations: ["Four synthetic English paragraphs, one account/model and one run per fixture; no statistical latency or broad writing-quality qualification.", "The connector is synthetic. Actual Word capture/apply, local microphone/Whisper and physical foreground typing are separate tests.", "Numeric/citation guards and named examples do not prove general factual or semantic preservation.", "OAuth is read-only and cannot refresh. This qualification requires an already-fresh sign-in."] };
	if (process.env.MIDNIGHT_TEST_REPORT) { const file = path.resolve(process.env.MIDNIGHT_TEST_REPORT); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2)); }
	console.log(JSON.stringify(report));
} catch {
	const failure = { at: new Date().toISOString(), passed: false, provider, model, completed: results, failedFixture: activeFixture, missionStatus: lastMissionStatus, ...(lastProposal ? { proposal: { kind: lastProposal.kind, text: lastProposal.text, question: lastProposal.question, directlySupported: lastProposal.directlySupported, reviewReasons: lastProposal.reviewReasons } } : {}), limitations: ["Only typed synthetic proposals are retained; raw provider and credential errors are suppressed."] };
	if (process.env.MIDNIGHT_TEST_REPORT) { const file = path.resolve(process.env.MIDNIGHT_TEST_REPORT); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(failure, null, 2)); }
	console.error(JSON.stringify(failure));
	process.exitCode = 1;
} finally {
	await host?.close();
	// Only this newly created qualification tree is removed; installed auth/settings/cache stay outside it.
	const resolved = fs.realpathSync(temporary);
	assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(resolved).startsWith("midnight-cloud-writing-"));
	fs.rmSync(resolved, { recursive: true, force: true }); authBytes.fill(0);
}
