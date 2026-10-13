// Fixed typed protocol to an owned STA helper. This bridge never invokes arbitrary COM, VBA or shell code.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const WORD_HELPER = fileURLToPath(new URL("./native/midnight-word.exe", import.meta.url)).replace(/app\.asar([\\/])/, "app.asar.unpacked$1");

export function createWordBroker({ helper = WORD_HELPER, spawnImpl = spawn, platform = process.platform, timeoutMs = 15_000 } = {}) {
	let child, sequence = 0, buffer = "", identity, closed = false;
	const pending = new Map();
	function stop(reason = new Error("The Word connection stopped. Select the original target again.")) {
		const old = child; child = undefined; buffer = ""; identity = undefined;
		for (const request of pending.values()) {
			clearTimeout(request.timer); request.signal?.removeEventListener("abort", request.cancel);
			request.reject(request.mutating ? Object.assign(new Error("Word may have applied the edit. Reconcile its outcome before retrying."), { code: "EDIT_UNKNOWN", uncertain: true }) : reason);
		}
		pending.clear(); old?.kill();
	}
	function start() {
		if (closed) throw new Error("The Word connector is closed.");
		if (platform !== "win32" || !fs.existsSync(helper)) throw new Error("Word selection is unavailable in this copy of Midnight.");
		if (child) return child;
		identity = { id: "word", api: 1, artifact: `sha256:${createHash("sha256").update(fs.readFileSync(helper)).digest("hex")}` };
		const process = child = spawnImpl(helper, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		process.stdout.setEncoding("utf8");
		process.stdout.on("data", chunk => {
			if (child !== process) return;
			buffer += chunk;
			if (Buffer.byteLength(buffer, "utf8") > 131072) return stop(new Error("The Word connector returned too much data."));
			let newline;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
				if (!line) continue;
				let result;
				try { result = JSON.parse(line); } catch { return stop(new Error("The Word connector returned an invalid response.")); }
				const request = pending.get(result.id);
				if (!request) continue;
				pending.delete(result.id); clearTimeout(request.timer); request.signal?.removeEventListener("abort", request.cancel);
				result.ok ? request.resolve(result.result) : request.reject(Object.assign(new Error(result.error), { code: result.code, uncertain: !!result.uncertain }));
			}
		});
		process.stdin.on("error", err => { if (child === process) stop(err); });
		process.stderr.on("data", () => {}); // Never copy document diagnostics into a generic log.
		process.on("error", err => { if (child === process) stop(err); });
		process.on("exit", () => { if (child === process) stop(); });
		return process;
	}
	function request(op, params = {}, { signal } = {}) {
		if (!["status", "capture", "inspect", "release", "apply", "receipt"].includes(op)) return Promise.reject(new Error("Unsupported Word operation."));
		if (signal?.aborted) return Promise.reject(signal.reason);
		let process;
		try { process = start(); } catch (err) { return Promise.reject(err); }
		const connector = { ...identity };
		if (op === "apply" && (params.connector?.id !== connector.id || params.connector?.api !== connector.api || params.connector?.artifact !== connector.artifact)) return Promise.reject(Object.assign(new Error("The original Word connector changed. Select the target again."), { code: "TARGET_CONFLICT", uncertain: false }));
		return new Promise((resolve, reject) => {
			const id = ++sequence;
			const cancel = () => {
				if (op === "apply") reject(Object.assign(new Error("Word may have applied the edit. Reconcile its outcome before retrying."), { code: "EDIT_UNKNOWN", uncertain: true }));
				else stop(signal.reason ?? new Error("Word capture cancelled."));
			};
			const timer = setTimeout(() => stop(Object.assign(new Error("Word is busy or not responding."), { code: "TIMEOUT" })), timeoutMs);
			const answer = value => {
				if (op === "capture" || op === "inspect") resolve({ ...value, connector });
				else if (op === "apply") resolve({ ...value, snapshot: { ...value.snapshot, connector } });
				else if (op === "receipt" && value.found) resolve({ ...value, result: { ...value.result, snapshot: { ...value.result.snapshot, connector } } });
				else resolve(value);
			};
			pending.set(id, { resolve: answer, reject, timer, signal, cancel, mutating: op === "apply" });
			signal?.addEventListener("abort", cancel, { once: true });
			process.stdin.write(`${JSON.stringify({ id, op, ...params, connector: undefined })}\n`);
		});
	}
	return {
		status: options => request("status", {}, options),
		capture: (options = {}) => {
			const { expectedWindowId, expectedProcessId } = options;
			if (expectedWindowId !== undefined && (!/^[1-9][0-9]{0,18}$/.test(expectedWindowId) || !Number.isSafeInteger(expectedProcessId) || expectedProcessId <= 0)) return Promise.reject(new Error("Invalid original foreground identity."));
			return request("capture", expectedWindowId === undefined ? {} : { expectedWindowId, expectedProcessId }, options);
		},
		inspect: (handle, options) => request("inspect", { handle }, options),
		receipt: (editId, options) => request("receipt", { editId }, options),
		apply: (command, options) => {
			if (!command || !["paragraph.replace", "chart.setType", "chart.restoreType"].includes(command.operation) || typeof command.handle !== "string" || typeof command.editId !== "string" || !command.expected || typeof command.expected !== "object") return Promise.reject(new Error("Invalid typed Word edit."));
			const { handle, editId, operation, expected, text, chartType, connector } = command;
			return request("apply", { handle, editId, operation, expected, text, chartType, connector }, options);
		},
		release: handle => request("release", { handle }),
		reset() { stop(); },
		close() { closed = true; stop(); },
	};
}
