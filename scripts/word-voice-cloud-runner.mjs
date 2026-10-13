// One synthetic utterance through real Whisper/cloud/Word, with durable apply and conditional undo.
// Native capture is a development-only owned-range fixture; no personal document, microphone or foreground selection.
import assert from "node:assert/strict";
import { app } from "electron";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { compiler } from "./build-native.mjs";
import { prepareReadOnlyWriter } from "./fixtures/cloud-writer.mjs";
import { createModelRuntime } from "../src/runtime/adapter.mjs";
import { createHost } from "../src/runtime/host.mjs";
import { createInferenceArbiter } from "../src/inference/arbiter.mjs";
import { createSpeechRuntime } from "../src/voice/runtime.mjs";
import { createCaptureEpoch } from "../src/voice/capture-epoch.mjs";
import { createPushToTalk } from "../src/voice/ptt.mjs";
import { createPttRecorder } from "../src/desktop/ptt-recorder.mjs";
import { createQuickAssist } from "../src/desktop/quick-assist.mjs";
import { createWordBroker } from "../src/desktop/word-broker.mjs";
import { createPlatform } from "../src/desktop/platform.mjs";

assert.equal(process.platform, "win32", "the combined native workflow requires Windows");
assert.equal(process.env.MIDNIGHT_TEST_CLOUD, "1", "Set MIDNIGHT_TEST_CLOUD=1 to send one synthetic selected paragraph to the configured writer.");
const voiceData = process.env.MIDNIGHT_TEST_VOICE_DATA;
assert.ok(voiceData, "Set MIDNIGHT_TEST_VOICE_DATA to an existing prepared Whisper cache; downloads are refused.");
const temporaryRoot = fs.realpathSync(os.tmpdir()), profile = fs.realpathSync(process.env.MIDNIGHT_TEST_WORKFLOW_PROFILE);
assert.equal(path.dirname(profile), temporaryRoot); assert.ok(path.basename(profile).startsWith("midnight-word-voice-cloud-"));
app.setPath("userData", profile);
const wav = path.join(profile, "speech.wav");
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.Speech; $workflowSpeech = New-Object System.Speech.Synthesis.SpeechSynthesizer; $workflowSpeech.SetOutputToWaveFile('${wav.replace(/'/g, "''")}'); $workflowSpeech.Speak('Make this paragraph clearer.'); $workflowSpeech.Dispose()`], { windowsHide: true, timeout: 30_000 });
app.commandLine.appendSwitch("use-fake-device-for-media-stream"); app.commandLine.appendSwitch("use-fake-ui-for-media-stream"); app.commandLine.appendSwitch("use-file-for-fake-audio-capture", wav);
app.on("window-all-closed", () => {});
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const waitFor = async (predicate, timeoutMs) => { const start = Date.now(); while (!await predicate()) { if (Date.now() - start >= timeoutMs) throw new Error("The bounded workflow stage did not settle."); await new Promise(resolve => setTimeout(resolve, 25)); } };

