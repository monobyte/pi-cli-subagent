/**
 * Codex adapter (`codex exec --json`).
 *
 * Read-only launch configuration (see design.md "Capability research"):
 *   - `-s read-only` sandbox: blocks shell writes (`operation not permitted`)
 *     and file-tool writes (`patch rejected: writing is blocked by read-only
 *     sandbox`), while read-only commands execute.
 *   - `--ignore-user-config`: drops the user config so inherited MCP servers,
 *     hooks, plugins, and `notify` cannot run. User-config-defined MCP servers
 *     are not reliably removable through `-c` overrides (plugin-provided and
 *     hyphenated servers cannot be disabled), and a probe proved MCP writes are
 *     NOT constrained by the shell sandbox.
 *   - `--disable hooks --disable plugins`: belt-and-braces for feature-gated
 *     hook/plugin execution.
 *   - Because user config is ignored, the effective `model` and
 *     `model_reasoning_effort` are re-applied from the same configuration so
 *     the CLI's configured defaults are preserved.
 *
 * Codex does not report the effective model or effort in its exec JSONL, so
 * those confirmed-identity fields stay unreported.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { runCaptured } from "../runner.ts";
import {
	type AdapterContext,
	type AdapterResult,
	type AdapterState,
	type BuiltCommand,
	type CliAdapter,
	type DispatchRequest,
	MalformedStreamError,
	type ModelCatalogue,
	type ModelInfo,
	type PreflightResult,
	type ResolvedDefaults,
	type StreamEvent,
} from "../types.ts";
import {
	asNumber,
	asString,
	isRecord,
	readTomlTopLevel,
	truncate,
} from "./util.ts";

interface CodexState extends AdapterState {
	sessionId?: string;
	finalText: string;
	usage?: Usage;
	terminalSeen: boolean;
	isError: boolean;
	errorMessage?: string;
}

function newState(): CodexState {
	return { finalText: "", terminalSeen: false, isError: false };
}

function mapUsage(raw: unknown): Usage | undefined {
	if (!isRecord(raw)) return undefined;
	const inputTotal = asNumber(raw.input_tokens);
	const cacheRead = asNumber(raw.cached_input_tokens);
	const cacheWrite = asNumber(raw.cache_write_input_tokens);
	const output = asNumber(raw.output_tokens);
	const reasoning = asNumber(raw.reasoning_output_tokens);
	const input = Math.max(0, inputTotal - cacheRead);
	const usage: Usage = {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	if (reasoning > 0) usage.reasoning = reasoning;
	return usage;
}

function extractErrorMessage(
	event: Record<string, unknown>,
): string | undefined {
	if (isRecord(event.error)) {
		const message = asString(event.error.message);
		if (message) return message;
	}
	return asString(event.message);
}

function describeItem(
	item: Record<string, unknown>,
	state: CodexState,
	phase: string,
): StreamEvent | StreamEvent[] | null {
	const itemType = asString(item.type) ?? "";
	switch (itemType) {
		case "agent_message": {
			const text = asString(item.text) ?? "";
			if (phase === "item.completed") state.finalText = text;
			return text ? { type: "text", text } : null;
		}
		case "reasoning": {
			const text = asString(item.text) ?? "";
			return text ? { type: "text", text } : null;
		}
		case "command_execution": {
			const command = asString(item.command) ?? "";
			const output = asString(item.aggregated_output);
			const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
			const status =
				phase === "item.started"
					? "started"
					: phase === "item.completed"
						? "completed"
						: "completed";
			return { type: "command", command, output, exitCode, status };
		}
		case "file_change": {
			const changes = Array.isArray(item.changes) ? item.changes : [];
			const paths = changes
				.map((change) => (isRecord(change) ? asString(change.path) : undefined))
				.filter((value): value is string => Boolean(value));
			return {
				type: "command",
				command: `apply_patch ${paths.join(" ")}`.trim(),
				status: "completed",
			};
		}
		case "mcp_tool_call": {
			const server = asString(item.server) ?? "mcp";
			const tool = asString(item.tool) ?? "tool";
			return {
				type: "command",
				command: `mcp ${server}/${tool}`,
				status: "completed",
			};
		}
		case "web_search": {
			const query = asString(item.query) ?? "";
			return {
				type: "command",
				command: `web_search ${truncate(query, 80)}`,
				status: "completed",
			};
		}
		case "error": {
			const message = asString(item.message) ?? "item error";
			return { type: "error", message };
		}
		default:
			return null;
	}
}

function parseLine(
	line: string,
	state: AdapterState,
): StreamEvent | StreamEvent[] | null {
	const s = state as CodexState;
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(line) as Record<string, unknown>;
	} catch {
		throw new MalformedStreamError(`invalid JSON line: ${truncate(line)}`);
	}
	if (!isRecord(event))
		throw new MalformedStreamError(`non-object JSON line: ${truncate(line)}`);
	const type = asString(event.type) ?? "";
	switch (type) {
		case "thread.started": {
			const threadId = asString(event.thread_id);
			if (!threadId) return null;
			s.sessionId = threadId;
			return { type: "metadata", identity: { sessionId: threadId } };
		}
		case "turn.completed": {
			s.terminalSeen = true;
			const usage = mapUsage(event.usage);
			if (usage) s.usage = usage;
			return { type: "done" };
		}
		case "turn.failed": {
			s.terminalSeen = true;
			s.isError = true;
			const message = extractErrorMessage(event) ?? "turn failed";
			s.errorMessage = message;
			return { type: "error", message };
		}
		case "error": {
			// A top-level error event is a thread failure. It must stay sticky even
			// if a later `turn.completed` arrives, or a failed run reports success.
			const message = extractErrorMessage(event) ?? "stream error";
			s.errorMessage = message;
			s.isError = true;
			return { type: "error", message };
		}
		case "item.started":
		case "item.updated":
		case "item.completed": {
			const item = event.item;
			if (!isRecord(item)) return null;
			return describeItem(item, s, type);
		}
		default:
			return null;
	}
}

function extractResult(state: AdapterState): AdapterResult {
	const s = state as CodexState;
	// On failure keep both the error and any answer the agent produced. The runner
	// names the failure from the first line, and discarding the answer would throw
	// away work the caller may still want to read.
	const text = s.isError
		? [s.errorMessage, s.finalText].filter(Boolean).join("\n\n")
		: s.finalText || s.errorMessage || "";
	return {
		text,
		usage: s.usage,
		identity: { sessionId: s.sessionId },
		terminalSeen: s.terminalSeen,
		isError: s.isError,
	};
}

async function discoverModels(ctx: AdapterContext): Promise<ModelCatalogue> {
	const result = await runCaptured(
		ctx,
		"codex",
		["debug", "models"],
		process.cwd(),
		{ ...process.env },
	);
	if (result.spawnError) throw result.spawnError;
	if (result.cancelled) throw new Error("model discovery was cancelled");
	if (result.exitCode !== 0) {
		throw new Error(
			`codex debug models exited with ${result.exitCode}: ${truncate(result.stderr)}`,
		);
	}
	return parseModelCatalogue(result.stdout);
}

/** Parse the JSON catalogue emitted by `codex debug models`. */
export function parseModelCatalogue(stdout: string): ModelCatalogue {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error(
			`codex debug models returned unparseable output: ${truncate(stdout)}`,
		);
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
		throw new Error("codex debug models returned an unexpected shape");
	}
	const models: ModelInfo[] = [];
	for (const raw of parsed.models) {
		if (!isRecord(raw)) continue;
		const id = asString(raw.slug);
		if (!id) continue;
		const efforts: string[] = [];
		if (Array.isArray(raw.supported_reasoning_levels)) {
			for (const level of raw.supported_reasoning_levels) {
				if (isRecord(level)) {
					const effort = asString(level.effort);
					if (effort) efforts.push(effort);
				}
			}
		}
		const model: ModelInfo = { id, supportedEfforts: efforts };
		const displayName = asString(raw.display_name);
		if (displayName) model.displayName = displayName;
		const defaultEffort = asString(raw.default_reasoning_level);
		if (defaultEffort) model.defaultEffort = defaultEffort;
		models.push(model);
	}
	return { models };
}

