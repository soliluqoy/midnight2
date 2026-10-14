import assert from "node:assert/strict";
import test from "node:test";
import { discoverTestFiles, selectTestFiles } from "../scripts/test-suites.mjs";

const files = discoverTestFiles();

test("development suites partition every discovered test file without overlap", () => {
	const unit = selectTestFiles("unit", files), integration = selectTestFiles("integration", files);
	assert.equal(unit.some(file => integration.includes(file)), false);
	assert.deepEqual([...unit, ...integration].sort(), files);
	assert.ok(unit.includes("test/test-suites.test.mjs"));
	for (const name of ["e2e", "architecture", "desktop", "ptt-hotkey", "selected-target"]) assert.ok(integration.includes(`test/${name}.test.mjs`));
});

test("new and nested test files default to integration instead of losing coverage", () => {
	const added = "test/future/nested.test.mjs", expanded = [...files, added];
	assert.ok(selectTestFiles("integration", expanded).includes(added));
	assert.equal(selectTestFiles("unit", expanded).includes(added), false);
});

test("unknown suites and stale unit entries fail rather than silently running a partial suite", () => {
	assert.throws(() => selectTestFiles("typo", files), /Expected suite/);
	assert.throws(() => selectTestFiles("unit", files.filter(file => file !== "test/capture-epoch.test.mjs")), /missing test\/capture-epoch/);
	assert.throws(() => selectTestFiles("integration", []), /missing/);
});
