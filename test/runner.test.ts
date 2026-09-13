import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { codexAdapter } from "../.pi/extensions/agent-dispatch/adapters/codex.ts";
import { ProcessRegistry } from "../.pi/extensions/agent-dispatch/process-registry.ts";
import { runAdapter } from "../.pi/extensions/agent-dispatch/runner.ts";
import type { StreamEvent } from "../.pi/extensions/agent-dispatch/types.ts";
import {
	isAlive,
	jsonLineAdapter,
	makeTempDir,
	readPidFile,
	waitFor,
	withFakeCli,
	writeJson,
} from "./helpers.ts";

const agentMessage =
	'{"type":"item.completed","item":{"type":"agent_message","text":"the answer"}}';
const completed =
	'{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2}}';
const threadStarted = '{"type":"thread.started","thread_id":"t-1"}';

async function runWith(
	config: Record<string, unknown>,
	options: { signal?: AbortSignal; onEvent?: (event: StreamEvent) => void } = {},
) {
	const dir = makeTempDir("runner-");
	const configPath = writeJson(dir, "config.json", config);
	const registry = new ProcessRegistry();
	const adapter = withFakeCli(codexAdapter, configPath);
	try {
		return await runAdapter({
			adapter,
			request: { prompt: "p", cwd: dir },
			registry,
			signal: options.signal,
			onEvent: options.onEvent,
		});
	} finally {
		await registry.cleanupAll();
	}
}

test("parses valid JSONL even when stdout arrives in tiny chunks", async () => {
	const payload = [threadStarted, agentMessage, completed].join("\n");
	const events: StreamEvent[] = [];
	const outcome = await runWith(
		{ stdout: [payload], stdoutChunkSize: 7 },
		{ onEvent: (event) => events.push(event) },
	);
	assert.equal(outcome.failure, undefined);
	assert.equal(outcome.result.text, "the answer");
	assert.equal(outcome.result.terminalSeen, true);
	assert.equal(outcome.result.usage?.input, 6);
	assert.equal(outcome.result.usage?.cacheRead, 4);
	assert.ok(events.some((event) => event.type === "done"));
});

test("parses a final complete line with no trailing newline", async () => {
	const payload = [threadStarted, agentMessage, completed].join("\n");
	const outcome = await runWith({ stdout: [payload] });
	assert.equal(outcome.failure, undefined);
	assert.equal(outcome.result.text, "the answer");
});

test("reports malformed or truncated JSONL as a failure and preserves usage", async () => {
	const payload = [threadStarted, completed, "{not-json"].join("\n");
	const outcome = await runWith({ stdout: [payload] });
	assert.equal(outcome.failure?.kind, "malformed-stream");
	assert.equal(outcome.result.usage?.input, 6);
});

test("reports exit 0 without a terminal envelope as missing-terminal", async () => {
	const outcome = await runWith({ stdout: [`${threadStarted}\n`] });
	assert.equal(outcome.failure?.kind, "missing-terminal");
});

test("reports an error envelope with exit zero as an error", async () => {
	const payload = [
		threadStarted,
		'{"type":"turn.failed","error":{"message":"upstream exploded"}}',
	].join("\n");
	const outcome = await runWith({ stdout: [payload], exitCode: 0 });
	assert.equal(outcome.failure?.kind, "error-envelope");
	assert.match(outcome.failure?.message ?? "", /upstream exploded/);
});

test("reports a non-zero exit with stderr diagnostics", async () => {
	const outcome = await runWith({
		stdout: [`${threadStarted}\n`],
		stderr: "fatal: nope",
		exitCode: 3,
	});
	assert.equal(outcome.failure?.kind, "nonzero-exit");
	assert.match(outcome.failure?.message ?? "", /fatal: nope/);
});

test("reports signal termination", async () => {
	const outcome = await runWith({
		stdout: [`${threadStarted}\n`],
		selfSignal: "SIGKILL",
	});
	assert.equal(outcome.failure?.kind, "signal");
	assert.equal(outcome.signal, "SIGKILL");
});

test("ignores unknown well-formed events when a terminal envelope is present", async () => {
	const payload = [
		threadStarted,
		'{"type":"future.event","x":1}',
		agentMessage,
		completed,
	].join("\n");
	const outcome = await runWith({ stdout: [payload] });
	assert.equal(outcome.failure, undefined);
	assert.equal(outcome.result.text, "the answer");
});

test("refuses to spawn after shutdown", async () => {
	const dir = makeTempDir("runner-");
	const configPath = writeJson(dir, "config.json", { stdout: [completed] });
	const registry = new ProcessRegistry();
	registry.beginShutdown();
	const outcome = await runAdapter({
		adapter: withFakeCli(codexAdapter, configPath),
		request: { prompt: "p", cwd: dir },
		registry,
	});
	assert.equal(outcome.failure?.kind, "shutdown");
});

