// Trusted source I/O only. Candidate modules are read as bytes and never imported or executed here.
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { createSourceCapsule } from "./source-capsule.mjs";
import { loadCoreWorkspace, coreSourceDiff, prepareCoreValidation, finishCoreValidation, proposeCoreWorkspace } from "./core-workspace.mjs";

const { directory, sourceRoot, baseDigest } = workerData;
if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Source workers refuse linked job directories.");
const jobRoot = fs.realpathSync(directory);
let capsule, frozen;
function current() { return capsule ??= loadCoreWorkspace(directory, baseDigest); }
function perform(op, args) {
	if (op === "capture") {
		const destination = path.join(jobRoot, "source");
		if (!fs.existsSync(destination)) {
			// Interrupted copies stay separate; a complete captured base can be adopted after a lost reply.
			const staging = path.join(jobRoot, `source-${randomUUID()}.partial`);
			const captured = createSourceCapsule({ workspace: sourceRoot, destination: staging }); captured.inspect();
			const resolvedStaging = fs.realpathSync(staging), resolvedDestination = path.resolve(destination);
			if (path.dirname(resolvedStaging) !== jobRoot || path.dirname(resolvedDestination) !== jobRoot) throw new Error("Source capture promotion escaped its owned job directory.");
			fs.renameSync(resolvedStaging, resolvedDestination);
		}
		capsule = loadCoreWorkspace(directory, baseDigest); capsule.inspect();
		return { kind: "core.source", digest: capsule.digest, version: capsule.version };
	}
	const source = current();
	if (op === "tree") {
		const offset = args.offset ?? 0; if (!Number.isInteger(offset) || offset < 0 || offset > 4096) throw new Error("Invalid source-list offset.");
		const files = source.list(); return { files: files.slice(offset, offset + 100), next: offset + 100 < files.length ? offset + 100 : undefined, baseDigest: source.digest };
	}
	if (op === "read") { const text = source.read(args.filename); return { filename: args.filename, text, sha256: createHash("sha256").update(text).digest("hex") }; }
	if (op === "write") return source.write(args.filename, args.text);
	if (op === "patch") return source.patch(args.filename, args);
	if (op === "remove") return source.remove(args.filename);
	if (op === "diff") { const diff = coreSourceDiff(source); return { diff: diff.slice(0, 32 * 1024), truncated: diff.length > 32 * 1024, changed: source.inspect().changed }; }
	if (op === "prepare-validation") { const prepared = prepareCoreValidation({ capsule: source, directory }); frozen = prepared.frozen; return prepared; }
	if (op === "finish-validation") {
		if (!frozen) throw new Error("This worker has no pending frozen validation.");
		const result = finishCoreValidation({ capsule: source, directory, frozen, result: args.result }); frozen = undefined; return result;
	}
	if (op === "propose") return proposeCoreWorkspace({ capsule: source, directory, validation: args.validation });
	throw new Error("Unknown source workspace operation.");
}
parentPort.on("message", ({ id, op, args = {} }) => {
	try { parentPort.postMessage({ id, ok: true, result: perform(op, args) }); }
	catch (error) { parentPort.postMessage({ id, ok: false, error: error.message }); }
});
