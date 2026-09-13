import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { codexAdapter } from "../.pi/extensions/agent-dispatch/adapters/codex.ts";
import {
	ProcessRegistry,
	terminate,
} from "../.pi/extensions/agent-dispatch/process-registry.ts";
import { runAdapter } from "../.pi/extensions/agent-dispatch/runner.ts";
import {
	isAlive,
	makeTempDir,
	readPidFile,
	sleep,
	waitFor,
	withFakeCli,
	writeJson,
	FAKE_CLI,
} from "./helpers.ts";
import { runCaptured } from "../.pi/extensions/agent-dispatch/runner.ts";

const completed =
	'{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}';

function makeFixture(prefix: string, config: Record<string, unknown>) {
	const dir = makeTempDir(prefix);
	config.pidFile = path.join(dir, "cli.pid");
	const configPath = writeJson(dir, "config.json", config);
	return { dir, configPath, cliPidFile: path.join(dir, "cli.pid") };
}

test("cleans up a descendant left behind after the direct child exits", async () => {
	const dir = makeTempDir("lifecycle-desc-");
	const descendantPid = path.join(dir, "desc.pid");
	const { configPath } = makeFixture("lifecycle-desc-", {
		stdout: [completed],
		descendant: { pidFile: descendantPid, trapSigterm: false, lifetimeMs: 60000 },
	});
	const registry = new ProcessRegistry();
	try {
		const outcome = await runAdapter({
			adapter: withFakeCli(codexAdapter, configPath),
			request: { prompt: "p", cwd: dir },
			registry,
		});
		assert.equal(outcome.failure, undefined);
		const pid = await readPidFile(descendantPid);
		assert.equal(
			await waitFor(() => !isAlive(pid), 5000),
			true,
			"descendant should be terminated",
		);
	} finally {
		await registry.cleanupAll();
	}
});

test("force-kills a descendant that ignores SIGTERM", async () => {
	const dir = makeTempDir("lifecycle-stubborn-");
	const descendantPid = path.join(dir, "desc.pid");
	const { configPath } = makeFixture("lifecycle-stubborn-", {
		stdout: [completed],
		descendant: { pidFile: descendantPid, trapSigterm: true, lifetimeMs: 60000 },
	});
	const registry = new ProcessRegistry();
	try {
		const started = Date.now();
		await runAdapter({
			adapter: withFakeCli(codexAdapter, configPath),
			request: { prompt: "p", cwd: dir },
			registry,
		});
		const elapsed = Date.now() - started;
		const pid = await readPidFile(descendantPid);
		assert.equal(
			await waitFor(() => !isAlive(pid), 5000),
			true,
			"SIGTERM-resistant descendant should be SIGKILLed",
		);
		// Bounded: one grace period plus scheduling tolerance.
		assert.ok(elapsed < 6000, `cleanup took too long: ${elapsed}ms`);
	} finally {
		await registry.cleanupAll();
	}
});

test("session shutdown terminates an active dispatch and leaves no child", async () => {
	const { dir, configPath, cliPidFile } = makeFixture("lifecycle-shutdown-", {
		stdout: ['{"type":"thread.started","thread_id":"t"}\n'],
		lifetimeMs: 30000,
	});
	const registry = new ProcessRegistry();
	const promise = runAdapter({
		adapter: withFakeCli(codexAdapter, configPath),
		request: { prompt: "p", cwd: dir },
		registry,
	});
	await waitFor(() => registry.activeCount > 0);
	const pid = await readPidFile(cliPidFile);
	registry.beginShutdown();
	await registry.cleanupAll();
	const outcome = await promise;
	assert.ok(outcome.failure, "shutdown should produce a failure outcome");
	assert.equal(
		await waitFor(() => !isAlive(pid), 5000),
		true,
		"CLI process should be gone",
	);
	assert.equal(registry.activeCount, 0);
	assert.equal(registry.isShuttingDown, true);
});

