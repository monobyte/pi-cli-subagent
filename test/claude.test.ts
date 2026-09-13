import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeAdapter } from "../.pi/extensions/agent-dispatch/adapters/claude.ts";
import { MalformedStreamError } from "../.pi/extensions/agent-dispatch/types.ts";

const INIT =
	'{"type":"system","subtype":"init","cwd":"/private/tmp/dprobe","session_id":"f00d58e7-8ec3-48d9-9832-1e2f8173c42f","tools":["Bash","Read"],"mcp_servers":[],"model":"claude-sonnet-5","apiKeySource":"none"}';
const ASSISTANT_TOOL =
	'{"type":"assistant","message":{"model":"claude-sonnet-5","content":[{"type":"text","text":"Running."},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"echo READ_OK"}}]}}';
const USER_TOOL_RESULT =
	'{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"READ_OK","is_error":false}]}}';
const RESULT =
	'{"type":"result","subtype":"success","is_error":false,"session_id":"f00d58e7-8ec3-48d9-9832-1e2f8173c42f","result":"All done.","stop_reason":"end_turn","usage":{"input_tokens":4,"output_tokens":321,"cache_read_input_tokens":13708,"cache_creation_input_tokens":14036,"output_tokens_details":{"thinking_tokens":0}},"total_cost_usd":0.0631356,"num_turns":3}';
const ERROR_RESULT =
	'{"type":"result","subtype":"success","is_error":true,"session_id":"s","result":"Credit balance is too low","api_error_status":400,"usage":{"input_tokens":2,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"total_cost_usd":0.01}';

function feed(lines: string[]) {
	const state = claudeAdapter.newState();
	const events = [];
	for (const line of lines) {
		const parsed = claudeAdapter.parseLine(line, state);
		if (parsed) events.push(...(Array.isArray(parsed) ? parsed : [parsed]));
	}
	return { state, events, result: claudeAdapter.extractResult(state) };
}

test("maps the init envelope to confirmed model and session identity", () => {
	const { result } = feed([INIT]);
	assert.equal(
		result.identity.sessionId,
		"f00d58e7-8ec3-48d9-9832-1e2f8173c42f",
	);
	assert.equal(result.identity.model, "claude-sonnet-5");
	assert.equal(result.identity.effort, undefined);
});

test("surfaces agent text and tool activity as stream events", () => {
	const { events } = feed([INIT, ASSISTANT_TOOL, USER_TOOL_RESULT]);
	const text = events.find((event) => event.type === "text");
	assert.ok(text && text.type === "text");
	assert.equal(text.text, "Running.");
	const commands = events.filter((event) => event.type === "command");
	assert.ok(commands.length >= 2);
	assert.equal(
		commands[0]?.type === "command" ? commands[0].command : undefined,
		"echo READ_OK",
	);
});

test("extracts the final result, usage, and terminal state", () => {
	const { result, events } = feed([INIT, ASSISTANT_TOOL, RESULT]);
	assert.equal(events.at(-1)?.type, "done");
	assert.equal(result.terminalSeen, true);
	assert.equal(result.isError, false);
	assert.equal(result.text, "All done.");
	assert.ok(result.usage);
	assert.equal(result.usage.input, 4);
	assert.equal(result.usage.output, 321);
	assert.equal(result.usage.cacheRead, 13708);
	assert.equal(result.usage.cacheWrite, 14036);
	assert.equal(result.usage.totalTokens, 4 + 321 + 13708 + 14036);
	assert.equal(result.usage.cost.total, 0.0631356);
});

test("retains diagnostics and usage for a reported error envelope", () => {
	const { result } = feed([ERROR_RESULT]);
	assert.equal(result.terminalSeen, true);
	assert.equal(result.isError, true);
	assert.equal(result.text, "Credit balance is too low");
	assert.equal(result.usage?.input, 2);
	assert.equal(result.usage?.cost.total, 0.01);
});

test("ignores unknown well-formed events and rate-limit notices", () => {
	const { result, events } = feed([
		'{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
	]);
	assert.equal(events.length, 0);
	assert.equal(result.terminalSeen, false);
});

test("throws MalformedStreamError on invalid JSON", () => {
	assert.throws(
		() => claudeAdapter.parseLine("{truncated", claudeAdapter.newState()),
		MalformedStreamError,
	);
});

test("reports no model catalogue and no preflight validation", () => {
	assert.equal(claudeAdapter.capabilities.discoverModels, false);
	assert.equal(claudeAdapter.discoverModels, undefined);
	assert.equal(claudeAdapter.preflight, undefined);
});

function assistantWithUsage(id: string, outputTokens: number): string {
	return `{"type":"assistant","message":{"id":"${id}","model":"claude-sonnet-5","usage":{"input_tokens":2,"output_tokens":${outputTokens},"cache_read_input_tokens":10,"cache_creation_input_tokens":5},"content":[{"type":"text","text":"partial"}]}}`;
}

test("retains per-message usage when the run ends before the terminal envelope", () => {
	const { result } = feed([INIT, assistantWithUsage("msg_1", 3)]);
	assert.equal(result.terminalSeen, false);
	assert.ok(result.usage, "assistant-reported usage must not be discarded");
	assert.equal(result.usage.input, 2);
	assert.equal(result.usage.output, 3);
	assert.equal(result.usage.cacheRead, 10);
	assert.equal(result.usage.cacheWrite, 5);
	assert.equal(result.usage.totalTokens, 2 + 3 + 10 + 5);
});

test("deduplicates repeated assistant usage and prefers terminal totals", () => {
	const withTerminal = feed([
		INIT,
		assistantWithUsage("msg_1", 3),
		assistantWithUsage("msg_1", 3),
		RESULT,
	]);
	// Terminal envelope is authoritative when present.
	assert.equal(withTerminal.result.usage?.input, 4);
	assert.equal(withTerminal.result.usage?.output, 321);

	const withoutTerminal = feed([
		INIT,
		assistantWithUsage("msg_1", 3),
		assistantWithUsage("msg_1", 3),
		assistantWithUsage("msg_2", 5),
	]);
	// 3 + 5, not 3 + 3 + 5.
	assert.equal(withoutTerminal.result.usage?.output, 8);
});
