import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { codexAdapter } from "../.pi/extensions/agent-dispatch/adapters/codex.ts";
import { runDispatch } from "../.pi/extensions/agent-dispatch/dispatch-core.ts";
import { ProcessRegistry } from "../.pi/extensions/agent-dispatch/process-registry.ts";
import type {
	CliAdapter,
	DispatchDetails,
} from "../.pi/extensions/agent-dispatch/types.ts";
import { makeTempDir, withFakeCli, writeJson } from "./helpers.ts";

function deps(
	registry: ProcessRegistry,
	cwd: string,
	overrides: Partial<Parameters<typeof runDispatch>[1]> = {},
) {
	return { registry, cwd, isOnPath: () => true, ...overrides };
}

test("fails clearly when no CLI is specified", async () => {
	const registry = new ProcessRegistry();
	const result = await runDispatch(
		{ task: "review" },
		deps(registry, process.cwd()),
	);
	assert.equal(result.isError, true);
	assert.equal(result.details.failure?.kind, "missing-cli");
	assert.match(result.content, /codex, claude/);
});

test("rejects an unsupported CLI and lists supported agents", async () => {
	const registry = new ProcessRegistry();
	const result = await runDispatch(
		{ task: "review", cli: "gpt5" },
		deps(registry, process.cwd()),
	);
	assert.equal(result.details.failure?.kind, "unsupported-cli");
	assert.match(result.content, /Supported agents: codex, claude/);
});

test("distinguishes a supported CLI that is not installed", async () => {
	const registry = new ProcessRegistry();
	const result = await runDispatch(
		{ task: "review", cli: "codex" },
		deps(registry, process.cwd(), { isOnPath: () => false }),
	);
	assert.equal(result.details.failure?.kind, "cli-not-installed");
	assert.match(result.content, /codex.*PATH/);
});

test("refuses to dispatch when an adapter cannot enforce read-only", async () => {
	const stub: CliAdapter = {
		name: "codex",
		capabilities: { readOnly: false, discoverModels: false },
		buildCommand: codexAdapter.buildCommand.bind(codexAdapter),
		newState: codexAdapter.newState,
		parseLine: codexAdapter.parseLine,
		extractResult: codexAdapter.extractResult,
	};
	const registry = new ProcessRegistry();
	const result = await runDispatch(
		{ task: "review", cli: "codex" },
		deps(registry, process.cwd(), { resolveAdapter: () => stub }),
	);
	assert.equal(result.details.failure?.kind, "read-only-unavailable");
	assert.equal(registry.activeCount, 0);
});

test("preflight rejection starts no agent run", async () => {
	const dir = makeTempDir("core-preflight-");
	const pidFile = path.join(dir, "cli.pid");
	const configPath = writeJson(dir, "config.json", {
		stdout: ["{}\n"],
		pidFile,
	});
	const base = withFakeCli(codexAdapter, configPath);
	const stub: CliAdapter = {
		...base,
		preflight: async () => ({
			ok: false,
			message: 'Unsupported model "nope" for codex. Valid models: gpt-6-astra.',
		}),
	};
	const registry = new ProcessRegistry();
	const result = await runDispatch(
		{ task: "review", cli: "codex", model: "nope" },
		deps(registry, dir, { resolveAdapter: () => stub }),
	);
	assert.equal(result.details.failure?.kind, "invalid-request");
	assert.match(result.content, /Unsupported model "nope"/);
	assert.equal(
		fs.existsSync(pidFile),
		false,
		"no agent process should have started",
	);
});

test("runs a successful dispatch and returns text, identity, activity, and usage", async () => {
	const dir = makeTempDir("core-success-");
	const configPath = writeJson(dir, "config.json", {
		stdout: [
			'{"type":"thread.started","thread_id":"thread-7"}\n',
			'{"type":"item.completed","item":{"type":"agent_message","text":"review complete"}}\n',
			'{"type":"turn.completed","usage":{"input_tokens":20,"cached_input_tokens":5,"output_tokens":7}}\n',
		],
	});
	const adapter = withFakeCli(codexAdapter, configPath);
	const registry = new ProcessRegistry();
	try {
		const updates: DispatchDetails[] = [];
		const result = await runDispatch(
			{ task: "review the diff", cli: "codex" },
			deps(registry, dir, {
				resolveAdapter: () => adapter,
				onUpdate: (partial) => updates.push(partial.details),
			}),
		);
		assert.equal(result.isError, false);
		assert.equal(result.content, "review complete");
		assert.equal(result.details.confirmed.sessionId, "thread-7");
		assert.equal(result.details.failure, undefined);
		assert.ok(result.details.activity.some((item) => item.kind === "text"));
		assert.equal(result.usage?.input, 15);
		assert.equal(result.usage?.cacheRead, 5);
		assert.equal(result.usage?.output, 7);
		assert.ok(updates.length > 0, "caller should see incremental progress");
		assert.ok(
			updates.some((partial) => partial.confirmed.sessionId === "thread-7"),
			"CLI metadata should update the live row",
		);
		assert.ok(
			updates.some((partial) =>
				partial.activity.some((item) => item.kind === "text"),
			),
			"activity should stream through onUpdate",
		);
	} finally {
		await registry.cleanupAll();
	}
});

