import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
	codexAdapter,
	parseModelCatalogue,
	resolveConfiguredDefaults,
	validateCodexRequest,
} from "../.pi/extensions/agent-dispatch/adapters/codex.ts";
import {
	MalformedStreamError,
	type StreamEvent,
} from "../.pi/extensions/agent-dispatch/types.ts";
import { readTomlTopLevel } from "../.pi/extensions/agent-dispatch/adapters/util.ts";
import { makeTempDir } from "./helpers.ts";

// Captured `codex exec --json` event log (read-only no-op run).
const CAPTURED = [
	'{"type":"thread.started","thread_id":"01a09bb6-5c91-7dd2-91ee-39a41b3b81b5"}',
	'{"type":"turn.started"}',
	'{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll run the two commands."}}',
	'{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \'echo READ_ONLY_OK\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
	'{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \'echo READ_ONLY_OK\'","aggregated_output":"READ_ONLY_OK\\n","exit_code":0,"status":"completed"}}',
	'{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Command A stdout:\\nREAD_ONLY_OK"}}',
	'{"type":"turn.completed","usage":{"input_tokens":43303,"cached_input_tokens":34304,"cache_write_input_tokens":0,"output_tokens":124,"reasoning_output_tokens":0}}',
];

function feed(lines: string[]) {
	const state = codexAdapter.newState();
	const events = [];
	for (const line of lines) {
		const parsed = codexAdapter.parseLine(line, state);
		if (parsed) events.push(...(Array.isArray(parsed) ? parsed : [parsed]));
	}
	return { state, events, result: codexAdapter.extractResult(state) };
}

test("maps Codex JSONL into text, command, metadata, and done events", () => {
	const { events, result } = feed(CAPTURED);
	const metadata = events.find((event) => event.type === "metadata");
	assert.deepEqual(metadata, {
		type: "metadata",
		identity: { sessionId: "01a09bb6-5c91-7dd2-91ee-39a41b3b81b5" },
	});
	const command = events.find(
		(event): event is Extract<StreamEvent, { type: "command" }> =>
			event.type === "command" && event.exitCode === 0,
	);
	assert.ok(command && command.type === "command");
	assert.equal(command.command, "/bin/zsh -lc 'echo READ_ONLY_OK'");
	assert.equal(command.exitCode, 0);
	assert.equal(command.output, "READ_ONLY_OK\n");
	assert.equal(events.at(-1)?.type, "done");
	assert.equal(result.terminalSeen, true);
	assert.equal(result.isError, false);
	// The final agent message is the answer; progress text is not duplicated.
	assert.equal(result.text, "Command A stdout:\nREAD_ONLY_OK");
	assert.equal(
		result.identity.sessionId,
		"01a09bb6-5c91-7dd2-91ee-39a41b3b81b5",
	);
	// Codex does not report model or effort in exec JSONL.
	assert.equal(result.identity.model, undefined);
	assert.equal(result.identity.effort, undefined);
});

test("usage matches the raw event log without double-counting cached input", () => {
	const { result } = feed(CAPTURED);
	assert.ok(result.usage);
	assert.equal(result.usage.input, 43303 - 34304);
	assert.equal(result.usage.cacheRead, 34304);
	assert.equal(result.usage.cacheWrite, 0);
	assert.equal(result.usage.output, 124);
	assert.equal(
		result.usage.totalTokens,
		result.usage.input + result.usage.output + 34304,
	);
});

test("does not double-count repeated cumulative usage reports", () => {
	const { result } = feed([
		'{"type":"thread.started","thread_id":"t-usage"}',
		'{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":1}}',
		'{"type":"turn.completed","usage":{"input_tokens":25,"output_tokens":3}}',
	]);
	assert.equal(result.usage?.input, 25);
	assert.equal(result.usage?.output, 3);
});

test("ignores unknown well-formed events without treating them as completion", () => {
	const { events, result } = feed(['{"type":"future.event","payload":{"a":1}}']);
	assert.equal(events.length, 0);
	assert.equal(result.terminalSeen, false);
});

test("throws MalformedStreamError on invalid JSON", () => {
	const state = codexAdapter.newState();
	assert.throws(
		() => codexAdapter.parseLine("not json", state),
		MalformedStreamError,
	);
});

test("maps an error event into an error state", () => {
	const { result } = feed([
		'{"type":"thread.started","thread_id":"t1"}',
		'{"type":"error","message":"boom"}',
	]);
	assert.equal(result.isError, true);
	assert.equal(result.text, "boom");
});

test("maps turn.failed into a terminal error state", () => {
	const { result } = feed([
		'{"type":"thread.started","thread_id":"t1"}',
		'{"type":"turn.failed","error":{"message":"turn exploded"}}',
	]);
	assert.equal(result.isError, true);
	assert.equal(result.terminalSeen, true);
});

