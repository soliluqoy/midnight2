// Search has its own local embedding model; it never changes the chat provider.
export const EMBEDDING_DEFAULTS = Object.freeze({
	enabled: false,
	assist: true,
	model: "onnx-community/embeddinggemma-2-ONNX",
	dimensions: 768,
	device: "cpu", // cpu | gpu (DirectML on Windows, Core ML on macOS, CUDA on Linux; falls back to the CPU)
});

export function embeddingSettings(value) {
	const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	return {
		enabled: v.enabled === true,
		assist: v.assist !== false,
		model: EMBEDDING_DEFAULTS.model,
		dimensions: [128, 256, 512, 768].includes(v.dimensions) ? v.dimensions : 768,
		// "cuda" and "mps" were the Python runtime's GPU choices; both mean the GPU now.
		device: ["gpu", "cuda", "mps"].includes(v.device) ? "gpu" : "cpu",
	};
}
