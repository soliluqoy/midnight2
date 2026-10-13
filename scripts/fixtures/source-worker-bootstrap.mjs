import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { app, utilityProcess } from "electron";
const root = fs.realpathSync(process.env.MIDNIGHT_SOURCE_QUAL_ROOT);
assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^midnight-source-worker-[^/\\]+$/);
app.setPath("userData", path.join(root, "shell")); app.on("window-all-closed", () => {});
app.whenReady().then(() => {
	const child = utilityProcess.fork(fileURLToPath(new URL("./source-worker-runner.mjs", import.meta.url)), [], { serviceName: "Owned source workspace qualification", stdio: "pipe" });
	child.stdout.on("data", bytes => process.stdout.write(bytes)); child.stderr.on("data", bytes => process.stderr.write(bytes));
	child.once("exit", code => app.exit(code));
});
