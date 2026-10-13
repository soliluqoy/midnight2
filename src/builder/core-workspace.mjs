import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSourceCapsule, openSourceCapsule } from "./source-capsule.mjs";

export const CORE_COMPONENT = Object.freeze({ id: "midnight.core", label: "App source", scopes: ["official"] });
export function hasCoreSource(root) { return !!root && ["package.json", "package-lock.json", "src", "test", "scripts", "vendor/PROVENANCE.json"].every(name => fs.existsSync(path.join(root, name))); }
export function createCoreWorkspace({ source, directory }) { return createSourceCapsule({ workspace: source, destination: path.join(directory, "source") }); }
export function loadCoreWorkspace(directory, digest) { return openSourceCapsule(path.join(directory, "source"), { expectedDigest: digest }); }
function lines(text) { const normalized = text.replace(/\r\n/g, "\n"), values = normalized.split("\n"); if (values.at(-1) === "") values.pop(); return { values, terminated: normalized.endsWith("\n") }; }
function content(root, name) { const file = path.join(root, ...name.split("/")); return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined; }
export function coreSourceDiff(capsule) {
	const snapshot = capsule.inspect();
	return snapshot.changed.map(name => {
		const from = JSON.stringify(`a/${name}`), to = JSON.stringify(`b/${name}`);
		const before = content(capsule.base, name), after = content(capsule.candidate, name), a = lines(before ?? ""), b = lines(after ?? "");
		let prefix = 0, suffix = 0;
		while (prefix < a.values.length && prefix < b.values.length && a.values[prefix] === b.values[prefix] && !(prefix === a.values.length - 1 && a.terminated !== b.terminated)) prefix++;
		while (suffix < a.values.length - prefix && suffix < b.values.length - prefix && a.values.at(-suffix - 1) === b.values.at(-suffix - 1) && !(suffix === 0 && a.terminated !== b.terminated)) suffix++;
		const start = Math.max(0, prefix - 3), endA = Math.min(a.values.length, a.values.length - suffix + 3), endB = Math.min(b.values.length, b.values.length - suffix + 3);
		const section = (data, begin, end, marker) => data.values.slice(begin, end).map((line, index) => `${marker}${line}\n${begin + index === data.values.length - 1 && !data.terminated ? "\\ No newline at end of file\n" : ""}`).join("");
		const changedA = a.values.length - suffix, changedB = b.values.length - suffix;
		return `diff --git ${from} ${to}\n${before === undefined ? "new file mode 100644\n" : after === undefined ? "deleted file mode 100644\n" : ""}--- ${before === undefined ? "/dev/null" : from}\n+++ ${after === undefined ? "/dev/null" : to}\n@@ -${endA - start ? start + 1 : 0},${endA - start} +${endB - start ? start + 1 : 0},${endB - start} @@\n${section(a, start, prefix, " ")}${section(a, prefix, changedA, "-")}${section(b, prefix, changedB, "+")}${section(b, changedB, endB, " ")}`;
	}).join("\n");
}
export function prepareCoreValidation({ capsule, directory }) {
	const current = capsule.inspect();
	if (!current.changed.length) throw new Error("The source builder did not produce a change.");
	const record = path.join(directory, "source-validation.json");
	if (fs.existsSync(record)) {
		const old = JSON.parse(fs.readFileSync(record, "utf8"));
		if (old.ok && old.digest === current.digest && old.baseDigest === capsule.digest && old.version === 1) return { cached: old };
	}
	return { frozen: capsule.freeze(path.join(directory, `frozen-${randomUUID()}`)) };
}
export function finishCoreValidation({ capsule, directory, frozen, result }) {
	if (capsule.inspect().digest !== frozen.digest) throw new Error("The source candidate changed during validation. Validate its current bytes again.");
	if (!result.ok || result.digest !== frozen.digest || result.baseDigest !== capsule.digest || !result.processesExited) throw new Error(result.error ?? "The source candidate did not pass host-owned validation.");
	const report = { ...result, version: 1, changed: frozen.changed, kernelChanges: frozen.kernelChanges, requiresNativeBuild: frozen.requiresNativeBuild, at: new Date().toISOString() };
	fs.writeFileSync(path.join(directory, "source-validation.json"), JSON.stringify(report, null, 2)); return report;
}
export async function validateCoreWorkspace({ capsule, directory, validate, signal, onWaiting }) {
	signal?.throwIfAborted(); const prepared = prepareCoreValidation({ capsule, directory });
	if (prepared.cached) return prepared.cached;
	if (!validate) throw new Error("Core source validation is not configured for this installation.");
	const result = await validate(prepared.frozen, { signal, jobId: path.basename(directory), onWaiting }); signal?.throwIfAborted();
	return finishCoreValidation({ capsule, directory, frozen: prepared.frozen, result });
}
export function proposeCoreWorkspace({ capsule, directory, validation }) {
	const current = capsule.inspect();
	if (!validation.ok || validation.digest !== current.digest || validation.baseDigest !== capsule.digest) throw new Error("The official source proposal needs validation of its exact bytes.");
	const officialPath = path.join(directory, `official-source-${current.digest.slice(7)}-${randomUUID()}`), frozen = capsule.freeze(path.join(officialPath, "source"));
	const patch = coreSourceDiff(capsule); fs.writeFileSync(path.join(officialPath, "source.patch"), patch);
	const candidate = { kind: "core.source", digest: frozen.digest, baseDigest: capsule.digest, version: capsule.version };
	fs.writeFileSync(path.join(officialPath, "candidate.json"), JSON.stringify({ format: 1, candidate, changed: frozen.changed, kernelChanges: frozen.kernelChanges, validation, windowsBuild: "pending", appPreview: "pending", publishing: "maintainer review required", activation: "not supported by the plugin activation API" }, null, 2));
	return { candidate, validation, officialPath, sourceDiff: patch.slice(0, 32 * 1024), diffTruncated: patch.length > 32 * 1024, changed: frozen.changed, kernelChanges: frozen.kernelChanges, windowsBuild: "pending", appPreview: "pending" };
}
