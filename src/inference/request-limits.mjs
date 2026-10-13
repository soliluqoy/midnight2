// Local compute admission and cloud request limits are separate. This boundary caps provider calls and
// output for one quick edit, and forwards the caller/deadline cancellation to the actual transport.
export function boundedStream(streamFunction, { signal, maxCalls = 1, maxTokens = 2048 } = {}) {
	let calls = 0;
	return (model, context, options = {}) => {
		const combined = signal ? (options.signal ? AbortSignal.any([signal, options.signal]) : signal) : options.signal;
		combined?.throwIfAborted();
		if (++calls > maxCalls) throw new Error("This quick-edit request already used its provider-call budget.");
		const requested = Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? Math.min(options.maxTokens, maxTokens) : maxTokens;
		return streamFunction(model, context, { ...options, signal: combined, maxTokens: requested });
	};
}
