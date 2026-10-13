// The Whisper files voice input downloads: OpenAI Whisper base (multilingual) in its ONNX export, 8-bit quantized
// (about 80 MB), pinned to one commit with each file's hash, like local search's model.
export const SPEECH_MODEL_ID = "onnx-community/whisper-base";
export const SPEECH_MODEL_REVISION = "1846881b6b3a3024392c1eea3ad983695bc23925";
export const SPEECH_DTYPE = "q8";
export const SPEECH_FILES = [
	{ path: "config.json", size: 2243, git: "ce7faf5d5e56e82d4800e55f524582a525639ff7" },
	{ path: "generation_config.json", size: 3832, git: "a57cdbf036979f80bb7ff092a0fee6256a81d329" },
	{ path: "preprocessor_config.json", size: 339, git: "91876762a536a746d268353c5cba57286e76b058" },
	{ path: "tokenizer.json", size: 2480466, git: "1e95340ff836fad1b5932e800fb7b8c5e6d78a74" },
	{ path: "tokenizer_config.json", size: 282682, git: "25be523be5ac50a7671a77f55acba082459d6314" },
	{ path: "onnx/encoder_model_quantized.onnx", size: 23201314, sha256: "5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46" },
	{ path: "onnx/decoder_model_merged_quantized.onnx", size: 53693315, sha256: "fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b" },
];
export const SPEECH_BYTES = SPEECH_FILES.reduce((n, f) => n + f.size, 0);
