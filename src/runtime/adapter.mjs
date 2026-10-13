// MidnightRuntimeAdapter over the Pi coding-agent SDK (docs/adr/0001-runtime.md). Pi owns the conversation, model
// calls, retries and compaction; Midnight owns tools, policy, missions and outcomes. Pi types and events stay
// inside this file: the coordinator sees `run()` results and a small live-event stream.
import fs from "node:fs";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { pruneImages } from "../harness-utils.mjs";
import { corePaths } from "./paths.mjs";
import { isLocal } from "./models.mjs";
import { admittedStream } from "../inference/stream.mjs";
import { boundedStream } from "../inference/request-limits.mjs";
// The standalone MCP client ships with the Pi packages; connectors reach it through this single seam.
export { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";

// The package does not export its package.json; the vendor manifest records the exact pinned version.
function coreVersion() {
	try {
		const prov = JSON.parse(fs.readFileSync(new URL("../../vendor/PROVENANCE.json", import.meta.url), "utf8"));
		return prov.packages.find((p) => p.name === "@earendil-works/pi-coding-agent")?.version ?? "unknown";
	} catch {
		return "unknown";
	}
}
export const RUNTIME_VERSION = `pi-coding-agent@${coreVersion()}`;

export async function createModelRuntime({ core = corePaths(), credentials, allowModelNetwork = false } = {}) {
	return ModelRuntime.create({ authPath: core.authPath, modelsStorePath: core.modelsStorePath, modelsPath: core.modelsPath, credentials, allowModelNetwork });
}

/** Native media uses the provider's API-key lane, never a subscription OAuth token or a proxy credential. */
export async function resolveMediaApiKey(modelRuntime, provider, { signal } = {}) {
	if (!["openai", "google"].includes(provider)) throw new Error("Unsupported native media provider.");
	const configured = modelRuntime.getRegisteredProviderConfig?.(provider);
	const expected = provider === "openai" ? "https://api.openai.com" : "https://generativelanguage.googleapis.com";
	const direct = value => { if (!value) return true; try { const url = new URL(value); return url.origin === expected && !url.username && !url.password && !url.search && !url.hash && /^\/(?:v1(?:beta)?)?\/?$/.test(url.pathname); } catch { return false; } };
	if (!direct(configured?.baseUrl)) throw new Error("Native media requires the provider's direct API credential.");
	let check, result;
	try { check = await modelRuntime.checkAuth(provider, { signal }); } catch { signal?.throwIfAborted(); throw new Error("The media provider credential could not be checked."); }
	if (check?.type !== "api_key") throw new Error("Connect an API key for this media provider in Settings → Models. Text-model OAuth does not configure native media.");
	try { result = await modelRuntime.getAuth(provider, { signal }); } catch { signal?.throwIfAborted(); throw new Error("The media provider credential could not be resolved."); }
	signal?.throwIfAborted();
	if (!direct(result?.auth?.baseUrl)) throw new Error("Native media requires the provider's direct API credential.");
	if (typeof result?.auth?.apiKey !== "string" || !result.auth.apiKey || /[\r\n]/.test(result.auth.apiKey)) throw new Error("The media provider has no usable API key.");
	return result.auth.apiKey;
}

/** The inline extension that routes every tool call through the broker (direct, deferred, nested, Codemode, MCP). */
export function gateExtension({ gate, result }) {
	return (pi) => {
		pi.on("tool_call", async (event, ctx) => gate({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, signal: ctx?.signal }));
		pi.on("tool_result", async (event) => {
			result?.({ toolCallId: event.toolCallId, toolName: event.toolName, isError: !!event.isError, content: event.content });
			return undefined;
		});
	};
}

const textOf = (msg) =>
	(msg?.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("");

/**
 * @param {{ modelRuntime: ModelRuntime, sessionsDir: string, cwd?: string, core?: object, onLive?: (missionId: string, e: object) => void, quiet?: () => boolean, extraExtensions?: () => any[] }} o
 */
export function createPiRuntime({ modelRuntime, sessionsDir, cwd = sessionsDir, core = corePaths(), onLive = () => {}, quiet = () => false, extraExtensions = () => [], arbiter }) {
	const live = new Map(); // missionId -> { session, runId }

	return {
		version: RUNTIME_VERSION,
		modelRuntime,
		/**
		 * Run one input to settlement. Resolves with { answer, stopReason, error, usage, sessionFile, aborted }.
		 * A finished run is only a runtime fact; the coordinator decides whether the mission succeeded.
		 */
		async run(missionId, { runId, input, images, model, thinking = "low", systemPrompt, tools, gate, sessionFile, onSession, signal: callerSignal, priority = 1, requestLimits }) {
			if (live.has(missionId)) throw new Error("this mission already has a run in progress");
			const isolated = !!requestLimits;
			const deadline = isolated ? AbortSignal.timeout(Math.max(1, requestLimits.deadline - Date.now())) : undefined;
			const signal = deadline ? (callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline) : callerSignal;
			if (isolated) { sessionFile = undefined; images = []; tools = []; }
			const dir = path.join(sessionsDir, missionId);
			fs.mkdirSync(dir, { recursive: true });
			const sm = sessionFile && fs.existsSync(sessionFile) ? SessionManager.open(sessionFile, dir) : SessionManager.create(cwd, dir);
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir: core.agentDir,
				noExtensions: true, // nothing ambient: no home-folder extensions, skills, prompts or AGENTS files
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt,
				extensionFactories: [gateExtension(gate), ...(isolated ? [] : extraExtensions(missionId))],
			});
			await loader.reload();
			const usage = { input: 0, output: 0, tokens: 0, costUsd: 0, unknownCost: 0, modelCalls: 0 };
			const { session } = await createAgentSession({
				cwd,
				agentDir: core.agentDir,
				model,
				thinkingLevel: thinking,
				modelRuntime,
				resourceLoader: loader,
				tools: tools.map((t) => t.name),
				customTools: tools,
				sessionManager: sm,
				settingsManager: SettingsManager.inMemory({ compaction: { enabled: !isolated }, retry: { enabled: !isolated, maxRetries: isolated ? 0 : 2 }, cacheWarming: "off" }),
			});
			if (isolated) session.agent.streamFunction = boundedStream(session.agent.streamFunction.bind(session.agent), { signal, maxCalls: 1, maxTokens: requestLimits.maxTokens });
			if (arbiter && isLocal(model)) session.agent.streamFunction = admittedStream(session.agent.streamFunction.bind(session.agent), arbiter, { signal, priority, preemptible: priority >= 2 });
			await session.bindExtensions({});
			onSession?.(sm.getSessionFile?.());
			const transform = session.agent.transformContext;
			// Screenshots dominate a desktop run's tokens and only the latest matter; prune before compaction too.
			session.agent.transformContext = async (messages, signal) => (transform ? transform(pruneImages(messages), signal) : pruneImages(messages));
			live.set(missionId, { session, runId });
			let settled = false;
			const unsub = session.subscribe((e) => {
				switch (e.type) {
					case "message_start":
						if (e.message.role === "assistant") onLive(missionId, { type: "assistant_start", runId });
						break;
					case "message_update":
						if (e.assistantMessageEvent.type === "text_delta") onLive(missionId, { type: "text", runId, delta: e.assistantMessageEvent.delta });
						break;
					case "message_end":
						if (e.message.role === "assistant") {
							const u = e.message.usage ?? {};
							usage.modelCalls++;
							usage.input += u.input ?? 0;
							usage.output += u.output ?? 0;
							usage.tokens += u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0);
							if (typeof u.cost?.total === "number") usage.costUsd += u.cost.total;
							else usage.unknownCost++;
							onLive(missionId, { type: "usage", runId, usage: { ...usage } });
						}
						break;
					case "tool_execution_start":
						onLive(missionId, { type: "tool_start", runId, id: e.toolCallId, name: e.toolName, args: e.args, nested: !!e.parentToolCallId });
						break;
					case "tool_execution_end":
						onLive(missionId, { type: "tool_end", runId, id: e.toolCallId, name: e.toolName, isError: e.isError });
						break;
					case "agent_settled":
						settled = true;
						break;
				}
			});
			let error;
			let aborted = false;
			const cancel = () => session.abort().catch(() => {});
			signal?.addEventListener("abort", cancel, { once: true });
			try {
				signal?.throwIfAborted();
				await session.prompt(input, images?.length ? { images } : undefined);
			} catch (err) {
				error = String(err?.message ?? err);
				aborted = signal?.aborted || err?.name === "AbortError";
			}
			const last = [...session.messages].reverse().find((m) => m.role === "assistant");
			if (last?.stopReason === "aborted") aborted = true;
			if (!error && last?.stopReason === "error") error = last.errorMessage ?? "the model returned an error";
			const file = sm.getSessionFile?.();
			unsub();
			signal?.removeEventListener("abort", cancel);
			live.delete(missionId);
			session.dispose();
			return { answer: textOf(last), stopReason: last?.stopReason, error, aborted, usage, settled, sessionFile: file };
		},
		/** Steer a running mission; false if nothing is running. */
		async steer(missionId, text) {
			const l = live.get(missionId);
			if (!l) return false;
			await l.session.steer(text);
			return true;
		},
		async abort(missionId) {
			const l = live.get(missionId);
			if (l) await l.session.abort();
		},
		isRunning: (missionId) => live.has(missionId),
		running: () => [...live.keys()],
	};
}
