// Recovery-owned metadata lives outside the core database and plugin state. Packages/generations are immutable;
// a fsynced intent precedes the atomic pointer switch. Restoring code never restores or deletes action receipts.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { packageIdentity, validateManifest } from "./manifest.mjs";
import { COMPONENTS, componentFor } from "./catalog.mjs";

const builtinRoot = fileURLToPath(new URL("./builtin/", import.meta.url));
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
function atomic(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${randomUUID()}.tmp`, fd = fs.openSync(temp, "wx");
	try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	fs.renameSync(temp, file);
}
export function createPluginStore({ root, safeMode = false, fault = () => {}, recover: bootRecovery = true }) {
	root = path.resolve(root); fs.mkdirSync(root, { recursive: true });
	if (fs.lstatSync(root).isSymbolicLink()) throw new Error("The plugin store must be an owned directory.");
	const identityFile = path.join(root, "store-identity.json");
	if (!fs.existsSync(identityFile)) atomic(identityFile, { format: 1, epoch: randomUUID() });
	if (fs.lstatSync(identityFile).isSymbolicLink()) throw new Error("The component store identity must be a local file.");
	const identity = read(identityFile);
	if (identity.format !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity.epoch ?? "")) throw new Error("The component store identity needs recovery.");
	const pointer = path.join(root, "active.json"), lock = path.join(root, "activation.lock");
	const packageDir = digest => { if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) throw new Error("Invalid plugin artifact identity."); return path.join(root, "artifacts", digest.slice(7)); };
	function owned(file) {
		const relative = path.relative(root, fs.realpathSync(file));
		if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("A plugin artifact escaped its store.");
	}
	function critical(task) {
		try { const fd = fs.openSync(lock, "wx"); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd); }
		catch (err) {
			if (err.code !== "EEXIST") throw err;
			let owner; try { owner = read(lock); } catch { throw new Error("The plugin activation lock needs recovery."); }
			try { process.kill(owner.pid, 0); throw new Error("Another process owns plugin activation."); } catch (error) { if (error.code !== "ESRCH") throw error; }
			fs.unlinkSync(lock); return critical(task);
		}
		try { return task(); } finally { fs.unlinkSync(lock); }
	}
	const api = {
		root,
		epoch: identity.epoch,
		install(manifest, source) {
			validateManifest(manifest); const { digest, files } = packageIdentity(manifest, source), directory = packageDir(digest);
			if (!fs.existsSync(directory)) {
				const temporary = path.join(root, "artifacts", `staging-${randomUUID()}`); fs.mkdirSync(temporary, { recursive: true });
				fs.writeFileSync(path.join(temporary, "renderer.js"), source); atomic(path.join(temporary, "manifest.json"), manifest); atomic(path.join(temporary, "identity.json"), { digest, files });
				fs.renameSync(temporary, directory);
			}
			return api.get(digest).pin;
		},
		get(digest) {
			const directory = packageDir(digest);
			for (const file of ["manifest.json", "renderer.js", "identity.json"]) owned(path.join(directory, file));
			const manifest = read(path.join(directory, "manifest.json")), source = fs.readFileSync(path.join(directory, "renderer.js"), "utf8"), identity = packageIdentity(manifest, source);
			if (identity.digest !== digest || read(path.join(directory, "identity.json")).digest !== digest) throw new Error("The exact plugin artifact is missing or changed.");
			const component = componentFor(manifest.id);
			return { manifest, source, pin: { id: manifest.id, digest, api: manifest.api, schema: manifest.schema, input: component.contribution.input, output: component.contribution.output } };
		},
		current() {
			const state = read(pointer);
			if (state.format !== 1 || !Number.isInteger(state.generation) || !state.bindings?.["chart.bar"]) throw new Error("Invalid activation pointer.");
			return structuredClone(state);
		},
		bindings() { const state = api.current(); return { generation: state.generation, bindings: safeMode ? api.bases : state.bindings }; },
		qualify(pin, report) {
			const artifact = api.get(pin.digest), component = componentFor(artifact.manifest.id);
			if (report.digest !== pin.digest || report.version !== component.validation || report.ok !== true || report.checked < 4) throw new Error("The candidate has no current host validation report.");
			atomic(path.join(root, "qualification", `${pin.digest.slice(7)}.json`), report);
		},
		qualification(pin) {
			const exact = api.get(pin.digest).pin, component = componentFor(exact.id), report = read(path.join(root, "qualification", `${pin.digest.slice(7)}.json`));
			if (Object.keys(exact).some(key => exact[key] !== pin[key]) || report.digest !== pin.digest || !report.ok || report.checked < 4 || report.version !== component.validation) throw new Error("The qualification no longer matches this artifact.");
			return structuredClone(report);
		},
		activate(pin, expectedGeneration) {
			return critical(() => {
				if (api.isQuarantined(pin.digest)) throw new Error("This plugin version is quarantined.");
				const exact = api.get(pin.digest).pin;
				const component = componentFor(exact.id);
				if (Object.keys(exact).some(key => pin[key] !== exact[key])) throw new Error("The activation pin does not match the exact plugin contract.");
				const report = read(path.join(root, "qualification", `${pin.digest.slice(7)}.json`));
				if (report.digest !== pin.digest || !report.ok || report.version !== component.validation) throw new Error("The qualification no longer matches this artifact.");
				const current = api.current(); if (current.generation !== expectedGeneration) throw new Error("The active generation changed. Revalidate the candidate.");
				if (current.health !== "healthy") throw new Error("Another candidate is still in probation. Wait for its health check.");
				const priorGood = current.health === "healthy" ? current.bindings : current.lastGood;
				const next = { format: 1, generation: current.generation + 1, bindings: { ...current.bindings, [component.binding]: pin }, previous: current.bindings, lastGood: priorGood, historyGood: [...(current.historyGood ?? []), priorGood].slice(-16), health: "probation" };
				const intentFile = path.join(root, "activation-intents", `${randomUUID()}.json`);
				atomic(intentFile, { state: "prepared", expectedGeneration, candidate: pin, next }); fault("after-intent");
				atomic(path.join(root, "generations", `${next.generation}.json`), next); atomic(pointer, next); fault("after-pointer");
				atomic(intentFile, { state: "applied", expectedGeneration, candidate: pin, next }); return next;
			});
		},
		accept(digest) {
			return critical(() => { const state = api.current(), component = componentFor(api.get(digest).manifest.id); if (state.bindings[component.binding]?.digest !== digest) throw new Error("Another candidate became active."); const next = { ...state, health: "healthy", lastGood: state.bindings }; atomic(pointer, next); return next; });
		},
		rollback(reason = "user restore", { binding } = {}) {
			return critical(() => {
				const state = api.current(), history = [...(state.historyGood ?? [])]; let restored;
				const usable = bindings => {
					try { if (!bindings?.["chart.bar"]) return false; for (const [key, pin] of Object.entries(bindings)) { if (binding && key !== binding) continue; const exact = api.get(pin.digest).pin; if (componentFor(exact.id).binding !== key || api.isQuarantined(pin.digest) || Object.keys(exact).some(key => exact[key] !== pin[key])) return false; } return !binding || !!bindings[binding]; } catch { return false; }
				};
				while (history.length && !restored) { const prior = history.pop(); if (usable(prior)) restored = prior; }
				if (!restored && state.health !== "healthy" && usable(state.lastGood)) restored = state.lastGood;
				restored ??= api.bases;
				if (binding) restored = { ...state.bindings, [binding]: restored[binding] ?? api.bases[binding] };
				const next = { format: 1, generation: state.generation + 1, bindings: restored, previous: state.bindings, lastGood: restored, historyGood: history, health: "healthy", reason };
				atomic(path.join(root, "generations", `${next.generation}.json`), next); atomic(pointer, next); return next;
			});
		},
		quarantine(pin, reason) {
			atomic(path.join(root, "quarantine", `${pin.digest.slice(7)}.json`), { digest: pin.digest, reason: String(reason).slice(0, 500) });
			const component = componentFor(pin.id);
			if (api.current().bindings[component.binding]?.digest === pin.digest) api.rollback("candidate failed host validation", { binding: component.binding });
		},
		isQuarantined: digest => fs.existsSync(path.join(root, "quarantine", `${digest.slice(7)}.json`)),
		recover() {
			try { const current = api.current(); for (const pin of Object.values(current.bindings)) api.get(pin.digest); if (current.health === "probation") return api.rollback("interrupted probation"); return current; }
			catch { const directory = path.join(root, "generations"); const seen = fs.existsSync(directory) ? fs.readdirSync(directory).map(file => /^([0-9]+)\.json$/.exec(file)).filter(Boolean).map(match => Number(match[1])) : []; const next = { format: 1, generation: Math.max(0, ...seen) + 1, bindings: api.bases, lastGood: api.bases, health: "healthy", reason: "recover malformed activation metadata" }; atomic(path.join(root, "generations", `${next.generation}.json`), next); atomic(pointer, next); return next; }
		},
	};
	api.bases = Object.fromEntries(COMPONENTS.map(component => { const directory = path.join(builtinRoot, component.directory); return [component.binding, api.install(read(path.join(directory, "manifest.json")), fs.readFileSync(path.join(directory, "renderer.js"), "utf8"))]; }));
	api.base = api.bases["chart.bar"]; // Existing chart callers/pins retain their exact contract.
	if (!fs.existsSync(pointer)) atomic(pointer, { format: 1, generation: 0, bindings: api.bases, lastGood: api.bases, health: "healthy" });
	if (bootRecovery) {
		api.recover();
		// Add reviewed official components to older installations without discarding their private chart binding.
		if (Object.keys(api.bases).some(key => !api.current().bindings[key])) critical(() => {
			const prior = api.current(), enrich = value => ({ ...api.bases, ...value });
			const next = { ...prior, generation: prior.generation + 1, bindings: enrich(prior.bindings), lastGood: enrich(prior.lastGood), previous: enrich(prior.previous), historyGood: (prior.historyGood ?? []).map(enrich), reason: "add reviewed component contracts" };
			const intentFile = path.join(root, "activation-intents", `${randomUUID()}.json`);
			atomic(intentFile, { state: "prepared", operation: "catalog-add", expectedGeneration: prior.generation, next });
			atomic(path.join(root, "generations", `${next.generation}.json`), next); atomic(pointer, next);
			atomic(intentFile, { state: "applied", operation: "catalog-add", expectedGeneration: prior.generation, next });
		});
	}
	return api;
}
