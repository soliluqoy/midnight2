// On Windows, the native recovery writer opens this file with FileShare.None. Live shared handles refuse reset.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function rootFor(profile) {
	const root = path.join(profile, "recovery"); fs.mkdirSync(root, { recursive: true });
	if (fs.lstatSync(root).isSymbolicLink() || !fs.realpathSync(root).startsWith(fs.realpathSync(profile) + path.sep)) throw new Error("The recovery directory escaped this profile.");
	return root;
}
export function holdRecoveryProfile(profile) {
	const root = rootFor(profile), file = path.join(root, "operation.lock");
	if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).nlink !== 1)) throw new Error("The recovery lease must be a private ordinary file.");
	const fd = fs.openSync(file, "a+"); let released = false;
	const release = () => { if (released) return; released = true; fs.closeSync(fd); process.off("exit", release); };
	process.once("exit", release);
	return release;
}
export function registerRecoveryProfile(profile) {
	const root = rootFor(profile), releaseLease = holdRecoveryProfile(profile), token = randomUUID(), ownerFile = path.join(root, "shell-owner.json");
	const atomic = (file, bytes) => {
		const temporary = path.join(root, `${randomUUID()}.tmp`), fd = fs.openSync(temporary, "wx");
		try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		fs.renameSync(temporary, file);
	};
	try { atomic(path.join(root, "app-id"), "app.midnight.capsule\n"); atomic(ownerFile, JSON.stringify({ format: 1, pid: process.pid, token })); }
	catch (error) { releaseLease(); throw error; }
	let released = false;
	const release = () => {
		if (released) return; released = true;
		try { if (!fs.lstatSync(ownerFile).isSymbolicLink() && JSON.parse(fs.readFileSync(ownerFile, "utf8")).token === token) fs.unlinkSync(ownerFile); } catch {}
		releaseLease(); process.off("exit", release);
	};
	process.once("exit", release);
	return release;
}
