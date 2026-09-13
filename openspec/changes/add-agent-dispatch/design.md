## Context

See `proposal.md` for motivation and scope. What matters here is the starting state:

- `codex` (0.154.0) and `claude` (2.1.263) are installed and authenticated on this machine. Both were exercised directly during exploration, and the facts below are observed, not assumed.
- Pi's extension API supplies everything needed: `pi.registerTool()` with `execute(toolCallId, params, signal, onUpdate, ctx)` for blocking execution with live progress and cancellation, `renderCall`/`renderResult` for TUI presentation, and `node:child_process` for spawning.
- The two CLIs share almost no surface: different flag names, different model identifier spaces, different output encodings, different discoverability, and different environment requirements.

Constraints carried in from the proposal: blocking only, read-only, no persistence, results inline.

## Goals / Non-Goals

**Goals**

- One tool whose behaviour does not depend on which CLI it targets, so adding an agent is one new module and zero changes to the tool.
- Correct by default with no model knowledge from the caller.
- Fail loudly and early rather than silently degrading.

**Non-Goals** (design-level boundaries, not a restatement of scope)

- No background process service, restart recovery, or reattach. The extension still owns cancellation and shutdown cleanup for its active child process groups.
- Not a model registry. We do not maintain or reconcile a mapping between Pi's model names and any CLI's identifier space.
- Not a permission broker. We do not relay a subagent's interactive prompts back to the user; a subagent that needs approval fails.
- Share only the adapter command, event, and result contracts. Adapters are free to differ internally.

## Decisions

**D1. One `dispatch` tool, driven by arguments.** Not one tool per CLI, and not one tool per use case. A `second_opinion` or `code_review` tool would be a prompt, not a capability, and would duplicate per-CLI plumbing. Per-CLI tools would force the caller to switch tools just to switch agent. Alternatives rejected: use-case tools, per-CLI tools.

**D2. Blocking execution only.** Blocking shares the entire adapter and parsing path with any future background mode, and Pi supports parallel tool execution when enabled, so this change needs no separate fan-out API. The known delivery path for later is `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`. Background is deferred, not foreclosed — but it adds durable process supervision and reattach-on-resume. Active-process cleanup is required now, as specified in D12.

**D3. Model selection is inherit-by-default, pass-through, never translated.** Both CLIs already hold a configured default (Codex is configured with `gpt-6-astra` at `medium`), so the common case needs no model at all. A caller-supplied model goes to the CLI unmodified. Alternatives rejected: maintaining a friendly-alias table (rots on every model release, and Codex has no aliases to mirror); requiring an explicit model on every call (makes routine calls fail-prone and contradicts the intent of asking naturally).

**D4. Validation is per-adapter, never a shared guess.** Codex exposes `codex debug models`, returning a JSON catalogue with each model's `slug`, `default_reasoning_level`, and `supported_reasoning_levels[].effort`, so an invalid model or effort can be rejected before any run. Claude exposes no catalogue command; it resolves aliases (`sonnet`, `opus`, `fable`) itself, and an unknown model returns a structured failure (`[claude-code:unrecognized_model]`) with a readable message. Therefore the adapter interface carries an optional `discoverModels()`, and an adapter without it skips pre-validation and surfaces the CLI's error. A shared abstraction here would be a least-common-denominator that guesses.

**D5. Read-only is enforced by the CLI's own sandbox, not by prompt instructions.** Codex `-s read-only` was verified to block a file write (`operation not permitted`) while still permitting shell command execution. That combination is exactly what makes a review trustworthy: the agent can verify its own claims but cannot mutate the tree. Prompt-based requests to "avoid writing" are not acceptable, because a sandbox cannot be talked out of it. `--dangerously-bypass-*` is rejected outright. Where an adapter cannot enforce read-only, dispatch must refuse rather than run unsandboxed.

The guarantee covers the complete launch configuration. A shell sandbox alone does not establish that file tools, inherited hooks, or MCP servers cannot write. Each adapter must disable write-capable paths outside its enforcement boundary or prove that they are constrained. Preserve model and authentication defaults while applying these restrictions. Claude's [sandbox documentation](https://code.claude.com/docs/en/sandbox-environments) explicitly distinguishes Bash isolation from hooks and MCP servers running on the host.

