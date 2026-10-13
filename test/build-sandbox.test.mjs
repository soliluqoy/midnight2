import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createBuildSandbox } from "../src/builder/build-sandbox.mjs";
import { createQueue, PRIORITY } from "../src/scheduler/queue.mjs";
import { tempDir } from "./helpers.mjs";
import { until } from "./e2e-helpers.mjs";

const image = `sha256:${"b".repeat(64)}`, id = "c".repeat(64);
const endpoint = "unix:///var/run/docker.sock", daemonId = "owned-engine";
const ok = stdout => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
const failed = stderr => ({ code: 1, stdout: "", stderr });
function fixture() {
	const root = tempDir("midnight-source-owner"), source = path.join(root, "source"), ownershipRoot = path.join(root, "ownership"); fs.mkdirSync(source);
	let container, disconnected = false; const calls = [], waiting = [];
	const execute = async args => {
		calls.push(args); if (disconnected) return failed("Cannot connect to the Docker daemon");
		if (args[0] === "context") return ok(args[1] === "show" ? "owned-local" : endpoint);
		if (args[0] === "info") return ok(daemonId);
		if (args[0] === "image") return ok(image);
		if (args[0] === "create") {
			const name = args[args.indexOf("--name") + 1], owner = args.find(value => value.startsWith("midnight.source-owner=")).split("=")[1];
			assert.equal(JSON.parse(fs.readFileSync(path.join(ownershipRoot, `${name}.json`), "utf8")).phase, "creating", "ownership is durable before container creation");
			container = { Id: id, Name: `/${name}`, Image: image, Config: { Labels: { "midnight.source-build": "1", "midnight.source-owner": owner } }, State: { Running: false, Pid: 0 } }; return ok(id);
		}
		if (args[0] === "inspect") {
			if (!container) return failed("Error: No such object: " + args.at(-1));
			if (args[2] === "{{json .HostConfig}}") return ok({ NetworkMode: "none", ReadonlyRootfs: true, Memory: 2 * 1024 ** 3, MemorySwap: 2 * 1024 ** 3, PidsLimit: 128, NanoCpus: 2e9, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] });
			if (args[2] === "{{json .Mounts}}") return ok([{ Type: "bind", RW: false, Destination: "/work" }]);
			return ok(args[2] === "{{json .State}}" ? container.State : container);
		}
		if (args[0] === "start") { container.State = { Running: true, Pid: 123 }; return ok(id); }
		if (args[0] === "wait" || args[0] === "kill") { container.State = { Running: false, Pid: 0 }; return ok("0"); }
		if (args[0] === "logs") return ok("validated\n");
		if (args[0] === "rm") { assert.equal(container.State.Pid, 0); container = undefined; return ok(id); }
		if (args[0] === "ps") return ok(container ? container.Id : "");
		throw new Error("Unexpected control request");
	};
	return { root, source, ownershipRoot, execute, calls, waiting, get container() { return container; }, disconnect() { disconnected = true; }, reconnect() { disconnected = false; } };
}
const sandboxFor = (f, execute = f.execute) => createBuildSandbox({ image, ownershipRoot: f.ownershipRoot, execute, cleanupRetryMs: 5, onCleanupWaiting: reason => f.waiting.push(reason) });
const run = (sandbox, f) => sandbox.run({ source: f.source, entry: "/work/check.mjs" });

test("source build records exact ownership before effect and completion only after physical exit and removal", async () => {
	const f = fixture(), sandbox = sandboxFor(f), result = await run(sandbox, f);
	assert.equal(result.processesExited, true); assert.equal(f.container, undefined); assert.deepEqual(sandbox.pending(), []);
	const record = JSON.parse(fs.readFileSync(path.join(f.ownershipRoot, fs.readdirSync(f.ownershipRoot).find(name => name.endsWith(".json"))), "utf8"));
	assert.equal(record.id, id); assert.equal(record.phase, "complete"); assert.ok(record.completedAt);
	assert.equal(record.endpoint, endpoint); assert.equal(record.daemonId, daemonId);
});

test("a lost create reply recovers the exact named container and never starts it", async () => {
	const f = fixture(), sandbox = sandboxFor(f, async args => { const result = await f.execute(args); if (args[0] === "create") throw new Error("lost create reply"); return result; });
	await assert.rejects(run(sandbox, f), /lost create reply/); assert.equal(f.container, undefined);
	assert.equal(f.calls.some(args => args[0] === "start"), false); assert.equal(sandbox.pending().length, 0);
});

