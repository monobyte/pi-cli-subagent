/**
 * Adapter runner: spawns a CLI in its own process group, buffers stdout into
 * complete lines, forwards normalized events, and assembles a typed outcome.
 *
 * Success requires exit code zero, a recognized successful terminal envelope,
 * and no parsing failure. Usage is preserved on every outcome, including
 * failures, cancellations, and incomplete streams.
 *
 * Direct-child `exit` is awaited before cleanup. `close` is only used to drain
 * stdout/stderr afterwards, because a descendant that inherits the CLI's pipes
 * can keep them open after the CLI itself has exited.
 */

import { StringDecoder } from "node:string_decoder";
import type {
	AdapterContext,
	AdapterResult,
	AdapterState,
	CliAdapter,
	DispatchRequest,
	FailureKind,
	ResolvedDefaults,
	StreamEvent,
} from "./types.ts";
import { MalformedStreamError } from "./types.ts";
import { ProcessRegistry, type TrackedProcess } from "./process-registry.ts";

/** Bound for waiting on stdio to drain after the child has been cleaned up. */
const STREAM_DRAIN_MS = 2000;
/** Bound for a single unterminated stdout line before the stream is invalid. */
const MAX_LINE_CHARS = 1_000_000;
/** Bound for accumulated stderr diagnostics. */
const MAX_STDERR_CHARS = 262_144;

export interface RunOptions {
	adapter: CliAdapter;
	request: DispatchRequest;
	registry: ProcessRegistry;
	defaults?: ResolvedDefaults;
	signal?: AbortSignal;
	onEvent?: (event: StreamEvent) => void;
}

