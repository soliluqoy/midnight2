// Native media has its own provider and consent. It does not change the text model or local embeddings.
export const DEFAULT_PERCEPTION = Object.freeze({ enabled: false, provider: "google", model: "gemini-3.8-flash" });
export function perceptionSettings(value) {
	const provider = value?.provider === "openai" ? "openai" : "google";
	const fallback = provider === "openai" ? "gpt-realtime-2.1" : "gemini-3.8-flash";
	return { enabled: value?.enabled === true, provider, model: typeof value?.model === "string" && /^[a-z0-9][a-z0-9.-]{1,95}$/.test(value.model) ? value.model : fallback };
}
