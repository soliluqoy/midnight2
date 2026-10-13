// Skill packs and recipes (plan ch. 12, K02). A skill is a reviewed, versioned workflow manifest: purpose, inputs,
// outputs, capabilities, tools, network destinations and checks. Loading a skill adds guidance; it never grants
// permission or runs install scripts. A recipe captured from a verified mission is a parameterized template the user
// reviews; every run still rechecks files, accounts, grants and schemas through the broker.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECK_KINDS, EFFECTS } from "../contracts/domain.mjs";
import { newId } from "../contracts/events.mjs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { stableStringify } from "../policy/canonical.mjs";
import { json } from "../storage/db.mjs";

const PACKS = fileURLToPath(new URL("./packs/", import.meta.url));
const FIELDS = ["id", "version", "title", "purpose", "capabilities", "tools", "prompt"];

export function validateSkill(m, toolNames) {
	const issues = [];
	for (const f of FIELDS) if (m[f] === undefined) issues.push(`missing ${f}`);
	if (!/^[a-z0-9-]+$/.test(m.id ?? "")) issues.push("id must be lowercase letters, digits and dashes");
	for (const c of m.capabilities ?? []) if (!EFFECTS[c]) issues.push(`unknown capability ${c}`);
	for (const t of m.tools ?? []) if (toolNames && !toolNames.has(t)) issues.push(`unknown tool ${t}`);
	for (const c of m.checks ?? []) if (!CHECK_KINDS[c.kind]) issues.push(`unknown check ${c.kind}`);
	for (const k of ["grants", "install", "postinstall", "scripts", "exec"]) if (k in m) issues.push(`${k} is not allowed in a skill`);
	return issues;
}

export function createSkills({ toolNames, dir = PACKS }) {
	const skills = new Map();
	const rejected = [];
	for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
		if (!f.endsWith(".json")) continue;
		try {
			const m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
			const issues = validateSkill(m, toolNames);
			if (issues.length) rejected.push({ file: f, issues });
			else skills.set(m.id, Object.freeze({ ...m, file: f }));
		} catch (err) {
			rejected.push({ file: f, issues: [err.message] });
		}
	}
	return {
		get: (id) => skills.get(id),
		list: () => [...skills.values()].map(({ prompt, ...rest }) => rest),
		rejected: () => rejected,
		/** Best skill for a request by simple keyword match (a hint the user can override). */
		suggest(text) {
			const t = text.toLowerCase();
			if (/\b(sales|revenue|quarter|q[1-4])\b/.test(t) && /\b(brief|chart|report|compare)\b/.test(t)) return "sales-brief";
			if (/\b(tidy|organi[sz]e|clean up)\b/.test(t) && /\b(folder|downloads|files)\b/.test(t)) return "file-organizer";
			if (/\b(meeting|agenda)\b/.test(t) && /\b(brief|pack|prep)/.test(t)) return "meeting-prep";
			return undefined;
		},
	};
}

// A routine shared as a file: the reviewable template only (never the source mission, its data or any authority).
export const ROUTINE_FORMAT = "midnight.routine";
const RoutineFile = Type.Object({
	format: Type.Literal(ROUTINE_FORMAT),
	version: Type.Literal(1),
	label: Type.String({ minLength: 1, maxLength: 120 }),
	exportedAt: Type.Optional(Type.String({ maxLength: 40 })),
	app: Type.Optional(Type.String({ maxLength: 60 })),
	digest: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
	template: Type.Object({
		goal: Type.String({ minLength: 1, maxLength: 20000 }),
		skill: Type.Optional(Type.Union([Type.String({ maxLength: 80 }), Type.Null()])),
		mode: Type.Optional(Type.String({ maxLength: 20 })),
		privacy: Type.Optional(Type.Union(["cloud", "local", "offline"].map((p) => Type.Literal(p)))),
		checks: Type.Array(Type.Object({ id: Type.Optional(Type.String({ maxLength: 40 })), kind: Type.String({ maxLength: 40 }), label: Type.String({ maxLength: 300 }), params: Type.Optional(Type.Record(Type.String({ maxLength: 60 }), Type.Unknown())), required: Type.Optional(Type.Boolean()) }), { maxItems: 20 }),
		tools: Type.Array(Type.String({ maxLength: 80 }), { maxItems: 60 }),
		effects: Type.Array(Type.String({ maxLength: 40 }), { maxItems: 30 }),
		artifacts: Type.Array(Type.Object({ name: Type.String({ maxLength: 200 }), type: Type.Optional(Type.String({ maxLength: 40 })) }), { maxItems: 30 }),
	}),
});
const routineDigest = (r) => `sha256:${createHash("sha256").update(stableStringify({ format: r.format, version: r.version, label: r.label, template: r.template })).digest("hex")}`;

