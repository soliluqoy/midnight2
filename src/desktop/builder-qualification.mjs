// Fixed, opt-in synthetic qualification through the same engine/platform/utility-process path as Settings.
// This routine has no arbitrary script, document, file or publication input.
import assert from "node:assert/strict";

export async function qualifyBuilder({ request, settings, emit = () => {}, jobTimeoutMs = 120_000 }) {
	assert.equal(process.env.MIDNIGHT_TEST_CLOUD, "1", "Real builder qualification requires an explicit cloud opt-in.");
	assert.equal(settings.privacy, "cloud");
	assert.ok(settings.provider && settings.model);
	const checks = [], jobs = [], initialTheme = await request("theme.current", {});
	const check = (name, value) => { assert.ok(value, name); checks.push(name); emit(`PASS ${name}`); };
	async function build(pluginId, scope, text) {
		const started = Date.now(), created = await request("builder.request", { pluginId, scope, text });
		emit(`START ${scope} ${pluginId}`);
		try {
			for (;;) {
				const job = await request("builder.get", { jobId: created.id });
				if (["preview-ready", "proposed"].includes(job.status)) {
					check(`${scope} ${pluginId} changed and passed host validation`, job.candidate?.digest !== job.base.digest && job.validation?.checked > 0);
					jobs.push({ id: job.id, pluginId, scope, elapsedMs: Date.now() - started, candidate: job.candidate, base: job.base });
					return job;
				}
				if (["failed", "cancelled", "interrupted"].includes(job.status)) throw new Error(job.error ?? `Builder ${job.status}.`);
				if (Date.now() - started >= jobTimeoutMs) throw new Error("The synthetic builder job exceeded its qualification deadline.");
				await new Promise(resolve => setTimeout(resolve, 100));
			}
		} catch (error) { await request("builder.cancel", { jobId: created.id }).catch(() => {}); throw error; }
	}
	const chart = await build("midnight.chart", "user", "Make my chart's first series blue (#1177aa). Preserve the other palette colors, data, scale, labels and layout. Increment the patch version and validate.");
	check("real-model private chart preview uses the requested color", chart.previewSvg?.includes('fill="#1177aa"'));
	await request("builder.activate", { jobId: chart.id, digest: chart.candidate.digest, expectedGeneration: chart.baseGeneration });
	check("exact reviewed private chart activates", (await request("builder.get", { jobId: chart.id })).status === "accepted");
	const themeBeforeProposal = await request("theme.current", {});
	check("private chart activation preserves the color component", themeBeforeProposal.pin.digest === initialTheme.pin.digest && JSON.stringify(themeBeforeProposal.tokens) === JSON.stringify(initialTheme.tokens));
	const theme = await build("midnight.theme", "user", "Make my accent colors teal. Return constant tokens: accent #176b65, accent-hover #176b65, accent-soft #173530, accent-line #65547f, highlight #a0e8d0, on-accent #ffffff. Increment the patch version and validate.");
	const teal = { accent: "#176b65", "accent-hover": "#176b65", "accent-soft": "#173530", "accent-line": "#65547f", highlight: "#a0e8d0", "on-accent": "#ffffff" };
	check("real-model private color preview matches all six requested tokens", Object.entries(teal).every(([key, value]) => theme.previewTokens?.[key] === value));
	check("generation and preview leave active colors unchanged", JSON.stringify(await request("theme.current", {})) === JSON.stringify(themeBeforeProposal));
	await request("builder.activate", { jobId: theme.id, digest: theme.candidate.digest, expectedGeneration: theme.baseGeneration });
	const activeTheme = await request("theme.current", {});
	check("exact reviewed private colors activate", Object.entries(teal).every(([key, value]) => activeTheme.tokens?.[key] === value));
	const officialChart = await build("midnight.chart", "official", "Increase the official chart's left margin from 64 to 80. Preserve the official palette, data, labels and scale. Increment the patch version and validate.");
	check("official chart preview starts from the official palette", officialChart.previewSvg?.includes('fill="#8068e8"') && !officialChart.previewSvg.includes('fill="#1177aa"'));
	check("official chart preview applies the requested margin", officialChart.previewSvg?.includes('<text x="80" y="34"'));
	const officialTheme = await build("midnight.theme", "official", "Set the official accent to #3d5e78 and accent-hover to #466a88. Preserve the other four official color tokens. Increment the patch version and validate.");
	check("official colors exclude the private overlay", officialTheme.previewTokens?.accent === "#3d5e78" && officialTheme.previewTokens?.["accent-hover"] === "#466a88" && officialTheme.previewTokens?.["accent-soft"] === initialTheme.tokens?.["accent-soft"] && officialTheme.previewTokens?.highlight === initialTheme.tokens?.highlight);
	check("official proposals leave private colors active", JSON.stringify(await request("theme.current", {})) === JSON.stringify(activeTheme));
	check("official candidates provide reviewable output paths", !!officialChart.officialPath && !!officialTheme.officialPath);
	return { checks, jobs, activeTheme: theme.candidate, activeChart: chart.candidate, provider: settings.provider, model: settings.model };
}
