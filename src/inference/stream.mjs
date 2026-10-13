// Lease just the provider stream, not the agent's tool loop: a tool can request an embedding without
// deadlocking behind the model that requested that tool. The provider result marks actual stream completion.
export function admittedStream(streamFunction, arbiter, options) {
	return async (model, context, streamOptions = {}) => {
		const signal = options.signal && streamOptions.signal ? AbortSignal.any([options.signal, streamOptions.signal]) : options.signal ?? streamOptions.signal;
		const lease = await arbiter.acquire({ ...options, signal, role: "text" });
		try {
			lease.signal.throwIfAborted();
			const stream = await streamFunction(model, context, { ...streamOptions, signal: lease.signal });
			if (typeof stream?.result !== "function") throw new Error("The local provider did not return a completion-aware stream.");
			Promise.resolve(stream.result()).then(() => lease.release(), () => lease.release());
			return stream;
		} catch (err) { lease.release(); throw err; }
	};
}