export function createRecipes({ store, repo, ledger, evidence, coord, skills, version = "midnight" }) {
	const row = (r) => r && { id: r.id, label: r.label, version: r.version, sourceMission: r.source_mission, template: json(r.template, {}), reviewed: !!r.reviewed, createdAt: r.created_at };
	return {
		/** Capture a verified mission as a reviewable recipe (never coordinates or raw clicks). */
		capture(missionId, label) {
			const m = repo.get(missionId);
			if (!m) throw new Error("no such mission");
			if (m.status !== "succeeded") return { ok: false, error: "Only a mission whose checks all passed can become a recipe." };
			const plan = repo.plan(missionId);
			const intents = ledger.forMission(missionId);
			if (intents.some((i) => i.effect.startsWith("desktop."))) return { ok: false, error: "Missions that used the screen cannot become recipes; screen steps are not reliably repeatable." };
			const template = {
				goal: m.goal,
				skill: m.skill,
				mode: m.mode,
				privacy: m.privacy,
				checks: plan?.checks ?? [],
				tools: [...new Set(intents.filter((i) => i.state === "verified").map((i) => i.tool))],
				effects: [...new Set(intents.filter((i) => i.state === "verified").map((i) => i.effect))],
				artifacts: evidence.artifacts(missionId).map((a) => ({ name: a.name, type: a.type })),
			};
			const id = newId("rcp");
			store.run("INSERT INTO recipes (id, label, source_mission, template, created_at) VALUES (?, ?, ?, ?, ?)", id, label.slice(0, 120), missionId, JSON.stringify(template), new Date().toISOString());
			return { ok: true, recipe: row(store.get("SELECT * FROM recipes WHERE id = ?", id)), review: "Review the steps and effects before scheduling it; it will still ask before anything not covered by a rule." };
		},
		list: () => store.all("SELECT * FROM recipes ORDER BY created_at DESC").map(row),
		get: (id) => row(store.get("SELECT * FROM recipes WHERE id = ?", id)),
		markReviewed: (id) => store.run("UPDATE recipes SET reviewed = 1 WHERE id = ?", id).changes > 0,
		/** A shareable file for a routine: its template and label, with a digest that detects edits in transit. */
		exportFile(id) {
			const r = row(store.get("SELECT * FROM recipes WHERE id = ?", id));
			if (!r) throw new Error("no such routine");
			const file = { format: ROUTINE_FORMAT, version: 1, label: r.label, exportedAt: new Date().toISOString(), app: version, template: r.template };
			return { ...file, digest: routineDigest(file) };
		},
		/**
		 * Add a routine from a file. It arrives unreviewed and in "Ask me" mode whatever the file says, so a shared
		 * routine never gains autonomy or runs before the user has read it; unknown skills are dropped.
		 */
		importFile(data) {
			if (!Value.Check(RoutineFile, data)) {
				const first = [...Value.Errors(RoutineFile, data)][0];
				throw new Error(`This is not a valid midnight routine (${first?.instancePath || "file"} ${first?.message ?? ""}).`.replace(/ \)/, ")"));
			}
			if (routineDigest(data) !== data.digest) throw new Error("This routine file was changed after it was exported; it was not imported.");
			const t = data.template;
			const template = { ...t, mode: "ask", skill: t.skill && skills?.get?.(t.skill) ? t.skill : undefined, privacy: t.privacy ?? "cloud" };
			const id = newId("rcp");
			store.run("INSERT INTO recipes (id, label, source_mission, template, reviewed, created_at) VALUES (?, ?, NULL, ?, 0, ?)", id, data.label.slice(0, 120), JSON.stringify(template), new Date().toISOString());
			return { ok: true, recipe: row(store.get("SELECT * FROM recipes WHERE id = ?", id)), droppedSkill: t.skill && !template.skill ? t.skill : undefined };
		},
		run(id, { requestId }) {
			const r = row(store.get("SELECT * FROM recipes WHERE id = ?", id));
			if (!r?.reviewed) throw new Error("review this recipe before running it");
			return coord().createMission({ text: r.template.goal, requestId, skill: r.template.skill, mode: r.template.mode, privacy: r.template.privacy, trigger: { kind: "routine", recipeId: id }, title: r.label });
		},
	};
}