app.whenReady().then(async () => {
	let host, writer, word, child, ptt, recorder, quick, ownedOffice, speech;
	let stage = "prepare", report;
	const cleanupFailures = [];
	const checks = [], timings = {}, packets = [], nativeWrites = [];
	const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`); };
	try {
		writer = prepareReadOnlyWriter(profile);
		const helper = path.join(profile, "word-workflow.exe"), source = fileURLToPath(new URL("../src/desktop/native/MidnightWord.cs", import.meta.url));
		execFileSync(compiler(), ["/nologo", "/optimize+", "/define:MIDNIGHT_WORD_FIXTURES", `/out:${helper}`, ...["System.Core.dll", "System.Xml.dll", "Microsoft.CSharp.dll", "System.Web.Extensions.dll", "System.Windows.Forms.dll"].map(ref => `/reference:${ref}`), source], { windowsHide: true });
		word = createWordBroker({ helper, spawnImpl: (executable, args, options) => child = spawn(executable, ["--fixture-workflow"], options) });
		stage = "native-fixture";
		const native = await word.status(); ownedOffice = { processId: native.fixture.processId, createdAtTicks: native.fixture.createdAtTicks };
		const snapshot = { ...native.fixture.snapshot, connector: undefined }, originalDocument = native.fixture.original;
		check("new hidden Office process owns a supported mixed-format native paragraph", native.fixture.hidden && snapshot.metadata.supported && snapshot.metadata.protectedSpans.length === 3);
		const arbiter = createInferenceArbiter();
		speech = createSpeechRuntime({ paths: { dataDir: voiceData }, arbiter, download: async () => { throw new Error("No download is allowed in the combined qualification."); } });
		check("existing prepared local Whisper is available", speech.status().available === true);
		const voiceMarker = path.join(voiceData, "voice-runtime", "prepared.json"), markerBefore = hash(fs.readFileSync(voiceMarker));
		const rt = await createModelRuntime({ core: writer.core, credentials: writer.credentials });
		check("exact configured cloud writer exists without a model substitution", !!rt.getModel(writer.provider, writer.model));
		const stream = rt.streamSimple.bind(rt);
		rt.streamSimple = (model, context, options) => {
			assert.equal(model.provider, writer.provider); assert.equal(model.id, writer.model); assert.ok(options.maxTokens <= 2048); assert.deepEqual(context.tools ?? [], []);
			const packet = JSON.stringify(context);
			assert.doesNotMatch(packet, /PRIVATE_UNRELATED|STANDING_INSTRUCTION|data:audio|data:image|WordOpenXML|preservationHash|structureHash/);
			assert.ok(!packet.includes(snapshot.documentId) && !packet.includes(snapshot.handle));
			packets.push({ inputBytes: Buffer.byteLength(packet), maxOutputTokens: options.maxTokens });
			return stream(model, context, options);
		};
		const lease = { valid: () => false, acquire: async () => ({ epoch: 1, release() {} }), revokeAll: async () => {} };
		const platformCall = createPlatform({ web: { tools: [] }, browsers: {}, lease, appEditAllowed: () => true, wordBroker: { ...word, apply: (...args) => { nativeWrites.push(args[0].editId); return word.apply(...args); } } });
		const platform = { lease, call: (operation, params, options) => { assert.ok(["word.inspect", "word.receipt", "word.apply"].includes(operation), "this fixture permits only the production typed Word lane"); return platformCall(operation, params, options); } };
		const settings = { provider: writer.provider, model: writer.model, privacy: "cloud", instructions: "STANDING_INSTRUCTION", voice: true, pushToTalk: true, voiceLanguage: "en", embedding: { enabled: false } };
		const dataDir = path.join(profile, "data");
		host = await createHost({ dataDir, core: writer.core, modelRuntime: rt, inferenceArbiter: arbiter, speechRuntime: speech, platform, settings }); await host.start();
		const notices = [];
		quick = createQuickAssist({ word, settings: () => settings, request: (method, params) => host.handle(method, params), present: options => notices.push(options) });
		host.subscribe(event => void quick.onEngine(event));
		recorder = createPttRecorder({ allowed: id => ptt?.currentId() === id && ptt.canRecord() });
		let transcript, samplesCount, preparationMs;
		ptt = createPushToTalk({ quick, recorder, settings: () => settings, fence: createCaptureEpoch(), prepareSpeech: async params => { const began = Date.now(); const result = await host.handle("voice.quickPrepare", params); preparationMs = Date.now() - began; return result; }, transcribe: async params => { samplesCount = params.samples.length; const result = await host.handle("voice.quickTranscribe", params); transcript = result.text; return result; }, cancelTranscription: captureId => host.handle("voice.quickCancel", { captureId }) });
		stage = "recording";
		const held = Date.now(); await ptt.down({ windowId: snapshot.windowId, processId: snapshot.processId }); timings.heldToRecorderReadyMs = Date.now() - held;
		assert.equal(quick.state().phase, "input", "one native capture precedes the voice instruction");
		await new Promise(resolve => setTimeout(resolve, 2800)); const loadedAtRelease = speech.status().loaded, released = Date.now();
		stage = "whisper-cloud"; await ptt.up();
		await waitFor(() => { const state = quick.state(); if (["error", "expired", "needsContext"].includes(state.phase)) throw new Error("The combined workflow did not produce an applicable proposal."); return state.phase === "preview"; }, 65_000);
		timings.releaseToPreviewMs = Date.now() - released; timings.gesturePreparationMs = preparationMs;
		const preview = quick.state(), replacement = preview.replacement;
		check("actual local Whisper recognizes the synthetic bounded instruction", /paragraph.*clearer/i.test(transcript) && samplesCount >= 1600 && samplesCount <= 480000 && loadedAtRelease);
		check("one bounded real provider call returns an applicable changed paragraph", packets.length === 1 && preview.canApply && replacement !== snapshot.text);
		check("protected phrases and source numbers remain intact", ["North", "12%", "higher costs"].every(phrase => replacement.includes(phrase)));
		check("cloud generation and passive notices cause no native write", nativeWrites.length === 0 && (await word.status()).fixture.documentText === originalDocument && !notices.some(options => options.focus));
		stage = "native-apply";
		const applyBegan = Date.now(), applied = await quick.apply({ panelId: preview.panelId, proposalId: preview.proposalId }); timings.applyMs = Date.now() - applyBegan;
		assert.ok(applied, "the reviewed proposal must produce a native receipt");
		const after = (await word.status()).fixture;
		check("real native apply changes exactly one range and preserves formatting", applied.intent.state === "verified" && quick.state().phase === "applied" && nativeWrites.length === 1 && after.documentText === originalDocument.replace(snapshot.text, replacement) && after.snapshot.preservationHash === snapshot.preservationHash);
		stage = "host-restart";
		ptt.close(); recorder.close(); await host.close();
		host = await createHost({ dataDir, core: writer.core, modelRuntime: rt, platform, settings: { ...settings, voice: false, pushToTalk: false } }); await host.start(); host.subscribe(event => void quick.onEngine(event));
		const duplicate = await host.handle("mission.targetApply", { intentId: applied.intent.id, intentHash: applied.intent.argsHash });
		check("verified receipt survives an actual host/store restart without redispatch", duplicate.intent.state === "verified" && duplicate.duplicate === true && nativeWrites.length === 1);
		stage = "native-undo";
		const undoBegan = Date.now(), undone = await quick.undo({ panelId: quick.state().panelId }); timings.undoMs = Date.now() - undoBegan;
		const restored = (await word.status()).fixture;
		check("conditional native undo after restart restores text and tested formatting", undone?.intent.state === "verified" && quick.state().phase === "undone" && nativeWrites.length === 2 && restored.documentText === originalDocument && restored.snapshot.preservationHash === snapshot.preservationHash);
		check("undo makes no additional cloud request", packets.length === 1);
		writer.verifyUnchanged(); check("installed credentials/settings and prepared voice marker remain unchanged", hash(fs.readFileSync(voiceMarker)) === markerBefore);
		report = { at: new Date().toISOString(), passed: true, provider: writer.provider, model: writer.model, authType: writer.authType, native: { provider: native.provider, apiVersion: native.fixture.wordVersion, build: native.fixture.wordBuild, hiddenOwnedDocument: true, fixtureCapture: true, mixedFormat: true, repeatedParagraphUntouched: true }, transcript, samples: samplesCount, timings, source: snapshot.text, replacement, packet: packets[0], providerCalls: packets.length, nativeWrites: nativeWrites.length, durableRestart: true, conditionalUndo: true, credentialStorageChanged: false, settingsChanged: false, voiceMarkerChanged: false, checks, limitations: ["One synthetic English recording and paragraph on this account/model/WPS build; no statistical latency, broad writing quality or multilingual qualification.", "Native capture uses a development-only hidden owned-range fixture. Physical hotkey, real foreground selection, microphone device, Word typing and user workflow timing remain unqualified.", "Only the selected fixture paragraph/transcript reach the provider; no raw media, native handles, unrelated paragraphs or standing instructions.", "This run does not qualify installed packaging, linked charts, Microsoft Word builds, full process-tree CPU/RAM, battery behavior or long-running reliability."] };
	} catch (error) {
		report = { at: new Date().toISOString(), passed: false, failedStage: stage, ...(writer ? { provider: writer.provider, model: writer.model } : {}), errorType: error.name, checks, timings, providerCalls: packets.length, nativeWrites: nativeWrites.length, limitations: ["Raw provider/credential errors are suppressed. Only synthetic fixture data and bounded stage evidence are retained."] };
	} finally {
		try {
			ptt?.close(); recorder?.close(); quick?.close(); await host?.close();
			if (child && child.exitCode === null && !child.killed) {
				const exited = new Promise(resolve => child.once("exit", resolve)); child.stdin.end();
				let timer; try { await Promise.race([exited, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("The owned native helper did not exit.")), 10_000); })]); } finally { clearTimeout(timer); }
			}
		} catch (error) { cleanupFailures.push({ stage: "native-helper-exit", type: error.name, code: error.code }); child?.kill(); }
		word?.close();
		if (ownedOffice) {
			try {
				assert.ok(Number.isSafeInteger(ownedOffice.processId) && ownedOffice.processId > 0 && /^[0-9]+$/.test(ownedOffice.createdAtTicks));
				const cleanup = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$workflowOffice = Get-Process -Id ${ownedOffice.processId} -ErrorAction SilentlyContinue; if ($workflowOffice -and $workflowOffice.StartTime.ToUniversalTime().Ticks.ToString() -eq '${ownedOffice.createdAtTicks}') { if (-not $workflowOffice.WaitForExit(2000)) { Stop-Process -Id $workflowOffice.Id -Force -ErrorAction Stop; Write-Output 'forced' } else { Write-Output 'exited' } } else { Write-Output 'exited' }`], { windowsHide: true, encoding: "utf8", timeout: 10_000 }).trim();
				report.ownedOfficeExited = true; report.forcedOfficeCleanup = cleanup === "forced";
				if (report.forcedOfficeCleanup) cleanupFailures.push({ stage: "office-required-forced-exit" });
			} catch (error) { cleanupFailures.push({ stage: "owned-office-exit", type: error.name, code: error.code }); }
		}
		try { writer?.verifyUnchanged(); } catch (error) { cleanupFailures.push({ stage: "installed-files-unchanged", type: error.name, code: error.code }); }
		writer?.close();
		// The Node parent removes this profile only after Electron and its Chromium processes have exited.
		if (cleanupFailures.length) { report.passed = false; report.cleanupFailures = cleanupFailures; }
	}
	if (process.env.MIDNIGHT_TEST_REPORT) { const file = path.resolve(process.env.MIDNIGHT_TEST_REPORT); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2)); }
	console.log(JSON.stringify(report)); app.exit(report.passed ? 0 : 1);
}).catch(() => { console.error("The combined workflow fixture could not finish or clean up safely."); app.exit(1); });