test("cancellation during an active run terminates the process group", async () => {
	const { dir, configPath, cliPidFile } = makeFixture("lifecycle-abort-", {
		stdout: ['{"type":"thread.started","thread_id":"t"}\n'],
		lifetimeMs: 30000,
	});
	const registry = new ProcessRegistry();
	const controller = new AbortController();
	const promise = runAdapter({
		adapter: withFakeCli(codexAdapter, configPath),
		request: { prompt: "p", cwd: dir },
		registry,
		signal: controller.signal,
	});
	await waitFor(() => registry.activeCount > 0);
	const pid = await readPidFile(cliPidFile);
	controller.abort();
	const outcome = await promise;
	assert.equal(outcome.failure?.kind, "cancelled");
	assert.equal(
		await waitFor(() => !isAlive(pid), 5000),
		true,
		"CLI process should be gone",
	);
});

test("cancellation during startup leaves no surviving child", async () => {
	const { dir, configPath, cliPidFile } = makeFixture("lifecycle-startup-", {
		stdout: [completed],
		delayMs: 15000,
		lifetimeMs: 15000,
	});
	const registry = new ProcessRegistry();
	const controller = new AbortController();
	const promise = runAdapter({
		adapter: withFakeCli(codexAdapter, configPath),
		request: { prompt: "p", cwd: dir },
		registry,
		signal: controller.signal,
	});
	await waitFor(() => registry.activeCount > 0);
	const pid = await readPidFile(cliPidFile);
	controller.abort();
	const outcome = await promise;
	assert.equal(outcome.failure?.kind, "cancelled");
	assert.equal(
		await waitFor(() => !isAlive(pid), 5000),
		true,
		"CLI process should be gone",
	);
});

test("discovery subprocesses share the cancellation lifecycle", async () => {
	const dir = makeTempDir("lifecycle-discovery-");
	const pidFile = path.join(dir, "disc.pid");
	const configPath = writeJson(dir, "config.json", {
		pidFile,
		stdout: ["x"],
		lifetimeMs: 30000,
	});
	const registry = new ProcessRegistry();
	const controller = new AbortController();
	const promise = runCaptured(
		{ registry, signal: controller.signal },
		process.execPath,
		[FAKE_CLI, configPath],
		dir,
		{ ...process.env },
	);
	await waitFor(() => registry.activeCount > 0);
	const pid = await readPidFile(pidFile);
	controller.abort();
	const result = await promise;
	assert.equal(result.cancelled, true);
	assert.equal(
		await waitFor(() => !isAlive(pid), 5000),
		true,
		"discovery process should be gone",
	);
	assert.equal(registry.activeCount, 0);
});

test("repeated cleanup never signals an unrelated process", async () => {
	const sentinel = spawn(
		process.execPath,
		["-e", "setTimeout(() => {}, 60000)"],
		{
			detached: true,
			stdio: "ignore",
		},
	);
	sentinel.unref();
	assert.ok(sentinel.pid);
	try {
		const { dir, configPath } = makeFixture("lifecycle-sentinel-", {
			stdout: [completed],
			descendant: {
				pidFile: path.join(makeTempDir("desc-"), "d.pid"),
				trapSigterm: false,
				lifetimeMs: 60000,
			},
		});
		const registry = new ProcessRegistry();
		await runAdapter({
			adapter: withFakeCli(codexAdapter, configPath),
			request: { prompt: "p", cwd: dir },
			registry,
		});
		await registry.cleanupAll();
		await registry.cleanupAll();
		assert.equal(
			isAlive(sentinel.pid),
			true,
			"unrelated sentinel must survive cleanup",
		);
	} finally {
		try {
			process.kill(-sentinel.pid, "SIGKILL");
		} catch {
			/* already gone */
		}
	}
});

