// Real-model check for voice input, in Electron so audio goes through the real decoder window:
//   npm run test:voice-model
// Downloads pinned Whisper (about 80 MB) into MIDNIGHT_TEST_VOICE_DATA (default: a cache folder in your home
// directory) on first use, speaks a sentence with Windows' built-in voice (System.Speech), decodes it as the
// launcher's recordings are decoded, and checks the local transcription. Windows only (the synthesized speech).
import { app } from "electron";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMediaDecoder } from "../src/desktop/media-decoder.mjs";
import { createSpeechRuntime } from "../src/voice/runtime.mjs";

app.on("window-all-closed", () => {});
const say = (line) => console.log(`[voice-model] ${line}`);

async function run() {
	if (process.platform !== "win32") return say("SKIP speech synthesis for the check is Windows-only"), 0;
	const dataDir = path.resolve(process.env.MIDNIGHT_TEST_VOICE_DATA ?? path.join(os.homedir(), ".cache", "midnight-voice-model"));
	const runtime = createSpeechRuntime({ paths: { dataDir } });
	const decoder = createMediaDecoder();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "midnight-voice-"));
	try {
		if (!runtime.status().available) {
			say("downloading Whisper (pinned, about 80 MB)");
			await runtime.setup();
		}
		say("PASS setup (pinned Whisper, verified load)");
		const wav = path.join(tmp, "speech.wav");
		const sentence = "Please summarize the quarterly budget and send it to Sam.";
		execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}'); $s.Speak('${sentence}'); $s.Dispose()`], { windowsHide: true, timeout: 60000 });
		const media = await decoder.fromBytes(new Uint8Array(fs.readFileSync(wav)), "audio", "audio/wav");
		const { samples } = await media.audio({ start: 0, seconds: 300 });
		await media.close();
		const t0 = Date.now();
		const { text } = await runtime.transcribe(samples);
		say(`heard "${text}" in ${Date.now() - t0} ms`);
		const words = (s) => s.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean);
		const got = new Set(words(text));
		const want = words(sentence);
		const hits = want.filter((w) => got.has(w)).length;
		assert.ok(hits / want.length >= 0.8, `only ${hits}/${want.length} words recognized`);
		say(`PASS local transcription (${hits}/${want.length} words)`);
		return 0;
	} catch (err) {
		say(`FAIL ${err.stack}`);
		return 1;
	} finally {
		runtime.close();
		decoder.dispose();
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

app.whenReady().then(async () => app.exit(await run()));
