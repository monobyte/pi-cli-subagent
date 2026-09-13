/**
 * Adapter registry. The dispatch tool contains no CLI-specific knowledge:
 * adding an agent is one new adapter module registered here.
 */

import type { CliAdapter } from "../types.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";

const REGISTRY: ReadonlyMap<string, CliAdapter> = new Map<string, CliAdapter>([
	[codexAdapter.name, codexAdapter],
	[claudeAdapter.name, claudeAdapter],
]);

/** Aliases accepted in addition to the canonical adapter names. */
const ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
	["claude-code", "claude"],
]);

export function supportedCliNames(): string[] {
	return [...REGISTRY.keys()];
}

/** Resolve a caller-supplied CLI name to an adapter, or undefined. */
export function resolveAdapter(name: string): CliAdapter | undefined {
	const normalized = name.trim().toLowerCase();
	const direct = REGISTRY.get(normalized);
	if (direct) return direct;
	const aliased = ALIASES.get(normalized);
	return aliased ? REGISTRY.get(aliased) : undefined;
}

export { claudeAdapter, codexAdapter };
