/**
 * TUI presentation for the dispatch tool.
 *
 * While running, the row streams a live tail of the agent's activity. When
 * settled, it shows a one- or two-line summary that expands to the full
 * response. Requested model/effort is always labelled separately from
 * CLI-confirmed identity; values the CLI does not report show `not reported`
 * rather than echoing the request as fact.
 */

import {
	getMarkdownTheme,
	keyHint,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ActivityItem, DispatchArgs, DispatchDetails } from "./types.ts";

const LIVE_TAIL = 6;

function requestedLabel(value: string | undefined): string {
	return value && value.trim() ? value : "CLI default";
}

function confirmLabel(
	requested: string,
	confirmed: string | undefined,
	pending: boolean,
): string {
	if (confirmed) return `${requested} (confirmed: ${confirmed})`;
	return pending
		? `${requested} (pending)`
		: `${requested} (confirmed: not reported)`;
}

/** `cli · model <req→conf> · effort <req→conf>` with explicit confirmation state. */
export function identityLine(
	details: DispatchDetails,
	theme: Theme,
	pending: boolean,
): string {
	const cli = details.cli || "unknown";
	const model = confirmLabel(
		requestedLabel(details.requested.model),
		details.confirmed.model,
		pending,
	);
	const effort = confirmLabel(
		requestedLabel(details.requested.effort),
		details.confirmed.effort,
		pending,
	);
	return [
		theme.fg("accent", cli),
		theme.fg("muted", `model ${model}`),
		theme.fg("muted", `effort ${effort}`),
	].join("  ");
}

function activityLines(
	activity: ActivityItem[],
	theme: Theme,
	limit: number,
): string {
	const tail = activity.slice(-limit);
	return tail
		.map((item) => {
			if (item.kind === "command")
				return `${theme.fg("muted", "→ ")}${theme.fg("toolOutput", item.text)}`;
			if (item.kind === "error")
				return `${theme.fg("error", "✗ ")}${theme.fg("error", item.text)}`;
			return theme.fg("toolOutput", item.text);
		})
		.join("\n");
}

function summaryLine(content: string): string {
	const firstLine =
		content
			.trim()
			.split("\n")
			.find((line) => line.trim().length > 0) ?? "(no output)";
	return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}

function detailsOf(
	result: AgentToolResult<unknown>,
): DispatchDetails | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null) return undefined;
	const candidate = details as Partial<DispatchDetails>;
	if (typeof candidate.cli !== "string") return undefined;
	return candidate as DispatchDetails;
}

export function renderDispatchCall(args: DispatchArgs, theme: Theme): Text {
	const cli = args.cli && args.cli.trim() ? args.cli : "…";
	const model = requestedLabel(args.model);
	const effort = requestedLabel(args.effort);
	let text = `${theme.fg("toolTitle", theme.bold("dispatch "))}${theme.fg("accent", cli)}`;
	text += `\n  ${theme.fg("muted", `model ${model}`)}  ${theme.fg("muted", `effort ${effort}`)}  ${theme.fg("dim", "(confirmation pending)")}`;
	return new Text(text, 0, 0);
}

export function renderDispatchResult(
	result: AgentToolResult<unknown>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Text | Markdown {
	const details = detailsOf(result);
	const content = result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();

	if (!details) return new Text(content || "(no output)", 0, 0);

	const identity = identityLine(details, theme, options.isPartial);

	if (options.isPartial) {
		const tail = activityLines(details.activity, theme, LIVE_TAIL);
		return new Text(
			`${identity}\n${tail || theme.fg("muted", "working…")}`,
			0,
			0,
		);
	}

	if (details.failure) {
		const diagnostic = content || details.failure.message;
		let text = `${theme.fg("error", "✗ ")}${identity}`;
		text += `\n${theme.fg("error", diagnostic)}`;
		if (options.expanded && details.activity.length > 0) {
			text += `\n\n${activityLines(details.activity, theme, 40)}`;
		}
		return new Text(text, 0, 0);
	}

	if (options.expanded) {
		const markdownTheme = getMarkdownTheme();
		const header = `${theme.fg("success", "✓ ")}${identity}`;
		return new Markdown(`${header}\n\n${content}`, 0, 0, markdownTheme);
	}

	const summary = summaryLine(content);
	const expandHint = keyHint("app.tools.expand", "to expand");
	return new Text(
		`${theme.fg("success", "✓ ")}${identity}\n${theme.fg("toolOutput", summary)} ${theme.fg("dim", `(${expandHint})`)}`,
		0,
		0,
	);
}
