/**
 * Claude Code adapter (`claude -p --output-format stream-json`).
 *
 * Read-only launch configuration (see design.md "Capability research"):
 *   - `--safe-mode`: disables inherited hooks, MCP servers, plugins, skills,
 *     and other customizations. `--strict-mcp-config` with no `--mcp-config`
 *     is a second gate that ignores all other MCP configuration.
 *   - `--tools "Read,Bash"`: only read-only built-ins are available. File
 *     tools (`Edit`, `Write`, `NotebookEdit`) and worktree/scheduling tools
 *     are absent, so those write paths are disabled rather than merely
 *     discouraged.
 *   - Sandbox settings with `failIfUnavailable: true` and
 *     `allowUnsandboxedCommands: false`: Bash runs in the OS sandbox and
 *     cannot escape it. `filesystem.denyWrite` covers the working tree and the
 *     repository root, so a shell write fails (`operation not permitted`)
 *     while read-only commands still execute.
 *   - `ANTHROPIC_API_KEY` is removed from the child environment. When present,
 *     Claude selects the API key instead of the working subscription login and
 *     fails with "Credit balance is too low".
 *
 * Claude exposes no model catalogue, so there is no pre-validation: an unknown
 * model reaches the caller as the CLI's own error message. Claude does not
 * report a reasoning effort, so that confirmed field stays unreported.
 */

import type { Usage } from "@earendil-works/pi-ai";
import {
	type AdapterResult,
	type AdapterState,
	type BuiltCommand,
	type CliAdapter,
	type DispatchRequest,
	MalformedStreamError,
	type ResolvedDefaults,
	type StreamEvent,
} from "../types.ts";
import {
	absoluteSandboxPath,
	asNumber,
	asString,
	findRepoRoot,
	isRecord,
	truncate,
} from "./util.ts";

interface ClaudeState extends AdapterState {
	sessionId?: string;
	model?: string;
	finalText: string;
	/** Usage reported by the terminal result envelope, when present. */
	terminalUsage?: Usage;
	/** Per-message usage keyed by message id, for runs that end early. */
	usageByMessage: Map<string, Record<string, unknown>>;
	terminalSeen: boolean;
	isError: boolean;
}

function newState(): ClaudeState {
	return {
		finalText: "",
		terminalSeen: false,
		isError: false,
		usageByMessage: new Map<string, Record<string, unknown>>(),
	};
}

/**
 * Sum unique per-message usage samples. Used when a run ends before its
 * terminal envelope, so already-reported usage is not discarded. Cost is not
 * summed here because per-message events do not report it; a terminal result
 * supersedes this value whenever one arrives.
 */
