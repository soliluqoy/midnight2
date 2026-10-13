// One held gesture owns one capture, one instruction and one frozen quick-edit ticket.
import { randomUUID } from "node:crypto";
import { perceptionSettings } from "../perception/config.mjs";
export function createPushToTalk({ quick, recorder, transcribe, prepareSpeech = () => Promise.resolve(), cancelTranscription = () => {}, fence, settings, publish = () => {}, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
	let current, generation = 0, closed = false;
	const enabled = () => settings().voice === true && settings().pushToTalk === true;
	function valid(ctx) {
		const config = settings(), language = config.voiceLanguage === "auto" ? null : config.voiceLanguage ?? null;
		if (closed || current !== ctx || ctx.generation !== generation || !enabled() || language !== ctx.language || (config.privacy ?? "cloud") !== ctx.privacy || JSON.stringify(perceptionSettings(config.perception)) !== ctx.mediaRoute) return false;
		try { fence.assert(ctx.epoch); return quick.state().panelId === ctx.panelId; } catch { return false; }
	}
	const quiet = promise => Promise.resolve(promise).catch(() => {});
	function cancel(message) {
		const ctx = current; current = undefined; generation++;
		if (!ctx) return;
		clearTimer(ctx.timer); ctx.controller.abort(); quiet(recorder.cancel({ id: ctx.id })); quiet(cancelTranscription(ctx.id));
		if (ctx.panelId && quick.state().panelId === ctx.panelId) {
			let fresh = false; try { fence.assert(ctx.epoch); fresh = true; } catch {}
			if (typeof message === "string" && !closed && fresh) quick.voiceFailure({ panelId: ctx.panelId, message }); else quick.cancel({ panelId: ctx.panelId });
		}
		publish({ phase: "idle" });
	}
	function check(ctx) { if (!valid(ctx)) throw new Error("This voice gesture was cancelled or its target changed."); }
	async function down(foreground) {
		if (closed || current || !enabled() || fence.blocked()) return;
		const ctx = { id: `ptt_${randomUUID()}`, capturedAt: now(), epoch: fence.begin(), generation: ++generation, controller: new AbortController(), privacy: settings().privacy ?? "cloud", language: settings().voiceLanguage === "auto" ? null : settings().voiceLanguage ?? null, mediaRoute: JSON.stringify(perceptionSettings(settings().perception)) };
		current = ctx;
		try {
			const before = quick.state().panelId, capture = quick.open({ passive: true, foreground });
			if (quick.state().panelId === before) { quiet(capture); throw new Error("Finish the current quick edit before speaking another request."); }
			ctx.panelId = quick.state().panelId;
			ctx.timer = setTimer(() => cancel("Speak for up to 30 seconds, then release the chord."), 30_000); ctx.timer.unref?.(); publish({ phase: "preparing" });
			ctx.boot = Promise.all([capture, recorder.begin({ id: ctx.id, signal: ctx.controller.signal }).then(() => { if (valid(ctx)) ctx.started = true; })]).then(([ticket]) => {
				if (!ticket) throw new Error(quick.state().message || "The voice target could not be captured."); check(ctx); ctx.ticket = ticket;
				if (!perceptionSettings(settings().perception).enabled) {
					ctx.preparing = Promise.resolve().then(() => { check(ctx); return prepareSpeech({ captureId: ctx.id, deadline: Math.min(ctx.ticket.expiresAt, ctx.capturedAt + 30_000) }, { signal: ctx.controller.signal }); }).catch(error => { if (valid(ctx) && !ctx.released) cancel(error.message); throw error; }); quiet(ctx.preparing);
				}
				if (!ctx.released) { quick.voiceStatus({ panelId: ctx.panelId, phase: "listening", message: "Listening · release the chord to finish" }); publish({ phase: "listening" }); }
			});
			await ctx.boot;
		} catch (error) { if (current === ctx) cancel(error.message); }
	}
	async function up() {
		const ctx = current; if (!ctx || ctx.released) return;
		ctx.released = true;
		if (!ctx.started) { cancel(); return; } // a permission stream arriving after release is never recorded
		clearTimer(ctx.timer); ctx.timer = setTimer(() => cancel("The spoken request expired. Capture a fresh target."), 30_000); ctx.timer.unref?.();
		const audio = recorder.end({ id: ctx.id }); quiet(audio); let samples;
		try {
			await ctx.boot; check(ctx); samples = (await audio).samples; check(ctx);
			if (!(samples instanceof Float32Array) || samples.length < 1600 || samples.length > 480000 || samples.some(value => !Number.isFinite(value))) throw new Error("The spoken request is empty or exceeds its audio budget.");
			let energy = 0; for (const value of samples) energy += value * value; if (Math.sqrt(energy / samples.length) < 0.003) throw new Error("No audible request was recorded. Hold the chord and speak again.");
			const cloudMedia = perceptionSettings(settings().perception).enabled;
			quick.voiceStatus({ panelId: ctx.panelId, phase: "transcribing", message: cloudMedia ? "Understanding this utterance with the cloud media provider" : "Transcribing on this computer" }); publish({ phase: "transcribing", cloudMedia });
			const deadline = Math.min(ctx.ticket.expiresAt, now() + 30_000);
			clearTimer(ctx.timer); ctx.timer = setTimer(() => cancel("The spoken request expired. Capture a fresh target."), Math.max(1, deadline - now())); ctx.timer.unref?.();
			await ctx.preparing; check(ctx);
			const result = await transcribe({ captureId: ctx.id, capturedAt: ctx.capturedAt, samples, language: ctx.language, deadline }, { signal: ctx.controller.signal }); check(ctx);
			if (typeof result.text !== "string" || !result.text.trim() || result.text.length > 1000 || now() >= deadline) throw new Error("The spoken request was empty, too long or expired. Try a fresh selection.");
			clearTimer(ctx.timer); current = undefined; publish({ phase: "idle" });
			await quick.submit({ panelId: ctx.panelId, text: result.text });
		} catch (error) { if (current === ctx) cancel(error.message); }
		finally { samples?.fill(0); }
	}
	return { down, up, cancel, isWorking: () => !!current, canRecord: () => !!current && !current.released && valid(current), currentId: () => current?.id, close() { closed = true; cancel(); } };
}