Verification must record an actual denied write attempt and an unchanged working tree. An agent declining the request is not proof. Exercise shell writes and file-tool writes, plus inherited hook and MCP configurations that attempt writes. A disabled path must be shown not to execute. Record exact CLI versions, flags, settings, and denial evidence. The existing Codex shell-write observation proves only that path; neither adapter is complete until the full configuration passes this gate.

**D6. A normalized event stream, one module per CLI.** The adapter contract is `buildCommand(req) -> { cmd, args, cwd, env, stdin }`, `parseLine(line, state) -> StreamEvent | null`, `extractResult(state) -> { text, usage, sessionId, isError, terminalSeen, identity }`, a `capabilities` record, and an optional `discoverModels()`. `StreamEvent` is a small union: `text`, `command`, `metadata`, `error`, `done`. The `metadata` event and final `identity` carry CLI-reported model and effort. Requested model and effort remain separate fields; missing reported values remain unknown. A `done` event means a recognized terminal envelope was parsed, not merely that stdout closed. The tool, the renderer, and usage accounting all consume `StreamEvent` and never branch on CLI name. The alternative — conditionals on CLI identity inside the tool — leaks every CLI quirk into shared code and is what makes a second CLI expensive.

**D7. Environment hygiene is per-adapter data.** The Claude adapter removes `ANTHROPIC_API_KEY` from the child environment; the Codex adapter does not. This was verified directly: with the variable present, Claude fails with `Credit balance is too low`; with it removed, Claude succeeds using the working subscription login (`"pong"`, exit 0). The variable's precedence is a Claude CLI behaviour, not a general rule, so it is encoded as adapter data rather than shared logic.

**D8. Child stdin is closed.** Codex reported `Reading additional input from stdin...` and appends piped stdin as a `<stdin>` block. Leaving a pipe open risks an indefinite hang, so every spawn closes or ignores stdin.

**D9. Results are inline; presentation is separated from model context.** The full response text goes to the model, because the caller needs it to act. The TUI layer does the collapsing: `renderCall` shows CLI, model, and effort; `renderResult` streams the agent's activity while `isPartial`, then shows a one- or two-line summary with the configured expand key to expand, using `keyHint` for the affordance. Alternative rejected: writing the response to a file and returning a path, which costs an extra read turn and risks the model never reading it.

**D10. The caller owns the question and response format.** Assemble each prompt from the standing instruction `Assess the evidence independently.`, the caller's unchanged task, and the scope hint. Do not require disagreement, a counterargument, or a particular response format. No framing enum is needed.

**D11. Failure preserves usage and requires a complete stream.** Success requires exit code zero, a recognized successful terminal envelope, and no stream parsing failure. Non-zero exit, termination by signal, an error envelope, malformed or truncated JSONL, and exit zero without a terminal envelope all produce a tool failure. Buffer partial lines across stdout chunks and parse a final complete line even without a trailing newline. Ignore unknown well-formed event types for forward compatibility; they cannot establish completion. Keep stderr as diagnostic text, not as a success detector.

Return known CLI failures as an `AgentToolResult` with diagnostic content, reported `usage`, and a typed failure marker in `details`. A `tool_result` handler scoped to `dispatch` reads that marker and returns `{ isError: true }`, preserving content, details, and usage. Do not rely on an `isError` property returned directly from `execute`. Pi's agent loop sets successful returns to `isError: false`; its exception path creates a fresh result with empty details and no usage. Throw only for unexpected failures where there is no collected result to preserve. Attach available usage once to the final result, including for cancellation and incomplete streams; do not invent usage for missing reports or count repeated cumulative reports twice.

The supplied Pi source supports this through `packages/agent/src/agent-loop.ts` and the `tool_result` patch contract in `packages/coding-agent/docs/extensions.md`. No Pi core change is required.

**D12. The extension owns active-process cleanup.** Keep an in-memory registry of active dispatches, including discovery subprocesses. On POSIX, give each spawned CLI its own process group so cancellation can terminate the CLI and its descendants without signalling Pi. This is process isolation, not background execution. Keep the dispatch awaited and do not unref it.

