// An owned parent exits after creating a live build, allowing the real restart owner to recover it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBuildSandbox } from "../../src/builder/build-sandbox.mjs";
const root = fs.realpathSync(process.env.MIDNIGHT_SOURCE_ORPHAN_ROOT);
if (path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !/^midnight-source-sandbox-[^/\\]+$/.test(path.basename(root))) throw new Error("Orphan fixture requires an owned test root.");
const ownershipRoot = path.join(root, "ownership"), sandbox = createBuildSandbox({ image: process.env.MIDNIGHT_SOURCE_ORPHAN_IMAGE, ownershipRoot, timeoutMs: 60_000 });
const timer = setInterval(() => {
	for (const file of sandbox.pending()) if (JSON.parse(fs.readFileSync(file, "utf8")).phase === "running") process.exit(0);
}, 25);
try { await sandbox.run({ source: path.join(root, "source"), entry: "/work/hang.mjs" }); throw new Error("Orphan fixture exited its container early."); }
finally { clearInterval(timer); }
