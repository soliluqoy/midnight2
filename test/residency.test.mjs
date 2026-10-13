import assert from "node:assert/strict";
import test from "node:test";
import { createResidencyBudget, LOCAL_MODEL_BUDGETS, GiB } from "../src/inference/residency.mjs";
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(t, options = {}) {
	let available = 10 * GiB, total = 16 * GiB; const owners = new Map(), events = [];
	const budget = createResidencyBudget({ intervalMs: 20, waitMs: 1000, readMemory: () => ({ total, available }), ...options }); t.after(() => budget.close());
	for (const role of ["speech", "embedding"]) { const owner = { resident: false, busy: false, unloading: false }; owners.set(role, owner); budget.register({ role, ...LOCAL_MODEL_BUDGETS[role], inspect: () => owner, unload: async () => { events.push(role); available += LOCAL_MODEL_BUDGETS[role].footprint; owner.resident = false; owner.unloading = false; } }); }
	return { budget, owners, events, setAvailable: value => available = value, setTotal: value => total = value };
}
test("cold and resident memory admission reserve working space without double-crediting existing weights", async t => {
	const f = fixture(t); f.setAvailable(5 * GiB); await assert.rejects(f.budget.acquire("speech"), { code: "INFERENCE_MEMORY_PRESSURE" }); assert.equal(f.budget.status().reservations, 0);
	f.owners.get("speech").resident = true; const lease = await f.budget.acquire("speech"); assert.equal(f.budget.status().estimatedOwnedBytes, 1.25 * GiB); assert.deepEqual(f.events, []); lease.release(); assert.equal(f.budget.status().estimatedOwnedBytes, GiB);
	f.setTotal(4 * GiB); f.setAvailable(3 * GiB); await assert.rejects(f.budget.acquire("embedding"), { code: "INFERENCE_MEMORY_CAPACITY" });
});
test("pending cold reservations are deducted from OS availability as well as the combined model cap", async t => {
	const f = fixture(t); f.setAvailable(7 * GiB); const first = await f.budget.acquire("speech");
	await assert.rejects(f.budget.acquire("embedding"), { code: "INFERENCE_MEMORY_PRESSURE" }); assert.equal(f.budget.status().reservations, 1); first.release();
	const second = await f.budget.acquire("embedding"); assert.equal(f.budget.status().estimatedOwnedBytes, 2.75 * GiB); second.release();
});
test("idle eviction awaits physical exit and an updated OS sample before admitting the next model", async t => {
	const done = deferred(), events = []; let resident = true, unloading = false, available = 4.5 * GiB;
	const budget = createResidencyBudget({ readMemory: () => ({ total: 16 * GiB, available }) }); t.after(() => { done.resolve(); return budget.close(); });
	budget.register({ role: "embedding", ...LOCAL_MODEL_BUDGETS.embedding, inspect: () => ({ resident, unloading }), unload: async () => { unloading = true; events.push("stopping"); await done.promise; resident = false; unloading = false; available += 1.5 * GiB; events.push("exited"); } }); budget.register({ role: "speech", ...LOCAL_MODEL_BUDGETS.speech, inspect: () => ({ resident: false }), unload: async () => {} });
	let started = false; const next = budget.acquire("speech").then(lease => { started = true; events.push("admitted"); return lease; }); await tick(); assert.equal(started, false); assert.equal(budget.status().models.find(model => model.role === "embedding").unloading, true); assert.equal(budget.status().estimatedOwnedBytes, 2.5 * GiB);
	done.resolve(); const lease = await next; assert.deepEqual(events, ["stopping", "exited", "admitted"]); assert.equal(budget.status().available, 6 * GiB); lease.release();
});
test("a failed unload or unreclaimed OS memory cannot be counted as recovered capacity", async t => {
	for (const mode of ["rejected", "not-exited", "no-OS-reclaim"]) {
		let resident = true; const budget = createResidencyBudget({ readMemory: () => ({ total: 16 * GiB, available: 4.5 * GiB }) }); t.after(() => budget.close());
		budget.register({ role: "embedding", ...LOCAL_MODEL_BUDGETS.embedding, inspect: () => ({ resident }), unload: async () => { if (mode === "rejected") throw new Error("Could not stop owned process."); if (mode === "no-OS-reclaim") resident = false; } }); budget.register({ role: "speech", ...LOCAL_MODEL_BUDGETS.speech, inspect: () => ({ resident: false }), unload: async () => {} });
		await assert.rejects(budget.acquire("speech")); assert.equal(budget.status().reservations, 0); assert.equal(budget.status().available, 4.5 * GiB);
	}
});
test("bounded held-speech protection survives pressure, and releasing it permits idle eviction", async t => {
	let time = Date.now(); const f = fixture(t, { now: () => time }); f.owners.get("speech").resident = true; f.owners.get("embedding").resident = true; f.setAvailable(3 * GiB);
	const first = f.budget.pin("speech", "gesture", time + 30000), replaced = f.budget.pin("speech", "gesture", time + 30000); first(); await f.budget.check(); assert.deepEqual(f.events, ["embedding"]); assert.equal(f.owners.get("speech").resident, true); assert.equal(f.budget.status().pins.length, 1);
	replaced(); f.setAvailable(3 * GiB); await f.budget.check(); assert.deepEqual(f.events, ["embedding", "speech"]); assert.equal(f.budget.status().pins.length, 0);
	f.owners.get("speech").resident = true; f.setAvailable(3 * GiB); f.budget.pin("speech", "expire", time + 100); time += 101; await f.budget.check(); assert.equal(f.owners.get("speech").resident, false);
});
test("active reservations and owners are protected while pressure is reported to the shared arbiter", async t => {
	let pressures = 0; const f = fixture(t, { onPressure: () => pressures++ }); f.owners.get("speech").resident = true; const lease = await f.budget.acquire("speech"); f.setAvailable(3 * GiB); await f.budget.check(); assert.equal(f.owners.get("speech").resident, true); assert.equal(pressures, 1);
	lease.release(); f.owners.get("speech").busy = true; await f.budget.check(); assert.equal(f.owners.get("speech").resident, true); f.owners.get("speech").busy = false; await f.budget.check(); assert.equal(f.owners.get("speech").resident, false);
});
test("background memory waits are bounded, cancellable and wake on an explicit pressure check", async t => {
	const f = fixture(t); f.setAvailable(4 * GiB); const waiting = f.budget.acquire("embedding", { priority: 2 }); await tick(); assert.equal(f.budget.status().waiting.length, 1); f.setAvailable(10 * GiB); await f.budget.check(); const lease = await waiting; lease.release(); assert.equal(f.budget.status().waiting.length, 0);
	f.setAvailable(4 * GiB); const controller = new AbortController(), cancelled = assert.rejects(f.budget.acquire("embedding", { priority: 2, signal: controller.signal }), /cancelled/); await tick(); controller.abort(new Error("cancelled")); await cancelled; assert.equal(f.budget.status().waiting.length, 0);
	await assert.rejects(f.budget.acquire("embedding", { priority: 2, deadline: Date.now() + 25 }), { code: "INFERENCE_MEMORY_EXPIRED" }); assert.equal(f.budget.status().reservations, 0);
});
test("revocation during a physical unload waits for cleanup and never admits a replacement", async t => {
	let resident = true; const done = deferred(), controller = new AbortController(); const budget = createResidencyBudget({ readMemory: () => ({ total: 16 * GiB, available: 4.5 * GiB }) }); t.after(() => { done.resolve(); return budget.close(); });
	budget.register({ role: "embedding", ...LOCAL_MODEL_BUDGETS.embedding, inspect: () => ({ resident }), unload: async () => { await done.promise; resident = false; } }); budget.register({ role: "speech", ...LOCAL_MODEL_BUDGETS.speech, inspect: () => ({ resident: false }), unload: async () => {} });
	let settled = false; const pending = budget.acquire("speech", { signal: controller.signal }).finally(() => settled = true), rejected = assert.rejects(pending, /revoked/); await tick(); controller.abort(new Error("revoked")); await tick(); assert.equal(settled, false); done.resolve(); await rejected; assert.equal(budget.status().reservations, 0);
});
test("invalid or missing memory samples fail closed and a stale late reading cannot start a worker", async t => {
	for (const value of [null, { total: NaN, available: 0 }, { total: 16 * GiB, available: -1 }, { total: 16 * GiB, available: 17 * GiB }]) {
		const budget = createResidencyBudget({ readMemory: () => value }); t.after(() => budget.close()); budget.register({ role: "speech", ...LOCAL_MODEL_BUDGETS.speech, inspect: () => ({ resident: false }), unload: async () => {} }); await assert.rejects(budget.acquire("speech"), { code: "INFERENCE_MEMORY_UNAVAILABLE" });
	}
	const done = deferred(), controller = new AbortController(), budget = createResidencyBudget({ readMemory: () => done.promise }); t.after(() => budget.close()); budget.register({ role: "speech", ...LOCAL_MODEL_BUDGETS.speech, inspect: () => ({ resident: false }), unload: async () => {} }); const pending = assert.rejects(budget.acquire("speech", { signal: controller.signal }), /old reading/); await tick(); controller.abort(new Error("old reading")); done.resolve({ total: 16 * GiB, available: 10 * GiB }); await pending; assert.equal(budget.status().reservations, 0);
});
test("closing memory admission cancels waits and diagnostics cannot mutate reservation history", async t => {
	const f = fixture(t); f.setAvailable(4 * GiB); const pending = assert.rejects(f.budget.acquire("embedding", { priority: 2 }), { code: "INFERENCE_MEMORY_CLOSED" }); await tick(); await f.budget.close(); await pending; await assert.rejects(f.budget.acquire("speech"));
	const publicState = f.budget.status(); publicState.evictions.push({ role: "forged" }); assert.equal(f.budget.status().evictions.length, 0);
});
