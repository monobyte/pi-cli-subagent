/**
 * `dispatch` tool registration and the error-patching `tool_result` handler.
 *
 * Known failures are returned as an `AgentToolResult` carrying diagnostic
 * content, reported usage, and a typed failure marker in `details`. Returning a
 * value never sets Pi's error flag, so the `tool_result` handler reads the
 * marker and patches `isError: true` while preserving content, details, and
 * usage. Only unexpected failures throw.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { runDispatch } from "./dispatch-core.ts";
import type { ProcessRegistry } from "./process-registry.ts";
import { renderDispatchCall, renderDispatchResult } from "./render.ts";
import type { DispatchDetails } from "./types.ts";

export const dispatchParameters = Type.Object({
	task: Type.String({
		description:
			"The task to hand to the external CLI agent. Passed through unchanged.",
	}),
	cli: Type.Optional(
		StringEnum(["codex", "claude"] as const, {
			description: 'Which CLI agent to run. Required; one of "codex" or "claude".',
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Model identifier passed to the CLI unmodified. Omit to use the CLI's own configured default model.",
		}),
	),
	effort: Type.Optional(
		Type.String({
			description:
				"Reasoning effort level for the dispatch. Omit to use the CLI's configured default.",
		}),
	),
	scope: Type.Optional(
		Type.String({
			description:
				"Optional scope hint appended after the task (for example a directory or file list).",
		}),
	),
});

export type DispatchToolArgs = Static<typeof dispatchParameters>;

/** Whether a dispatch result details object carries a typed failure marker. */
export function isDispatchFailure(
	details: unknown,
): details is DispatchDetails {
	if (typeof details !== "object" || details === null) return false;
	const candidate = details as Partial<DispatchDetails>;
	return typeof candidate.failure === "object" && candidate.failure !== null;
}

export function registerDispatchTool(
	pi: ExtensionAPI,
	registry: ProcessRegistry,
): void {
	pi.registerTool({
		name: "dispatch",
		label: "Dispatch",
		description: [
			"Run a task on an installed external CLI coding agent (codex, claude) and return its final response.",
			"The dispatch blocks until the agent finishes and is read-only: the agent can inspect the workspace",
			"and run read-only commands but cannot modify the working tree. Omit model/effort to use the CLI's",
			"own configured defaults.",
		].join(" "),
		promptSnippet:
			"Run a task on an external CLI agent (codex, claude) for independent review or analysis; read-only.",
		promptGuidelines: [
			"Use dispatch when the user asks for an independent review, a second opinion, or work delegated to Codex or Claude.",
			"Use dispatch with the cli argument set to codex or claude; omit model and effort unless the user names them.",
		],
		parameters: dispatchParameters,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const result = await runDispatch(params, {
				registry,
				cwd: ctx.cwd,
				signal,
				onUpdate: (partial) => {
					onUpdate?.({
						content: [{ type: "text", text: partial.content }],
						details: partial.details,
					});
				},
			});
			return {
				content: [{ type: "text", text: result.content }],
				details: result.details,
				usage: result.usage,
			};
		},

		renderCall(args, theme) {
			return renderDispatchCall(args, theme);
		},

		renderResult(result, options, theme) {
			return renderDispatchResult(result, options, theme);
		},
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "dispatch") return;
		if (isDispatchFailure(event.details)) return { isError: true };
	});
}
