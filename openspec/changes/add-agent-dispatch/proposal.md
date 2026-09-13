## Why

Pi can only reason with its own configured model. Other capable coding agents — Codex and Claude Code — are already installed, authenticated, and configured on this machine with their own models, reasoning levels, and tooling. There is no way to hand a task to them from inside a Pi session. Offloading work to them keeps Pi's context small and produces genuinely independent verification, because a different model with a different toolchain reviews the work.

## What Changes

- Add a `dispatch` tool that runs a task on an installed CLI agent, blocking until it finishes, and returns that agent's result inline into the Pi session.
- The caller chooses the agent, model, and reasoning effort per call. Nothing about reviews or "second opinions" is hardcoded — those are prompts, expressed through the `task` argument.
- When no model is named, the CLI's own configured default is used. When a model is named, it is passed through unmodified and validated against the CLI when the CLI exposes a way to do so.
- Add an adapter layer: one module per CLI, normalizing each CLI's output into a single event stream so the tool itself contains no CLI-specific knowledge. Adding a CLI later is one new adapter and no changes to the tool.
- Enforce read-only operation across the complete launch configuration, including shell commands, file tools, hooks, and MCP servers. A dispatched agent may inspect the workspace and run commands, but must not modify the working tree. Refuse to launch when this cannot be enforced.
- Each adapter owns its own environment hygiene. The Claude adapter must remove `ANTHROPIC_API_KEY` from the child process environment, because when it is present the CLI selects a non-functional API key instead of the working subscription login.
- Ship Codex and Claude adapters, with each enabled only after its complete read-only configuration is verified. Additional CLIs follow the same contract.
- Preserve reported usage on successful and failed dispatches. Require a valid terminal result before reporting success.
- Track active child process groups and terminate them on cancellation and normal session shutdown.
- Report CLI-confirmed model and effort separately from requested values, and label values the CLI does not report.
- Use a short instruction to assess evidence independently; leave the question and response format to the caller.

Explicitly **not** in this change: background execution or children intentionally left running after return, persistence across Pi restarts, session resume or follow-up, structured/schema-constrained results, fan-out as a distinct feature, and write-enabled dispatch.

## Capabilities

### New Capabilities

- `agent-dispatch`: dispatching a task to an installed external CLI agent from within a Pi session — the tool contract, the read-only guarantee, model and effort selection rules, and the adapter interface every supported CLI must satisfy.

### Modified Capabilities

None. No existing capability's requirements change; this project has no existing specs.

## Impact

- New Pi extension in this repository, loaded project-locally.
- New runtime dependency on external CLI binaries (`codex`, `claude`) being installed and authenticated. Availability is a user environment concern, not a bundled dependency.
- Runs third-party agents as child processes with tooling restricted to the verified read-only configuration. Read-only enforcement and per-adapter environment scrubbing are the primary safety controls.
- No changes to Pi core, and no writes to the user's working tree, since dispatch is read-only by design.
- Deferred work that this change must not preclude: background execution and multi-CLI fan-out.
