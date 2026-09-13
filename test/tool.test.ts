import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ProcessRegistry } from "../.pi/extensions/agent-dispatch/process-registry.ts";
import {
	isDispatchFailure,
	registerDispatchTool,
} from "../.pi/extensions/agent-dispatch/tool.ts";
import type { DispatchDetails } from "../.pi/extensions/agent-dispatch/types.ts";
import { makeTempDir } from "./helpers.ts";

interface FakeTool {
	name: string;
	parameters: { properties?: Record<string, unknown> };
	execute: (...args: unknown[]) => Promise<unknown>;
}

interface FakePi {
	tools: Map<string, FakeTool>;
	handlers: Map<string, (event: unknown) => Promise<unknown>>;
	registerTool(definition: FakeTool): void;
	on(event: string, handler: (event: unknown) => Promise<unknown>): void;
}

function makeFakePi(): FakePi {
	const tools = new Map<string, FakeTool>();
	const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
	return {
		tools,
		handlers,
		registerTool(definition: FakeTool) {
			tools.set(definition.name, definition);
		},
		on(event: string, handler: (event: unknown) => Promise<unknown>) {
			handlers.set(event, handler);
		},
	};
}

test("registers the dispatch tool with task, cli, model, effort, and scope", () => {
	const pi = makeFakePi();
	registerDispatchTool(pi as unknown as ExtensionAPI, new ProcessRegistry());
	const tool = pi.tools.get("dispatch");
	assert.ok(tool, "dispatch tool should be registered");
	const properties = tool.parameters.properties ?? {};
	assert.deepEqual(Object.keys(properties).sort(), [
		"cli",
		"effort",
		"model",
		"scope",
		"task",
	]);
	assert.ok(
		pi.handlers.has("tool_result"),
		"a tool_result handler should be registered",
	);
});

test("tool_result handler patches isError only for failing dispatch results", async () => {
	const pi = makeFakePi();
	registerDispatchTool(pi as unknown as ExtensionAPI, new ProcessRegistry());
	const handler = pi.handlers.get("tool_result");
	assert.ok(handler);
	const failureDetails = {
		cli: "codex",
		requested: {},
		confirmed: {},
		activity: [],
		failure: { kind: "nonzero-exit", message: "boom" },
	} satisfies DispatchDetails;
	assert.deepEqual(
		await handler({ toolName: "dispatch", details: failureDetails }),
		{ isError: true },
	);
	assert.equal(
		await handler({
			toolName: "dispatch",
			details: { cli: "codex", activity: [] },
		}),
		undefined,
	);
	assert.equal(
		await handler({ toolName: "bash", details: failureDetails }),
		undefined,
	);
	assert.equal(isDispatchFailure(failureDetails), true);
	assert.equal(isDispatchFailure({}), false);
});

test("the registered tool is callable and returns the agent's result", async () => {
	const bin = makeTempDir("fake-bin-");
	const repo = makeTempDir("tool-repo-");
	const codexPath = path.join(bin, "codex");
	fs.writeFileSync(
		codexPath,
		[
			"#!/bin/sh",
			"cat <<'JSON'",
			'{"type":"thread.started","thread_id":"t-live"}',
			'{"type":"item.completed","item":{"type":"agent_message","text":"tool answer"}}',
			'{"type":"turn.completed","usage":{"input_tokens":3,"cached_input_tokens":0,"output_tokens":4}}',
			"JSON",
		].join("\n"),
	);
	fs.chmodSync(codexPath, 0o755);

	const previousPath = process.env.PATH ?? "";
	process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
	const pi = makeFakePi();
	const registry = new ProcessRegistry();
	registerDispatchTool(pi as unknown as ExtensionAPI, registry);
	try {
		const tool = pi.tools.get("dispatch");
		assert.ok(tool);
		const result = (await tool.execute(
			"call-1",
			{ task: "review", cli: "codex" },
			undefined,
			undefined,
			{
				cwd: repo,
			},
		)) as {
			content: { text: string }[];
			details: DispatchDetails;
			usage?: { output: number };
		};
		assert.equal(result.content[0]?.text, "tool answer");
		assert.equal(result.details.confirmed.sessionId, "t-live");
		assert.equal(result.details.failure, undefined);
		assert.equal(result.usage?.output, 4);
	} finally {
		await registry.cleanupAll();
		process.env.PATH = previousPath;
	}
});
