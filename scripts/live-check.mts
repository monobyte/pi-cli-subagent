/**
 * Live verification harness. Run manually; it makes real (paid) CLI calls.
 *
 *   git init /tmp/... ; modify a file ; node --experimental-strip-types scripts/live-check.mts <repo>
 *
 * Records the raw outcome of each check so the validation matrix in tasks.md can
 * cite observed results.
 */

import fs from "node:fs";
import path from "node:path";
import { claudeAdapter } from "../.pi/extensions/agent-dispatch/adapters/claude.ts";
import { codexAdapter } from "../.pi/extensions/agent-dispatch/adapters/codex.ts";
import { ProcessRegistry } from "../.pi/extensions/agent-dispatch/process-registry.ts";
import { runDispatch } from "../.pi/extensions/agent-dispatch/dispatch-core.ts";

const repo = process.argv[2] ?? process.cwd();
const registry = new ProcessRegistry();

function summarize(
	label: string,
	result: Awaited<ReturnType<typeof runDispatch>>,
	extra: Record<string, unknown> = {},
) {
	console.log(
		JSON.stringify(
			{
				label,
				isError: result.isError,
				failureKind: result.details.failure?.kind,
				confirmed: result.details.confirmed,
				usage: result.usage,
				content: result.content.slice(0, 900),
				...extra,
			},
			null,
			1,
		),
	);
}

async function main() {
	console.log("== codex: discoverModels ==");
	try {
		const catalogue = await codexAdapter.discoverModels?.({ registry });
		console.log(
			JSON.stringify(
				catalogue?.models.map((m) => ({ id: m.id, efforts: m.supportedEfforts })),
				null,
				1,
			),
		);
	} catch (error) {
		console.log(
			"discoverModels failed:",
			error instanceof Error ? error.message : String(error),
		);
	}

	console.log("== codex: unsupported model (no run) ==");
	summarize(
		"codex-model",
		await runDispatch(
			{ task: "noop", cli: "codex", model: "not-a-real-model" },
			{ registry, cwd: repo },
		),
	);
	console.log("== codex: unsupported effort (no run) ==");
	summarize(
		"codex-effort",
		await runDispatch(
			{ task: "noop", cli: "codex", effort: "not-a-real-effort" },
			{ registry, cwd: repo },
		),
	);

	console.log("== codex: live no-op + write probes + uncommitted diff ==");
	const codexTask = [
		"Run these steps and report each result concisely.",
		"1. Use the shell to run: printf shell > probe-shell.txt",
		"2. Use your file editing/apply_patch tool to create probe-tool.txt containing tool.",
		"3. Use the shell to run: git diff",
		"4. End your reply with the exact token CODEX_DONE.",
	].join("\n");
	summarize(
		"codex-live",
		await runDispatch({ task: codexTask, cli: "codex" }, { registry, cwd: repo }),
	);

	console.log(
		"== claude: live no-op + write probes + uncommitted diff (model override) ==",
	);
	const claudeTask = [
		"Run these steps and report each result concisely.",
		"1. Use the Bash tool to run: printf shell > probe-shell.txt",
		"2. Use a file editing tool to create probe-tool.txt containing tool.",
		"3. Use the Bash tool to run: git diff",
		"4. End your reply with the exact token CLAUDE_DONE.",
	].join("\n");
	summarize(
		"claude-live",
		await runDispatch(
			{ task: claudeTask, cli: "claude", model: "sonnet", effort: "high" },
			{ registry, cwd: repo },
		),
	);

	console.log("== claude: unknown model surfaced ==");
	summarize(
		"claude-unknown-model",
		await runDispatch(
			{ task: "Reply ok.", cli: "claude", model: "not-a-real-model" },
			{ registry, cwd: repo },
		),
	);

	console.log("== repo state ==");
	for (const file of ["probe-shell.txt", "probe-tool.txt"]) {
		console.log(
			file,
			fs.existsSync(path.join(repo, file)) ? "EXISTS (BAD)" : "absent (good)",
		);
	}

	await registry.cleanupAll();
}

main().catch(async (error) => {
	console.error(error);
	await registry.cleanupAll();
	process.exit(1);
});
