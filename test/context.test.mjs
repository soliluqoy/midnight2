import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createContextService } from "../src/context/service.mjs";
import { createMemory } from "../src/memory/store.mjs";
import { createEvidence } from "../src/evidence/store.mjs";
import { createRoots } from "../src/policy/roots.mjs";
import { createSkills } from "../src/skills/registry.mjs";
import { createJournal } from "../src/storage/journal.mjs";
import { createUnitOfWork } from "../src/storage/uow.mjs";
import { createData } from "../src/storage/data.mjs";
import { shellTools } from "../src/tools/shell-tools.mjs";
import { openStore } from "../src/storage/db.mjs";
import { tempDir } from "./helpers.mjs";
import { createHost } from "../src/runtime/host.mjs";
import { fileSearchTools } from "../src/tools/file-search.mjs";
import { makeModel, fakePlatform, fauxAssistantMessage, fauxText, fauxToolCall, settled, until } from "./e2e-helpers.mjs";

// Deliberately disjoint words share a vector. These fixtures test retrieval wiring, not Gemma quality.
const vectorFor = text => /railway|transportation|commuter|trains/i.test(text) ? [1, 0, 0] : /cake|dessert|baking/i.test(text) ? [0, 1, 0] : [0, 0, 1];
async function fixture(t, opts = {}) {
	const dir = fs.realpathSync.native(tempDir("context")), store = await openStore(dir), journal = createJournal(store);
	const { commit, emit } = createUnitOfWork(store, journal);
	const memory = createMemory(store, emit, commit), roots = createRoots(store);
	const evidence = createEvidence(store, journal, emit, { workspaces: path.join(dir, "workspaces") });
	const config = { embedding: { enabled: true, assist: true } };
	let fp = "fixture-v1";
	const calls = [];
	const runtime = {
		status: () => ({ available: true, ready: true, busy: false, dimensions: 3, ...opts.status }),
		fingerprint: () => fp,
		embedText: async (texts, o) => { calls.push({ texts, ...o }); return opts.embed ? opts.embed(texts, o) : texts.map(vectorFor); },
	};
	const fileSearch = { status: () => ({ busy: false }), search: opts.search ?? (async () => ({ results: [] })) };
	const skills = opts.skills ?? { list: () => [], get: () => undefined };
	const context = createContextService({ store, journal, memory, roots, evidence, commit, emit, settings: () => config, runtime, fileSearch, skills, recipes: { list: () => opts.recipes ?? [] }, deadlineMs: 40, pageDeadlineMs: 80 });
	t.after(() => { context.close(); store.close(); });
	const task = (id, text, privacy = "cloud", scope = {}) => {
		store.run("INSERT INTO missions (id,title,goal,status,model_policy,scope,created_at,updated_at) VALUES (?,?,?,'succeeded',?,?,?,?)", id, text, text, JSON.stringify({ privacy }), JSON.stringify(scope), "2026-10-01", "2026-10-02");
		commit(() => journal.putPayload(id, "answer", text));
	};
	const mission = { id: "current", privacy: "cloud", scope: {} };
	return { dir, store, journal, commit, emit, memory, roots, evidence, config, runtime, calls, context, task, mission, setFingerprint: s => { fp = s; } };
}

test("semantic recall joins confirmed memories, past task answers and workflows with no shared words", async t => {
	const f = await fixture(t, { skills: { list: () => [{ id: "travel", title: "Railway planner", purpose: "trains" }], get: () => ({ prompt: "Prepare travel options." }) }, recipes: [{ id: "r1", label: "Commuter plan", reviewed: true, template: { goal: "Railway itinerary" } }] });
	const relevant = f.memory.remember("Railway journeys are preferred.");
	f.memory.remember("Chocolate cake is delicious.");
	f.memory.suggest("Transportation unconfirmed preference");
	f.task("past", "Commuters ride trains.");
	f.task("unrelated", "Chocolate baking instructions.");
	await f.context.refresh();
	const result = await f.context.prepare("public transportation", f.mission);
	assert.deepEqual(result.memories, [relevant.text]);
	assert.match(result.context, /Past task past/);
	assert.doesNotMatch(result.context, /baking|unconfirmed/);
	assert.match(result.context, /Suggested skill travel/);
	assert.match(result.context, /Suggested recipe r1/);
	assert.equal(result.metrics.mode, "hybrid");
	assert.ok(result.context.length <= 10000);
	assert.ok(f.evidence.list("current").some(e => e.kind === "history" && e.source === "past"));
	const event = f.journal.forMission("current").find(e => e.type === "context.prepared");
	assert.ok(event.payload.elapsedMs >= 0);
	assert.equal(JSON.stringify(event.payload).includes("Railway"), false);
});

