/**
 * Agent dispatch extension.
 *
 * Registers the `dispatch` tool, which runs a task on an installed external CLI
 * agent (Codex or Claude Code) and returns its response inline. The extension
 * owns an in-memory registry of active child process groups and releases them
 * on cancellation, completion, and session shutdown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ProcessRegistry } from "./process-registry.ts";
import { registerDispatchTool } from "./tool.ts";

export default function (pi: ExtensionAPI) {
	const registry = new ProcessRegistry();

	pi.on("session_start", async () => {
		// A replaced session may reuse this instance; re-enable spawning.
		registry.resume();
	});

	pi.on("session_shutdown", async () => {
		// Prevent new spawns and terminate every active group before returning.
		registry.beginShutdown();
		await registry.cleanupAll();
	});

	registerDispatchTool(pi, registry);
}
