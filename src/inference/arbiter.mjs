// One admission point for expensive local work. A revoked lease remains occupied until its owner has
// stopped the actual worker/stream and releases it; cancelling a Promise never frees compute by itself.
import { randomUUID } from "node:crypto";

export const INFERENCE_PRIORITY = Object.freeze({ interactive: 0, user: 1, background: 2, speculative: 3, builder: 4 });
const error = (message, code) => Object.assign(new Error(message), { name: "AbortError", code });

export function createInferenceArbiter({ maxWaiting = 32, now = () => Date.now() } = {}) {
	const waiting = [];
	let active, paused, closed = false, timer, gate = () => undefined;
	const notify = new Set();
	const snapshot = () => ({ paused, closed, running: active ? [{ id: active.id, role: active.role, priority: active.priority, revoked: active.ac.signal.aborted, startedAt: active.startedAt }] : [], waiting: waiting.map(it => ({ id: it.id, role: it.role, priority: it.priority, deadline: it.deadline, why: gate(it) })) });
	function changed() { for (const fn of notify) { try { fn(snapshot()); } catch {} } }
	function discard(it, reason) {
		const index = waiting.indexOf(it);
		if (index < 0) return;
		waiting.splice(index, 1);
		it.signal?.removeEventListener("abort", it.cancel);
		it.reject(reason);
	}
	function pump() {
		clearTimeout(timer);
		for (const it of [...waiting]) if (it.deadline <= now()) discard(it, error("This local request expired before it could start.", "INFERENCE_EXPIRED"));
		waiting.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
		const index = waiting.findIndex(it => !gate(it));
		if (!active && !paused && !closed && index >= 0) {
			const [it] = waiting.splice(index, 1);
			it.signal?.removeEventListener("abort", it.cancel);
			it.startedAt = now();
			it.ac = new AbortController();
			active = it;
			const cancel = () => it.ac.abort(it.signal.reason ?? error("Local work cancelled.", "INFERENCE_CANCELLED"));
			it.signal?.addEventListener("abort", cancel, { once: true });
			if (it.signal?.aborted) cancel();
			let released = false;
			it.resolve({ id: it.id, signal: it.ac.signal, release() {
				if (released) return;
				released = true;
				it.signal?.removeEventListener("abort", cancel);
				if (active === it) active = undefined;
				pump();
			} });
		}
		const first = waiting.find(it => !gate(it));
		if (active?.preemptible && first && first.priority < active.priority && !active.ac.signal.aborted) active.ac.abort(error("Background work yielded to an interactive request.", "INFERENCE_PREEMPTED"));
		const deadlines = waiting.map(it => it.deadline).filter(Number.isFinite);
		if (deadlines.length) { timer = setTimeout(pump, Math.max(1, Math.min(...deadlines) - now())); timer.unref?.(); }
		changed();
	}
	function acquire({ id = randomUUID(), role = "text", priority = INFERENCE_PRIORITY.user, signal, deadline = Infinity, preemptible = false } = {}) {
		if (closed) return Promise.reject(error("Local inference is closed.", "INFERENCE_CLOSED"));
		if (paused) return Promise.reject(error(paused, "INFERENCE_PAUSED"));
		if (signal?.aborted) return Promise.reject(signal.reason ?? error("Local work cancelled.", "INFERENCE_CANCELLED"));
		if (!Number.isInteger(priority) || priority < 0 || priority > INFERENCE_PRIORITY.builder || !(deadline === Infinity || Number.isFinite(deadline))) return Promise.reject(new Error("Invalid local inference priority or deadline."));
		if (active?.id === id || waiting.some(it => it.id === id)) return Promise.reject(new Error("This local inference request already exists."));
		if (waiting.length >= maxWaiting) return Promise.reject(error("Local work queue is full. Try again when the current requests finish.", "INFERENCE_QUEUE_FULL"));
		return new Promise((resolve, reject) => {
			const it = { id, role, priority, signal, deadline, preemptible, resolve, reject, enqueuedAt: now() };
			it.cancel = () => { discard(it, signal.reason ?? error("Local work cancelled.", "INFERENCE_CANCELLED")); pump(); };
			signal?.addEventListener("abort", it.cancel, { once: true });
			waiting.push(it);
			pump();
		});
	}
	function revoke(reason) {
		for (const it of [...waiting]) discard(it, error(reason, closed ? "INFERENCE_CLOSED" : "INFERENCE_PAUSED"));
		active?.ac.abort(error(reason, closed ? "INFERENCE_CLOSED" : "INFERENCE_PAUSED"));
		pump();
	}
	return {
		acquire,
		async run(options, task) { const lease = await acquire(options); try { lease.signal.throwIfAborted(); return await task(lease.signal); } finally { lease.release(); } },
		pause(reason = "Local work is paused.") { paused = reason; revoke(reason); },
		revokeBackground(reason = "Background inference yielded to memory pressure.") { if (active?.preemptible && active.priority >= INFERENCE_PRIORITY.background) active.ac.abort(error(reason, "INFERENCE_MEMORY_PRESSURE")); },
		resume() { if (!closed) { paused = undefined; pump(); } },
		setGate(fn) { gate = fn; if (active && gate(active)) active.ac.abort(error(gate(active), "INFERENCE_DEFERRED")); pump(); },
		close() { closed = true; paused = "Local inference is closed."; revoke(paused); clearTimeout(timer); },
		status: snapshot,
		subscribe(fn) { notify.add(fn); return () => notify.delete(fn); },
	};
}
