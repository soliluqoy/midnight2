// Cancellation requests revoke authority immediately. Supervised work retains its lease until the shell
// acknowledges cleanup; in particular, the builder runner answers only after its utility process exits.
const cleanupAcknowledged = new Set(["builder.run", "plugin.execute"]);
export function createPlatformBridge({ send }) {
	let sequence = 0;
	const pending = new Map();
	return {
		async call(op, args = {}, { signal } = {}) {
			signal?.throwIfAborted();
			const id = ++sequence;
			return new Promise((resolve, reject) => {
				const cleanup = () => { pending.delete(id); signal?.removeEventListener("abort", cancel); };
				const entry = { resolve, reject, cleanup };
				const cancel = () => {
					entry.cancelled = signal.reason ?? new Error("Platform request cancelled.");
					try { send({ kind: "platform-cancel", id }); } catch {}
					if (!cleanupAcknowledged.has(op)) { cleanup(); reject(entry.cancelled); }
				};
				pending.set(id, entry); signal?.addEventListener("abort", cancel, { once: true });
				try { send({ kind: "platform", id, op, args }); }
				catch (error) { cleanup(); reject(error); }
			});
		},
		respond(message) {
			const entry = pending.get(message.id); if (!entry) return false;
			entry.cleanup();
			if (entry.cancelled) entry.reject(entry.cancelled);
			else if (message.ok) entry.resolve(message.result);
			else entry.reject(Object.assign(new Error(message.error), { code: message.code, uncertain: message.uncertain }));
			return true;
		},
		pendingCount: () => pending.size,
	};
}
