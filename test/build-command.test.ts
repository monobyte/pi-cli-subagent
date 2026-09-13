import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeAdapter } from "../.pi/extensions/agent-dispatch/adapters/claude.ts";
import { codexAdapter } from "../.pi/extensions/agent-dispatch/adapters/codex.ts";

const REQ = {
	prompt: "Assess the evidence independently.\n\ntask",
	cwd: "/tmp/work",
};

test("Claude buildCommand removes ANTHROPIC_API_KEY and enforces the read-only config", () => {
	const previous = process.env.ANTHROPIC_API_KEY;
	const previousOpenai = process.env.OPENAI_API_KEY;
	process.env.ANTHROPIC_API_KEY = "sk-ant-test";
	process.env.OPENAI_API_KEY = "sk-openai-test";
	try {
		const built = claudeAdapter.buildCommand(REQ);
		assert.equal(built.cmd, "claude");
		assert.equal(built.cwd, "/tmp/work");
		assert.equal(built.stdin, "ignore");
		assert.equal(built.env.ANTHROPIC_API_KEY, undefined);
		// The CLI's scrub denylist does not cover OpenAI keys.
		assert.equal(built.env.OPENAI_API_KEY, undefined);
		assert.equal(built.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
		assert.ok(built.args.includes("--safe-mode"));
		assert.ok(built.args.includes("--strict-mcp-config"));
		const toolsIndex = built.args.indexOf("--tools");
		assert.equal(built.args[toolsIndex + 1], "Read,Bash");
		const settingsIndex = built.args.indexOf("--settings");
		const settings = JSON.parse(built.args[settingsIndex + 1] ?? "{}");
		assert.equal(settings.sandbox.enabled, true);
		assert.equal(settings.sandbox.failIfUnavailable, true);
		assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
		assert.equal(settings.sandbox.autoAllowBashIfSandboxed, true);
		// The Claude sandbox addresses absolute paths with a `//` prefix. A single
		// leading slash is instead resolved relative to the settings directory, so
		// assert the exact form rather than a substring that both would satisfy.
		assert.ok(
			settings.sandbox.filesystem.denyWrite.includes("//tmp/work"),
			`denyWrite must contain the sandbox-absolute path, got ${JSON.stringify(
				settings.sandbox.filesystem.denyWrite,
			)}`,
		);
		assert.equal(settings.disableAllHooks, true);
		// Prompts are passed as a single argument; no mandatory critique framing.
		assert.equal(built.args.at(-1), REQ.prompt);
	} finally {
		if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = previous;
		if (previousOpenai === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previousOpenai;
	}
});

test("Claude buildCommand passes model and effort through unmodified", () => {
	const built = claudeAdapter.buildCommand({
		...REQ,
		model: "claude-fable-5",
		effort: "high",
	});
	const modelIndex = built.args.indexOf("--model");
	assert.equal(built.args[modelIndex + 1], "claude-fable-5");
	const effortIndex = built.args.indexOf("--effort");
	assert.equal(built.args[effortIndex + 1], "high");
});

test("Codex buildCommand enforces read-only and ignores inherited config", () => {
	const built = codexAdapter.buildCommand(REQ);
	assert.equal(built.cmd, "codex");
	assert.equal(built.stdin, "ignore");
	const joined = built.args.join(" ");
	assert.match(joined, /-s read-only/);
	assert.match(joined, /--ignore-user-config/);
	assert.match(joined, /--ignore-rules/);
	assert.match(joined, /--disable hooks/);
	assert.match(joined, /--disable plugins/);
	assert.match(joined, /-C \/tmp\/work/);
	assert.equal(built.args.at(-1), REQ.prompt);
	// No model/effort override when neither is requested or configured.
	assert.doesNotMatch(joined, /-c model=/);
});

test("Codex buildCommand re-applies resolved defaults as config overrides", () => {
	const built = codexAdapter.buildCommand(REQ, {
		model: "gpt-6-astra",
		effort: "medium",
	});
	const joined = built.args.join(" ");
	assert.match(joined, /-c model="gpt-6-astra"/);
	assert.match(joined, /-c model_reasoning_effort="medium"/);
});

test("Codex buildCommand leaves the ambient environment intact", () => {
	const previous = process.env.ANTHROPIC_API_KEY;
	process.env.ANTHROPIC_API_KEY = "sk-ant-test";
	try {
		const built = codexAdapter.buildCommand(REQ);
		assert.equal(built.env.ANTHROPIC_API_KEY, "sk-ant-test");
	} finally {
		if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = previous;
	}
});
