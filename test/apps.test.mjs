import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAppRegistry, websiteUrl, appPartition } from "../src/apps/registry.mjs";
import { validateRequest } from "../src/contracts/ipc.mjs";
import { tempDir } from "./helpers.mjs";
import { fauxAssistantMessage, fauxText, makeModel, startHost, settled } from "./e2e-helpers.mjs";

test("saved apps isolate duplicate websites and retain profiles through unpinning and restart", () => {
	const file = path.join(tempDir("apps"), "apps.json"), registry = createAppRegistry(file);
	const work = registry.add({ url: "example.com", profile: "Work" });
	const personal = registry.add({ url: "https://example.com", profile: "Personal" });
	assert.notEqual(appPartition(work.id), appPartition(personal.id));
	registry.update(work.id, { pinned: false, name: "Team" }); registry.opened(work.id);
	const loaded = createAppRegistry(file);
	assert.equal(loaded.get(work.id).pinned, false);
	assert.equal(loaded.get(work.id).name, "Team");
	assert.equal(loaded.get(work.id).url, "https://example.com/");
	assert.ok(loaded.get(work.id).lastOpenedAt);
	loaded.remove(work.id);
	assert.equal(createAppRegistry(file).list().length, 1);
	assert.equal(createAppRegistry(file).get(personal.id).profile, "Personal");
});

test("app addresses reject privileged protocols and credentials; corrupt profiles are not overwritten", () => {
	for (const url of ["javascript:alert(1)", "file:///C:/secrets", "data:text/html,hi", "https://name:password@example.com", "", "https://"]) assert.throws(() => websiteUrl(url));
	assert.throws(() => appPartition("../../profile"));
	const file = path.join(tempDir("apps-corrupt"), "apps.json"); fs.writeFileSync(file, "broken");
	assert.throws(() => createAppRegistry(file), /Could not read saved apps/);
	assert.equal(fs.readFileSync(file, "utf8"), "broken");
});

test("app IPC cannot inject page content, profile paths or host mission scope", () => {
	const req = (method, params) => validateRequest({ v: 1, seq: 1, method, params });
	assert.equal(req("apps.add", { url: "https://example.com", partition: "persist:midnight-browser" }).ok, false);
	assert.equal(req("apps.ask", { id: "a", text: "Hi", scope: "page", requestId: "req", page: { text: "forged" } }).ok, false);
	assert.equal(req("mission.pageAssist", {}).ok, false);
	assert.equal(req("mission.create", { text: "hi", requestId: "req", scope: { pageAssistant: false } }).ok, false);
});

test("page assistance records its actual source, stays in task history, and cannot escape into tools", async () => {
	const model = await makeModel(), { host, platform } = await startHost({ model });
	try {
		const page = { appId: "app_12345678-1234-1234-1234-123456789012", appName: "Tracker", profile: "Work", url: "https://example.com/issue/42", title: "Issue 42", text: "The export button is broken.", scope: "page", capturedAt: new Date().toISOString() };
		model.faux.setResponses([fauxAssistantMessage([fauxText("The export button is broken. [Issue 42](https://example.com/issue/42)")])]);
		const created = await host.handle("mission.pageAssist", { page, text: "Summarize this issue", requestId: "page-1" });
		await settled(host, created.missionId);
		const m = host.repo.get(created.missionId);
		assert.equal(m.scope.pageAssistant.appId, page.appId);
		assert.deepEqual(host.tools.forMission(m, host.settings()), []);
		assert.equal(host.viewOf(m.id).status, "succeeded");
		assert.equal(host.evidence.list(m.id)[0].source, page.url);
		assert.equal(host.snapshot().missions[m.id].trigger.appId, page.appId);
		for (const toolName of ["browser", "computer", "mail_send", "files_read", "unknown_mcp_tool"]) {
			const blocked = await host.broker.gate({ missionId: m.id, runId: "x", toolCallId: toolName, toolName, input: {} });
			assert.equal(blocked.block, true); assert.match(blocked.reason, /only answer or draft/);
		}
		assert.equal(platform.calls.length, 0);
		await assert.rejects(host.handle("mission.pageAssist", { page: { ...page, appId: "app_87654321-1234-1234-1234-123456789012" }, missionId: m.id, text: "Follow up", requestId: "wrong-app" }), /another app/);
		await assert.rejects(host.handle("mission.pageAssist", { page: { ...page, appId: "app_87654321-1234-1234-1234-123456789012" }, text: "Follow up", requestId: "page-1" }), /another app/);
		model.faux.setResponses([fauxAssistantMessage([fauxText("Here is a draft you can copy: Thanks for reporting this.")])]);
		const follow = await host.handle("mission.pageAssist", { page, missionId: m.id, text: "Draft a response", requestId: "page-2" });
		assert.equal(follow.missionId, m.id);
		await settled(host, m.id);
		const duplicate = await host.handle("mission.pageAssist", { page, missionId: m.id, text: "Draft a response", requestId: "page-2" });
		assert.equal(duplicate.duplicate, true);
		assert.equal(host.repo.runs(m.id).length, 2);
		assert.deepEqual(host.tools.forMission(host.repo.get(m.id), host.settings()), []);
		host.setSettings({ privacy: "local" });
		await assert.rejects(host.handle("mission.pageAssist", { page, missionId: m.id, text: "Keep this local", requestId: "privacy-changed" }), /privacy setting changed/);
		assert.equal(host.repo.runs(m.id).length, 2, "changing privacy cannot accidentally send another turn to the old cloud conversation");
	} finally { await host.close(); }
});
