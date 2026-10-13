// Host-owned OCI policy. The caller supplies frozen source and a prequalified image, never model shell text.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const IMAGE = /^sha256:[a-f0-9]{64}$/;
const OWNER = /^[a-f0-9-]{36}$/;
const localEndpoint = value => typeof value === "string" && (/^npipe:\/\/\/\/\.\/pipe\/docker(?:DesktopLinuxEngine|_engine)$/.test(value) || /^unix:\/\/\/[^\x00-\x1f,]+\.sock$/.test(value));
function saveOwnership(file, record) {
	if (!file) return;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	for (const target of [file, `${file}.tmp`]) if (fs.existsSync(target) && (fs.lstatSync(target).isSymbolicLink() || fs.statSync(target).nlink !== 1)) throw new Error("Source-build ownership refuses linked records.");
	const fd = fs.openSync(`${file}.tmp`, "w", 0o600);
	try { fs.writeFileSync(fd, JSON.stringify(record, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	fs.renameSync(`${file}.tmp`, file);
}
function readOwnership(file) {
	const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16_384) throw new Error("Invalid source-build ownership record.");
	const record = JSON.parse(fs.readFileSync(file, "utf8"));
	if (![1, 2].includes(record.format) || !OWNER.test(record.owner ?? "") || record.name !== `midnight-core-${record.owner}` || !IMAGE.test(record.image ?? "") || record.id !== undefined && !/^[a-f0-9]{64}$/.test(record.id) || !["creating", "running", "cleanup", "complete"].includes(record.phase) || record.format === 2 && (!localEndpoint(record.endpoint) || !/^[a-zA-Z0-9:-]{1,128}$/.test(record.daemonId ?? ""))) throw new Error("Invalid source-build ownership identity.");
	return record;
}
function mount(directory, target) {
	const source = fs.realpathSync(directory); if (/[",\r\n]/.test(source)) throw new Error("Unsupported source mount path.");
	return ["--mount", `type=bind,source=${source},target=${target},readonly`];
}
export function createBuildSandbox({ docker = "docker", image, memoryBytes = 2 * 1024 ** 3, cpuCount = 2, pids = 128, timeoutMs = 120_000, outputLimit = 2 * 1024 ** 2, execute, ownershipRoot, cleanupRetryMs = 2_000, onCleanupWaiting = () => {} } = {}) {
	if (!IMAGE.test(image ?? "") || !Number.isSafeInteger(memoryBytes) || memoryBytes < 256 * 1024 ** 2 || memoryBytes > 4 * 1024 ** 3 || !Number.isInteger(cpuCount) || cpuCount < 1 || cpuCount > 4 || !Number.isInteger(pids) || pids < 16 || pids > 256 || timeoutMs < 1 || timeoutMs > 600_000 || !Number.isInteger(cleanupRetryMs) || cleanupRetryMs < 1 || cleanupRetryMs > 30_000) throw new Error("Invalid source-build sandbox policy.");
	if (!ownershipRoot) throw new Error("Source builds need a private ownership directory.");
	fs.mkdirSync(ownershipRoot, { recursive: true });
	const controlDirectory = path.join(ownershipRoot, ".docker-control"); fs.mkdirSync(controlDirectory, { recursive: true });
	if (fs.lstatSync(controlDirectory).isSymbolicLink()) throw new Error("Docker build controls refuse linked directories.");
	const controlFile = path.join(controlDirectory, "config.json");
	if (fs.existsSync(controlFile) && (fs.lstatSync(controlFile).isSymbolicLink() || fs.statSync(controlFile).nlink !== 1)) throw new Error("Docker build controls refuse linked files.");
	fs.writeFileSync(controlFile, "{}", { mode: 0o600 });
	const command = execute ?? ((args, { signal, captureLimit = outputLimit, endpoint, discover = false } = {}) => new Promise((resolve, reject) => {
		signal?.throwIfAborted();
		const environment = discover ? process.env : Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^DOCKER_/i.test(key)));
		const controlArgs = discover ? args : ["--config", controlDirectory, ...(endpoint ? ["--host", endpoint] : []), ...args];
		const child = spawn(docker, controlArgs, { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "", bytes = 0, failure;
		const controlDeadline = setTimeout(() => { failure ??= new Error("Docker control request exceeded its deadline."); child.kill(); }, args[0] === "wait" ? timeoutMs + 30_000 : 20_000);
		const stop = () => { failure ??= signal.reason ?? new Error("Docker control request cancelled."); child.kill(); };
		signal?.addEventListener("abort", stop, { once: true });
		for (const [stream, append] of [[child.stdout, value => { stdout += value; }], [child.stderr, value => { stderr += value; }]]) stream.on("data", chunk => { bytes += chunk.length; if (bytes > captureLimit) { failure ??= new Error("Build diagnostics exceeded their output budget."); child.kill(); } else append(chunk.toString()); });
		child.once("error", error => { failure = error; });
		child.once("close", code => { clearTimeout(controlDeadline); signal?.removeEventListener("abort", stop); failure ? reject(failure) : resolve({ code, stdout, stderr }); });
	}));
	const checked = async (args, options) => { const result = await command(args, options); if (result.code !== 0) throw new Error(`Source-build control failed: ${result.stderr.slice(0, 800)}`); return result.stdout.trim(); };
	async function authority() {
		const context = await checked(["context", "show"], { discover: true }); if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(context)) throw new Error("Unsupported Docker build context.");
		const endpoint = await checked(["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"], { discover: true });
		if (!localEndpoint(endpoint)) throw new Error("Source validation requires a prepared local Docker engine.");
		const daemonId = await checked(["info", "--format", "{{.ID}}"], { endpoint });
		if (!/^[a-zA-Z0-9:-]{1,128}$/.test(daemonId)) throw new Error("Docker did not return a source-build authority.");
		return { endpoint, daemonId };
	}
	const pending = () => ownershipRoot ? fs.readdirSync(ownershipRoot).filter(name => /^midnight-core-[a-f0-9-]{36}\.json$/.test(name)).map(name => path.join(ownershipRoot, name)).filter(file => { try { return readOwnership(file).phase !== "complete"; } catch { return true; } }) : [];
	async function cleanup(record, file, waiting = onCleanupWaiting) {
		// Losing the control plane is not evidence of exit. Retain the caller's lease until this loop
		// has inspected physical exit and removal, or positively observed absence on a live daemon.
		for (;;) {
			try {
				if (record.format !== 2) throw new Error("Legacy source-build ownership needs an explicit authority recovery.");
				if (await checked(["info", "--format", "{{.ID}}"], record) !== record.daemonId) throw new Error("The source build belongs to a different Docker engine.");
				record.phase = "cleanup"; saveOwnership(file, record);
				const inspected = await command(["inspect", "--format", "{{json .}}", record.id ?? record.name], record);
				if (inspected.code !== 0) {
					if (!/no such (?:object|container)/i.test(inspected.stderr)) throw new Error("Source-build cleanup cannot reach its container.");
					const listed = await checked(["ps", "--all", "--no-trunc", "--filter", `name=^/${record.name}$`, "--format", "{{.ID}}"], record);
					if (listed) throw new Error("Source-build identity needs another inspection.");
				} else {
					const container = JSON.parse(inspected.stdout), labels = container.Config?.Labels;
					if (!/^[a-f0-9]{64}$/.test(container.Id) || record.id && container.Id !== record.id || container.Name !== `/${record.name}` || container.Image !== record.image || labels?.["midnight.source-owner"] !== record.owner || labels?.["midnight.source-build"] !== "1") throw new Error("Source-build cleanup refuses a different container identity.");
					record.id = container.Id; saveOwnership(file, record);
					if (container.State.Running || container.State.Pid !== 0) { await checked(["kill", "--signal", "KILL", record.id], record); await checked(["wait", record.id], record); }
					const final = JSON.parse(await checked(["inspect", "--format", "{{json .State}}", record.id], record));
					if (final.Running || final.Pid !== 0) throw new Error("Owned source-build cleanup is incomplete.");
					await checked(["rm", record.id], record);
				}
				record.phase = "complete"; record.completedAt = new Date().toISOString(); saveOwnership(file, record); try { waiting(undefined); } catch {} return;
			} catch (error) {
				try { waiting("Waiting to confirm that source-build processes stopped."); } catch {}
				await new Promise(resolve => setTimeout(resolve, cleanupRetryMs));
			}
		}
	}
	const api = {
		pending,
		async preflight() { const route = await authority(); if (await checked(["image", "inspect", "--format", "{{.Id}}", image], route) !== image) throw new Error("The prepared source-validation image does not match its pinned identity."); },
		async recover() {
			for (const file of pending()) {
				let record;
				while (!record) { try { record = readOwnership(file); } catch { try { onCleanupWaiting("Source-build ownership needs recovery before another build can start."); } catch {} await new Promise(resolve => setTimeout(resolve, cleanupRetryMs)); } }
				await cleanup(record, file);
			}
		},
		async run({ source, dependencies, validation, entry, args = [], signal, onCleanupWaiting: cleanupWaiting } = {}) {
			signal?.throwIfAborted();
			if (typeof entry !== "string" || !/^\/(?:work|proof)\/[a-zA-Z0-9_./-]+\.(?:mjs|js|cjs)$/.test(entry) || entry.split("/").includes("..") || !Array.isArray(args) || args.length > 32 || args.some(value => typeof value !== "string" || value.includes("\0") || value.length > 400)) throw new Error("Invalid fixed source-build entry.");
			const owner = randomUUID(), name = `midnight-core-${owner}`, settings = ["create", "--name", name, "--label", "midnight.source-build=1", "--label", `midnight.source-owner=${owner}`, "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "node", "--memory", String(memoryBytes), "--memory-swap", String(memoryBytes), "--cpus", String(cpuCount), "--pids-limit", String(pids), "--ulimit", "nofile=256:256", "--ulimit", "fsize=67108864:67108864", "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=1", "--log-opt", "compress=false", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=268435456", "--workdir", "/work", "--env", "MIDNIGHT_CORE_DIR=/tmp/core", "--env", "MIDNIGHT_USER_DATA=/tmp/profile", ...mount(source, "/work"), ...(dependencies ? mount(dependencies, "/work/node_modules") : []), ...(validation ? mount(validation, "/proof") : []), "--entrypoint", "node", image, "--max-old-space-size=256", entry, ...args];
			const route = await authority(), file = path.join(ownershipRoot, `${name}.json`), record = { format: 2, ...route, owner, name, image, phase: "creating", createdAt: new Date().toISOString() };
			let attempted = false, started = false, failure, timer, aborting, id;
			const stop = reason => { failure ??= reason; if (started) { aborting ??= command(["kill", "--signal", "KILL", id], route); void aborting.catch(() => {}); } };
			const cancel = () => stop(signal.reason ?? new Error("Source build cancelled."));
			try {
				saveOwnership(file, record); attempted = true;
				id = await checked(settings, route); if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Docker returned an invalid source-build identity."); record.id = id; saveOwnership(file, record);
				signal?.throwIfAborted();
				const policy = JSON.parse(await checked(["inspect", "--format", "{{json .HostConfig}}", id], route));
				if (policy.NetworkMode !== "none" || !policy.ReadonlyRootfs || policy.Memory !== memoryBytes || policy.MemorySwap !== memoryBytes || policy.PidsLimit !== pids || policy.NanoCpus !== cpuCount * 1e9 || !policy.CapDrop?.some(value => value.toUpperCase() === "ALL") || !policy.SecurityOpt?.some(value => value.startsWith("no-new-privileges"))) throw new Error("Docker did not apply the source-build policy.");
				const mounts = JSON.parse(await checked(["inspect", "--format", "{{json .Mounts}}", id], route));
				if (mounts.length !== 1 + Number(!!dependencies) + Number(!!validation) || mounts.some(value => value.Type !== "bind" || value.RW || !["/work", "/work/node_modules", "/proof"].includes(value.Destination))) throw new Error("Docker did not apply read-only source mounts.");
				signal?.throwIfAborted();
				signal?.addEventListener("abort", cancel, { once: true });
				await checked(["start", id], route); started = true; record.phase = "running"; saveOwnership(file, record); if (signal?.aborted) cancel();
				timer = setTimeout(() => stop(new Error("Source build exceeded its deadline.")), timeoutMs);
				const waited = await checked(["wait", id], route);
				if (aborting) await aborting;
				const state = JSON.parse(await checked(["inspect", "--format", "{{json .State}}", id], route));
				if (state.Running || state.Pid !== 0) throw new Error("Source-build processes have not exited.");
				const logs = await command(["logs", id], route); if (failure) { failure.diagnostics = { stdout: logs.stdout, stderr: logs.stderr, processesExited: true }; throw failure; }
				return { exitCode: Number(waited), stdout: logs.stdout, stderr: logs.stderr, policy: { image, network: policy.NetworkMode, memoryBytes, cpuCount, pids, readonlySource: true }, processesExited: true };
			} finally {
				clearTimeout(timer); signal?.removeEventListener("abort", cancel);
				if (aborting) await aborting.catch(() => {});
				if (attempted) await cleanup(record, file, cleanupWaiting ?? onCleanupWaiting);
			}
		},
	};
	return api;
}
