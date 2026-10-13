// Shared reservations for owned local models. OS availability is sampled independently of weight-file sizes.
// Estimates are admission budgets, not a per-process measurement or an OS-enforced allocation limit.
import os from "node:os";
import { randomUUID } from "node:crypto";
export const GiB = 1024 ** 3;
export const LOCAL_MODEL_BUDGETS = Object.freeze({ speech: { footprint: GiB, scratch: GiB / 4 }, embedding: { footprint: 2.5 * GiB, scratch: GiB / 4 } });
export function readAvailableMemory() {
	const constraint = process.constrainedMemory?.() ?? 0, total = constraint > 0 ? Math.min(os.totalmem(), constraint) : os.totalmem();
	return { total, available: Math.min(total, process.availableMemory?.() ?? os.freemem()), source: "node-available-memory" };
}
const fail = (message, code) => Object.assign(new Error(message), { code });
export function createResidencyBudget({ readMemory = readAvailableMemory, intervalMs = 15_000, waitMs = 30_000, now = () => Date.now(), onPressure = () => {} } = {}) {
	const models = new Map(), reservations = new Map(), pins = new Map(), waits = new Map(), pulses = new Set();
	const controller = new AbortController(); let chain = Promise.resolve(), timer, closed = false, sample, lastError, sweeping, evictions = [];
	const serial = task => { const result = chain.then(task, task); chain = result.catch(() => {}); return result; };
	const wake = () => { for (const fn of [...pulses]) fn(); };
	const check = signal => { signal?.throwIfAborted(); if (closed) throw fail("Local memory admission is closed.", "INFERENCE_MEMORY_CLOSED"); };
	const reserved = role => [...reservations.values()].some(value => value.role === role);
	const pinned = role => [...pins.values()].some(value => value.role === role && value.deadline > now());
	function state(model) {
		try { const value = model.inspect(); return { resident: value?.resident === true, busy: value?.busy === true, unloading: value?.unloading === true }; }
		catch { return { resident: true, busy: true, unloading: false }; } // an unknown owner cannot be credited as free
	}
	const used = () => [...models.values()].reduce((sum, model) => sum + (state(model).resident || reserved(model.role) ? model.footprint : 0), 0) + [...reservations.values()].reduce((sum, value) => sum + value.scratch, 0);
	async function refresh(signal) {
		check(signal); const value = await readMemory({ signal }); check(signal);
		if (!value || !Number.isSafeInteger(value.total) || value.total <= 0 || !Number.isSafeInteger(value.available) || value.available < 0 || value.available > value.total) throw fail("Local memory information is unavailable. No model was started.", "INFERENCE_MEMORY_UNAVAILABLE");
		sample = { total: value.total, available: value.available, source: value.source === "node-available-memory" ? value.source : "injected", at: now(), reserve: Math.min(4 * GiB, Math.floor(value.total / 3)), cap: Math.min(4 * GiB, Math.floor(value.total * 0.35)) }; lastError = undefined; return sample;
	}
	function candidates(except) {
		return [...models.values()].filter(model => model.role !== except && !reserved(model.role) && !pinned(model.role) && state(model).resident && !state(model).busy).sort((a, b) => a.footprint - b.footprint);
	}
	async function evict(model, signal) {
		check(signal); if (!candidates().includes(model)) return false;
		await model.unload(); // actual process/thread exit is part of this await; never credit a rejected Promise
		check(signal); if (state(model).resident) throw fail("An owned model has not finished unloading.", "INFERENCE_MEMORY_UNLOAD");
		evictions = [...evictions, { role: model.role, at: now() }].slice(-16); await refresh(signal); return true;
	}
	async function attempt(role, signal) {
		check(signal); const model = models.get(role); if (!model) throw fail("This local model has no registered memory owner.", "INFERENCE_MEMORY_OWNER");
		await refresh(signal);
		if (model.footprint + model.scratch > sample.cap) throw fail("This local model exceeds the memory budget for this computer.", "INFERENCE_MEMORY_CAPACITY");
		const fits = () => {
			const current = state(model), extra = current.resident || reserved(role) ? model.scratch : model.footprint + model.scratch;
			const promised = [...models.values()].reduce((sum, owner) => sum + (reserved(owner.role) && !state(owner).resident ? owner.footprint : 0), 0) + [...reservations.values()].reduce((sum, value) => sum + value.scratch, 0);
			return !current.unloading && sample.available >= sample.reserve + promised + extra && used() + (current.resident || reserved(role) ? 0 : model.footprint) + model.scratch <= sample.cap;
		};
		for (const other of candidates(role)) { if (fits()) break; await evict(other, signal); }
		if (!fits()) return undefined;
		const id = randomUUID(); reservations.set(id, { role, scratch: model.scratch });
		return { release() { if (reservations.delete(id)) wake(); } };
	}
	function pulse(signal, deadline) {
		return new Promise((resolve, reject) => {
			let timer; const cleanup = () => { clearTimeout(timer); pulses.delete(done); signal?.removeEventListener("abort", abort); };
			const done = () => { cleanup(); resolve(); }, abort = () => { cleanup(); reject(signal.reason); };
			pulses.add(done); signal?.addEventListener("abort", abort, { once: true });
			timer = setTimeout(done, Math.max(1, Math.min(intervalMs, deadline - now()))); if (signal?.aborted) abort();
		});
	}
	async function sweep() {
		await refresh(controller.signal);
		for (const [id, pin] of pins) if (pin.deadline <= now()) pins.delete(id);
		if (sample.available < sample.reserve || used() > sample.cap) {
			onPressure({ available: sample.available, reserve: sample.reserve });
			for (const model of candidates()) { if (sample.available >= sample.reserve && used() <= sample.cap) break; await evict(model, controller.signal); }
		}
		wake(); return status();
	}
	function status() {
		return structuredClone({ ...(sample ?? {}), estimatedOwnedBytes: used(), reservations: reservations.size, pins: [...pins.values()].filter(value => value.deadline > now()).map(value => ({ role: value.role, deadline: value.deadline })), waiting: [...waits.values()].map(value => ({ role: value.role, deadline: value.deadline })), models: [...models.values()].map(model => ({ role: model.role, ...state(model), footprint: model.footprint, scratch: model.scratch })), evictions, ...(lastError ? { error: lastError } : {}), scope: "owned-speech-and-embeddings", estimates: true });
	}
	const api = {
		register({ role, footprint, scratch, inspect, unload }) {
			if (closed || models.has(role) || !/^[a-z][a-z-]{1,31}$/.test(role) || !Number.isSafeInteger(footprint) || footprint <= 0 || !Number.isSafeInteger(scratch) || scratch < 0 || typeof inspect !== "function" || typeof unload !== "function") throw new Error("Invalid or duplicate local model memory owner.");
			models.set(role, { role, footprint, scratch, inspect, unload });
		},
		async acquire(role, { signal, priority = 0, deadline = Infinity } = {}) {
			const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, expires = Math.min(deadline, now() + waitMs), id = randomUUID();
			if (!Number.isInteger(priority) || priority < 0 || priority > 4 || !(Number.isFinite(deadline) || deadline === Infinity)) throw new Error("Invalid local memory request.");
			try {
				for (;;) {
					check(combined); if (now() >= expires) throw fail("This local request expired while waiting for memory.", "INFERENCE_MEMORY_EXPIRED");
					const lease = await serial(() => attempt(role, combined));
					try { check(combined); if (now() >= expires) throw fail("This local request expired while waiting for memory.", "INFERENCE_MEMORY_EXPIRED"); } catch (error) { lease?.release(); throw error; }
					if (lease) return lease;
					if (priority < 2) throw fail("Not enough memory for this local request while preserving room for your active app.", "INFERENCE_MEMORY_PRESSURE");
					waits.set(id, { role, deadline: expires }); await pulse(combined, expires);
				}
			} finally { waits.delete(id); }
		},
		pin(role, id, deadline) {
			check(); if (!models.has(role) || typeof id !== "string" || !id || id.length > 100 || !Number.isFinite(deadline) || deadline <= now() || deadline > now() + 30_000) throw new Error("Invalid bounded model residency hold.");
			const pin = { role, deadline }; pins.set(id, pin); return () => { if (pins.get(id) === pin && pins.delete(id)) wake(); };
		},
		clearPins() { pins.clear(); wake(); },
		check() { sweeping ??= serial(sweep).catch(error => { lastError = error.code ?? "INFERENCE_MEMORY_UNAVAILABLE"; throw error; }).finally(() => sweeping = undefined); return sweeping; },
		start() { if (closed || timer) return; timer = setInterval(() => void api.check().catch(() => {}), intervalMs); timer.unref?.(); },
		status,
		async close() { if (closed) return chain; closed = true; clearInterval(timer); pins.clear(); controller.abort(fail("Local memory admission closed.", "INFERENCE_MEMORY_CLOSED")); wake(); await chain; },
	};
	return api;
}