test("an already-aborted signal produces a cancelled outcome without spawning", async () => {
	const dir = makeTempDir("runner-");
	const configPath = writeJson(dir, "config.json", {
		stdout: [completed],
		lifetimeMs: 5000,
	});
	const registry = new ProcessRegistry();
	const controller = new AbortController();
	controller.abort();
	const outcome = await runAdapter({
		adapter: withFakeCli(codexAdapter, configPath),
		request: { prompt: "p", cwd: dir },
		registry,
		signal: controller.signal,
	});
	assert.equal(outcome.failure?.kind, "cancelled");
});

test("decodes UTF-8 split across stdout byte boundaries", async () => {
	const text = "café 😀 — naïve";
	const payload = [
		threadStarted,
		`{"type":"item.completed","item":{"type":"agent_message","text":${JSON.stringify(text)}}}`,
		completed,
	].join("\n");
	const outcome = await runWith({ stdout: [payload], byteChunks: true });
	assert.equal(outcome.failure, undefined);
	assert.equal(outcome.result.text, text);
});

test("decodes UTF-8 split across stderr byte boundaries", async () => {
	const outcome = await runWith({
		stdout: [`${threadStarted}\n`],
		stderr: "échec 😀",
		exitCode: 3,
		byteChunks: true,
	});
	assert.equal(outcome.failure?.kind, "nonzero-exit");
	assert.match(outcome.failure?.message ?? "", /échec 😀/);
	assert.equal(outcome.stderr, "échec 😀");
});

test(
	"a throwing parser is captured, terminates the child, and rejects",
	{ timeout: 20000 },
	async () => {
		const dir = makeTempDir("runner-parser-throw-");
		const pidFile = path.join(dir, "cli.pid");
		const configPath = writeJson(dir, "config.json", {
			pidFile,
			stdout: ['{"type":"text","text":"x"}\n'],
			lifetimeMs: 30000,
		});
		const registry = new ProcessRegistry();
		const base = withFakeCli(jsonLineAdapter, configPath);
		const adapter = {
			...base,
			parseLine: () => {
				throw new Error("adapter exploded");
			},
		};
		try {
			await assert.rejects(
				runAdapter({ adapter, request: { prompt: "p", cwd: dir }, registry }),
				/adapter exploded/,
			);
			const pid = await readPidFile(pidFile);
			assert.equal(
				await waitFor(() => !isAlive(pid), 5000),
				true,
				"child must be terminated when a callback throws",
			);
			assert.equal(registry.activeCount, 0);
		} finally {
			await registry.cleanupAll();
		}
	},
);

test(
	"a throwing onUpdate is captured, terminates the child, and rejects",
	{ timeout: 20000 },
	async () => {
		const dir = makeTempDir("runner-update-throw-");
		const pidFile = path.join(dir, "cli.pid");
		const configPath = writeJson(dir, "config.json", {
			pidFile,
			stdout: ['{"type":"text","text":"x"}\n'],
			lifetimeMs: 30000,
		});
		const registry = new ProcessRegistry();
		try {
			await assert.rejects(
				runAdapter({
					adapter: withFakeCli(jsonLineAdapter, configPath),
					request: { prompt: "p", cwd: dir },
					registry,
					onEvent: () => {
						throw new Error("callback exploded");
					},
				}),
				/callback exploded/,
			);
			const pid = await readPidFile(pidFile);
			assert.equal(await waitFor(() => !isAlive(pid), 5000), true);
			assert.equal(registry.activeCount, 0);
		} finally {
			await registry.cleanupAll();
		}
	},
);

test(
	"bounds an unterminated stdout line instead of growing without limit",
	{ timeout: 20000 },
	async () => {
		const outcome = await runWith({
			stdout: ["x".repeat(1_000_001)],
			lifetimeMs: 30000,
		});
		assert.equal(outcome.failure?.kind, "malformed-stream");
	},
);

test(
	"terminates a CLI that emits a malformed line and then stalls",
	{ timeout: 5000 },
	async () => {
		// The fixture stays alive for 30s after writing. If the runner does not
		// terminate on the bad line, this test blocks until the 5s timeout fires.
		const startedAt = Date.now();
		const outcome = await runWith({
			stdout: [`${threadStarted}\n{not-json\n`],
			lifetimeMs: 30000,
		});
		assert.equal(outcome.failure?.kind, "malformed-stream");
		assert.ok(
			Date.now() - startedAt < 5000,
			"dispatch must not wait for a CLI that stalls after a malformed line",
		);
	},
);