test("correction, expiry, scope, revocation and deletion exclude cached sources immediately", async t => {
	const f = await fixture(t);
	const m = f.memory.remember("Railway journeys are preferred.");
	f.memory.remember("Transportation secret", { scope: { missionId: "other" } });
	f.memory.remember("Transportation expired", { validUntil: "2020-01-01" });
	f.task("local", "Transportation private local work", "local");
	f.task("page", "Transportation page draft", "cloud", { pageAssistant: { appId: "appA" } });
	const root = f.roots.add(f.dir);
	f.task("revoked", "Transportation source notes");
	f.commit(() => f.evidence.record("revoked", { kind: "file", source: path.join(f.dir, "notes.txt") }));
	await f.context.refresh();
	assert.ok(f.store.get("SELECT vector FROM context_vectors WHERE source_id = ?", m.id));
	f.memory.correct(m.id, "Chocolate cake preference");
	f.roots.remove(root.id);
	let result = await f.context.recall("public transportation", f.mission);
	assert.equal(result.memories.length, 0);
	assert.equal(result.tasks.length, 0);
	f.task("past", "Transportation valid previous work");
	await f.context.refresh();
	assert.equal((await f.context.recall("public transportation", f.mission)).tasks[0].id, "past");
	const data = createData({ ...f, paths: { sessions: path.join(f.dir, "sessions"), workspaces: path.join(f.dir, "workspaces") }, version: "test" });
	data.remove("history");
	result = await f.context.recall("public transportation", f.mission);
	assert.equal(result.tasks.length, 0);
	assert.equal(f.store.get("SELECT COUNT(*) AS n FROM context_vectors WHERE source_type = 'task'").n, 0);
	f.memory.clear();
	assert.equal(f.store.get("SELECT COUNT(*) AS n FROM context_vectors WHERE source_type = 'memory'").n, 0);
});

test("cold or busy runtime and timed-out requests fall back without waiting for model startup", async t => {
	const cold = await fixture(t, { status: { ready: false, busy: true } });
	cold.memory.remember("Transportation preference");
	assert.equal((await cold.context.recall("transportation", cold.mission)).mode, "words");
	assert.equal(cold.calls.length, 0);
	const hung = await fixture(t, { embed: () => new Promise(() => {}) });
	hung.memory.remember("Transportation preference");
	const start = Date.now(), result = await hung.context.prepare("transportation", hung.mission);
	assert.ok(Date.now() - start < 500);
	assert.equal(result.metrics.mode, "words");
	assert.equal(result.memories.length, 1);
	assert.equal(hung.calls[0].signal.aborted, true);
	hung.config.embedding.assist = false;
	assert.equal((await hung.context.prepare("transportation", hung.mission)).context, "");
	const ac = new AbortController(); ac.abort();
	hung.config.embedding.assist = true;
	await assert.rejects(hung.context.prepare("transportation", hung.mission, { signal: ac.signal }), { name: "AbortError" });
});

test("fingerprints and late background replies never revive corrected or forgotten memory", async t => {
	let resolve;
	const f = await fixture(t, { embed: () => new Promise(r => { resolve = r; }) });
	const m = f.memory.remember("Railway journeys preferred");
	const work = f.context.refresh();
	await until(() => resolve);
	f.memory.forget(m.id);
	resolve([[1, 0, 0]]);
	await work;
	assert.equal(f.store.get("SELECT COUNT(*) AS n FROM context_vectors").n, 0);
});

test("a model fingerprint change prevents comparisons until source vectors are rebuilt", async t => {
	const f = await fixture(t);
	f.memory.remember("Railway journeys preferred");
	await f.context.refresh();
	assert.equal((await f.context.recall("public transportation", f.mission)).memories.length, 1);
	f.setFingerprint("fixture-v2");
	const stale = await f.context.recall("public transportation", f.mission);
	assert.equal(stale.memories.length, 0);
	assert.equal(stale.mode, "words");
	await f.context.refresh();
	assert.equal((await f.context.recall("public transportation", f.mission)).mode, "hybrid");
});

