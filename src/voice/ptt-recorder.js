// No visible UI, networking, paths or app-edit bridge. One bounded 16 kHz recording at a time.
let current;
const PROCESSOR = `class Capture extends AudioWorkletProcessor { process(inputs) { const source=inputs[0]?.[0]; if(source){const copy=new Float32Array(source);this.port.postMessage(copy,[copy.buffer]);} return true; }} registerProcessor('midnight-ptt',Capture);`;
async function dispose(ctx) {
	ctx.cancelled = true; ctx.stream?.getTracks().forEach(track => track.stop());
	ctx.source?.disconnect(); ctx.node?.disconnect(); ctx.gain?.disconnect(); await ctx.audio?.close().catch(() => {});
}
recorder.on(async command => {
	if (command.op === "begin") {
		const ctx = { id: command.id, chunks: [], size: 0, cancelled: false }; current = ctx;
		try {
			ctx.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
			if (current !== ctx || ctx.cancelled) { await dispose(ctx); return; }
			ctx.audio = new AudioContext({ sampleRate: 16000 });
			if (ctx.audio.sampleRate !== 16000) throw new Error("The recorder could not provide 16 kHz audio.");
			const url = URL.createObjectURL(new Blob([PROCESSOR], { type: "text/javascript" }));
			try { await ctx.audio.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
			if (current !== ctx || ctx.cancelled) { await dispose(ctx); return; }
			ctx.node = new AudioWorkletNode(ctx.audio, "midnight-ptt"); ctx.source = ctx.audio.createMediaStreamSource(ctx.stream);
			const firstChunk = new Promise(resolve => { ctx.firstChunk = resolve; });
			ctx.node.port.onmessage = event => {
				if (current !== ctx || ctx.cancelled || !(event.data instanceof Float32Array)) return;
				if (ctx.size + event.data.length > 480000) { current = undefined; void dispose(ctx); ctx.chunks.forEach(chunk => chunk.fill(0)); ctx.chunks = []; recorder.reply({ id: ctx.id, kind: "failed", error: "Recording reached its 30-second limit." }); return; }
				ctx.chunks.push(event.data); ctx.size += event.data.length;
				ctx.firstChunk?.(); ctx.firstChunk = undefined;
			};
			// The processor's output remains zero; a zero-gain downstream node can stop Chromium pulling input.
			ctx.source.connect(ctx.node).connect(ctx.audio.destination); await ctx.audio.resume(); await firstChunk;
			if (current !== ctx || ctx.cancelled) { await dispose(ctx); return; }
			recorder.reply({ id: ctx.id, kind: "started", sampleRate: 16000 });
		} catch (error) { if (current === ctx) { current = undefined; await dispose(ctx); recorder.reply({ id: ctx.id, kind: "failed", error: String(error.message).slice(0, 300) }); } }
	} else if (command.op === "end") {
		const ctx = current; if (!ctx || ctx.id !== command.id) return; current = undefined;
		await dispose(ctx); const samples = new Float32Array(ctx.size); let offset = 0;
		for (const chunk of ctx.chunks) { samples.set(chunk, offset); offset += chunk.length; chunk.fill(0); } ctx.chunks = [];
		recorder.reply({ id: ctx.id, kind: "ended", sampleRate: 16000, samples }); samples.fill(0);
	}
});
