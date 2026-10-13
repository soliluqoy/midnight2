import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { defaultHotkey, migrateHotkey } from "./desktop/hotkey.mjs";
import { EMBEDDING_DEFAULTS, embeddingSettings } from "./search/config.mjs";
import { DEFAULT_PERCEPTION, perceptionSettings } from "./perception/config.mjs";

export const SETTINGS_VERSION = 4;

export const DEFAULTS = {
	version: SETTINGS_VERSION,
	provider: "", // "" = choose automatically from what you are signed in to
	model: "",
	thinking: "low", // off | low | medium | high
	computerUse: "ask", // ask = allowed once a plan that needs it is approved | never
	hotkey: defaultHotkey(),
	corner: "right", // legacy preference; the launcher now centres on summon and can be dragged
	launchAtLogin: false,
	instructions: "", // standing instructions appended to the system prompt
	// reading
	textSize: 1, // zoom for the whole capsule: 0.9 … 1.6
	highContrast: false,
	reducedMotion: false,
	voice: false, // dictation into Ask with local Whisper
	pushToTalk: false, // explicitly enabled, held Windows chord for selected-target help
	voiceLanguage: "en", // auto | en | ms | zh | ta | hi; explicit ASR setting, never a model/privacy route
	perception: { ...DEFAULT_PERCEPTION }, // separate explicit consent to send bounded raw media to its API provider
	mcpServer: false, // let other apps on this computer use midnight through its MCP connector
	autoExpand: true, // open the wide reading view when an answer is long
	answerLength: "normal", // brief | normal | detailed
	// web
	searchEngine: "google", // google | bing | duckduckgo (falls back to the others when blocked)
	fastPages: true, // fetch pages without a window when possible; block images, media, fonts and trackers otherwise
	shareContext: true, // tell the model which window / page the user was on when they opened the capsule
	// autonomy (mission engine)
	onboarded: false,
	mode: "ask", // ask | prepare | rules
	privacy: "cloud", // cloud | local | offline
	profile: "balanced", // quiet | balanced | focused | burst
	local: { enabled: false, baseUrl: "http://localhost:11434/v1", model: "", vision: false },
	embedding: { ...EMBEDDING_DEFAULTS },
	quietHours: { enabled: true, from: "22:00", to: "07:00" },
	budget: { costUsd: 2, toolCalls: 300 },
	demoConnectors: false,
	updates: "notify", // notify | off: read the public release feed at most daily; installs only when you ask
	display: "", // legacy preference; summon follows the monitor with the cursor
};

const file = () => path.join(app.getPath("userData"), "settings.json");

export function loadSettings() {
	let data = {};
	try {
		data = JSON.parse(fs.readFileSync(file(), "utf8"));
	} catch {}
	const s = { ...DEFAULTS };
	const unknown = {};
	for (const [k, v] of Object.entries(data)) {
		if (!(k in DEFAULTS)) unknown[k] = v;
		else if (typeof v === typeof DEFAULTS[k] && (typeof v !== "object" || (v && !Array.isArray(v)))) s[k] = typeof v === "object" ? { ...DEFAULTS[k], ...v } : v;
	}
	s.hotkey = migrateHotkey({ ...data, hotkey: s.hotkey }) ?? DEFAULTS.hotkey;
	s.version = SETTINGS_VERSION;
	s.embedding = embeddingSettings(s.embedding);
	s.perception = perceptionSettings(s.perception);
	if (!["auto", "en", "ms", "zh", "ta", "hi"].includes(s.voiceLanguage)) s.voiceLanguage = "en";
	s.textSize = Math.min(1.6, Math.max(0.9, s.textSize));
	const write = () => {
		fs.mkdirSync(path.dirname(file()), { recursive: true });
		const tmp = `${file()}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ ...unknown, ...s }, null, 2));
		fs.renameSync(tmp, file());
	};
	if (data.version !== SETTINGS_VERSION || !fs.existsSync(file())) {
		try {
			write();
		} catch {}
	}
	return {
		get: () => structuredClone(s), // a copy, so callers can compare before/after a set()
		set(patch) {
			for (const k of Object.keys(patch)) {
				if (!(k in DEFAULTS) || k === "version") continue;
				const v = patch[k];
				if (typeof v !== typeof DEFAULTS[k]) continue;
				s[k] = typeof v === "object" && v && !Array.isArray(v) ? { ...s[k], ...v } : v;
			}
			s.textSize = Math.min(1.6, Math.max(0.9, Math.round(s.textSize * 100) / 100));
			s.embedding = embeddingSettings(s.embedding);
			s.perception = perceptionSettings(s.perception);
			if (!["auto", "en", "ms", "zh", "ta", "hi"].includes(s.voiceLanguage)) s.voiceLanguage = "en";
			if (!["ask", "prepare", "rules"].includes(s.mode)) s.mode = "ask";
			if (!["cloud", "local", "offline"].includes(s.privacy)) s.privacy = "cloud";
			if (!["quiet", "balanced", "focused", "burst"].includes(s.profile)) s.profile = "balanced";
			write();
			return structuredClone(s);
		},
	};
}

/** The part of the settings the agent host needs. */
export const hostSettings = (s) => ({
	provider: s.provider,
	model: s.model,
	thinking: s.thinking,
	answerLength: s.answerLength,
	instructions: s.instructions,
	mode: s.mode,
	privacy: s.privacy,
	computerUse: s.computerUse,
	local: s.local,
	embedding: embeddingSettings(s.embedding),
	budget: s.budget,
	profile: s.profile,
	quietHours: s.quietHours,
	demoConnectors: s.demoConnectors,
	voice: s.voice,
	pushToTalk: s.pushToTalk,
	voiceLanguage: s.voiceLanguage,
	perception: perceptionSettings(s.perception),
});