test("a lost start reply and control-plane outage keep the shared slot until cleanup is confirmed", async () => {
	const f = fixture(), queue = createQueue({ slots: { network: 1, inference: 1 }, start: () => {} });
	const sandbox = sandboxFor(f, async args => { const result = await f.execute(args); if (args[0] === "start") { f.disconnect(); return failed("lost start reply"); } return result; });
	let settled = false, interactiveStarted = false;
	const pending = queue.run({ missionId: "source", priority: PRIORITY.speculative }, () => run(sandbox, f));
	const rejected = assert.rejects(pending, /lost start reply/).then(() => { settled = true; });
	await until(() => f.waiting.some(Boolean));
	const interactive = queue.run({ missionId: "quick", priority: PRIORITY.interactive }, () => { interactiveStarted = true; });
	queue.remove("source"); await new Promise(resolve => setTimeout(resolve, 15));
	assert.equal(settled, false); assert.equal(interactiveStarted, false); assert.equal(f.container.State.Running, true);
	assert.deepEqual(queue.status().running, ["source"]); assert.equal(sandbox.pending().length, 1);
	f.reconnect(); await rejected; await interactive;
	assert.equal(f.container, undefined); assert.equal(interactiveStarted, true); assert.equal(sandbox.pending().length, 0); queue.close();
});

test("restart recovery refuses another container identity and stops only its recorded owner", async () => {
	const f = fixture(), sandbox = sandboxFor(f), owner = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name = `midnight-core-${owner}`;
	const record = { format: 2, owner, name, image, id, endpoint, daemonId, phase: "running" }; fs.mkdirSync(f.ownershipRoot, { recursive: true }); fs.writeFileSync(path.join(f.ownershipRoot, `${name}.json`), JSON.stringify(record));
	let label = "different-owner", running = true, removed = false, settled = false;
	const restarted = createBuildSandbox({ image, ownershipRoot: f.ownershipRoot, cleanupRetryMs: 5, onCleanupWaiting: reason => f.waiting.push(reason), execute: async args => {
		f.calls.push(args);
		if (args[0] === "info") return ok(daemonId);
		if (args[0] === "inspect") return ok(args[2] === "{{json .State}}" ? { Running: running, Pid: running ? 321 : 0 } : { Id: id, Name: `/${name}`, Image: image, Config: { Labels: { "midnight.source-build": "1", "midnight.source-owner": label } }, State: { Running: running, Pid: running ? 321 : 0 } });
		if (args[0] === "kill" || args[0] === "wait") { running = false; return ok("0"); }
		if (args[0] === "rm") { removed = true; return ok(id); }
		throw new Error("Recovery cannot create or start a container");
	} });
	const recovery = restarted.recover().then(() => { settled = true; }); await until(() => f.waiting.some(Boolean));
	assert.equal(settled, false); assert.equal(f.calls.some(args => args[0] === "kill"), false); assert.equal(removed, false);
	label = owner; await recovery; assert.equal(removed, true); assert.deepEqual(restarted.pending(), []); assert.deepEqual(sandbox.pending(), []);
});

test("a lost removal acknowledgement is reconciled using an absence query on a reachable daemon", async () => {
	const f = fixture(), sandbox = sandboxFor(f, async args => { const result = await f.execute(args); return args[0] === "rm" ? failed("lost removal reply") : result; });
	const result = await run(sandbox, f); assert.equal(result.processesExited, true); assert.equal(f.container, undefined);
	assert.ok(f.calls.some(args => args[0] === "ps" && args.includes("--no-trunc"))); assert.deepEqual(sandbox.pending(), []);
});
test("cleanup cannot credit a missing container on a different daemon after a context or engine change", async () => {
	const f = fixture(); let activeDaemon = daemonId, settled = false;
	const sandbox = sandboxFor(f, async (args, options) => {
		if (args[0] !== "context") assert.equal(options.endpoint, endpoint, "every effect and observation uses the recorded local endpoint");
		if (args[0] === "info") return ok(activeDaemon);
		const result = await f.execute(args); if (args[0] === "logs") activeDaemon = "other-engine"; return result;
	});
	const pending = run(sandbox, f).then(() => { settled = true; }); await until(() => f.waiting.some(Boolean));
	assert.equal(settled, false); assert.equal(f.calls.some(args => args[0] === "rm"), false); assert.equal(sandbox.pending().length, 1);
	activeDaemon = daemonId; await pending; assert.equal(f.container, undefined); assert.equal(sandbox.pending().length, 0);
});
test("source preflight rejects remote Docker endpoints before any container or provider work", async () => {
	const f = fixture(), sandbox = sandboxFor(f, async args => args[0] === "context" && args[1] === "inspect" ? ok("ssh://remote-build-host") : f.execute(args));
	await assert.rejects(sandbox.preflight(), /prepared local/); assert.equal(f.calls.some(args => args[0] === "create"), false);
});
