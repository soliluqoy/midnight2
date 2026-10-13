// Actual native API qualification in a new hidden Word instance and disposable unsaved documents.
// The /define branch is absent from the shipped helper; never attach this harness to the user's active Word.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compiler } from "./build-native.mjs";

if (process.platform !== "win32") throw new Error("Native Word qualification requires Windows.");
const source = fileURLToPath(new URL("../src/desktop/native/MidnightWord.cs", import.meta.url));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "midnight-word-fixtures-"));
const helper = path.join(directory, "word-fixtures.exe");
execFileSync(compiler(), ["/nologo", "/optimize+", "/define:MIDNIGHT_WORD_FIXTURES", `/out:${helper}`, ...["System.Core.dll", "System.Xml.dll", "Microsoft.CSharp.dll", "System.Web.Extensions.dll", "System.Windows.Forms.dll"].map(ref => `/reference:${ref}`), source], { windowsHide: true, stdio: "inherit" });
if (process.argv.slice(2).some(arg => !["--paragraph", "--chart-probe"].includes(arg)) || process.argv.slice(2).length > 1) throw new Error("Use --paragraph, --chart-probe, or no argument for the full Word/chart fixtures.");
const child = spawn(helper, [process.argv.includes("--paragraph") ? "--fixture-paragraph" : process.argv.includes("--chart-probe") ? "--fixture-chart-probe" : "--fixture"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let output = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { output += chunk; });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
const timeout = setTimeout(() => {
	console.error("Word fixture timed out. Its reported private process needs cleanup; no broad Word process termination is attempted.");
	child.kill();
}, 120_000);
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
clearTimeout(timeout);
const events = output.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean);
const result = events.find(event => event.kind === "fixture-result");
if (code === 0 && result && process.env.MIDNIGHT_TEST_REPORT) {
	const file = path.resolve(process.env.MIDNIGHT_TEST_REPORT);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const { processId, kind, passed: checks, ...details } = result;
	fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...(result.scope === "chart-probe" ? { completed: true } : { passed: true }), ...details, checks, limitations: ["Disposable hidden Office automation instance and synthetic document; no personal file or physical hotkey/microphone input.", "Single capture/apply/undo timing samples exclude shell IPC, cloud reasoning and foreground typing contention.", result.scope === "paragraph-and-native-chart" ? "Qualification is for this provider/build and prepared embedded chart sources; linked sources, other Office builds and all bar-axis styling remain separate work." : "Paragraph fixtures or exploratory probes do not establish native chart qualification."] }, null, 2));
}
// Delete only these two known files in the newly created temp folder.
fs.rmSync(helper, { force: true }); fs.rmdirSync(directory);
process.exitCode = code ?? 1;
