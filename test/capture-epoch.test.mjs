import assert from "node:assert/strict";
import test from "node:test";
import { createCaptureEpoch } from "../src/voice/capture-epoch.mjs";

test("a late decoded recording or transcript stays revoked after unlock", () => {
	const fence = createCaptureEpoch();
	const old = fence.begin();
	fence.setReason("lock", "The computer is locked.");
	assert.throws(() => fence.begin(), { code: "CAPTURE_REVOKED" });
	fence.setReason("lock", undefined);
	assert.throws(() => fence.assert(old), { code: "CAPTURE_REVOKED" });
	fence.assert(fence.begin());
	const hidden = fence.begin(); fence.invalidate();
	assert.throws(() => fence.assert(hidden), { code: "CAPTURE_REVOKED" });
});

test("clearing one session block does not clear another or revive emergency-era recordings", () => {
	const fence = createCaptureEpoch();
	const old = fence.begin();
	fence.setReason("lock", "Locked"); fence.setReason("suspend", "Suspended");
	fence.setReason("lock", undefined);
	assert.equal(fence.blocked(), true);
	fence.setReason("suspend", undefined); fence.setReason("emergency", "Stopped");
	assert.throws(() => fence.begin(), /Stopped/);
	fence.setReason("emergency", undefined);
	fence.assert(fence.begin());
	assert.throws(() => fence.assert(old), { code: "CAPTURE_REVOKED" });
});
