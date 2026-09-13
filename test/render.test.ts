import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	identityLine,
	renderDispatchCall,
	renderDispatchResult,
} from "../.pi/extensions/agent-dispatch/render.ts";
import type { DispatchDetails } from "../.pi/extensions/agent-dispatch/types.ts";

initTheme();

// Minimal theme stub: render.ts only uses `fg` and `bold`.
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function details(overrides: Partial<DispatchDetails> = {}): DispatchDetails {
	return {
		cli: "codex",
		requested: {},
		confirmed: {},
		activity: [],
		...overrides,
	};
}

function rendered(component: { render(width: number): string[] }): string {
	return component.render(120).join("\n");
}

test("shows the CLI and requested model/effort with confirmation pending", () => {
	const call = rendered(
		renderDispatchCall(
			{ cli: "codex", model: "gpt-6-astra", effort: "high" },
			theme,
		),
	);
	assert.match(call, /dispatch/);
	assert.match(call, /codex/);
	assert.match(call, /model gpt-6-astra/);
	assert.match(call, /effort high/);
	assert.match(call, /confirmation pending/);
	const defaults = rendered(renderDispatchCall({ cli: "claude" }, theme));
	assert.match(defaults, /model CLI default/);
	assert.match(defaults, /effort CLI default/);
});

test("labels confirmed identity and shows not reported for missing values", () => {
	const pending = identityLine(
		details({ requested: { model: "gpt-6-astra" } }),
		theme,
		true,
	);
	assert.match(pending, /gpt-6-astra \(pending\)/);
	const confirmed = identityLine(
		details({
			requested: { model: "sonnet", effort: "high" },
			confirmed: { model: "claude-sonnet-5" },
		}),
		theme,
		false,
	);
	assert.match(confirmed, /sonnet \(confirmed: claude-sonnet-5\)/);
	assert.match(confirmed, /effort high \(confirmed: not reported\)/);
});

test("shows confirmed identity as soon as metadata arrives, even while running", () => {
	const before = identityLine(
		details({ requested: { model: "sonnet" } }),
		theme,
		true,
	);
	assert.match(before, /sonnet \(pending\)/);
	const after = identityLine(
		details({
			requested: { model: "sonnet" },
			confirmed: { model: "claude-sonnet-5" },
		}),
		theme,
		true,
	);
	assert.match(after, /sonnet \(confirmed: claude-sonnet-5\)/);
});

test("streams a live tail of agent activity while partial", () => {
	const result: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "working" }],
		details: details({
			activity: [
				{ kind: "text", text: "thinking about it" },
				{ kind: "command", text: "git diff --stat" },
			],
		}),
	};
	const text = rendered(
		renderDispatchResult(result, { expanded: false, isPartial: true }, theme),
	);
	assert.match(text, /working|thinking about it/);
	assert.match(text, /git diff --stat/);
	assert.match(text, /pending/);
});

test("shows a compact settled summary that expands to the full response", () => {
	const result: AgentToolResult<unknown> = {
		content: [
			{ type: "text", text: "Line one summary\nSecond detailed line\nThird line" },
		],
		details: details({ confirmed: { model: "gpt-6-astra" } }),
	};
	const collapsed = rendered(
		renderDispatchResult(result, { expanded: false, isPartial: false }, theme),
	);
	assert.match(collapsed, /Line one summary/);
	assert.match(collapsed, /to expand/);
	assert.doesNotMatch(collapsed, /Third line/);
	const expanded = rendered(
		renderDispatchResult(result, { expanded: true, isPartial: false }, theme),
	);
	assert.match(expanded, /Third line/);
});

test("renders a failed dispatch with the agent's diagnostic text", () => {
	const result: AgentToolResult<unknown> = {
		content: [
			{ type: "text", text: "codex reported an error: upstream exploded" },
		],
		details: details({
			failure: {
				kind: "error-envelope",
				message: "codex reported an error: upstream exploded",
			},
		}),
	};
	const text = rendered(
		renderDispatchResult(result, { expanded: false, isPartial: false }, theme),
	);
	assert.match(text, /upstream exploded/);
});
