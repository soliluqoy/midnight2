import fs from "node:fs";
import path from "node:path";
import { createBuildSandbox } from "./build-sandbox.mjs";
// Qualified Node image; preparation/pulls are explicit setup, never a maintenance-tool effect.
export const CORE_VALIDATION_IMAGE = "sha256:28388b76f14e702c6a42a4cfac35028e7c4f27f47b78dc5ee6791a761c5d33a7";
export function createCoreSourceValidator({ dependencies, ownershipRoot, onCleanupWaiting, image = CORE_VALIDATION_IMAGE, sandbox = createBuildSandbox({ image, timeoutMs: 540_000, ownershipRoot, onCleanupWaiting }) }) {
	const validate = async (frozen, { signal, onWaiting } = {}) => {
		const proof = `${frozen.root}-proof`; fs.mkdirSync(proof);
		fs.mkdirSync(path.join(frozen.root, "node_modules"));
		fs.writeFileSync(path.join(proof, "run-tests.mjs"), `import fs from 'node:fs'; import {run} from 'node:test'; import {spec} from 'node:test/reporters';
const files=[...fs.globSync('test/**/*.test.mjs',{cwd:'/work'})].map(name=>'/work/'+name);
const stream=run({files,concurrency:2,timeout:60000}); let summary;
stream.on('test:summary',value=>{if(value.file===undefined)summary=value}); stream.compose(spec()).pipe(process.stdout);
await new Promise(resolve=>stream.once('end',resolve)); console.log('SOURCE_VALIDATION_SUMMARY '+JSON.stringify(summary));
process.exitCode=summary?.success===true?0:1;
`);
		const result = await sandbox.run({ source: frozen.root, validation: proof, dependencies, entry: "/proof/run-tests.mjs", signal, onCleanupWaiting: onWaiting });
		const raw = result.stdout.split(/\r?\n/).find(value => value.startsWith("SOURCE_VALIDATION_SUMMARY "));
		const summary = raw ? JSON.parse(raw.slice("SOURCE_VALIDATION_SUMMARY ".length)) : undefined;
		const ok = result.exitCode === 0 && summary?.success === true && summary.counts.tests >= 300 && summary.counts.failed === 0 && summary.counts.cancelled === 0;
		return { ok, digest: frozen.digest, baseDigest: frozen.baseDigest, processesExited: result.processesExited, counts: summary?.counts, policy: result.policy, error: ok ? undefined : `Source validation failed. ${result.stdout.slice(-4000)} ${result.stderr.slice(-1000)}`, platform: "linux", windowsBuild: "pending", appPreview: "pending" };
	};
	validate.pending = sandbox.pending;
	validate.recover = () => sandbox.recover();
	validate.preflight = async () => {
		if (!dependencies || !fs.existsSync(dependencies) || !fs.statSync(dependencies).isDirectory()) throw new Error("App repair validation needs setup before a source change can be built.");
		await sandbox.preflight();
	};
	return validate;
}