test("semantic passage selection retrieves different wording, preserves attribution and honors budgets", async t => {
	const f = await fixture(t);
	const noise = Array.from({ length: 15 }, (_, i) => "Cake baking paragraph " + i + " " + "ingredients ".repeat(40)).join("\n\n");
	const page = { url: "https://a.test/page", title: "Travel", text: noise + "\n\nRailway stations connect commuters to the central terminal.\n\nA timetable accompanies these journeys." };
	const selected = await f.context.focusPages([page], "public transportation", 700, { missionId: "current" });
	assert.equal(selected.metrics.mode, "hybrid");
	assert.match(selected.pages[0].excerpt, /Railway stations/);
	assert.ok(selected.pages[0].excerpt.length <= 700);
	assert.equal(selected.pages[0].url, page.url);
	assert.ok(selected.metrics.sourceChars > selected.metrics.chars);
	const shell = shellTools({ platform: { call: async () => ({ details: { urls: [page.url], pages: [page], failures: [{ url: "https://bad.test", error: "HTTP 500" }] } }) }, evidence: f.evidence, commit: f.commit, selectPassages: (...args) => f.context.focusPages(...args) });
	const out = await shell.readPages.execute({ urls: [page.url], query: "public transportation" }, { missionId: "current" });
	assert.match(out.content[0].text, /https:\/\/a.test\/page/);
	assert.match(out.content[0].text, /HTTP 500/);
	assert.ok(f.evidence.list("current").some(e => e.kind === "web" && e.source === page.url));
	assert.equal(JSON.stringify(out.details).includes("vector"), false);
});

test("file context shares the query vector and rechecks memories after an asynchronous read", async t => {
	let f;
	f = await fixture(t, { search: async args => {
		assert.deepEqual(args.queryVector, [1, 0, 0]);
		assert.equal(args.wordsOnly, false);
		f.memory.forget(f.saved.id);
		return { results: [{ id: "segment1", path: path.join(f.dir, "recording.wav"), kind: "audio", match: "semantic", text: "", locator: { startSeconds: 25 } }] };
	} });
	f.roots.add(f.dir);
	f.saved = f.memory.remember("Railway journeys preferred");
	await f.context.refresh();
	const result = await f.context.prepare("public transportation", f.mission);
	assert.deepEqual(result.memories, []);
	assert.match(result.context, /startSeconds.*25/);
	assert.match(result.context, /no transcript/);
	assert.equal(f.evidence.list("current")[0].kind, "file");
});

test("the cloud runtime receives recalled history and a brokered recall tool, with page assistants isolated", async t => {
	const model = await makeModel();
	const host = await createHost({ dataDir: tempDir("context-host"), platform: fakePlatform(), modelRuntime: model.rt, core: model.core });
	t.after(() => host.close());
	await host.start();
	model.faux.setResponses([fauxAssistantMessage([fauxText("The Acme proposal uses a monthly retainer.")])]);
	const first = await host.handle("mission.create", { text: "Acme proposal", requestId: "context-first" });
	await settled(host, first.missionId);
	model.faux.setResponses([ctx => {
		assert.match(JSON.stringify(ctx.messages), /Past task/);
		assert.match(JSON.stringify(ctx.messages), /monthly retainer/);
		return fauxAssistantMessage([fauxText("Proposal continued.")]);
	}]);
	const second = await host.handle("mission.create", { text: "Continue Acme proposal", requestId: "context-second" });
	await settled(host, second.missionId);
	assert.ok(host.viewOf(second.missionId).context.tasks.includes(first.missionId));
	model.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("recall_context", { query: "Acme proposal" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Recalled.")]),
	]);
	const third = await host.handle("mission.create", { text: "Recall Acme proposal", requestId: "context-third" });
	await settled(host, third.missionId);
	assert.equal(host.ledger.forMission(third.missionId).find(i => i.tool === "recall_context").state, "verified");
	assert.deepEqual(host.tools.forMission({ scope: { pageAssistant: {} } }, {}), []);
	assert.equal((await host.tools.context.prepare("Acme", { id: "page", scope: { pageAssistant: {} } })).metrics.mode, "disabled");
});

