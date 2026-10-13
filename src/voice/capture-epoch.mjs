// Capture permission and result delivery share an epoch: unlocking never revives media captured before a stop.
export function createCaptureEpoch() {
	let epoch = 0;
	const reasons = new Map();
	const failure = () => Object.assign(new Error(reasons.values().next().value ?? "This recording was cancelled. Start a new recording."), { name: "AbortError", code: "CAPTURE_REVOKED" });
	return {
		begin() { if (reasons.size) throw failure(); return epoch; },
		assert(token) { if (reasons.size || token !== epoch) throw failure(); },
		invalidate() { epoch++; },
		setReason(key, reason) { if (reasons.get(key) === reason) return; epoch++; reason ? reasons.set(key, reason) : reasons.delete(key); },
		blocked: () => reasons.size > 0,
	};
}
