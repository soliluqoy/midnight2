import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { startMcpServer, TOOLS } from "../src/desktop/mcp-server.mjs";
import { buildNative } from "../scripts/build-native.mjs";
import { tempDir } from "./helpers.mjs";

function fakeHost() {
	const calls = [];
	const host = async (method, params) => {
		calls.push({ method, params });
		if (method === "files.search") return { results: [{ path: "C:/Docs/Q3 budget.pdf", locator: { page: 3 }, match: "both", text: "The Q3 budget allocates funding to the East region." }] };
		if (method === "mission.create") return { missionId: "msn_42" };
		if (method === "query.mission") return { mission: { id: params.missionId, status: "waiting-approval", approvals: [{ display: { title: "Send “Q3 brief” to Sam" } }] } };
		throw new Error(`unexpected ${method}`);
	};
	return { host, calls };
}
const unique = () => `midnight-mcp-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const pipeOf = (name) => (process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(tempDir("pipe"), `${name}.sock`));

function connect(pipe) {
	const socket = net.connect(pipe);
	socket.setEncoding("utf8");
	let buf = "";
	const waiting = [];
	socket.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			waiting.shift()?.(JSON.parse(line));
		}
	});
	return {
		socket,
		send: (m) => socket.write(`${JSON.stringify(m)}\n`),
		next: () => new Promise((r) => waiting.push(r)),
		closed: () => new Promise((r) => socket.once("close", r)),
	};
}

test("midnight's MCP server needs the token, then answers MCP: tools that read, and tasks that still ask the user", async () => {
	const dir = tempDir("mcp-server");
	const { host, calls } = fakeHost();
	const tasks = [];
	const server = startMcpServer({ host, tokenFile: path.join(dir, "mcp-token"), pipe: pipeOf(unique()), onTask: (id, client) => tasks.push([id, client]) });
	try {
		const token = fs.readFileSync(path.join(dir, "mcp-token"), "utf8");
		assert.match(token, /^[0-9a-f]{64}$/);
		const stranger = connect(server.pipe);
		stranger.send({ token: "0".repeat(64) });
		stranger.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		await stranger.closed();
		assert.equal(calls.length, 0, "a client without the token gets nothing");

		const c = connect(server.pipe);
		c.send({ token });
		c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "Windows Copilot" }, capabilities: {} } });
		const init = await c.next();
		assert.equal(init.result.protocolVersion, "2025-06-18");
		assert.equal(init.result.serverInfo.name, "midnight");
		c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		c.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		const list = await c.next();
		assert.deepEqual(list.result.tools.map((t) => [t.name, t.annotations.readOnlyHint]), [["search_files", true], ["start_task", false], ["get_task", true]]);
		c.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_files", arguments: { query: "east budget" } } });
		assert.match((await c.next()).result.content[0].text, /Q3 budget\.pdf \(page 3\)/);
		c.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "start_task", arguments: { request: "Email Sam the Q3 brief" } } });
		assert.match((await c.next()).result.content[0].text, /Task msn_42 started/);
		const create = calls.find((x) => x.method === "mission.create").params;
		assert.equal(create.mode, "ask", "outside apps can only start tasks that ask");
		assert.match(create.text, /\[Requested by Windows Copilot through midnight's MCP connector\.\]/);
		assert.deepEqual(tasks, [["msn_42", "Windows Copilot"]]);
		c.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_task", arguments: { taskId: "msn_42" } } });
		assert.match((await c.next()).result.content[0].text, /waiting-approval\. Waiting for the user to approve: Send “Q3 brief” to Sam/);
		c.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "delete_everything", arguments: {} } });
		assert.equal((await c.next()).error.code, -32602);
		c.socket.destroy();
	} finally {
		await server.close();
	}
	assert.equal(TOOLS.length, 3);
});

test("MCP clients reach midnight through midnight-mcp.exe (stdio bridge) with a standard MCP client", { skip: process.platform !== "win32" }, async () => {
	buildNative({ quiet: true });
	const dir = tempDir("mcp-bridge");
	const name = unique();
	const { host } = fakeHost();
	const server = startMcpServer({ host, tokenFile: path.join(dir, "mcp-token"), pipe: pipeOf(name) });
	const client = new McpClient({ name: "test-client", version: "1.0.0" });
	try {
		const bridge = new URL("../src/desktop/native/midnight-mcp.exe", import.meta.url);
		await client.connect(new StdioTransport({ command: path.resolve(new URL(bridge).pathname.replace(/^\/([a-z]:)/i, "$1")), env: { MIDNIGHT_MCP_PIPE: name, MIDNIGHT_MCP_TOKEN_FILE: path.join(dir, "mcp-token"), SYSTEMROOT: process.env.SYSTEMROOT ?? "", APPDATA: dir }, inheritEnv: false }));
		assert.equal(client.serverInfo.name, "midnight");
		assert.deepEqual((await client.listTools()).map((t) => t.name), ["search_files", "start_task", "get_task"]);
		const r = await client.callTool("search_files", { query: "budget" });
		assert.match(r.content[0].text, /Q3 budget\.pdf/);
	} finally {
		await client.close().catch(() => {});
		await server.close();
	}
	const manifest = JSON.parse(fs.readFileSync(new URL("../src/desktop/native/manifest.json", import.meta.url), "utf8"));
	assert.equal(manifest.manifest_version, "0.3");
	assert.equal(manifest.version, JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, "the MCPB manifest version follows the app");
	assert.equal(manifest.server.mcp_config.command, "${__dirname}/midnight-mcp");
	assert.deepEqual(manifest.tools.map((t) => t.name), TOOLS.map((t) => t.name));
});
