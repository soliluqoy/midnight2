// Cloud media has separate admission and qualification. One physical request owns its buffers until cleanup.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { MEDIA_PROTOCOL, validateMediaPacket, validateObservation, boundedUsage } from "./contracts.mjs";
import { createGeminiPerception } from "./gemini.mjs";
import { createOpenAiPerception } from "./openai-realtime.mjs";
import { perceptionSettings } from "./config.mjs";
import { perceptionFixtures } from "./fixtures.mjs";
import { createQualificationStore, qualificationIdentity } from "./qualification.mjs";

const hashes = Object.fromEntries(["google", "openai"].map(provider => [provider, createHash("sha256").update(fs.readFileSync(new URL(provider === "google" ? "./gemini.mjs" : "./openai-realtime.mjs", import.meta.url))).update(fs.readFileSync(new URL("./contracts.mjs", import.meta.url))).digest("hex")]));
export function createPerceptionService({ settings, stop, credential, credentialStatus, qualificationFile, inspectVideo = async () => { throw new Error("Native video requires local clip inspection."); }, adapters = { google: createGeminiPerception(), openai: createOpenAiPerception() }, publish = () => {} }) {
	let active, closed = false, epoch = 0, lastProbe;
	const qualifications = createQualificationStore(qualificationFile);
	const config = () => perceptionSettings(settings().perception), routeKey = () => JSON.stringify({ ...config(), privacy: settings().privacy });
	const cancel = () => { epoch++; active?.controller.abort(new Error("Cloud media request revoked.")); };
	const unsubscribe = stop.subscribe(event => { if (event.type === "emergency" || (event.type === "session" && event.reason)) cancel(); });
	function begin(requestId, expiresAt, signal) {
		const route = config();
		if (closed || !route.enabled || settings().privacy !== "cloud" || stop.blocked("perception")) throw new Error("Cloud raw-media perception is disabled or blocked by the current privacy/session policy.");
		if (active) throw new Error("A cloud media request is already running. Finish or cancel it first.");
		const controller = new AbortController(), currentEpoch = epoch, routeAtStart = routeKey();
		const callerAbort = () => controller.abort(signal.reason); signal?.addEventListener("abort", callerAbort, { once: true }); if (signal?.aborted) callerAbort();
		const timer = setTimeout(() => controller.abort(new Error("Cloud media request expired.")), Math.max(1, expiresAt - Date.now()));
		const guard = () => { controller.signal.throwIfAborted(); if (closed || epoch !== currentEpoch || routeKey() !== routeAtStart || stop.blocked("perception") || Date.now() >= expiresAt) throw new Error("This cloud media request expired or changed route."); };
		const run = { requestId, controller, route, guard, finish() { clearTimeout(timer); signal?.removeEventListener("abort", callerAbort); if (active === run) active = undefined; } }; active = run; return run;
	}
	async function execute(input, run, apiKey) {
		const coverage = validateMediaPacket(input), packet = structuredClone(input), began = Date.now(); let firstTokenMs;
		const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error("Cloud media request expired.")), Math.max(1, packet.expiresAt - Date.now()));
		const signal = AbortSignal.any([controller.signal, run.controller.signal]), guard = () => { signal.throwIfAborted(); run.guard(); if (Date.now() >= packet.expiresAt) throw new Error("The captured media expired."); };
		try {
			guard();
			for (const item of packet.media.filter(media => media.kind === "video")) {
				if (!adapters[run.route.provider].declared.nativeVideo) throw new Error("This media transport does not support native video.");
				const info = await inspectVideo(item, { signal }); guard();
				if (!Number.isFinite(info?.duration) || info.duration <= 0 || info.duration > 30 || !Number.isFinite(info.width) || !Number.isFinite(info.height) || info.width < 1 || info.height < 1 || info.width > 1600 || info.height > 1600 || Math.abs(info.duration * 1000 - item.durationMs) > 250) throw new Error("The native video does not match its bounded inspected clip.");
			}
			const result = await adapters[run.route.provider].observe({ packet, coverage, model: run.route.model, apiKey, signal, onDelta: () => { guard(); firstTokenMs ??= Date.now() - began; publish({ kind: "perception", requestId: run.requestId, phase: "receiving" }); } }); guard();
			return { ...validateObservation(result.text, packet, coverage), requestId: input.requestId, provider: run.route.provider, model: run.route.model, transport: adapters[run.route.provider].transport, transportDigest: hashes[run.route.provider], timings: { firstTokenMs, elapsedMs: Date.now() - began }, usage: boundedUsage(result.usage) };
		} finally { clearTimeout(timer); for (const item of packet.media) { item.samples?.fill(0); item.data?.fill(0); } }
	}
	return {
		async status() {
			const route = config(), adapter = adapters[route.provider]; let authenticated = false, record;
			try { authenticated = await credentialStatus(route.provider); if (authenticated) { const key = await credential(route.provider, {}); record = qualifications.get(qualificationIdentity(route, hashes[route.provider], key)); } } catch { authenticated = false; }
			return { ...route, available: authenticated, busy: !!active, protocol: MEDIA_PROTOCOL, transport: adapter.transport, transportDigest: hashes[route.provider], declared: adapter.declared, qualification: record ? "fixtures-passed" : "unqualified", qualified: record?.capabilities ?? [], checks: record?.checks ?? [], qualifiedAt: record?.at, probe: lastProbe, reason: !authenticated ? "Connect a media provider API key in Settings → Models. Codex OAuth configures text assistance." : record ? "Synthetic English audio, image and frame-order checks passed. Native video, live capture and broad quality remain unqualified." : "Run the synthetic media checks before using captured audio or images." };
		},
		async qualify({ signal } = {}) {
			const run = begin(`media_probe_${randomUUID()}`, Date.now() + 110_000, signal); let identity, fixtures;
			lastProbe = { phase: "running", passed: 0, total: 5 };
			try {
				const key = await credential(run.route.provider, { signal: run.controller.signal }); run.guard();
				identity = qualificationIdentity(run.route, hashes[run.route.provider], key); qualifications.revoke(identity); fixtures = perceptionFixtures(); const checks = [];
				for (const fixture of fixtures) {
					run.guard(); const capturedAt = Date.now(), packet = { requestId: `${run.requestId}_${fixture.id}`, purpose: fixture.purpose, instruction: fixture.instruction, capturedAt, expiresAt: capturedAt + 20_000, media: fixture.media };
					const result = await execute(packet, run, key); if (!fixture.accepts(result)) throw new Error("A synthetic media capability check did not pass.");
					checks.push({ id: fixture.id, passed: true, elapsedMs: result.timings.elapsedMs }); lastProbe = { phase: "running", passed: checks.length, total: fixtures.length };
				}
				run.guard(); const record = qualifications.pass(identity, checks); lastProbe = { phase: "passed", passed: checks.length, total: fixtures.length }; return { ok: true, qualified: record.capabilities, checks: record.checks };
			} catch {
				if (identity) qualifications.revoke(identity); lastProbe = { phase: "failed", passed: lastProbe?.passed ?? 0, total: 5 }; throw new Error("Synthetic media checks did not pass. Check the API connection, privacy setting and selected model, then run them again.");
			} finally { for (const fixture of fixtures ?? []) for (const item of fixture.media) { item.samples?.fill(0); item.data?.fill(0); } run.finish(); }
		},
		async observe(input, { signal } = {}) {
			const coverage = validateMediaPacket(input), run = begin(input.requestId, Math.min(input.expiresAt, Date.now() + 30_000), signal);
			try {
				const key = await credential(run.route.provider, { signal: run.controller.signal }); run.guard();
				const record = qualifications.get(qualificationIdentity(run.route, hashes[run.route.provider], key));
				const required = [...new Set(coverage.map(item => item.kind === "video" ? "nativeVideo" : item.kind))]; if (coverage.filter(item => item.kind === "image").length > 1) required.push("orderedFrames");
				if (coverage.some(item => item.kind === "audio") && coverage.some(item => item.kind !== "audio")) required.push("alignedMedia");
				if (!record || required.some(capability => !record.capabilities.includes(capability))) throw new Error("This model/transport has not passed the required native media checks. Run the synthetic checks or choose a qualified route.");
				return { ...await execute(input, run, key), qualification: "fixtures-passed" };
			} finally { run.finish(); }
		},
		cancel(requestId) { if (!requestId || active?.requestId === requestId) cancel(); },
		settingsChanged() { lastProbe = undefined; cancel(); },
		isBusy: () => !!active,
		async close() { closed = true; cancel(); while (active) await new Promise(resolve => setTimeout(resolve, 10)); unsubscribe(); },
	};
}
