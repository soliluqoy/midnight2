// Model routing (M01): every mission uses the one model the user chose; without a usable choice, the best available.
import assert from "node:assert/strict";
import test from "node:test";
import { routeModel } from "../src/runtime/models.mjs";

const M = (provider, id) => ({ provider, id, input: ["text", "image"], reasoning: true });
const runtime = (avail) => ({
	getAvailable: async () => avail,
	getModel: (p, id) => avail.find((m) => m.provider === p && m.id === id),
	checkAuth: async () => undefined,
});
const rt = runtime([M("openai-codex", "gpt-6-luna"), M("openai-codex", "gpt-6.1-sol"), M("anthropic", "claude-opus-5-5")]);
const pick = async (settings) => (await routeModel(rt, settings, "cloud")).route;

test("routing: the chosen model runs every mission and is never swapped for another", async () => {
	assert.deepEqual(await pick({ provider: "openai-codex", model: "gpt-6-luna" }), { provider: "openai-codex", model: "gpt-6-luna", privacy: "cloud", reason: "your choice" });
	assert.equal((await pick({ provider: "anthropic", model: "claude-opus-5-5" })).model, "claude-opus-5-5");
	assert.equal((await pick({ provider: "gone", model: "nope" })).model, "gpt-6.1-sol", "an unusable choice falls back to the best available");
	assert.equal((await pick({})).reason, "best available");
});
