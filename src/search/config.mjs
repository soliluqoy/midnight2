// Search has its own local embedding model; it never changes the chat provider.
export const EMBEDDING_DEFAULTS = Object.freeze({
	enabled: false,
	assist: true,
	model: "google/embeddinggemma-2",
	dimensions: 768,
	pythonPath: "",
	device: "cpu",
});

export function embeddingSettings(value) {
	const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	return {
		enabled: v.enabled === true,
		assist: v.assist !== false,
		model: EMBEDDING_DEFAULTS.model,
		dimensions: [128, 256, 512, 768].includes(v.dimensions) ? v.dimensions : 768,
		pythonPath: typeof v.pythonPath === "string" ? v.pythonPath.trim().slice(0, 2000) : "",
		device: ["cpu", "cuda"].includes(v.device) ? v.device : "cpu",
	};
}