export interface RunOutcome {
	result: AdapterResult;
	failure?: { kind: FailureKind; message: string };
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decode a chunk without splitting multi-byte UTF-8 characters. */
function decode(decoder: StringDecoder, chunk: Buffer | string): string {
	return typeof chunk === "string" ? chunk : decoder.write(chunk);
}

/** Wait for stdio to close, bounded so a stray pipe cannot hang the caller. */
async function waitForClosed(tp: TrackedProcess, ms: number): Promise<void> {
	if (tp.closedStreams) return;
	await Promise.race([tp.closed, delay(ms)]);
}

function emit(
	onEvent: ((event: StreamEvent) => void) | undefined,
	event: StreamEvent | StreamEvent[] | null,
): void {
	if (!onEvent || event === null) return;
	if (Array.isArray(event)) {
		for (const item of event) onEvent(item);
	} else {
		onEvent(event);
	}
}

function isBlank(line: string): boolean {
	return line.trim().length === 0;
}

/**
 * Feed one raw line to the adapter. Returns the first malformed-line error, or
 * null. Unknown well-formed events are ignored by the adapter (forward
 * compatibility) and never establish completion.
 */
function feedLine(
	adapter: CliAdapter,
	state: AdapterState,
	line: string,
	onEvent: ((event: StreamEvent) => void) | undefined,
): MalformedStreamError | null {
	if (isBlank(line)) return null;
	try {
		emit(onEvent, adapter.parseLine(line, state));
		return null;
	} catch (error) {
		if (error instanceof MalformedStreamError) return error;
		throw error;
	}
}

async function terminateQuietly(
	registry: ProcessRegistry,
	tp: TrackedProcess,
): Promise<void> {
	try {
		await registry.release(tp);
	} catch {
		/* cleanup must never mask the real outcome */
	}
}

/**
 * Run an adapter to completion. The child is always released from the registry
 * before returning, so descendants are swept even on the success path.
 */
export async function runAdapter(options: RunOptions): Promise<RunOutcome> {
	const { adapter, request, registry, defaults, signal, onEvent } = options;
	const state = adapter.newState();

	let tp: TrackedProcess | undefined;
	let cancelled = false;
	let stderr = "";
	let parseError: MalformedStreamError | null = null;

	const markCancelled = () => {
		cancelled = true;
		if (tp) void terminateQuietly(registry, tp);
	};

	if (registry.isShuttingDown) {
		const result = adapter.extractResult(state);
		return {
			result,
			failure: {
				kind: "shutdown",
				message: "Pi session is shutting down; dispatch did not start.",
			},
			exitCode: null,
			signal: null,
			stderr,
		};
	}

	if (signal?.aborted) {
		const result = adapter.extractResult(state);
		return {
			result,
			failure: {
				kind: "cancelled",
				message: "Dispatch was cancelled before it started.",
			},
			exitCode: null,
			signal: null,
			stderr,
		};
	}

	const built = adapter.buildCommand(request, defaults);
	try {
		tp = registry.spawn({
			cmd: built.cmd,
			args: built.args,
			cwd: built.cwd,
			env: built.env,
		});
	} catch (error) {
		const result = adapter.extractResult(state);
		return {
			result,
			failure: {
				kind: "spawn",
				message: `Failed to launch ${adapter.name}: ${error instanceof Error ? error.message : String(error)}`,
			},
			exitCode: null,
			signal: null,
			stderr,
		};
	}

	const active = tp;
	const onAbort = () => markCancelled();
	signal?.addEventListener("abort", onAbort, { once: true });

	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	let stdoutBuffer = "";
	// A callback (parser bug or caller onUpdate) must never escape a stream
	// listener as an uncaught exception; capture it, terminate, then rethrow
	// after cleanup has run.
	let callbackError: unknown;

	const captureCallbackError = (error: unknown): void => {
		if (callbackError === undefined) callbackError = error;
		void terminateQuietly(registry, active);
	};

	const drainLines = (): void => {
		let index = stdoutBuffer.indexOf("\n");
		while (index !== -1) {
			let line = stdoutBuffer.slice(0, index);
			stdoutBuffer = stdoutBuffer.slice(index + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!parseError) {
				parseError = feedLine(adapter, state, line, onEvent);
				// A malformed line makes the rest of the stream untrustworthy. Stop
				// reading and terminate now; otherwise a CLI that emits a bad line and
				// then stalls would leave us blocked on `active.exited` forever.
				if (parseError) {
					void terminateQuietly(registry, active);
					return;
				}
			}
			index = stdoutBuffer.indexOf("\n");
		}
	};

	active.child.stdout?.on("data", (chunk: Buffer | string) => {
		try {
			if (parseError) return;
			const text = decode(stdoutDecoder, chunk);
			if (stdoutBuffer.length + text.length > MAX_LINE_CHARS) {
				parseError = new MalformedStreamError(
					`a stdout line exceeded ${MAX_LINE_CHARS} characters`,
				);
				void terminateQuietly(registry, active);
				return;
			}
			stdoutBuffer += text;
			drainLines();
		} catch (error) {
			captureCallbackError(error);
		}
	});

	active.child.stderr?.on("data", (chunk: Buffer | string) => {
		try {
			if (stderr.length >= MAX_STDERR_CHARS) return;
			const text = decode(stderrDecoder, chunk);
			if (stderr.length + text.length > MAX_STDERR_CHARS) {
				stderr = `${(stderr + text).slice(0, MAX_STDERR_CHARS)}\n[stderr truncated]`;
				return;
			}
			stderr += text;
		} catch (error) {
			captureCallbackError(error);
		}
	});

	// `exit` fires even when descendants keep the pipes open. Cleanup is
	// guaranteed even if the awaited path throws below.
	try {
		await active.exited;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		// Terminate descendants and close inherited pipes before draining output.
		await terminateQuietly(registry, active);
		await waitForClosed(active, STREAM_DRAIN_MS);
	}

	// An unexpected parser/callback failure takes precedence over a result; the
	// child has already been terminated above.
	if (callbackError !== undefined) {
		throw callbackError instanceof Error
			? callbackError
			: new Error(String(callbackError));
	}

	if (!active.spawnError) {
		const stdoutTail = stdoutDecoder.end();
		if (stdoutTail) {
			stdoutBuffer += stdoutTail;
			drainLines();
		}
		const stderrTail = stderrDecoder.end();
		if (stderrTail && stderr.length < MAX_STDERR_CHARS) stderr += stderrTail;

		// A final complete line may arrive without a trailing newline.
		if (stdoutBuffer.length > 0) {
			const line = stdoutBuffer.endsWith("\r")
				? stdoutBuffer.slice(0, -1)
				: stdoutBuffer;
			stdoutBuffer = "";
			if (!parseError) parseError = feedLine(adapter, state, line, onEvent);
		}
	}

	const result = adapter.extractResult(state);

	const failure = determineFailure({
		adapter,
		cancelled,
		spawnError: active.spawnError,
		exitCode: active.exitCode,
		signal: active.signalCode,
		parseError,
		result,
		stderr,
	});

	return {
		result,
		failure,
		exitCode: active.exitCode,
		signal: active.signalCode,
		stderr,
	};
}

interface FailureInput {
	adapter: CliAdapter;
	cancelled: boolean;
	spawnError: Error | undefined;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	parseError: MalformedStreamError | null;
	result: AdapterResult;
	stderr: string;
}

function firstLine(text: string, fallback: string): string {
	const trimmed = text.trim();
	if (!trimmed) return fallback;
	return trimmed.split("\n").slice(0, 4).join("\n");
}

function determineFailure(
	input: FailureInput,
): { kind: FailureKind; message: string } | undefined {
	const {
		adapter,
		cancelled,
		spawnError,
		exitCode,
		signal,
		parseError,
		result,
		stderr,
	} = input;

	if (cancelled) {
		return {
			kind: "cancelled",
			message: `${adapter.name} dispatch was cancelled.`,
		};
	}
	if (spawnError) {
		return {
			kind: "spawn",
			message: `Failed to launch ${adapter.name}: ${spawnError.message}`,
		};
	}
	if (parseError) {
		return {
			kind: "malformed-stream",
			message: `${adapter.name} produced an unparseable stream: ${parseError.message}`,
		};
	}
	if (signal) {
		return {
			kind: "signal",
			message: `${adapter.name} terminated by signal ${signal}.`,
		};
	}
	if (exitCode !== 0) {
		const detail = firstLine(stderr, `exit code ${exitCode ?? "unknown"}`);
		return {
			kind: "nonzero-exit",
			message: `${adapter.name} exited with code ${exitCode ?? "unknown"}: ${detail}`,
		};
	}
	if (!result.terminalSeen) {
		const detail = firstLine(result.text || stderr, "no terminal envelope");
		return {
			kind: "missing-terminal",
			message: `${adapter.name} exited 0 without a recognized terminal envelope. ${detail}`,
		};
	}
	if (result.isError) {
		const detail = firstLine(result.text || stderr, "the CLI reported an error");
		return {
			kind: "error-envelope",
			message: `${adapter.name} reported an error: ${detail}`,
		};
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Discovery helper: short-lived captured subprocesses (catalogues, config).
// ---------------------------------------------------------------------------

export interface CapturedResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	spawnError?: Error;
	cancelled: boolean;
}

/**
 * Run a short-lived command to completion and capture its output. Uses the
 * same process registry so discovery subprocesses share the dispatch
 * lifecycle (cancellation and session shutdown).
 */
export async function runCaptured(
	ctx: AdapterContext,
	cmd: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<CapturedResult> {
	if (ctx.registry.isShuttingDown) {
		return {
			stdout: "",
			stderr: "",
			exitCode: null,
			signal: null,
			cancelled: true,
		};
	}
	if (ctx.signal?.aborted) {
		return {
			stdout: "",
			stderr: "",
			exitCode: null,
			signal: null,
			cancelled: true,
		};
	}
	let tp: TrackedProcess;
	try {
		tp = ctx.registry.spawn({ cmd, args, cwd, env });
	} catch (error) {
		return {
			stdout: "",
			stderr: "",
			exitCode: null,
			signal: null,
			cancelled: false,
			spawnError: error as Error,
		};
	}
	let stdout = "";
	let stderr = "";
	let cancelled = false;
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	const onAbort = () => {
		cancelled = true;
		void terminateQuietly(ctx.registry, tp);
	};
	ctx.signal?.addEventListener("abort", onAbort, { once: true });
	tp.child.stdout?.on("data", (chunk: Buffer | string) => {
		try {
			stdout += decode(stdoutDecoder, chunk);
		} catch {
			/* ignore decode failure; treated as empty output */
		}
	});
	tp.child.stderr?.on("data", (chunk: Buffer | string) => {
		try {
			if (stderr.length < MAX_STDERR_CHARS) stderr += decode(stderrDecoder, chunk);
		} catch {
			/* ignore */
		}
	});
	try {
		await tp.exited;
	} finally {
		ctx.signal?.removeEventListener("abort", onAbort);
		await terminateQuietly(ctx.registry, tp);
		await waitForClosed(tp, STREAM_DRAIN_MS);
	}
	stdout += stdoutDecoder.end();
	stderr += stderrDecoder.end();
	return {
		stdout,
		stderr,
		exitCode: tp.exitCode,
		signal: tp.signalCode,
		spawnError: tp.spawnError,
		cancelled,
	};
}
