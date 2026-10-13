// midnight as an MCP server, for Windows' agent connectors and any other MCP client on this computer. Clients reach
// it through midnight-mcp.exe (a stdio bridge) over a named pipe that only answers after the bridge presents the
// token midnight keeps in its own app-data folder. Off until the user turns it on in Settings.
//   search_files  read-only search of the folders the user selected (the local index)
//   start_task    a new mission in "Ask me" mode: midnight still asks in its own window before anything but reading
//   get_task      a mission's status, answer and what it is waiting for
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const MCP_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const TERMINAL = new Set(["succeeded", "partially-succeeded", "failed", "cancelled"]);

export const pipePath = (user = os.userInfo().username) => (process.platform === "win32" ? `\\\\.\\pipe\\midnight-mcp-${user.replace(/[^\w.-]/g, "_")}` : path.join(os.tmpdir(), `midnight-mcp-${user.replace(/[^\w.-]/g, "_")}.sock`));

export const TOOLS = [
	{
		name: "search_files",
		title: "Search my files with midnight",
		description: "Search the folders the user chose in midnight, by meaning and exact words (documents, PDFs, pictures, audio and video moments). Returns file paths, locations and short excerpts. Read-only.",
		inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 500 }, kind: { type: "string", enum: ["all", "document", "image", "audio", "video"] }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"] },
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	{
		name: "start_task",
		title: "Give midnight a task",
		description: "Start a task in midnight on this computer. midnight plans it and shows it in its own window; anything beyond reading (saving, sending, submitting, using the screen) waits for the user's approval there. Returns a task id for get_task.",
		inputSchema: { type: "object", properties: { request: { type: "string", minLength: 1, maxLength: 8000 } }, required: ["request"] },
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	},
	{
		name: "get_task",
		title: "Check a midnight task",
		description: "The status of a task started with start_task: working, waiting for the user's approval or answer, or finished with its answer.",
		inputSchema: { type: "object", properties: { taskId: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,80}$" } }, required: ["taskId"] },
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
];

const text = (t) => ({ content: [{ type: "text", text: t }] });

/**
 * JSON-RPC handling for one client. `host(method, params)` calls the engine; `onTask` lets the shell show a mission
 * that an outside app started.
 */
export function mcpSession({ host, onTask = () => {}, version = "0.4", client = "an app" }) {
	let clientName = client;
	const tools = {
		async search_files(a) {
			const r = await host("files.search", { query: String(a.query).slice(0, 500), kind: a.kind && a.kind !== "all" ? a.kind : undefined, limit: Math.min(20, Math.max(1, a.limit ?? 8)) });
			if (!r.results?.length) return text(r.warning ? `No matches. ${r.warning}` : "No matches in the folders the user chose in midnight.");
			return text(r.results.map((h, i) => `${i + 1}. ${h.path}${h.locator?.page ? ` (page ${h.locator.page})` : h.locator?.seconds !== undefined ? ` (at ${Math.round(h.locator.seconds)}s)` : ""} · ${h.match}\n${String(h.text ?? "").replace(/\s+/g, " ").slice(0, 300)}`).join("\n\n"));
		},
		async start_task(a) {
			const r = await host("mission.create", { text: `${String(a.request).slice(0, 8000)}\n\n[Requested by ${clientName} through midnight's MCP connector.]`, requestId: `mcp_${randomBytes(8).toString("hex")}`, mode: "ask" });
			onTask(r.missionId, clientName);
			return text(`Task ${r.missionId} started in midnight. It will ask the user in its window before doing anything beyond reading. Check it with get_task.`);
		},
		async get_task(a) {
			const { mission: m } = await host("query.mission", { missionId: a.taskId });
			if (!m) return text("No such task.");
			const waiting = m.status === "waiting-approval" ? ` Waiting for the user to approve: ${(m.approvals ?? []).map((x) => x.display?.title).filter(Boolean).join("; ")}.` : m.status === "waiting-input" ? ` Waiting for the user's answer: ${m.waiting?.question?.prompt ?? ""}` : "";
			return text(`Task ${m.id}: ${m.status}.${waiting}${TERMINAL.has(m.status) && m.answer ? `\n\n${m.answer}` : ""}${m.outcome?.summary ? `\n\n(${m.outcome.summary})` : ""}`);
		},
	};
	return async function handle(msg) {
		if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return msg?.id !== undefined ? { jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "invalid request" } } : undefined;
		if (msg.id === undefined) return undefined; // notifications (initialized, cancelled)
		const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
		const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
		switch (msg.method) {
			case "initialize": {
				clientName = String(msg.params?.clientInfo?.name ?? client).slice(0, 60);
				const want = msg.params?.protocolVersion;
				return ok({ protocolVersion: MCP_PROTOCOLS.includes(want) ? want : MCP_PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "midnight", title: "midnight", version }, instructions: "midnight works on this computer for the user. Tasks that change anything wait for the user's approval in midnight." });
			}
			case "ping":
				return ok({});
			case "tools/list":
				return ok({ tools: TOOLS });
			case "tools/call": {
				const fn = tools[msg.params?.name];
				if (!fn) return fail(-32602, `unknown tool ${String(msg.params?.name).slice(0, 60)}`);
				try {
					return ok(await fn(msg.params.arguments ?? {}));
				} catch (err) {
					return ok({ isError: true, content: [{ type: "text", text: String(err?.message ?? err).slice(0, 500) }] });
				}
			}
			default:
				return fail(-32601, `method not found: ${msg.method.slice(0, 60)}`);
		}
	};
}

/** The token file the bridge reads; created with a fresh secret when the server is turned on. */
export function ensureToken(file) {
	try {
		const t = fs.readFileSync(file, "utf8").trim();
		if (/^[0-9a-f]{64}$/.test(t)) return t;
	} catch {}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const t = randomBytes(32).toString("hex");
	fs.writeFileSync(file, t, { mode: 0o600 });
	return t;
}

/** Listen on the pipe. Each connection's first line must be {"token": "..."}; then JSON-RPC lines both ways. */
export function startMcpServer({ host, tokenFile, pipe = pipePath(), onTask, version, log = () => {} }) {
	const token = Buffer.from(ensureToken(tokenFile));
	const server = net.createServer((socket) => {
		let authed = false;
		let buf = "";
		const handle = mcpSession({ host, onTask, version });
		const send = (m) => m && socket.write(`${JSON.stringify(m)}\n`);
		const timer = setTimeout(() => !authed && socket.destroy(), 5000);
		socket.setEncoding("utf8");
		socket.on("error", () => {});
		socket.on("data", async (chunk) => {
			buf += chunk;
			if (buf.length > 1_000_000) return socket.destroy();
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i).trim();
				buf = buf.slice(i + 1);
				if (!line) continue;
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					if (!authed) return socket.destroy();
					send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
					continue;
				}
				if (!authed) {
					const given = Buffer.from(String(msg.token ?? ""));
					if (given.length !== token.length || !timingSafeEqual(given, token)) {
						log("mcp server", "rejected a connection without the token");
						return socket.destroy();
					}
					authed = true;
					clearTimeout(timer);
					continue;
				}
				send(await handle(msg));
			}
		});
	});
	if (process.platform !== "win32") fs.rmSync(pipe, { force: true });
	server.listen(pipe);
	return { pipe, close: () => new Promise((r) => server.close(() => r())) };
}