test("reports a failure envelope with diagnostics and usage preserved", async () => {
	const dir = makeTempDir("core-error-");
	const configPath = writeJson(dir, "config.json", {
		stdout: [
			'{"type":"thread.started","thread_id":"t"}\n',
			'{"type":"turn.failed","error":{"message":"upstream exploded"}}\n',
			'{"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":3}}\n',
		],
	});
	const adapter = withFakeCli(codexAdapter, configPath);
	const registry = new ProcessRegistry();
	try {
		const result = await runDispatch(
			{ task: "review", cli: "codex" },
			deps(registry, dir, { resolveAdapter: () => adapter }),
		);
		assert.equal(result.isError, true);
		assert.equal(result.details.failure?.kind, "error-envelope");
		assert.match(result.content, /upstream exploded/);
		assert.equal(result.usage?.input, 9);
		assert.equal(result.usage?.output, 3);
	} finally {
		await registry.cleanupAll();
	}
});

test("runs a third adapter through the same contract without tool changes", async () => {
	const dir = makeTempDir("core-third-");
	const configPath = writeJson(dir, "config.json", {
		stdout: [
			'{"type":"thread.started","thread_id":"third-1"}\n',
			'{"type":"item.completed","item":{"type":"agent_message","text":"third says hi"}}\n',
			'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',
		],
	});
	const third = { ...withFakeCli(codexAdapter, configPath), name: "third" };
	const registry = new ProcessRegistry();
	try {
		const result = await runDispatch(
			{ task: "hi", cli: "third" },
			deps(registry, dir, {
				resolveAdapter: (name) => (name === "third" ? third : undefined),
			}),
		);
		assert.equal(result.isError, false);
		assert.equal(result.content, "third says hi");
		assert.equal(result.details.cli, "third");
		for (const key of ["cli", "requested", "confirmed", "activity"]) {
			assert.ok(key in result.details, `details should include ${key}`);
		}
	} finally {
		await registry.cleanupAll();
	}
});

test("keeps concurrent dispatches isolated by call", async () => {
	const dirA = makeTempDir("core-concurrent-a-");
	const dirB = makeTempDir("core-concurrent-b-");
	const configA = writeJson(dirA, "config.json", {
		stdout: [
			'{"type":"thread.started","thread_id":"A"}\n',
			'{"type":"item.completed","item":{"type":"agent_message","text":"alpha"}}\n',
			'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',
		],
		delayMs: 30,
	});
	const configB = writeJson(dirB, "config.json", {
		stdout: [
			'{"type":"thread.started","thread_id":"B"}\n',
			'{"type":"item.completed","item":{"type":"agent_message","text":"beta"}}\n',
			'{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":2}}\n',
		],
		delayMs: 10,
	});
	const adapterA = withFakeCli(codexAdapter, configA);
	const adapterB = withFakeCli(codexAdapter, configB);
	const registry = new ProcessRegistry();
	try {
		const [a, b] = await Promise.all([
			runDispatch(
				{ task: "a", cli: "codex" },
				deps(registry, dirA, { resolveAdapter: () => adapterA }),
			),
			runDispatch(
				{ task: "b", cli: "codex" },
				deps(registry, dirB, { resolveAdapter: () => adapterB }),
			),
		]);
		assert.equal(a.content, "alpha");
		assert.equal(b.content, "beta");
		assert.equal(a.details.confirmed.sessionId, "A");
		assert.equal(b.details.confirmed.sessionId, "B");
		assert.equal(a.usage?.input, 1);
		assert.equal(b.usage?.input, 2);
	} finally {
		await registry.cleanupAll();
	}
});