Abort and `session_shutdown` use the same idempotent cleanup routine. Stop accepting new spawns during shutdown, check cancellation before spawning, send SIGTERM to active groups, allow at most two seconds for exit, then send SIGKILL to surviving groups and reap direct children. Clean remaining descendants when the direct CLI exits, and remove registry entries only after cleanup. Test cancellation during startup, repeated cleanup, and a descendant that ignores SIGTERM. The same cleanup applies to adapter failures.

SIGKILL of Pi, a runtime crash that skips shutdown, and machine failure cannot run extension cleanup. Child processes can survive abrupt parent death. Automatic recovery for those cases is outside this change; do not claim that blocking children always die with Pi.

**D13. Display confirmed identity separately from the request.** The row initially shows the CLI and requested model/effort, or `CLI default` when omitted, with confirmation pending. Adapter metadata updates the row with values reported by the running CLI. Never substitute a catalogue default or echoed argument for confirmed identity. If the CLI does not expose a value, show `not reported` and retain the request separately. Capture each CLI's metadata fields during capability research. Verify explicit overrides, inherited defaults, and effort-only requests against those fields, not against the row itself. For effort-only pre-validation, resolve the effective configured model through the CLI in the same working directory and configuration; a catalogue's model defaults alone do not identify the selected model.

## Risks / Trade-offs

- **Model identifier drift** → never translate; surface the CLI's own error; read Codex's catalogue live rather than caching it.
- **Complete read-only configurations remain to be verified.** Codex has a shell-write denial observation; Claude has no verified configuration yet. D5 is a completion gate for both adapters. If Claude cannot pass it, keep dispatch disabled for Claude and report the limitation.
- **Long runs block the turn.** A review can take minutes → the live tail makes progress visible; cancellation must terminate the child process group, since these CLIs spawn their own children. `signal` from `execute()` must map to killing that group, not just the direct child.
- **Cost surprise.** A dispatch bills the CLI's own account → usage is surfaced on the row. Hard budget enforcement is out of scope.
- **Prompt injection from repository content.** Read-only enforcement protects the working tree. It does not establish confidentiality or prevent remote side effects through network access and external tools. D5 must account for inherited tools; do not describe a misleading review as the only possible impact.
- **Abrupt parent death.** Normal cancellation and session shutdown use D12 cleanup. Forced termination or a crash that skips cleanup can leave children alive. There is no restart recovery in this change.
- **Capability divergence between adapters.** A future CLI may have no read-only mode → the `capabilities` record carries the flag and dispatch refuses rather than degrading silently.

## Migration Plan

Not applicable in the usual sense: this is a new extension with no existing behaviour to preserve. It loads project-locally in this repository for development, and can be installed globally once verified. Rollback is deleting the extension.

## Open Questions

- **Background execution.** The delivery path is known (`pi.sendMessage` with `triggerTurn`), but process supervision, orphan reaping, and reattach-on-resume are not designed. Deferrable: the tool contract does not change.
- **Fan-out semantics.** Whether to rely solely on Pi's parallel tool calls or add a batch parameter. Deferrable: the tool's arguments and result shape hold either way.
- **Human-initiated dispatch.** Whether a `/dispatch` command is worth adding, and whether a model-discovery command or picker should be exposed rather than leaving discovery to the caller.

## Validation strategy

The validation matrix in `tasks.md` maps acceptance areas to scenarios, observable results, and test methods. Run adapter fixtures first, then the Pi extension/tool pipeline with fake CLI processes, then the necessary live CLI and TUI checks. Failure and usage assertions must inspect the final persisted Pi result and session totals. Cancellation tests must inspect process survival, not only promise rejection. Concurrent dispatch tests must prove that identity, usage, and cleanup remain isolated by tool call.

Live checks establish the complete read-only configuration, working authentication, effective model settings where the CLI reports them, and access to uncommitted repository state. Keep unsupported, unreported, and untested cases explicit. Do not mark Claude support complete merely because its refusal path passes. Do not run paid model calls for parsing, error formatting, usage aggregation, or process-lifecycle behavior that deterministic fixtures can establish.
