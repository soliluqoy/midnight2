// Actual OCI boundary checks. Source code sees synthetic sentinels and an owned scratch filesystem only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBuildSandbox } from "../src/builder/build-sandbox.mjs";
const rootBase = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(rootBase, "midnight-source-sandbox-"));
const source = path.join(root, "source"); fs.mkdirSync(source);
const command = args => { const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 20_000 }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
const image = command(["image", "inspect", "--format", "{{.Id}}", process.env.MIDNIGHT_BUILD_IMAGE ?? "node:24-bookworm-slim"]);
const endpoint = command(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
const originalEnvironment = Object.fromEntries(["DOCKER_CONFIG", "DOCKER_CONTEXT"].map(key => [key, process.env[key]]));
const ownershipRoot = path.join(root, "ownership"), sandbox = createBuildSandbox({ image, timeoutMs: 15_000, ownershipRoot }), checks = [];
const ownedContainersAbsent = () => fs.readdirSync(ownershipRoot).filter(name => name.endsWith(".json")).every(name => {
	const record = JSON.parse(fs.readFileSync(path.join(ownershipRoot, name), "utf8"));
	return record.phase === "complete" && !command(["ps", "--all", "--no-trunc", "--filter", `id=${record.id}`, "--format", "{{.ID}}"]).length;
});
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); };
let report;
try {
	// A synthetic client config proves that build commands do not inject configured proxy credentials.
	const clientConfig = path.join(root, "client-config"); fs.mkdirSync(clientConfig);
	process.env.DOCKER_CONFIG = clientConfig; delete process.env.DOCKER_CONTEXT;
	command(["context", "create", "midnight-owned-fixture", "--docker", `host=${endpoint}`]);
	process.env.DOCKER_CONTEXT = "midnight-owned-fixture";
	fs.writeFileSync(path.join(clientConfig, "config.json"), JSON.stringify({ proxies: { default: { httpProxy: "http://OWNED_PROXY_USER:OWNED_PROXY_PASSWORD@127.0.0.1:8899" } }, HttpHeaders: { "X-Owned-Canary": "OWNED_HEADER_SECRET" } }));
	fs.writeFileSync(path.join(root, "host-secret"), "OWNED_SECRET_OUTSIDE_MOUNT");
	fs.writeFileSync(path.join(source, "fixture.mjs"), `import fs from 'node:fs'; import net from 'node:net';
const results={};
for(const name of ['/mnt/c/Users','/var/run/docker.sock','${root.replaceAll("\\", "/")}/host-secret']){try{fs.readFileSync(name);results[name]=false}catch{results[name]=true}}
try{fs.writeFileSync('/work/mutated-source','mutated');results.readonly=false}catch{results.readonly=true}
results.credentials=Object.keys(process.env).every(key=>!/(?:API_KEY|TOKEN|SECRET|PASSWORD|WSL_INTEROP)/i.test(key));
results.clientConfig=Object.values(process.env).every(value=>!/(?:OWNED_PROXY_USER|OWNED_PROXY_PASSWORD|OWNED_HEADER_SECRET)/.test(value));
results.uid=process.getuid()!==0;
results.privateTemp=fs.writeFileSync('/tmp/owned-output','ok')===undefined;
results.egress=await new Promise(resolve=>{const connection=net.connect({host:'1.1.1.1',port:443});connection.setTimeout(1000);connection.once('connect',()=>{connection.destroy();resolve(false)});connection.once('error',()=>resolve(true));connection.once('timeout',()=>{connection.destroy();resolve(true)})});
console.log(JSON.stringify(results));
`);
	const result = await sandbox.run({ source, entry: "/work/fixture.mjs" }); assert.equal(result.exitCode, 0, result.stderr);
	const observed = JSON.parse(result.stdout.trim());
	check("actual container cannot read excluded host paths or the Docker control socket", Object.entries(observed).filter(([key]) => key.startsWith("/")).every(([, value]) => value));
	check("actual source mount stays read-only and scratch output stays private", observed.readonly && observed.privateTemp && !fs.existsSync(path.join(source, "mutated-source")));
	check("actual container has no inherited provider credentials or Windows interop environment", observed.credentials && observed.uid);
	check("actual build excludes proxy credentials and custom headers from a synthetic Docker client config", observed.clientConfig);
	check("actual namespace prevents external TCP egress", observed.egress);
	check("actual Docker memory/CPU/process policy was applied and processes exited", result.policy.memoryBytes === 2 * 1024 ** 3 && result.policy.cpuCount === 2 && result.policy.pids === 128 && result.processesExited);
	fs.writeFileSync(path.join(source, "hang.mjs"), "import {spawn} from 'node:child_process'; spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref(); setInterval(()=>{},1000);");
	const before = Date.now(), short = createBuildSandbox({ image, timeoutMs: 500, ownershipRoot });
	await assert.rejects(short.run({ source, entry: "/work/hang.mjs" }), /deadline/);
	check("deadline cleanup removes an actual container with a detached child", ownedContainersAbsent());
	const controller = new AbortController(), pending = sandbox.run({ source, entry: "/work/hang.mjs", signal: controller.signal });
	const rejection = assert.rejects(pending, /explicit cancellation/); const timer = setTimeout(() => controller.abort(new Error("explicit cancellation")), 500);
	await rejection; clearTimeout(timer);
	check("explicit cancellation observes container exit and removal before settlement", ownedContainersAbsent());
	const orphan = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/source-orphan.mjs", import.meta.url))], { windowsHide: true, encoding: "utf8", timeout: 20_000, env: { ...process.env, MIDNIGHT_SOURCE_ORPHAN_ROOT: root, MIDNIGHT_SOURCE_ORPHAN_IMAGE: image } });
	assert.equal(orphan.status, 0, orphan.stderr); assert.equal(sandbox.pending().length, 1);
	const orphanRecord = JSON.parse(fs.readFileSync(sandbox.pending()[0], "utf8")); assert.equal(orphanRecord.phase, "running"); assert.equal(JSON.parse(command(["inspect", "--format", "{{json .State}}", orphanRecord.id])).Running, true);
	await sandbox.recover(); check("fresh owner recovers a live container and detached child after its parent process exits", ownedContainersAbsent());
	check("excluded owned host sentinel remains unchanged", fs.readFileSync(path.join(root, "host-secret"), "utf8") === "OWNED_SECRET_OUTSIDE_MOUNT");
	report = { at: new Date().toISOString(), passed: true, image, checks, forcedDeadlineAndCleanupMs: Date.now() - before, policy: result.policy, limitations: ["Synthetic boundary probes on this Docker Desktop Linux engine; no hostile-code certification, kernel escape proof or full application repair/build claim.", "No production data, credentials, checkout mutation, installation or publication; signed Windows builds and interactive previews remain separate qualification."] };
} finally {
	await sandbox.recover();
	for (const [key, value] of Object.entries(originalEnvironment)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
	assert.equal(path.dirname(fs.realpathSync(root)), rootBase); assert.match(path.basename(root), /^midnight-source-sandbox-[^/\\]+$/);
	fs.rmSync(root, { recursive: true, force: true });
	if (report && process.env.MIDNIGHT_TEST_REPORT) { const file = path.resolve(process.env.MIDNIGHT_TEST_REPORT); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2)); }
}
