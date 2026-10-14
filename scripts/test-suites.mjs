// Focused development suites. `npm test` remains the independent full-suite gate.
import { globSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// Only focused tests with stubbed external boundaries belong here. Mixed host,
// storage, process, SDK, architecture and native-helper files stay in integration.
const unitFiles = new Set([
	"capture-epoch", "harness-utils", "markdown", "models", "paragraph-format",
	"perception-contracts", "platform-bridge", "ptt", "quick-assist", "quick-ipc",
	"residency", "test-suites", "updater", "web-headless",
].map(name => `test/${name}.test.mjs`));

export function discoverTestFiles() {
	return [...globSync("test/**/*.test.mjs", { cwd: root })].map(file => file.replaceAll("\\", "/")).sort();
}

export function selectTestFiles(suite, files = discoverTestFiles()) {
	if (suite !== "unit" && suite !== "integration") throw new Error("Expected suite: unit or integration.");
	const discovered = new Set(files);
	for (const file of unitFiles) if (!discovered.has(file)) throw new Error(`Update the unit suite list: missing ${file}`);
	// New files default to integration, so a missing classification cannot drop coverage.
	const selected = files.filter(file => unitFiles.has(file) === (suite === "unit"));
	if (!selected.length) throw new Error(`The ${suite} suite is empty.`);
	return selected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const [suite, ...args] = process.argv.slice(2);
		const files = selectTestFiles(suite);
		if (args.length === 1 && args[0] === "--list") console.log(files.join("\n"));
		else {
			const result = spawnSync(process.execPath, ["--test", "--test-timeout=60000", ...args, ...files], { cwd: root, stdio: "inherit" });
			if (result.error) throw result.error;
			if (result.signal) console.error(`Test runner stopped by ${result.signal}.`);
			process.exitCode = result.status ?? 1;
		}
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
