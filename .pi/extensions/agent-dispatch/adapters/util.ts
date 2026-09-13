/**
 * Small parsing helpers shared by adapters. Kept dependency-free so adapters
 * stay testable without the Pi runtime.
 */

import fs from "node:fs";
import path from "node:path";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function truncate(value: string, max = 200): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Walk up from `start` looking for a `.git` directory or file (worktree). */
export function findRepoRoot(start: string): string | undefined {
	let dir = path.resolve(start);
	while (true) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Strip a trailing TOML comment that is outside any quoted string.
 * `key = "x" # note` must yield `"x"`, not `"x" # note`.
 */
function stripTomlComment(value: string): string {
	let inDouble = false;
	let inSingle = false;
	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if (char === '"' && !inSingle) inDouble = !inDouble;
		else if (char === "'" && !inDouble) inSingle = !inSingle;
		else if (char === "#" && !inDouble && !inSingle) {
			return value.slice(0, index).trim();
		}
	}
	return value;
}

/**
 * Read top-level scalar keys from a TOML document. Only the region before the
 * first table header is considered, which is where Codex stores `model`,
 * `model_reasoning_effort`, and `profile`.
 */
export function readTomlTopLevel(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = stripTomlComment(raw).trim();
		if (!line || line.startsWith("#")) continue;
		if (line.startsWith("[")) break;
		const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
		if (!match) continue;
		const key = match[1];
		const rawValue = match[2];
		if (key === undefined || rawValue === undefined) continue;
		let value = rawValue.trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

/** Join an absolute path into the Claude sandbox's `//` absolute prefix. */
export function absoluteSandboxPath(target: string): string {
	const normalized = path.resolve(target);
	return normalized.startsWith("/") ? `/${normalized}` : normalized;
}