test("historical source lineage prevents removed files and forgotten memories returning through later answers", async t => {
	const f = await fixture(t);
	const root = f.roots.add(f.dir);
	const m = f.memory.remember("Railway journeys preferred");
	f.task("original", "Transportation original notes");
	f.task("derived", "Transportation answer quoting the original");
	f.commit(() => {
		f.evidence.record("original", { kind: "file", source: path.join(f.dir, "report.txt") });
		f.evidence.record("derived", { kind: "history", source: "original" });
	});
	f.roots.remove(root.id);
	assert.equal((await f.context.recall("transportation", f.mission)).tasks.length, 0);
	f.task("remembered", "Transportation answer based on a saved preference");
	f.commit(() => f.evidence.record("remembered", { kind: "memory", source: m.id }));
	assert.ok((await f.context.recall("transportation", f.mission)).tasks.some(d => d.id === "remembered"));
	f.memory.forget(m.id);
	assert.equal((await f.context.recall("transportation", f.mission)).tasks.length, 0);
});

test("cancelling during local preflight never dispatches a cloud request and settles the run", async t => {
	const model = await makeModel();
	let calls = 0, began;
	model.faux.setResponses([() => { calls++; return fauxAssistantMessage([fauxText("Should not run")]); }]);
	const searchRuntime = { status: () => ({ available: true, ready: true, dimensions: 768, busy: false }), fingerprint: () => "cancel-fixture", embedText: async () => {
		began = true;
		return new Promise(() => {});
	}, close() {} };
	const host = await createHost({ dataDir: tempDir("context-cancel"), platform: fakePlatform(), modelRuntime: model.rt, core: model.core, searchRuntime, settings: { provider: "faux", model: "m1", embedding: { enabled: true } } });
	t.after(() => host.close());
	const { missionId } = await host.handle("mission.create", { text: "Prepare Acme proposal", requestId: "cancel-preflight" });
	await until(() => began);
	await host.handle("mission.cancel", { missionId });
	await until(() => host.store.get("SELECT ended_at FROM runs WHERE mission_id = ?", missionId)?.ended_at);
	assert.equal(calls, 0);
	assert.equal(host.repo.get(missionId).status, "cancelled");
	assert.equal(JSON.parse(host.store.get("SELECT payload FROM events WHERE mission_id = ? AND type = 'run.settled'", missionId).payload).reason, "aborted");
});

test("steering while local context loads reaches the first cloud request", async t => {
	const model = await makeModel();
	let began, received;
	model.faux.setResponses([ctx => {
		received = JSON.stringify(ctx.messages);
		return fauxAssistantMessage([fauxText("Draft prepared.")]);
	}]);
	const searchRuntime = { status: () => ({ available: true, ready: true, dimensions: 768, busy: false }), fingerprint: () => "steer-fixture", embedText: async () => {
		began = true;
		return new Promise(() => {});
	}, close() {} };
	const host = await createHost({ dataDir: tempDir("context-steer"), platform: fakePlatform(), modelRuntime: model.rt, core: model.core, searchRuntime, settings: { provider: "faux", model: "m1", embedding: { enabled: true } } });
	t.after(() => host.close());
	const { missionId } = await host.handle("mission.create", { text: "Prepare Acme proposal", requestId: "steer-preflight" });
	await until(() => began);
	assert.equal((await host.handle("mission.followUp", { missionId, text: "Use monthly billing", requestId: "steer-next" })).steered, true);
	await settled(host, missionId);
	assert.match(received, /Use monthly billing/);
});

test("visual inspection returns actual media and rechecks the source after rendering", async t => {
	const f = await fixture(t);
	let changed = false;
	const hit = { path: path.join(f.dir, "page.pdf"), kind: "document", hash: "original", sourceVersion: "1", locator: { page: 2 }, name: "page.pdf" };
	const spec = fileSearchTools({ roots: f.roots, commit: f.commit, evidence: f.evidence, runtime: f.runtime,
		search: { resolve: async () => ({ ...hit, hash: changed ? "changed" : "original" }) },
		render: async () => ({ mimeType: "image/jpeg", data: "aW1hZ2U=" }),
	}).all.find(s => s.name === "files_view");
	assert.equal((await spec.classify({ id: "result" })).effect, "read.local");
	const out = await spec.execute({ id: "result" }, { missionId: "current" });
	assert.equal(out.content[1].type, "image");
	assert.deepEqual(out.details.locator, { page: 2 });
	const changedSpec = fileSearchTools({ roots: f.roots, commit: f.commit, evidence: f.evidence, runtime: f.runtime,
		search: { resolve: async () => ({ ...hit, hash: changed ? "changed" : "original" }) },
		render: async () => { changed = true; return { mimeType: "image/jpeg", data: "aW1hZ2U=" }; },
	}).all.find(s => s.name === "files_view");
	await assert.rejects(changedSpec.execute({ id: "result" }, { missionId: "current" }), /changed during preview/);
});
