import assert from "node:assert/strict";
import test from "node:test";
import { createPlatformBridge } from "../src/runtime/platform-bridge.mjs";

test("supervised cancellation retains the platform request until cleanup acknowledgement", async () => {
	for (const op of ["builder.run", "plugin.execute"]) {
		const messages = [], bridge = createPlatformBridge({ send: value => messages.push(value) }), controller = new AbortController();
		let settled = false;
		const pending = bridge.call(op, {}, { signal: controller.signal }); pending.catch(() => { settled = true; });
		const reason = Object.assign(new Error("Yield to quick work"), { code: "QUEUE_PREEMPTED" }); controller.abort(reason);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(settled, false); assert.equal(bridge.pendingCount(), 1); assert.equal(messages[1].kind, "platform-cancel");
		bridge.respond({ id: messages[0].id, ok: true, result: "A cancelled result cannot become authority" });
		await assert.rejects(pending, error => error === reason); assert.equal(bridge.pendingCount(), 0);
	}
});
test("ordinary cancellation settles immediately and late platform replies stay inert", async () => {
	const messages = [], bridge = createPlatformBridge({ send: value => messages.push(value) }), controller = new AbortController();
	const pending = bridge.call("fetch.page", {}, { signal: controller.signal }), rejected = assert.rejects(pending, /cancelled/);
	controller.abort(new Error("cancelled")); await rejected;
	assert.equal(bridge.pendingCount(), 0); assert.equal(bridge.respond({ id: messages[0].id, ok: true, result: "late" }), false);
});
test("revoked work never sends and settled work removes its cancellation listener", async () => {
	const messages = [], bridge = createPlatformBridge({ send: value => messages.push(value) }), cancelled = new AbortController(); cancelled.abort(new Error("already revoked"));
	await assert.rejects(bridge.call("builder.run", {}, { signal: cancelled.signal }), /already revoked/); assert.equal(messages.length, 0);
	const controller = new AbortController(), pending = bridge.call("builder.run", {}, { signal: controller.signal });
	bridge.respond({ id: messages[0].id, ok: true, result: { done: true } }); assert.deepEqual(await pending, { done: true });
	controller.abort(); assert.equal(messages.length, 1); assert.equal(bridge.pendingCount(), 0);
});
test("transport failures clean up and structured uncertainty is preserved", async () => {
	const failed = createPlatformBridge({ send() { throw new Error("closed transport"); } });
	await assert.rejects(failed.call("builder.run"), /closed transport/); assert.equal(failed.pendingCount(), 0);
	const messages = [], bridge = createPlatformBridge({ send: value => messages.push(value) }), pending = bridge.call("word.apply");
	bridge.respond({ id: messages[0].id, ok: false, error: "unknown outcome", code: "APP_EDIT_UNKNOWN", uncertain: true });
	await assert.rejects(pending, { code: "APP_EDIT_UNKNOWN", uncertain: true });
});
