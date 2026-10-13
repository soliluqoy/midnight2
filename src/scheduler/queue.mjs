// Bounded mission concurrency (plan ch. 08, C01). Direct user work first, then time-sensitive authorized work,
// routine preparation, then speculative work. Waiting items age upward so nothing starves forever. Slot counts
// are tuning defaults, not promises: two network/I/O missions and one local-inference mission at a time.
export const PRIORITY = { interactive: -1, user: 0, timeSensitive: 1, routine: 2, speculative: 3 };
export const QUEUE_LIMITS = Object.freeze({ interactive: 8, user: 16, background: 4 });
const aborted = (message, code) => Object.assign(new Error(message), { name: "AbortError", code });
export class QueueFullError extends Error {
	constructor(group) { super(group === "interactive" ? "Finish or dismiss a pending quick request before starting another." : group === "background" ? "Background work is full. This update remains available for review." : "Midnight's task queue is full. Finish or pause a task before adding another."); this.code = "QUEUE_FULL"; this.group = group; }
}

export function createQueue({ start, slots = { network: 2, inference: 1 }, limits = QUEUE_LIMITS, reserveInteractive = false, agingMs = 5 * 60 * 1000, now = () => Date.now(), onExpire = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
	limits = { ...QUEUE_LIMITS, ...limits };
	if (Object.values(limits).some(value => !Number.isInteger(value) || value < 1 || value > 128)) throw new Error("Invalid mission queue capacity.");
	const waiting = [];
	const running = new Map(); // missionId -> dispatched item
	const reservations = new Map();
	const external = new Map(); // Host-owned work shares mission slots; its Promise settles after physical cleanup.
	let closed = false, expiration, pumping = false, pumpAgain = false;
	let gate = () => undefined; // (item) -> reason it must wait, or undefined
	const reasons = new Map(); // missionId -> why it is still waiting

	const groupFor = item => item.priority < PRIORITY.user ? "interactive" : item.priority === PRIORITY.user ? "user" : "background";
	const effective = it => it.priority <= PRIORITY.user ? it.priority : Math.max(PRIORITY.timeSensitive, it.priority - Math.floor((now() - it.enqueuedAt) / agingMs));
	const used = slot => [...running.values()].filter(item => item.slot === slot).length;
	const count = group => waiting.filter(item => groupFor(item) === group).length + [...running.values()].filter(item => groupFor(item) === group).length + [...reservations.values()].filter(item => item.group === group).length;
	const validate = item => { if (!Number.isInteger(item.priority ?? PRIORITY.user) || (item.priority ?? PRIORITY.user) < PRIORITY.interactive || (item.priority ?? PRIORITY.user) > PRIORITY.speculative || (item.deadline !== undefined && !Number.isFinite(item.deadline))) throw new Error("Invalid mission queue request."); if (closed) throw new Error("The mission queue is closed."); };
	const blocked = it => {
		const slot = it.slot ?? "network", reserved = reserveInteractive && slot === "network" && slots.network >= 2 && it.priority >= PRIORITY.user;
		const ordinary = [...running.values()].filter(item => item.slot === slot && item.priority >= PRIORITY.user).length;
		return gate(it) ?? (reserved && ordinary >= slots.network - 1 ? "Waiting for a task slot; one slot stays available for quick requests" : used(slot) >= (slots[slot] ?? 1) ? `queued behind ${used(slot) === 1 ? "another mission" : `${used(slot)} missions`}` : undefined);
	};
	const dropWaiting = id => { const index = waiting.findIndex(item => item.missionId === id); if (index >= 0) waiting.splice(index, 1); reasons.delete(id); };
	function notifyWaiting(entry, reason) {
		if (entry.waitingReason === reason) return;
		entry.waitingReason = reason;
		try { entry.onWaiting?.(reason); } catch (error) { entry.controller.abort(error); }
	}
	function scheduleExpiry() {
		clearTimer(expiration); expiration = undefined;
		if (closed) return;
		const deadlines = waiting.filter(item => Number.isFinite(item.deadline)).map(item => item.deadline);
		if (deadlines.length) { expiration = setTimer(() => pump(), Math.max(1, Math.min(...deadlines) - now())); expiration.unref?.(); }
	}

	function pump() {
		if (closed) return;
		if (pumping) { pumpAgain = true; return; }
		pumping = true;
		try { do { pumpAgain = false; pumpOnce(); } while (pumpAgain && !closed); }
		finally { pumping = false; }
	}
	function pumpOnce() {
		if (closed) return;
		for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].deadline !== undefined && waiting[i].deadline <= now()) {
			const expired = waiting.splice(i, 1)[0]; reasons.delete(expired.missionId);
			const entry = external.get(expired.missionId);
			if (entry) entry.controller.abort(aborted("This queued background job expired. Resume it when resources are available.", "QUEUE_EXPIRED")); else onExpire(expired);
		}
		waiting.sort((a, b) => effective(a) - effective(b) || a.enqueuedAt - b.enqueuedAt);
		for (const [id, entry] of external) {
			const active = running.get(id); if (!active || entry.controller.signal.aborted) continue;
			const why = gate(active);
			if (why) entry.controller.abort(aborted(why, "QUEUE_DEFERRED"));
			else if (active.preemptible && waiting.some(item => item.priority < active.priority && (item.slot ?? "network") === active.slot && !gate(item) && blocked(item))) entry.controller.abort(aborted("The change job yielded to higher-priority work. Resume the same candidate when ready.", "QUEUE_PREEMPTED"));
		}
		for (let i = 0; i < waiting.length && !closed; ) {
			const it = waiting[i];
			const slot = it.slot ?? "network";
			const why = blocked(it), entry = external.get(it.missionId);
			if (why) {
				reasons.set(it.missionId, why);
				if (entry) notifyWaiting(entry, why);
				i++;
				continue;
			}
			waiting.splice(i, 1);
			reasons.delete(it.missionId);
			running.set(it.missionId, { ...it, slot });
			if (entry) { notifyWaiting(entry, undefined); entry.resolve(); }
			else Promise.resolve()
				.then(() => start(it))
				.catch(() => {})
				.finally(() => {});
		}
		scheduleExpiry();
	}

	const api = {
		async run(item, task, { signal, onWaiting, onRevoke } = {}) {
			signal?.throwIfAborted(); validate(item);
			const id = item.missionId;
			if (typeof id !== "string" || !id || typeof task !== "function" || external.has(id) || running.has(id) || waiting.some(value => value.missionId === id)) throw new Error("Invalid or duplicate scheduled background job.");
			let resolve, reject;
			const admitted = new Promise((yes, no) => { resolve = yes; reject = no; }), controller = new AbortController();
			const entry = { controller, resolve, reject, onWaiting }; external.set(id, entry);
			const cancel = () => controller.abort(signal.reason ?? aborted("Background job cancelled.", "QUEUE_CANCELLED"));
			const revoked = () => {
				try { onRevoke?.(controller.signal.reason); } catch {}
				if (!running.has(id)) { dropWaiting(id); reject(controller.signal.reason); pump(); }
			};
			controller.signal.addEventListener("abort", revoked, { once: true }); signal?.addEventListener("abort", cancel, { once: true });
			try {
				api.enqueue(item);
				await admitted; controller.signal.throwIfAborted();
				const result = await task(controller.signal); controller.signal.throwIfAborted(); return result;
			} finally {
				signal?.removeEventListener("abort", cancel); controller.signal.removeEventListener("abort", revoked);
				external.delete(id); dropWaiting(id); running.delete(id); pump();
			}
		},
		reserve(item = {}) {
			validate(item); const group = groupFor({ priority: PRIORITY.user, ...item });
			if (count(group) >= limits[group]) throw new QueueFullError(group);
			const token = Object.freeze({}); reservations.set(token, { group }); return token;
		},
		releaseReservation: token => reservations.delete(token),
		/** @param {{ missionId: string, priority?: number, slot?: "network"|"inference", speculative?: boolean }} item */
		enqueue(item, reservation) {
			validate(item);
			if (running.has(item.missionId) || waiting.some((w) => w.missionId === item.missionId)) return false;
			const group = groupFor({ priority: PRIORITY.user, ...item });
			if (reservation) { if (reservations.get(reservation)?.group !== group) throw new Error("The queue reservation does not match this request."); reservations.delete(reservation); }
			else if (count(group) >= limits[group]) throw new QueueFullError(group);
			waiting.push({ priority: PRIORITY.user, ...item, enqueuedAt: now() });
			pump();
			return true;
		},
		done(missionId) {
			if (external.has(missionId)) return; // Only run() can free an external task after its cleanup settles.
			running.delete(missionId);
			pump();
		},
		remove(missionId) {
			const entry = external.get(missionId);
			if (entry) { entry.controller.abort(aborted("Background job cancelled.", "QUEUE_CANCELLED")); return; }
			dropWaiting(missionId);
			scheduleExpiry();
		},
		setGate(fn) {
			gate = fn;
			pump();
		},
		setSlots(next) {
			Object.assign(slots, next);
			pump();
		},
		pump,
		isRunning: (missionId) => running.has(missionId),
		isWaiting: (missionId) => waiting.some((w) => w.missionId === missionId),
		why: (missionId) => reasons.get(missionId),
		status: () => ({ running: [...running.keys()], waiting: waiting.map((w) => ({ missionId: w.missionId, priority: w.priority, deadline: w.deadline, why: reasons.get(w.missionId) })), capacity: Object.fromEntries(Object.keys(QUEUE_LIMITS).map(group => [group, { used: count(group), limit: limits[group] }])) }),
		close() { closed = true; clearTimer(expiration); reservations.clear(); for (const entry of external.values()) entry.controller.abort(aborted("Background scheduling stopped.", "QUEUE_CLOSED")); },
	};
	return api;
}