/** Resolve the configured model/effort from the same Codex config tree. */
export function resolveConfiguredDefaults(
	home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
): ResolvedDefaults {
	const base = readConfigFile(path.join(home, "config.toml"));
	const profile = base.profile;
	let merged = base;
	if (profile) {
		const profileFile = readConfigFile(path.join(home, `${profile}.config.toml`));
		merged = { ...base, ...profileFile };
	}
	const defaults: ResolvedDefaults = {};
	if (merged.model) defaults.model = merged.model;
	if (merged.model_reasoning_effort)
		defaults.effort = merged.model_reasoning_effort;
	return defaults;
}

function readConfigFile(file: string): Record<string, string> {
	try {
		return readTomlTopLevel(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

async function preflight(
	req: DispatchRequest,
	ctx: AdapterContext,
): Promise<PreflightResult> {
	return validateCodexRequest(req, undefined, resolveConfiguredDefaults(), {
		discover: () => discoverModels(ctx),
	});
}

/**
 * Pure pre-validation shared by `preflight` and tests. `discover` supplies the
 * catalogue lazily; when it is unavailable the request is allowed through so
 * the CLI's own error surfaces instead of a guess.
 */
export async function validateCodexRequest(
	req: DispatchRequest,
	preloaded: ModelCatalogue | undefined,
	configured: ResolvedDefaults,
	options: { discover?: () => Promise<ModelCatalogue> } = {},
): Promise<PreflightResult> {
	const defaults: ResolvedDefaults = {};
	const effectiveModel = req.model ?? configured.model;
	if (effectiveModel) defaults.model = effectiveModel;
	if (req.effort) defaults.effort = req.effort;
	else if (configured.effort) defaults.effort = configured.effort;

	if (!req.model && !req.effort) return { ok: true, defaults };

	let catalogue = preloaded;
	if (!catalogue && options.discover) {
		try {
			catalogue = await options.discover();
		} catch {
			catalogue = undefined;
		}
	}
	if (!catalogue) return { ok: true, defaults };

	if (req.model) {
		const match = catalogue.models.find((model) => model.id === req.model);
		if (!match) {
			const valid = catalogue.models.map((model) => model.id).join(", ");
			return {
				ok: false,
				message: `Unsupported model "${req.model}" for codex. Valid models: ${valid}.`,
			};
		}
	}

	if (req.effort) {
		const target = effectiveModel
			? catalogue.models.find((model) => model.id === effectiveModel)
			: undefined;
		if (target && !target.supportedEfforts.includes(req.effort)) {
			const supported = target.supportedEfforts.join(", ");
			const suffix = target.supportedEfforts.length
				? `Supported levels: ${supported}.`
				: "This model reports no supported levels.";
			return {
				ok: false,
				message: `Unsupported reasoning effort "${req.effort}" for model "${target.id}". ${suffix}`,
			};
		}
	}

	return { ok: true, defaults };
}

function buildCommand(
	req: DispatchRequest,
	defaults?: ResolvedDefaults,
): BuiltCommand {
	const model = defaults?.model ?? req.model;
	const effort = defaults?.effort ?? req.effort;
	const args = [
		"exec",
		"--json",
		"--skip-git-repo-check",
		"-s",
		"read-only",
		"--ignore-user-config",
		"--ignore-rules",
		"--disable",
		"hooks",
		"--disable",
		"plugins",
		"-C",
		req.cwd,
	];
	if (model) args.push("-c", `model=${JSON.stringify(model)}`);
	if (effort)
		args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
	// Separate a prompt that could begin with `-` from the flag list.
	args.push("--", req.prompt);
	return {
		cmd: "codex",
		args,
		cwd: req.cwd,
		env: { ...process.env },
		stdin: "ignore",
	};
}

export const codexAdapter: CliAdapter = {
	name: "codex",
	capabilities: { readOnly: true, discoverModels: true },
	buildCommand,
	newState,
	parseLine,
	extractResult,
	preflight,
	discoverModels,
};