function accumulateUsage(
	samples: Map<string, Record<string, unknown>>,
): Usage | undefined {
	if (samples.size === 0) return undefined;
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let reasoning = 0;
	for (const raw of samples.values()) {
		input += asNumber(raw.input_tokens);
		output += asNumber(raw.output_tokens);
		cacheRead += asNumber(raw.cache_read_input_tokens);
		cacheWrite += asNumber(raw.cache_creation_input_tokens);
		const details = isRecord(raw.output_tokens_details)
			? raw.output_tokens_details
			: undefined;
		if (details) reasoning += asNumber(details.thinking_tokens);
	}
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

function mapUsage(raw: unknown, totalCost: unknown): Usage | undefined {
	if (!isRecord(raw)) return undefined;
	const input = asNumber(raw.input_tokens);
	const output = asNumber(raw.output_tokens);
	const cacheRead = asNumber(raw.cache_read_input_tokens);
	const cacheWrite = asNumber(raw.cache_creation_input_tokens);
	const cost = asNumber(totalCost);
	const details = isRecord(raw.output_tokens_details)
		? raw.output_tokens_details
		: undefined;
	const reasoning = details ? asNumber(details.thinking_tokens) : 0;
	const usage: Usage = {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
	if (reasoning > 0) usage.reasoning = reasoning;
	return usage;
}

function describeToolUse(part: Record<string, unknown>): string {
	const name = asString(part.name) ?? "tool";
	const input = isRecord(part.input) ? part.input : {};
	if (name === "Bash") {
		const command = asString(input.command);
		if (command) return command;
	}
	const path = asString(input.file_path) ?? asString(input.path);
	if (path) return `${name} ${path}`;
	const pattern = asString(input.pattern);
	if (pattern) return `${name} ${pattern}`;
	return name;
}

function flattenToolResult(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (isRecord(part) ? (asString(part.text) ?? "") : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function parseLine(
	line: string,
	state: AdapterState,
): StreamEvent | StreamEvent[] | null {
	const s = state as ClaudeState;
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
		case "system": {
			if (asString(event.subtype) !== "init") return null;
			const sessionId = asString(event.session_id);
			const model = asString(event.model);
			if (sessionId) s.sessionId = sessionId;
			if (model) s.model = model;
			if (!sessionId && !model) return null;
			return { type: "metadata", identity: { sessionId, model } };
		}
		case "assistant": {
			const message = isRecord(event.message) ? event.message : undefined;
			if (!message) return null;
			const model = asString(message.model);
			if (model) s.model = model;
			const messageId = asString(message.id);
			const messageUsage = isRecord(message.usage) ? message.usage : undefined;
			if (messageId && messageUsage) {
				// Same id repeats across streaming updates; keep the latest only.
				s.usageByMessage.set(messageId, messageUsage);
			}
			const events: StreamEvent[] = [];
			if (model) events.push({ type: "metadata", identity: { model } });
			const content = Array.isArray(message.content) ? message.content : [];
			for (const rawPart of content) {
				if (!isRecord(rawPart)) continue;
				const partType = asString(rawPart.type);
				if (partType === "text") {
					const text = asString(rawPart.text);
					if (text) events.push({ type: "text", text });
				} else if (partType === "tool_use") {
					events.push({
						type: "command",
						command: describeToolUse(rawPart),
						status: "started",
					});
				}
			}
			return events.length ? events : null;
		}
		case "user": {
			const message = isRecord(event.message) ? event.message : undefined;
			const content =
				message && Array.isArray(message.content) ? message.content : [];
			const events: StreamEvent[] = [];
			for (const rawPart of content) {
				if (!isRecord(rawPart) || asString(rawPart.type) !== "tool_result")
					continue;
				const output = flattenToolResult(rawPart.content);
				const failed = rawPart.is_error === true;
				events.push({
					type: "command",
					command: "tool result",
					output,
					status: failed ? "failed" : "completed",
				});
			}
			return events.length ? events : null;
		}
		case "result": {
			s.terminalSeen = true;
			const subtype = asString(event.subtype) ?? "";
			s.isError = event.is_error === true || subtype.startsWith("error");
			const text = asString(event.result);
			if (text) s.finalText = text;
			const sessionId = asString(event.session_id);
			if (sessionId) s.sessionId = sessionId;
			const usage = mapUsage(event.usage, event.total_cost_usd);
			if (usage) s.terminalUsage = usage;
			return { type: "done" };
		}
		default:
			return null;
	}
}

function extractResult(state: AdapterState): AdapterResult {
	const s = state as ClaudeState;
	return {
		text: s.finalText,
		// The terminal envelope is authoritative; fall back to per-message usage
		// when a run is cancelled before completion.
		usage: s.terminalUsage ?? accumulateUsage(s.usageByMessage),
		identity: { sessionId: s.sessionId, model: s.model },
		terminalSeen: s.terminalSeen,
		isError: s.isError,
	};
}

function readOnlySettings(cwd: string): Record<string, unknown> {
	const denyWrite = new Set<string>();
	denyWrite.add(absoluteSandboxPath(cwd));
	const repoRoot = findRepoRoot(cwd);
	if (repoRoot) denyWrite.add(absoluteSandboxPath(repoRoot));
	return {
		sandbox: {
			enabled: true,
			failIfUnavailable: true,
			autoAllowBashIfSandboxed: true,
			allowUnsandboxedCommands: false,
			filesystem: { denyWrite: [...denyWrite] },
		},
		disableAllHooks: true,
	};
}

function buildCommand(
	req: DispatchRequest,
	defaults?: ResolvedDefaults,
): BuiltCommand {
	const model = defaults?.model ?? req.model;
	const effort = defaults?.effort ?? req.effort;
	const args = [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--safe-mode",
		"--strict-mcp-config",
		"--tools",
		"Read,Bash",
		"--settings",
		JSON.stringify(readOnlySettings(req.cwd)),
	];
	if (model) args.push("--model", model);
	if (effort) args.push("--effort", effort);
	args.push("--", req.prompt);
	const env = { ...process.env };
	delete env.ANTHROPIC_API_KEY;
	// The CLI's scrub denylist omits OpenAI keys, and this extension exists to
	// dispatch to Codex, so an OPENAI_API_KEY is commonly present in the parent
	// environment. Claude authenticates through its own login, not this variable.
	delete env.OPENAI_API_KEY;
	// Strip Anthropic and cloud-provider credentials from every subprocess the CLI
	// spawns (Bash tool, hooks, MCP stdio servers) while the CLI keeps its own
	// authentication. This is a denylist, not an allowlist: bespoke secrets are
	// still visible, and setting it forces the CLI's permission mode to `default`,
	// so commands the static analyzer deems sensitive need approval (read-only
	// review commands such as `git diff` are unaffected).
	env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
	return { cmd: "claude", args, cwd: req.cwd, env, stdin: "ignore" };
}

export const claudeAdapter: CliAdapter = {
	name: "claude",
	capabilities: { readOnly: true, discoverModels: false },
	buildCommand,
	newState,
	parseLine,
	extractResult,
};
