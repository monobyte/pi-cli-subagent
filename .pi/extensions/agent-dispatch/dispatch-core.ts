/**
 * CLI-agnostic dispatch logic. This module contains no Pi runtime imports and
 * no CLI-specific knowledge, so it can be exercised with fixtures directly.
 */

import fs from "node:fs";
import path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { resolveAdapter, supportedCliNames } from "./adapters/index.ts";
import { assemblePrompt } from "./prompt.ts";
import type { ProcessRegistry } from "./process-registry.ts";
import { runAdapter } from "./runner.ts";
import type {
	ActivityItem,
	CliAdapter,
	ConfirmedIdentity,
	DispatchDetails,
	FailureKind,
	StreamEvent,
} from "./types.ts";

export interface DispatchParams {
	task: string;
	cli?: string;
	model?: string;
	effort?: string;
	scope?: string;
}

export interface DispatchRunResult {
	content: string;
	details: DispatchDetails;
	usage?: Usage;
	isError: boolean;
}

export interface DispatchDeps {
	registry: ProcessRegistry;
	cwd: string;
	signal?: AbortSignal;
	onUpdate?: (result: DispatchRunResult) => void;
	/** Injectable for tests; defaults to the real adapter registry. */
	resolveAdapter?: (name: string) => CliAdapter | undefined;
	/** Injectable for tests; defaults to a real PATH lookup. */
	isOnPath?: (binary: string) => boolean;
}

const MAX_ACTIVITY = 400;

/** Whether an executable with this name is present on `PATH`. */
export function isOnPath(binary: string): boolean {
	const pathValue = process.env.PATH ?? "";
	const dirs = pathValue.split(path.delimiter).filter(Boolean);
	const extensions =
		process.platform === "win32"
			? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
			: [""];
	for (const dir of dirs) {
		for (const extension of extensions) {
			const candidate = path.join(dir, binary + extension);
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				return true;
			} catch {
				/* keep looking */
			}
		}
	}
	return false;
}

function eventToActivity(event: StreamEvent): ActivityItem | undefined {
	switch (event.type) {
		case "text": {
			const text = event.text.trim();
			return text ? { kind: "text", text } : undefined;
		}
		case "command": {
			const parts = [event.command];
			if (event.status === "failed") parts.push("(failed)");
			return { kind: "command", text: parts.join(" ").trim() };
		}
		case "error":
			return { kind: "error", text: event.message };
		case "metadata":
			return undefined;
		case "done":
			return undefined;
		default:
			return undefined;
	}
}

function failureResult(
	kind: FailureKind,
	message: string,
	adapterName: string,
	requested: { model?: string; effort?: string },
	activity: ActivityItem[],
	usage?: Usage,
): DispatchRunResult {
	const details: DispatchDetails = {
		cli: adapterName,
		requested,
		confirmed: {},
		failure: { kind, message },
		activity,
	};
	return { content: message, details, usage, isError: true };
}

/** Run one dispatch and normalize the outcome into a tool result shape. */
export async function runDispatch(
	params: DispatchParams,
	deps: DispatchDeps,
): Promise<DispatchRunResult> {
	const resolve = deps.resolveAdapter ?? resolveAdapter;
	const onPath = deps.isOnPath ?? isOnPath;
	const requested = { model: params.model, effort: params.effort };
	const activity: ActivityItem[] = [];
	const pushUpdate = (details: DispatchDetails): void => {
		deps.onUpdate?.({
			content: details.activity.at(-1)?.text ?? "",
			details,
			isError: Boolean(details.failure),
		});
	};

	if (!params.cli || !params.cli.trim()) {
		return failureResult(
			"missing-cli",
			`No CLI was specified. Supported agents: ${supportedCliNames().join(", ")}.`,
			"",
			requested,
			activity,
		);
	}

	const adapter = resolve(params.cli);
	if (!adapter) {
		return failureResult(
			"unsupported-cli",
			`Unsupported agent "${params.cli}". Supported agents: ${supportedCliNames().join(", ")}.`,
			params.cli,
			requested,
			activity,
		);
	}

	if (!onPath(adapter.name)) {
		return failureResult(
			"cli-not-installed",
			`The "${adapter.name}" CLI is not installed or not available on PATH.`,
			adapter.name,
			requested,
			activity,
		);
	}

	if (!adapter.capabilities.readOnly) {
		return failureResult(
			"read-only-unavailable",
			`The "${adapter.name}" adapter cannot enforce read-only execution for the complete launch configuration, so dispatch refuses to run it.`,
			adapter.name,
			requested,
			activity,
		);
	}

	let defaults;
	if (adapter.preflight) {
		const preflight = await adapter.preflight(
			{
				prompt: assemblePrompt(params.task, params.scope),
				cwd: deps.cwd,
				model: params.model,
				effort: params.effort,
			},
			{ registry: deps.registry, signal: deps.signal },
		);
		if (!preflight.ok) {
			return failureResult(
				"invalid-request",
				preflight.message ?? "Invalid request.",
				adapter.name,
				requested,
				activity,
			);
		}
		defaults = preflight.defaults;
	}

	const request = {
		prompt: assemblePrompt(params.task, params.scope),
		cwd: deps.cwd,
		model: params.model,
		effort: params.effort,
	};

	const started = Date.now();
	const confirmed: ConfirmedIdentity = {};
	const outcome = await runAdapter({
		adapter,
		request,
		registry: deps.registry,
		defaults,
		signal: deps.signal,
		onEvent: (event) => {
			if (event.type === "metadata") {
				// CLI-reported identity updates the live row as it arrives.
				Object.assign(confirmed, event.identity);
			} else {
				const activityItem = eventToActivity(event);
				if (activityItem) {
					activity.push(activityItem);
					if (activity.length > MAX_ACTIVITY)
						activity.splice(0, activity.length - MAX_ACTIVITY);
				}
			}
			pushUpdate({
				cli: adapter.name,
				requested,
				confirmed: { ...confirmed },
				activity: [...activity],
			});
		},
	});

	const details: DispatchDetails = {
		cli: adapter.name,
		requested,
		confirmed: outcome.result.identity,
		failure: outcome.failure,
		activity,
		durationMs: Date.now() - started,
		stderr: outcome.stderr.trim() || undefined,
	};

	if (outcome.failure) {
		const parts = [outcome.failure.message];
		const text = outcome.result.text.trim();
		if (text && !outcome.failure.message.includes(text)) parts.push(text);
		if (outcome.stderr.trim()) parts.push(outcome.stderr.trim());
		return {
			content: parts.join("\n\n"),
			details,
			usage: outcome.result.usage,
			isError: true,
		};
	}

	return {
		content: outcome.result.text.trim() || "(no output)",
		details,
		usage: outcome.result.usage,
		isError: false,
	};
}
