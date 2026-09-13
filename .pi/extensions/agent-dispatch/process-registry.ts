/**
 * Active child-process tracking and bounded, idempotent cleanup.
 *
 * Every CLI (and every discovery subprocess) is spawned in its own process
 * group so cancellation can terminate the CLI and its descendants without
 * signalling Pi. Abort and session shutdown share the same cleanup routine.
 *
 * Direct-child exit and stdio closure are tracked separately. A descendant that
 * inherits the CLI's stdout/stderr keeps the pipe open, so waiting on `close`
 * alone can hang after the CLI itself has exited; callers await `exited`, run
 * cleanup to terminate descendants, then drain `closed`.
 *
 * This is process isolation, not background execution: callers still await
 * their child to completion. Abrupt parent death (SIGKILL, crash) skips this
 * cleanup; children can survive it. That limit is documented, not hidden.
 *
 * Platform notes: POSIX gets true process-group termination. On Windows only
 * the direct child is killed, so descendants are not swept. There is no
 * execution deadline; a dispatch runs until the CLI exits or the caller
 * cancels.
 */

import { spawn, type ChildProcess } from "node:child_process";

/** Grace period before escalating from SIGTERM to SIGKILL. */
export const GRACE_MS = 2000;
/** How long to wait for a process group to drain before force-killing. */
const GROUP_SWEEP_MS = 300;
/** Poll interval while waiting for a process group to disappear. */
const GROUP_POLL_MS = 40;

export interface SpawnSpec {
	cmd: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export interface TrackedProcess {
	readonly child: ChildProcess;
	readonly pid: number;
	/** Resolves when the direct child exits or fails to spawn. */
	exited: Promise<void>;
	/** Resolves when the direct child exits and its stdio is fully closed. */
	closed: Promise<void>;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	spawnError?: Error;
	/** Whether the direct child has exited (descendants may survive). */
	exitedDirectly: boolean;
	/** Whether stdio has fully closed (all pipes drained). */
	closedStreams: boolean;
	/** Shared cleanup promise: every caller awaits the same termination. */
	cleanup?: Promise<void>;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function raceExit(tp: TrackedProcess, ms: number): Promise<boolean> {
	if (tp.exitedDirectly) return true;
	return Promise.race([tp.exited.then(() => true), delay(ms).then(() => false)]);
}

/** Whether any process remains in the child's process group. */
function groupAlive(pid: number): boolean {
	// A failed spawn has no pid (stored as 0). Negating a non-positive pid would
	// probe or signal process group 0 (this process) or PID 1 (init) instead.
	if (process.platform === "win32" || pid <= 0) return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// EPERM means the group exists but we may not signal it: treat as alive.
		return code === "EPERM";
	}
}

/** Signal the whole process group; fall back to the direct child. */
function signalGroup(tp: TrackedProcess, signal: NodeJS.Signals): void {
	// Without a valid pid there is no group and no child to signal.
	if (tp.pid <= 0) return;
	if (process.platform === "win32") {
		// Windows has no POSIX process groups here, so only the direct child is
		// killed; descendants are out of scope on that platform.
		try {
			tp.child.kill(signal);
		} catch {
			/* already gone */
		}
		return;
	}
	try {
		process.kill(-tp.pid, signal);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ESRCH") {
			try {
				tp.child.kill(signal);
			} catch {
				/* already gone */
			}
		}
	}
}

function track(child: ChildProcess, pid: number): TrackedProcess {
	const tp: TrackedProcess = {
		child,
		pid,
		exitCode: null,
		signalCode: null,
		exitedDirectly: false,
		closedStreams: false,
		exited: Promise.resolve(),
		closed: Promise.resolve(),
	};
	tp.exited = new Promise<void>((resolve) => {
		// `exit` fires when the process ends; it does not wait for inherited
		// stdio held open by descendants. `error` covers a failed spawn.
		child.once("error", (error) => {
			tp.spawnError = error as Error;
			tp.exitedDirectly = true;
			resolve();
		});
		child.once("exit", (code, signal) => {
			tp.exitCode = code ?? null;
			tp.signalCode = (signal as NodeJS.Signals | null) ?? null;
			tp.exitedDirectly = true;
			resolve();
		});
	});
	tp.closed = new Promise<void>((resolve) => {
		const done = () => {
			tp.closedStreams = true;
			resolve();
		};
		child.once("close", done);
		child.once("error", done);
	});
	return tp;
}

/**
 * Bounded cleanup: SIGTERM the group, wait at most two seconds, then SIGKILL
 * survivors. Descendants left behind after the direct child exits are swept in
 * the same pass. Idempotent and shareable: every caller awaits the same
 * promise, so overlapping cleanup never reports completion early.
 */
export function terminate(tp: TrackedProcess): Promise<void> {
	if (!tp.cleanup) tp.cleanup = runCleanup(tp);
	return tp.cleanup;
}

async function runCleanup(tp: TrackedProcess): Promise<void> {
	if (!tp.exitedDirectly) {
		signalGroup(tp, "SIGTERM");
		const exited = await raceExit(tp, GRACE_MS);
		if (!exited) {
			signalGroup(tp, "SIGKILL");
			await raceExit(tp, GRACE_MS);
		}
	}

	// The direct child may have exited while descendants survive. Sweep the group.
	if (process.platform !== "win32" && groupAlive(tp.pid)) {
		signalGroup(tp, "SIGTERM");
		const deadline = Date.now() + GROUP_SWEEP_MS;
		while (Date.now() < deadline && groupAlive(tp.pid)) {
			await delay(GROUP_POLL_MS);
		}
		if (groupAlive(tp.pid)) signalGroup(tp, "SIGKILL");
	}
}

/**
 * In-memory registry of active child process groups. `beginShutdown()` stops
 * new spawns and `cleanupAll()` terminates everything still tracked.
 */
export class ProcessRegistry {
	private readonly active = new Set<TrackedProcess>();
	private shuttingDown = false;

	get isShuttingDown(): boolean {
		return this.shuttingDown;
	}

	get activeCount(): number {
		return this.active.size;
	}

	/** Stop accepting new spawns. Idempotent. */
	beginShutdown(): void {
		this.shuttingDown = true;
	}

	/**
	 * Re-enable spawning for a fresh session. Used when a session restart reuses
	 * the same extension instance after `session_shutdown`.
	 */
	resume(): void {
		this.shuttingDown = false;
	}

	spawn(spec: SpawnSpec): TrackedProcess {
		if (this.shuttingDown) {
			throw new Error(
				"dispatch is shutting down; refusing to spawn a new process",
			);
		}
		const child = spawn(spec.cmd, spec.args, {
			cwd: spec.cwd,
			env: spec.env,
			stdio: ["ignore", "pipe", "pipe"],
			// POSIX: new process group so cancellation can signal the tree.
			detached: process.platform !== "win32",
			shell: false,
		});
		const tp = track(child, child.pid ?? 0);
		this.active.add(tp);
		return tp;
	}

	/** Terminate one tracked process and remove it once cleanup finishes. */
	async release(tp: TrackedProcess): Promise<void> {
		try {
			await terminate(tp);
		} finally {
			this.active.delete(tp);
		}
	}

	/** Terminate every tracked process. Reusable; safe to call more than once. */
	async cleanupAll(): Promise<void> {
		this.shuttingDown = true;
		const pending = [...this.active];
		await Promise.all(pending.map((tp) => this.release(tp)));
	}
}
