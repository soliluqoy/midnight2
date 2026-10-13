import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { tempDir } from "./helpers.mjs";
import { createWordBroker } from "../src/desktop/word-broker.mjs";
import { sha256 } from "../src/policy/canonical.mjs";

function fixture(t, { timeoutMs = 1000 } = {}) {
	const directory = tempDir("word-bridge"); const helper = path.join(directory, "helper.exe"); fs.writeFileSync(helper, "fixed-test-helper");
	const connector = { id: "word", api: 1, artifact: sha256("fixed-test-helper") };
	const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {}; child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
	child.kills = 0; child.kill = () => { child.kills++; child.emit("exit", 0); };
	const requests = [];
	child.stdin.write = line => requests.push(JSON.parse(line));
	const answer = (request, result) => child.stdout.emit("data", `${JSON.stringify({ id: request.id, ok: true, result })}\n`);
	const broker = createWordBroker({ helper, timeoutMs, platform: "win32", spawnImpl: () => child });
	t.after(() => { broker.close(); fs.rmSync(helper); fs.rmdirSync(directory); });
	const command = { handle: "original-range", editId: "act-test-fixed-identity", operation: "paragraph.replace", connector, expected: {}, text: "Replacement" };
	return { broker, child, answer, requests, command, connector };
}

test("abort after native dispatch reports unknown while preserving the helper for receipt reconciliation", async t => {
	const f = fixture(t); const controller = new AbortController();
	const apply = f.broker.apply(f.command, { signal: controller.signal });
	assert.equal(f.requests.length, 1);
	controller.abort();
	await assert.rejects(apply, err => err.uncertain && err.code === "EDIT_UNKNOWN");
	assert.equal(f.child.kills, 0);
	const result = { editId: f.command.editId, state: "verified", snapshot: { handle: "original-range", text: "Replacement" } };
	f.answer(f.requests[0], result);
	const receipt = f.broker.receipt(f.command.editId);
	f.answer(f.requests[1], { found: true, result });
	assert.deepEqual((await receipt).result.snapshot.connector, f.connector);
	assert.equal(f.requests.filter(request => request.op === "apply").length, 1);
});

test("helper timeout cannot claim an unobserved native edit failed or did not happen", async t => {
	const f = fixture(t, { timeoutMs: 20 });
	await assert.rejects(f.broker.apply(f.command), err => err.uncertain && err.code === "EDIT_UNKNOWN");
	assert.equal(f.child.kills, 1);
});

test("exact connector changes refuse native dispatch and helper errors preserve uncertainty", async t => {
	const f = fixture(t);
	await assert.rejects(f.broker.apply({ ...f.command, connector: { ...f.connector, artifact: sha256("changed-code") } }), { code: "TARGET_CONFLICT" });
	assert.equal(f.requests.length, 0);
	const apply = f.broker.apply(f.command);
	f.child.stdout.emit("data", `${JSON.stringify({ id: f.requests[0].id, ok: false, error: "Outcome uncertain", code: "EDIT_UNKNOWN", uncertain: true })}\n`);
	await assert.rejects(apply, err => err.uncertain && err.code === "EDIT_UNKNOWN");
});

test("voice capture binds the helper read to the original foreground and rejects malformed identities", async t => {
	const f = fixture(t); const capture = f.broker.capture({ expectedWindowId: "12345", expectedProcessId: 41 });
	assert.equal(f.requests[0].expectedWindowId, "12345"); assert.equal(f.requests[0].expectedProcessId, 41);
	f.answer(f.requests[0], { handle: "frozen" }); assert.equal((await capture).handle, "frozen");
	await assert.rejects(f.broker.capture({ expectedWindowId: "../../later", expectedProcessId: 0 }), /original foreground/);
	assert.equal(f.requests.length, 1);
});