test(
	"does not hang when a descendant holds the inherited stdout pipe",
	{ timeout: 20000 },
	async () => {
		const dir = makeTempDir("lifecycle-pipe-");
		const descendantPid = path.join(dir, "desc.pid");
		const { configPath } = makeFixture("lifecycle-pipe-", {
			stdout: [completed],
			descendant: {
				pidFile: descendantPid,
				trapSigterm: false,
				lifetimeMs: 60000,
				// Hold the runner's stdout/stderr pipes open after the direct child exits.
				inheritStdio: true,
			},
		});
		const registry = new ProcessRegistry();
		try {
			const outcome = await runAdapter({
				adapter: withFakeCli(codexAdapter, configPath),
				request: { prompt: "p", cwd: dir },
				registry,
			});
			assert.equal(outcome.failure, undefined);
			assert.equal(outcome.result.terminalSeen, true);
			const pid = await readPidFile(descendantPid);
			assert.equal(
				await waitFor(() => !isAlive(pid), 5000),
				true,
				"pipe-holding descendant should be terminated",
			);
		} finally {
			await registry.cleanupAll();
		}
	},
);

test(
	"overlapping cleanup awaits the same termination before reporting done",
	{ timeout: 20000 },
	async () => {
		const { dir, configPath, cliPidFile } = makeFixture("lifecycle-overlap-", {
			stdout: ["x"],
			trapSigterm: true,
			lifetimeMs: 30000,
		});
		const registry = new ProcessRegistry();
		const tp = registry.spawn({
			cmd: process.execPath,
			args: [FAKE_CLI, configPath],
			cwd: dir,
			env: { ...process.env },
		});
		const pid = await readPidFile(cliPidFile);
		// First cleanup starts but is not awaited; the second must not return early.
		const first = terminate(tp);
		await sleep(50);
		await registry.cleanupAll();
		assert.equal(
			isAlive(pid),
			false,
			"cleanupAll must not report completion while the child is alive",
		);
		assert.equal(registry.activeCount, 0);
		await first;
	},
);

test("discovery output decodes UTF-8 split across byte boundaries", async () => {
	const dir = makeTempDir("captured-utf8-");
	const configPath = writeJson(dir, "config.json", {
		stdout: ["café 😀"],
		byteChunks: true,
	});
	const registry = new ProcessRegistry();
	const result = await runCaptured(
		{ registry },
		process.execPath,
		[FAKE_CLI, configPath],
		dir,
		{ ...process.env },
	);
	assert.equal(result.stdout, "café 😀");
});

test("a failed spawn never probes or signals an invalid or PID 1 group", async () => {
	const registry = new ProcessRegistry();
	const tp = registry.spawn({
		cmd: "definitely-not-a-real-binary-xyz",
		args: [],
		cwd: process.cwd(),
		env: { ...process.env },
	});
	await tp.exited;
	assert.ok(tp.spawnError, "spawn should have failed");

	const calls: number[] = [];
	const realKill = process.kill;
	const patched = (pid: number, signal?: NodeJS.Signals | number) => {
		calls.push(pid);
		return realKill.call(process, pid, signal as NodeJS.Signals);
	};
	(process as unknown as { kill: typeof process.kill }).kill =
		patched as typeof process.kill;
	try {
		await terminate(tp);
	} finally {
		(process as unknown as { kill: typeof process.kill }).kill = realKill;
	}
	assert.deepEqual(
		calls.filter((pid) => Math.abs(pid) <= 1),
		[],
		"must never probe or signal PID 1 or this process group",
	);
});

test("runCaptured with an already-aborted signal does not spawn", async () => {
	const dir = makeTempDir("captured-abort-");
	const pidFile = path.join(dir, "cli.pid");
	const configPath = writeJson(dir, "config.json", { pidFile, stdout: ["x"] });
	const registry = new ProcessRegistry();
	const controller = new AbortController();
	controller.abort();
	const result = await runCaptured(
		{ registry, signal: controller.signal },
		process.execPath,
		[FAKE_CLI, configPath],
		dir,
		{ ...process.env },
	);
	assert.equal(result.cancelled, true);
	assert.equal(
		fs.existsSync(pidFile),
		false,
		"no process should have been spawned",
	);
	assert.equal(registry.activeCount, 0);
});