test("keeps a top-level error fatal when turn.completed follows", () => {
	// Regression: `error` used to record only a message, so a later completion
	// envelope made a failed run report success and dropped the error text.
	const { result } = feed([
		'{"type":"thread.started","thread_id":"t1"}',
		'{"type":"error","message":"boom"}',
		'{"type":"item.completed","item":{"type":"agent_message","text":"the answer"}}',
		'{"type":"turn.completed"}',
	]);
	assert.equal(result.terminalSeen, true);
	assert.equal(result.isError, true);
	// The error names the failure, and the agent's answer is still reported.
	assert.match(result.text, /^boom/);
	assert.match(result.text, /the answer/);
});

test("parses the model catalogue with slugs and supported efforts", () => {
	const raw = JSON.stringify({
		models: [
			{
				slug: "gpt-6-astra",
				display_name: "GPT-6 Astra",
				default_reasoning_level: "medium",
				supported_reasoning_levels: [
					{ effort: "low" },
					{ effort: "medium" },
					{ effort: "high" },
				],
			},
		],
	});
	const catalogue = parseModelCatalogue(raw);
	assert.equal(catalogue.models.length, 1);
	assert.deepEqual(catalogue.models[0], {
		id: "gpt-6-astra",
		displayName: "GPT-6 Astra",
		defaultEffort: "medium",
		supportedEfforts: ["low", "medium", "high"],
	});
});

test("rejects an unsupported model and names valid alternatives", async () => {
	const catalogue = parseModelCatalogue(
		JSON.stringify({
			models: [
				{ slug: "gpt-6-astra", supported_reasoning_levels: [{ effort: "medium" }] },
			],
		}),
	);
	const result = await validateCodexRequest(
		{ prompt: "p", cwd: "/tmp", model: "nope" },
		catalogue,
		{},
	);
	assert.equal(result.ok, false);
	assert.match(result.message ?? "", /Unsupported model "nope"/);
	assert.match(result.message ?? "", /gpt-6-astra/);
});

test("rejects an unsupported effort and lists supported levels", async () => {
	const catalogue = parseModelCatalogue(
		JSON.stringify({
			models: [
				{
					slug: "gpt-6-astra",
					supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
				},
			],
		}),
	);
	const result = await validateCodexRequest(
		{ prompt: "p", cwd: "/tmp", model: "gpt-6-astra", effort: "max" },
		catalogue,
		{},
	);
	assert.equal(result.ok, false);
	assert.match(result.message ?? "", /Unsupported reasoning effort "max"/);
	assert.match(result.message ?? "", /low, medium/);
});

test("effort-only validation uses the effective configured model and adds no model override", async () => {
	const catalogue = parseModelCatalogue(
		JSON.stringify({
			models: [
				{
					slug: "gpt-6-astra",
					supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
				},
			],
		}),
	);
	const configured = { model: "gpt-6-astra", effort: "medium" };
	const ok = await validateCodexRequest(
		{ prompt: "p", cwd: "/tmp", effort: "low" },
		catalogue,
		configured,
	);
	assert.equal(ok.ok, true);
	// The model is re-applied only to preserve the ignored user config.
	assert.equal(ok.defaults?.model, "gpt-6-astra");
	assert.equal(ok.defaults?.effort, "low");

	const bad = await validateCodexRequest(
		{ prompt: "p", cwd: "/tmp", effort: "ultra" },
		catalogue,
		configured,
	);
	assert.equal(bad.ok, false);
	assert.match(bad.message ?? "", /gpt-6-astra/);
});

test("accepts a request when no catalogue is available and adds no override", async () => {
	const result = await validateCodexRequest(
		{ prompt: "p", cwd: "/tmp", model: "whatever" },
		undefined,
		{},
		{
			discover: async () => {
				throw new Error("catalogue unavailable");
			},
		},
	);
	assert.equal(result.ok, true);
	assert.equal(result.defaults?.model, "whatever");
});

test("resolves configured model/effort, with profile override", () => {
	const home = makeTempDir("codex-home-");
	fs.writeFileSync(
		path.join(home, "config.toml"),
		[
			'model = "gpt-6-astra"',
			'model_reasoning_effort = "medium"',
			'profile = "work"',
			"",
			"[mcp_servers.x]",
		].join("\n"),
	);
	fs.writeFileSync(path.join(home, "work.config.toml"), 'model = "gpt-5.5"\n');
	const defaults = resolveConfiguredDefaults(home);
	assert.equal(defaults.model, "gpt-5.5");
	assert.equal(defaults.effort, "medium");
	assert.throws(() => parseModelCatalogue("not json"));
});

test("reads top-level TOML scalars with inline comments", () => {
	const parsed = readTomlTopLevel(
		[
			'model = "gpt-6-astra" # pinned by hand',
			"model_reasoning_effort = 'medium'  # notes",
			'name = "has # hash inside"',
			"[mcp_servers.x]",
			'model = "ignored"',
		].join("\n"),
	);
	assert.equal(parsed.model, "gpt-6-astra");
	assert.equal(parsed.model_reasoning_effort, "medium");
	assert.equal(parsed.name, "has # hash inside");
});
