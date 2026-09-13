/**
 * Shared types for the agent-dispatch extension.
 *
 * The adapter contract is intentionally CLI-agnostic: the dispatch tool, the
 * runner, the usage accounting, and the renderer all consume `StreamEvent` and
 * `AdapterResult` and never branch on the CLI name. Adding a CLI is one new
 * adapter module.
 */

import type { Usage } from "@earendil-works/pi-ai";

/**
 * Normalized event emitted by every adapter while a dispatch is running.
 *
 * `done` means a recognized terminal envelope was parsed, not merely that
 * stdout closed. `metadata` carries CLI-reported (confirmed) identity.
 */
export type StreamEvent =
	| { type: "text"; text: string }
	| {
			type: "command";
			command: string;
			output?: string;
			exitCode?: number | null;
			status?: "started" | "completed" | "failed";
	  }
	| { type: "metadata"; identity: Partial<ConfirmedIdentity> }
	| { type: "error"; message: string }
	| { type: "done" };

/** Identity as reported by the CLI itself. Absent fields are unreported. */
export interface ConfirmedIdentity {
	model?: string;
	effort?: string;
	sessionId?: string;
}

/** Typed failure marker carried in the tool result details. */
export type FailureKind =
	| "missing-cli"
	| "unsupported-cli"
	| "cli-not-installed"
	| "spawn"
	| "nonzero-exit"
	| "error-envelope"
	| "signal"
	| "malformed-stream"
	| "missing-terminal"
	| "cancelled"
	| "shutdown"
	| "invalid-request"
	| "read-only-unavailable";

/** Result extracted from an adapter's accumulated stream state. */
export interface AdapterResult {
	/** Final answer text. */
	text: string;
	/** Reported usage, or undefined when the CLI did not report any. */
	usage?: Usage;
	/** CLI-reported identity. */
	identity: ConfirmedIdentity;
	/** Whether a recognized terminal envelope was parsed. */
	terminalSeen: boolean;
	/** Whether the terminal envelope reported an error. */
	isError: boolean;
}

export interface ModelInfo {
	id: string;
	displayName?: string;
	defaultEffort?: string;
	supportedEfforts: string[];
}

export interface ModelCatalogue {
	models: ModelInfo[];
}

export interface DispatchRequest {
	prompt: string;
	cwd: string;
	model?: string;
	effort?: string;
}

/** Values the adapter must re-apply at launch (for example ignored user config). */
export interface ResolvedDefaults {
	model?: string;
	effort?: string;
}

export interface AdapterCapabilities {
	/**
	 * True only when the adapter can enforce read-only for the complete launch
	 * configuration (shell, file tools, hooks, MCP). Dispatch refuses otherwise.
	 */
	readOnly: boolean;
	/** True when the adapter can enumerate models/efforts for pre-validation. */
	discoverModels: boolean;
}

export interface BuiltCommand {
	cmd: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** Every spawn closes stdin; an open pipe can hang or append a `<stdin>` block. */
	stdin: "ignore";
}

export interface PreflightResult {
	ok: boolean;
	/** Populated when `ok` is false. */
	message?: string;
	/** Resolved launch defaults to re-apply. */
	defaults?: ResolvedDefaults;
}

/** Context passed to adapter discovery/preflight subprocess helpers. */
export interface AdapterContext {
	registry: import("./process-registry.ts").ProcessRegistry;
	signal?: AbortSignal;
}

/**
 * The contract every supported CLI implements. `buildCommand`, `parseLine`,
 * and `extractResult` are required; `preflight` and `discoverModels` are
 * optional because some CLIs expose no catalogue.
 */
export interface CliAdapter {
	readonly name: string;
	readonly capabilities: AdapterCapabilities;
	buildCommand(req: DispatchRequest, defaults?: ResolvedDefaults): BuiltCommand;
	newState(): AdapterState;
	parseLine(
		line: string,
		state: AdapterState,
	): StreamEvent | StreamEvent[] | null;
	extractResult(state: AdapterState): AdapterResult;
	/** Validate a request against the CLI's own catalogue before spawning. */
	preflight?(
		req: DispatchRequest,
		ctx: AdapterContext,
	): Promise<PreflightResult>;
	/** Enumerate the CLI's models and supported efforts. */
	discoverModels?(ctx: AdapterContext): Promise<ModelCatalogue>;
}

/**
 * Opaque per-run parse state owned by an adapter. Each adapter owns its own
 * concrete shape (extending this interface) and casts at its own boundary.
 */
export interface AdapterState {
	[key: string]: unknown;
}

/** Raised by `parseLine` when a line is not well-formed CLI output. */
export class MalformedStreamError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MalformedStreamError";
	}
}

// ---------------------------------------------------------------------------
// Tool result details (consumed by the renderer and the tool_result handler)
// ---------------------------------------------------------------------------

export interface ActivityItem {
	kind: "text" | "command" | "metadata" | "error";
	text: string;
}

export interface DispatchDetails {
	cli: string;
	requested: { model?: string; effort?: string };
	confirmed: ConfirmedIdentity;
	failure?: { kind: FailureKind; message: string };
	activity: ActivityItem[];
	durationMs?: number;
	stderr?: string;
}

/** Caller-supplied dispatch arguments, used by the renderer. */
export interface DispatchArgs {
	task?: string;
	cli?: string;
	model?: string;
	effort?: string;
	scope?: string;
}
