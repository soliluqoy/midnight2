// Synthetic evaluation using the installed local model. --cloud additionally sends only these fixtures
// to the currently configured cloud model; it never reads the user's tasks, memories or selected files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmbeddingRuntime } from "../src/search/runtime.mjs";
import { createContextService } from "../src/context/service.mjs";
import { createMemory } from "../src/memory/store.mjs";
import { createEvidence } from "../src/evidence/store.mjs";
import { createRoots } from "../src/policy/roots.mjs";
import { openStore } from "../src/storage/db.mjs";
import { createJournal } from "../src/storage/journal.mjs";
import { createUnitOfWork } from "../src/storage/uow.mjs";
import { createModelRuntime, createPiRuntime } from "../src/runtime/adapter.mjs";
import { routeModel } from "../src/runtime/models.mjs";

const cloud = process.argv.includes("--cloud");
const appDir = process.env.MIDNIGHT_BENCH_APP_DATA ?? (process.platform === "win32" ? path.join(process.env.APPDATA, "midnight") : "");
if (!appDir) throw new Error("Set MIDNIGHT_BENCH_APP_DATA to the installed app data folder.");
const installedDir = process.env.MIDNIGHT_TEST_SEARCH_DATA ?? path.join(appDir, "missions");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "midnight-context-benchmark-"));
const store = await openStore(dir), journal = createJournal(store), { commit, emit } = createUnitOfWork(store, journal);
const memory = createMemory(store, emit, commit), roots = createRoots(store);
const evidence = createEvidence(store, journal, emit, { workspaces: path.join(dir, "workspaces") });
const settings = { embedding: { enabled: true, assist: true, dimensions: 768, device: "cpu" } };
const embedder = createEmbeddingRuntime({ settings, paths: { dataDir: installedDir } });
const context = createContextService({ store, journal, memory, roots, evidence, commit, emit, runtime: embedder,
	settings: () => settings, skills: { list: () => [] }, recipes: { list: () => [] },
	fileSearch: { status: () => ({ busy: false }), search: async () => ({ results: [] }) } });

try {
	memory.remember("I prefer riding trains from the railway station to the central terminal. Commuters can use the local rail network.");
	for (let i = 0; i < 8; i++) memory.remember("Baking note " + i + ": " + "Chocolate cake recipes use flour, eggs and butter. Mix the batter, bake it in the oven and cover it with sweet icing. ".repeat(7));
	store.run("INSERT INTO missions (id,title,goal,status,created_at,updated_at) VALUES ('prior','Rail journey','Choose a commuter train','succeeded','2026-10-01','2026-10-02')");
	commit(() => journal.putPayload("prior", "answer", "Commuters ride trains to the central terminal. Chosen departure: 08:40. Ticket class: standard."));
	const question = "For public transportation, what is my preferred travel mode and what departure and ticket class did we choose previously? Return JSON with mode, departure and ticketClass.";
	const full = memory.list().map(m => m.text).join("\n\n") + "\n\n" + journal.getPayload(store.get("SELECT ref FROM payloads WHERE kind = 'answer'").ref);
	const warmStarted = Date.now();
	await context.refresh();
	const backgroundMs = Date.now() - warmStarted;
	const recalled = await context.prepare(question, { id: "benchmark", privacy: "cloud", scope: {} });
	const selected = recalled.memories.join("\n\n") + "\n\n" + recalled.context;
	const report = { synthetic: true, comparison: "whole-corpus context versus retrieved context", backgroundMs, retrieval: recalled.metrics,
		fullChars: full.length, selectedChars: selected.length, cloud: [] };
	console.log(JSON.stringify({ phase: "local", ...report }));
	if (cloud) {
		const appSettings = JSON.parse(fs.readFileSync(path.join(appDir, "settings.json"), "utf8"));
		const models = await createModelRuntime();
		const route = await routeModel(models, appSettings, "cloud");
		const runtime = createPiRuntime({ modelRuntime: models, sessionsDir: path.join(dir, "sessions") });
		for (const [label, material] of [["whole-corpus", full], ["retrieved", selected]]) {
			const began = Date.now();
			const result = await runtime.run(label, { runId: label, model: route.model, thinking: "off",
				systemPrompt: "Answer only from the supplied synthetic source material. Return a single JSON object with mode, departure and ticketClass. Use null for unknown values. No explanation.",
				input: question + "\n\nSource material:\n" + material, tools: [], gate: { gate: async () => ({ block: true }) } });
			if (result.error) throw new Error("The configured cloud model could not complete the benchmark.");
			let answer;
			try { answer = JSON.parse(result.answer.replace(/^.*?(\{[\s\S]*\}).*$/s, "$1")); } catch { answer = {}; }
			const correct = [/train|rail/i.test(answer.mode ?? ""), answer.departure === "08:40", answer.ticketClass === "standard"].filter(Boolean).length;
			const metrics = { label, provider: route.model.provider, model: route.model.id, elapsedMs: Date.now() - began, inputTokens: result.usage.input, outputTokens: result.usage.output, modelCalls: result.usage.modelCalls, correctFields: correct, expectedFields: 3 };
			report.cloud.push(metrics);
			console.log(JSON.stringify(metrics));
		}
		const [fullRun, selectedRun] = report.cloud;
		report.inputTokenReduction = fullRun.inputTokens ? 1 - selectedRun.inputTokens / fullRun.inputTokens : null;
	}
	console.log(JSON.stringify({ phase: "complete", ...report }));
} finally {
	context.close(); embedder.close(); store.close();
}
