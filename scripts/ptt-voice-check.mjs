// Fake microphone plays synthetic speech into the actual hidden PCM recorder and local Whisper.
// Serving model is scripted; document/connector are synthetic. No production profile or microphone is used.
import assert from "node:assert/strict";
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createPttRecorder } from "../src/desktop/ptt-recorder.mjs";
import { createPushToTalk } from "../src/voice/ptt.mjs";
import { createCaptureEpoch } from "../src/voice/capture-epoch.mjs";
import { createQuickAssist } from "../src/desktop/quick-assist.mjs";
import { createSpeechRuntime } from "../src/voice/runtime.mjs";
import { createInferenceArbiter } from "../src/inference/arbiter.mjs";
import { createHost } from "../src/runtime/host.mjs";
import { makeModel, fakePlatform, fauxAssistantMessage, fauxText, until } from "../test/e2e-helpers.mjs";
import { sha256 } from "../src/policy/canonical.mjs";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "midnight-ptt-voice-")), wav = path.join(profile, "speech.wav");
app.setPath("userData", profile);
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.Speech; $speechFixture = New-Object System.Speech.Synthesis.SpeechSynthesizer; $speechFixture.SetOutputToWaveFile('${wav.replace(/'/g, "''")}'); $speechFixture.Speak('Make this paragraph clearer.'); $speechFixture.Dispose()`], { windowsHide: true, timeout: 30_000 });
app.commandLine.appendSwitch("use-fake-device-for-media-stream"); app.commandLine.appendSwitch("use-fake-ui-for-media-stream"); app.commandLine.appendSwitch("use-file-for-fake-audio-capture", wav);
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
	let host, ptt, recorder, foreground, metricsTimer, typingTimer;
	try {
		const arbiter = createInferenceArbiter(), dataDir = process.env.MIDNIGHT_TEST_VOICE_DATA;
		if (!dataDir) throw new Error("Set MIDNIGHT_TEST_VOICE_DATA to an existing prepared voice cache. This qualification never downloads.");
		const ownedWorkers = [];
		const speech = createSpeechRuntime({ paths: { dataDir }, arbiter, download: async () => { throw new Error("No model download in this qualification."); }, workerFactory: data => { const worker = new Worker(new URL("../src/voice/speech-worker.mjs", import.meta.url), { workerData: data }); const post = worker.postMessage.bind(worker); worker.postMessage = message => { worker.lastOperation = message.op; return post(message); }; ownedWorkers.push(worker); return worker; } }); assert.equal(speech.status().available, true);
		const model = await makeModel(); let packet;
		const turns = 3;
		model.faux.setResponses(Array.from({ length: turns }, () => ctx => { packet = JSON.stringify(ctx.messages); return fauxAssistantMessage([fauxText('{"kind":"paragraph.replace","text":"Revenue increased by 12%."}')]); }));
		const settings = { provider: "faux", model: "m1", voice: true, pushToTalk: true, voiceLanguage: "en", privacy: "cloud" };
		host = await createHost({ dataDir: path.join(profile, "data"), core: model.core, modelRuntime: model.rt, speechRuntime: speech, inferenceArbiter: arbiter, settings, platform: fakePlatform() }); await host.start();
		const snapshot = { kind: "paragraph", documentId: "PRIVATE_DOCUMENT", handle: "PRIVATE_HANDLE", windowId: "52", processId: 41, text: "Revenue rose by 12%.", metadata: { supported: true, scope: "paragraph" }, structureHash: sha256("structure"), connector: { id: "word", api: 1, artifact: sha256("connector") } }, shown = [];
		const quick = createQuickAssist({ word: { capture: async () => structuredClone(snapshot), inspect: async () => structuredClone(snapshot), release: async () => {} }, request: (method, params) => host.handle(method, params), settings: () => settings, present: options => shown.push(options) }); host.subscribe(message => void quick.onEngine(message));
		foreground = new BrowserWindow({ width: 260, height: 80, webPreferences: { sandbox: true, nodeIntegration: false } }); await foreground.loadURL("data:text/html,<input id='typing' autofocus value='typing fixture'><script>window.typingEvents=[];document.addEventListener('keydown',e=>{if(e.key==='x')typingEvents.push(Date.now())})</script>"); foreground.show(); foreground.focus();
		recorder = createPttRecorder({ allowed: id => ptt?.currentId() === id && ptt.canRecord() }); let heard, samplesCount;
		let warmupMs;
		ptt = createPushToTalk({ quick, recorder, fence: createCaptureEpoch(), settings: () => settings, prepareSpeech: async params => { const began = Date.now(); const result = await host.handle("voice.quickPrepare", params); warmupMs = Date.now() - began; return result; }, transcribe: async params => { samplesCount = params.samples.length; const result = await host.handle("voice.quickTranscribe", params); heard = result.text; return result; }, cancelTranscription: captureId => host.handle("voice.quickCancel", { captureId }) });
		const observed = [], cpu = new Map(); let baseline = true, cpuSeconds = 0;
		const sample = () => {
			const metrics = app.getAppMetrics();
			for (const item of metrics) { const key = `${item.pid}:${item.creationTime}`, value = item.cpu?.cumulativeCPUUsage; if (!Number.isFinite(value)) continue; const before = cpu.get(key); if (before !== undefined) cpuSeconds += Math.max(0, value - before); else if (!baseline) cpuSeconds += value; cpu.set(key, value); }
			observed.push({ at: Date.now(), processes: metrics.length, workingSetMiB: metrics.reduce((sum, item) => sum + (item.memory?.workingSetSize ?? 0), 0) / 1024, privateMiB: metrics.reduce((sum, item) => sum + (item.memory?.privateBytes ?? 0), 0) / 1024 }); baseline = false;
		}; sample(); metricsTimer = setInterval(sample, 250); const began = Date.now(), results = [], sent = [];
		typingTimer = setInterval(() => { sent.push(Date.now()); foreground.webContents.sendInputEvent({ type: "keyDown", keyCode: "X" }); foreground.webContents.sendInputEvent({ type: "char", keyCode: "x" }); foreground.webContents.sendInputEvent({ type: "keyUp", keyCode: "X" }); }, 50);
		for (let turn = 0; turn < turns; turn++) {
			if (turn) { quick.cancel({ panelId: quick.state().panelId }); foreground.focus(); }
			warmupMs = undefined; const held = Date.now(); await ptt.down({ windowId: "52", processId: 41 }); const recorderReady = Date.now(); assert.equal(foreground.isFocused(), true);
			await new Promise(resolve => setTimeout(resolve, 2800)); const loadedAtRelease = speech.status().loaded, released = Date.now(); await ptt.up();
			await until(() => { const state = quick.state(); if (state.phase === "error") throw new Error(state.message); return state.phase === "preview"; }, 30_000);
			assert.match(heard, /paragraph.*clearer/i); assert.ok(samplesCount >= 1600 && samplesCount <= 480000); assert.equal(loadedAtRelease, true);
			assert.equal(quick.state().replacement, "Revenue increased by 12%."); assert.equal(shown.some(options => options.focus), false); assert.equal(foreground.isFocused(), true); assert.doesNotMatch(packet, /PRIVATE_DOCUMENT|PRIVATE_HANDLE|samples|audio\/|data:audio|wav/i);
			results.push({ turn, heldToRecorderReadyMs: recorderReady - held, warmupMs, loadedAtRelease, samples: samplesCount, transcript: heard, releaseToPreviewMs: Date.now() - released });
		}
		clearInterval(typingTimer); typingTimer = undefined; await new Promise(resolve => setTimeout(resolve, 100)); const events = await foreground.webContents.executeJavaScript("typingEvents"), content = await foreground.webContents.executeJavaScript("document.getElementById('typing').value");
		assert.equal(events.length, sent.length, "every fixture key arrives during speech work"); assert.equal(content.length, "typing fixture".length + sent.length, "every fixture character is retained");
		const lags = events.map((at, i) => Math.max(0, at - sent[i])).sort((a, b) => a - b), gaps = sent.slice(1).map((at, i) => at - sent[i]).sort((a, b) => a - b), percentile = (values, p) => values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]; sample(); clearInterval(metricsTimer); metricsTimer = undefined;
		assert.equal(Object.keys(host.snapshot().missions).length, turns); for (const id of Object.keys(host.snapshot().missions)) assert.equal(host.ledger.forMission(id).some(intent => intent.effect === "app.write"), false);
		const activeResources = { elapsedMs: Date.now() - began, observedCPUSeconds: cpuSeconds, logicalCPUs: os.cpus().length, normalizedObservedCPUPercent: cpuSeconds / ((Date.now() - began) / 1000 * os.cpus().length) * 100, peakSampledWorkingSetMiB: Math.max(...observed.map(item => item.workingSetMiB)), peakSampledPrivateMiB: Math.max(...observed.map(item => item.privateMiB)), sampleMs: 250, samples: observed.length };
		const idleWindow = async label => {
			sample(); const baselineCPU = cpuSeconds, start = Date.now(), samples = [];
			for (let i = 0; i < 5; i++) { const before = cpuSeconds, at = Date.now(); await new Promise(resolve => setTimeout(resolve, 1000)); sample(); samples.push({ ...observed.at(-1), normalizedCPUPercent: (cpuSeconds - before) / ((Date.now() - at) / 1000 * os.cpus().length) * 100 }); }
			const percentages = samples.map(value => value.normalizedCPUPercent).sort((a, b) => a - b);
			return { label, elapsedMs: Date.now() - start, loaded: speech.status().loaded, observedCPUSeconds: cpuSeconds - baselineCPU, medianCPUPercent: percentile(percentages, 0.5), p95CPUPercent: percentile(percentages, 0.95), privateMiB: samples.at(-1).privateMiB, samples };
		};
		const warmIdle = await idleWindow("resident Whisper, no requests"); assert.equal(warmIdle.loaded, true);
		const cancelling = { captureId: `ptt_${randomUUID()}`, samples: new Float32Array(480000).fill(0.1), language: "en", deadline: Date.now() + 30_000 }, worker = ownedWorkers.at(-1); worker.lastOperation = undefined; assert.ok(worker.threadId > 0);
		const pending = host.handle("voice.quickTranscribe", cancelling), rejected = assert.rejects(pending); await until(() => worker.lastOperation === "transcribe", 3000); await new Promise(resolve => setTimeout(resolve, 40)); const cancelledAt = Date.now(); await host.handle("voice.quickCancel", { captureId: cancelling.captureId });
		let admittedAfterExit = false; const next = arbiter.run({ role: "cleanup-probe", priority: 0 }, async () => { admittedAfterExit = worker.threadId === -1; }); await rejected; await next;
		const cancellation = { cancelToWorkerExitMs: Date.now() - cancelledAt, workerExited: worker.threadId === -1, subsequentAdmissionAfterExit: admittedAfterExit, ownedPCMZeroed: cancelling.samples.every(value => value === 0) }; assert.equal(cancellation.workerExited, true); assert.equal(admittedAfterExit, true); assert.equal(cancellation.ownedPCMZeroed, true); assert.equal(speech.status().loaded, false); const unloadedIdle = await idleWindow("Whisper worker terminated, no requests");
		const report = { at: new Date().toISOString(), passed: "synthetic microphone → gesture-time warmup → actual hidden PCM → actual Whisper → scripted cloud proposal", results, typing: { keys: sent.length, p50DispatchToRendererMs: percentile(lags, 0.5), p95DispatchToRendererMs: percentile(lags, 0.95), maxDispatchToRendererMs: lags.at(-1), p95InjectionGapMs: percentile(gaps, 0.95), maxInjectionGapMs: gaps.at(-1), focusPreserved: true, injectedElectronInput: true }, resources: activeResources, idle: { warm: warmIdle, unloaded: unloadedIdle }, cancellation, nativeEffect: false, limitations: ["Three synthetic English recordings, scripted cloud provider and connector; not personal microphone, physical keyboard or Office capture timing.", "Resource observations cover this Electron fixture, not all native helpers/embeddings or full production process tree. Each idle observation is only five seconds.", "Summed working sets can count shared pages more than once; short-lived CPU after the final per-process sample can be missed.", "Dispatch-to-renderer latency excludes injection scheduling delays, which are reported separately."] };
		if (process.env.MIDNIGHT_TEST_REPORT) { const file = path.resolve(process.env.MIDNIGHT_TEST_REPORT); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2)); }
		console.log(JSON.stringify(report));
		quick.close();
	} finally { clearInterval(metricsTimer); clearInterval(typingTimer); ptt?.close(); recorder?.close(); await host?.close(); foreground?.destroy(); }
	app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
