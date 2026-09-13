/**
 * Deterministic fake CLI used by the runner and lifecycle tests.
 *
 * Usage: node fake-cli.mjs <config.json>
 *
 * Config shape:
 *   stdout: string[]           lines/content to emit (joined, then chunked)
 *   stdoutChunkSize: number    optional byte chunk size for stdout writes
 *   stderr: string             optional stderr text
 *   byteChunks: boolean        write stdout/stderr one UTF-8 byte at a time,
 *                              splitting multi-byte characters across writes
 *   exitCode: number           exit status (default 0)
 *   delayMs: number            delay before the first write and between writes
 *   lifetimeMs: number         keep the process alive this long before exit
 *   trapSigterm: boolean       ignore SIGTERM (forces the SIGKILL escalation)
 *   selfSignal: string         kill self with this signal after writing output
 *   pidFile: string            write this process's pid here at startup
 *   descendant: {              optional child that outlives the direct child
 *     pidFile: string
 *     trapSigterm: boolean
 *     lifetimeMs: number
 *     inheritStdio: boolean    inherit this process's stdout/stderr pipes
 *   }
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const configPath = process.argv[2];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (config.pidFile) fs.writeFileSync(config.pidFile, String(process.pid));

if (config.trapSigterm) {
	process.on("SIGTERM", () => {
		/* keep running; cleanup must escalate to SIGKILL */
	});
}

if (config.descendant) {
	const descendantScript = path.join(
		path.dirname(new URL(import.meta.url).pathname),
		"fake-descendant.mjs",
	);
	const child = spawn(
		process.execPath,
		[
			descendantScript,
			config.descendant.pidFile,
			config.descendant.trapSigterm ? "1" : "0",
			String(config.descendant.lifetimeMs ?? 60000),
		],
		config.descendant.inheritStdio ? { stdio: "inherit" } : { stdio: "ignore" },
	);
	child.unref();
	// Wait for the descendant to record its pid so tests are deterministic.
	const deadline = Date.now() + 5000;
	while (!fs.existsSync(config.descendant.pidFile) && Date.now() < deadline) {
		await sleep(20);
	}
}

/** Write text either as one chunk or one UTF-8 byte at a time. */
async function writeOut(stream, text) {
	if (!text) return;
	if (!config.byteChunks) {
		stream.write(text);
		return;
	}
	const bytes = Buffer.from(text, "utf8");
	for (let offset = 0; offset < bytes.length; offset++) {
		stream.write(bytes.subarray(offset, offset + 1));
		if (config.delayMs) await sleep(config.delayMs);
	}
}

await writeOut(process.stderr, config.stderr ?? "");

const payload = (config.stdout ?? []).join("");
if (payload.length > 0) {
	if (config.delayMs) await sleep(config.delayMs);
	if (config.byteChunks) {
		await writeOut(process.stdout, payload);
	} else {
		const size =
			config.stdoutChunkSize && config.stdoutChunkSize > 0
				? config.stdoutChunkSize
				: payload.length;
		for (let offset = 0; offset < payload.length; offset += size) {
			process.stdout.write(payload.slice(offset, offset + size));
			if (config.delayMs && offset + size < payload.length)
				await sleep(config.delayMs);
		}
	}
}

if (config.selfSignal) {
	process.kill(process.pid, config.selfSignal);
	await sleep(200);
}

if (config.lifetimeMs) await sleep(config.lifetimeMs);
process.exit(config.exitCode ?? 0);
