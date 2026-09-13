/** Shared helpers for the deterministic fixture tests. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AdapterState,
	CliAdapter,
	DispatchRequest,
	StreamEvent,
} from "../.pi/extensions/agent-dispatch/types.ts";
import { MalformedStreamError } from "../.pi/extensions/agent-dispatch/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CLI = path.join(HERE, "fixtures", "fake-cli.mjs");

export function makeTempDir(prefix = "dispatch-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeJson(dir: string, name: string, value: unknown): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, JSON.stringify(value));
	return file;
}

/** Wrap a real adapter but launch the deterministic fake CLI instead. */
export function withFakeCli(
	base: CliAdapter,
	configPath: string,
	extraArgs: string[] = [],
): CliAdapter {
	return {
		...base,
		buildCommand(req: DispatchRequest) {
			return {
				cmd: process.execPath,
				args: [FAKE_CLI, configPath, ...extraArgs],
				cwd: req.cwd,
				env: { ...process.env },
				stdin: "ignore",
			};
		},
	};
}

/** A minimal adapter that parses `{type:"text"}` / `{type:"done"}` JSONL. */
export const jsonLineAdapter: CliAdapter = {
	name: "stub",
	capabilities: { readOnly: true, discoverModels: false },
	buildCommand(req: DispatchRequest) {
		return {
			cmd: process.execPath,
			args: [],
			cwd: req.cwd,
			env: { ...process.env },
			stdin: "ignore",
		};
	},
	newState(): AdapterState {
		return { text: "", terminalSeen: false, isError: false };
	},
	parseLine(line: string, state: AdapterState): StreamEvent | null {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			throw new MalformedStreamError(`invalid JSON: ${line.slice(0, 40)}`);
		}
		const record = event as { type?: string; text?: string };
		if (record.type === "text") return { type: "text", text: record.text ?? "" };
		if (record.type === "done") {
			state.terminalSeen = true;
			return { type: "done" };
		}
		return null;
	},
	extractResult(state: AdapterState) {
		return {
			text: String(state.text ?? ""),
			identity: {},
			terminalSeen: Boolean(state.terminalSeen),
			isError: Boolean(state.isError),
		};
	},
};

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5000,
	intervalMs = 25,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	return predicate();
}

/** Wait for a pid file to appear and return the pid. */
export async function readPidFile(
	file: string,
	timeoutMs = 5000,
): Promise<number> {
	await waitFor(() => fs.existsSync(file), timeoutMs);
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			const value = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
			if (Number.isFinite(value) && value > 0) return value;
		} catch {
			/* not written yet */
		}
		await sleep(25);
	}
	throw new Error(`pid file was never written: ${file}`);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
