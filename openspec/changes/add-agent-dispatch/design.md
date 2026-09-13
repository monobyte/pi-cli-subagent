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

**D7. Environment hygiene is per-adapter data.** The Claude adapter removes `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from the child environment and sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, which strips Anthropic and cloud-provider credentials from the subprocesses Claude spawns (the Bash tool, hooks, and MCP stdio servers) while the CLI keeps its own authentication; the Codex adapter does neither, because `codex exec -s read-only` blocks shell writes at the sandbox layer instead of at the credential layer. `OPENAI_API_KEY` is removed separately because the CLI's denylist omits it while this extension's sibling adapter is Codex. This is a denylist, not an allowlist, so bespoke secrets remain visible: environment hygiene is a mitigation, not a confidentiality boundary, and an allowlist environment remains the open follow-up. The `ANTHROPIC_API_KEY` removal was verified directly: with the variable present, Claude fails with `Credit balance is too low`; with it removed, Claude succeeds using the working subscription login (`"pong"`, exit 0). The variable's precedence is a Claude CLI behaviour, not a general rule, so it is encoded as adapter data rather than shared logic.

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

## Capability research (verified)

Recorded from live probes on this machine. Probes used a temporary Git repository
(`/private/tmp/dprobe`) and were read-only except where a denial was the point.
No credentials were printed.

### Codex — version and launch configuration

`codex-cli 0.154.0`, user config `~/.codex/config.toml`
(`model = "gpt-6-astra"`, `model_reasoning_effort = "medium"`, 3 user MCP
servers, `sandbox_mode = "danger-full-access"`, `approval_policy = "on-request"`).
The ambient config is write-capable, so the launch configuration overrides it:

```text
codex exec --json --skip-git-repo-check -s read-only \
  --ignore-user-config --ignore-rules --disable hooks --disable plugins \
  -C <cwd> [-c model=<resolved>] [-c model_reasoning_effort=<resolved>] <prompt>
```

| Path | Evidence |
| --- | --- |
| Shell write | `printf probe > write-probe.txt` under `-s read-only` produced `zsh:1: operation not permitted: write-probe.txt`; `write-probe.txt` was not created and `git status` was unchanged. |
| Read-only command | `echo READ_ONLY_OK` under the same run produced `READ_ONLY_OK` with exit 0. |
| File-tool write | `apply_patch` under the same run was rejected: `patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings`; the target file was not created. |
| MCP writes | A purpose-built MCP stdio server registered via `-c mcp_servers.probe...` attempted `writeFileSync` under `-s read-only` and returned `WRITE_SUCCEEDED`; the file appeared on disk. **The shell sandbox does not constrain MCP servers**, so they must be disabled. |
| MCP/hook disablement | `codex exec --ignore-user-config --disable plugins --disable hooks` reported `NONE` when asked to list available MCP tools. `-c mcp_servers={}` does not clear inherited servers; per-server `-c mcp_servers.<name>.enabled=false` works only for user-config rooms whose names are bare TOML keys, and fails for plugin-provided or hyphenated servers. `--disable plugins` removes plugin-provided servers such as `cua_repl`. |
| stdin | An inherited open stdin printed `Reading additional input from stdin...` and would append a `<stdin>` block. The adapter spawns with `stdio: ["ignore", ...]`. |
| Catalogue | `codex debug models` returns `{models:[{slug, display_name, default_reasoning_level, supported_reasoning_levels:[{effort}]}]}`. Observed slugs: `gpt-5.6-sol`, `gpt-6-astra`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.3-codex-spark` (plus hidden entries). |
| Effective configured model | `codex doctor --json` reports `checks["config.load"].details.model` (`gpt-6-astra`). It does not report the reasoning effort. Because `--ignore-user-config` is used, the adapter resolves `model`/`model_reasoning_effort` from `$CODEX_HOME/config.toml`, honouring `profile`, and re-applies them with `-c`. |

### Codex — envelope fields

`codex exec --json` emits JSONL with no model/effort field, so confirmed
identity is unreported for those two values:

- `thread.started` → `thread_id` (session identity).
- `item.started` / `item.updated` / `item.completed` with `item.type` in
  `agent_message` (final text), `reasoning`, `command_execution`
  (`command`, `aggregated_output`, `exit_code`, `status`), `file_change`,
  `mcp_tool_call`, `web_search`, `error`.
- `turn.completed` → `usage` (`input_tokens`, `cached_input_tokens`,
  `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`);
  this is the terminal envelope.
- `turn.failed` / `error` → diagnostic message.

### Claude — version and launch configuration

`2.1.263 (Claude Code)`. The ambient `ANTHROPIC_API_KEY` selects a
non-functional credential, so it is removed from the child environment. Launch
configuration:

```text
claude -p --output-format stream-json --verbose \
  --safe-mode --strict-mcp-config --tools Read,Bash \
  --settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,
    "autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,
    "filesystem":{"denyWrite":["//<cwd>","//<repo-root>"]}},
    "disableAllHooks":true}' \
  [--model <model>] [--effort <level>] -- <prompt>
```

| Path | Evidence |
| --- | --- |
| Shell write | `printf x > <cwd>/claude-write3.txt` under the sandbox produced `(eval):1: operation not permitted: ...`; the file was not created. |
| Read-only command | `echo READ_OK` under the same run produced `READ_OK` with exit 0. |
| File tools | `--tools Read,Bash` restricts the session to those two built-ins; the init event reported `tools: ["Bash","Read"]`, so `Edit`, `Write`, `NotebookEdit`, `EnterWorktree`, and the scheduling tools were absent. |
| Hooks / MCP | `--safe-mode` disables inherited hooks, MCP servers, plugins, and skills; `--strict-mcp-config` with no `--mcp-config` ignores all other MCP configuration. The init event reported `mcp_servers: []`. |
| Sandbox availability | `failIfUnavailable: true` turns a missing sandbox dependency into a hard startup failure rather than a silent unsandboxed run. |
| Effort being unsandboxed | `allowUnsandboxedCommands: false` makes the sandbox non-optional; the write denial above was produced by the sandbox, not a model refusal. |

Environment probe (`--model sonnet`, prompt `Reply with exactly: pong`):

- With `ANTHROPIC_API_KEY` present: `apiKeySource: ANTHROPIC_API_KEY`,
  `is_error: true`, `result: "Credit balance is too low"`, `api_error_status: 400`,
  exit code 1.
- With it removed: `apiKeySource: none`, `is_error: false`, exit code 0.

### Claude — envelope fields

`--output-format stream-json` emits:

- `system` / `subtype: init` → `session_id`, `model` (confirmed model),
  `cwd`, `tools`, `mcp_servers`, `permissionMode`, `apiKeySource`.
- `assistant` → `message.model`, `message.content` (`text`, `tool_use`, `thinking`).
- `user` → `message.content` (`tool_result` with `content`, `is_error`).
- `result` → `session_id`, `is_error`, `subtype`, `result` (final text),
  `stop_reason`, `num_turns`, `total_cost_usd`, `permission_denials`,
  `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `output_tokens_details.thinking_tokens`),
  `modelUsage`.

Claude reports no reasoning-effort field, so confirmed effort is unreported.
It has no catalogue command; `discoverModels` is absent, so an unknown model is
surfaced as the CLI's own error instead of being pre-validated.

### Metadata summary

| Value | Codex | Claude |
| --- | --- | --- |
| Confirmed model | not reported in exec JSONL | `system.init.model` and `assistant.message.model` |
| Confirmed effort | not reported | not reported |
| Session identity | `thread.started.thread_id` | `system.init.session_id` / `result.session_id` |
| Model catalogue | `codex debug models` | none |
| Effort pre-validation | catalogue `supported_reasoning_levels` against the resolved configured model | none; the CLI's own error is surfaced |

## Verification record

Tested CLI versions: `codex-cli 0.154.0`, `2.1.263 (Claude Code)`, `pi 0.85.1`,
Node `v22.22.0`.

Deterministic checks (no paid model calls):

```text
node ./node_modules/typescript/bin/tsc --noEmit        # clean
node --experimental-strip-types --test test/*.test.ts  # 62 pass, 0 fail
openspec validate add-agent-dispatch --strict          # valid
```

The fixture suite covers: prompt passthrough (quotes, newlines, Unicode,
explicit response format, scope); CLI resolution (missing, unsupported,
not-installed, spawn failure); read-only refusal for an adapter with the
capability disabled; preflight rejection starting no process; stream parsing
(text, command, metadata, unknown well-formed events); chunk-split lines and a
final line without a newline; malformed JSONL, missing terminal envelope,
error envelope with exit zero, non-zero exit, signal termination; usage mapping
and no double-counting of cumulative reports; concurrent-call isolation; tool
registration, the `tool_result` error patch, and a callable tool; process
lifecycle (descendant after direct-child exit, SIGTERM-resistant descendant,
shutdown during dispatch, cancellation during startup, repeated cleanup with an
unrelated sentinel); renderer presentation (pending, confirmed, `not reported`,
live tail, collapsed/expanded, error).

Live adapter checks (`scripts/live-check.mts`, temporary Git repo with one
uncommitted modification):

- `codex debug models` returned the slugs and per-model effort levels in the
  catalogue.
- Unsupported Codex model → `invalid-request`, valid alternatives named, no run.
- Unsupported Codex effort → `invalid-request`, supported levels named, no run.
- Codex live task: exit 0; shell write `operation not permitted`; file-tool
  write blocked by the read-only sandbox; `git diff` showed the uncommitted
  change; `probe-shell.txt` and `probe-tool.txt` absent afterwards.
- Claude live task with `--model sonnet --effort high`: exit 0; confirmed model
  `claude-sonnet-5` (effort unreported); shell write `operation not permitted`;
  file tools absent from the session; `git diff` showed the uncommitted change;
  no probe files created. The parent environment still had `ANTHROPIC_API_KEY`
  set and the dispatch succeeded.
- Unknown Claude model → the CLI's own `[claude-code:unrecognized_model]`
  message surfaced as a `nonzero-exit` failure.

Pi pipeline checks (fake `codex` on `PATH`, real extension, `pi --mode json`):

- Success: the final tool result carried `usage` `{input:6, output:6,
  cacheRead:4}` and `isError:false`; the model returned the tool text.
- Error envelope with usage: the final persisted tool result had
  `isError:true`, the diagnostic text, and `usage` `{input:5, output:3,
  cacheRead:2}` preserved.

Remaining limits: Codex reports no model/effort in its exec JSONL, so those
confirmed fields are labelled `not reported`; the adapter re-applies the
resolved `model`/`model_reasoning_effort` from `$CODEX_HOME/config.toml` because
`--ignore-user-config` is required to drop inherited MCP servers. Claude reports
no reasoning effort, so confirmed effort is `not reported`. Forced parent death
(SIGKILL of Pi or a crash that skips `session_shutdown`) can leave children
alive; normal cancellation, completion, and shutdown are bounded and verified.

### Reviewer follow-up

Four reproduced defects were fixed after the first verification pass, each with
a regression test:

1. **Hang after CLI exit.** The runner waited on `close`, which stays pending
   while a descendant holds the inherited stdout/stderr pipes. The registry now
   tracks direct-child `exit` separately (`exited`) and stdio closure
   (`closed`); the runner awaits `exit`, cleans the process group, then drains
   `closed` with a bound. Regression: a fake descendant spawned with
   `stdio: "inherit"` that outlives its parent.
2. **Overlapping cleanup returned early.** `terminate` set a boolean before the
   async work, so a second caller returned immediately. It now stores and
   returns a shared cleanup promise, so every caller waits for the same
   termination. Regression: `cleanupAll` while a first `terminate` is in flight
   against a SIGTERM-resistant child.
3. **Split UTF-8 corrupted.** stdout/stderr used `Buffer#toString` per chunk.
   The runner and discovery helper now use `StringDecoder`, which holds partial
   multi-byte sequences across chunks. Regression: a fixture that writes each
   UTF-8 byte in a separate `write`, for stdout, stderr, and captured discovery
   output.
4. **Claude usage before completion discarded.** Only the terminal envelope's
   usage was kept. The adapter now records per-message usage keyed by
   `message.id` (deduplicating streaming repeats) and uses it when no terminal
   envelope arrives; the terminal envelope remains authoritative when present.
   Regression: assistant usage with no terminal, plus dedup and
   terminal-precedence cases.

Post-fix verification: typecheck clean; 71 fixture tests pass; four live adapter
checks and the Pi success/error pipeline re-run with unchanged results
(read-only denials, unchanged tree, `isError` and usage preserved). The live
probe cost note above still applies.

A second review pass reproduced four more defects, also fixed with regression
tests:

1. **Hang after a malformed line.** `drainLines` recorded the parse error but
   only the oversized-line path terminated the child, so a CLI that emitted one
   bad line and then stalled left the runner blocked on `exited`. A non-null
   `feedLine` result now terminates immediately. Regression: a fixture that
   writes a malformed line and then stays alive past the test bound.
2. **Codex top-level error reported as success.** The `error` event recorded a
   message but never set `isError`, so a later `turn.completed` with exit zero
   produced a successful result and dropped the error text. `error` is now
   sticky, and `extractResult` keeps *both* the error and the agent's answer
   (joining them) so a failure names its cause without discarding the work.
   Regression: `error` → `agent_message` → `turn.completed`.
3. **Claude subprocesses inherited credentials.** Only `ANTHROPIC_API_KEY` was
   removed, so ambient cloud and registry tokens remained reachable from the
   Bash tool. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` now strips them from CLI
   subprocesses while preserving authentication. Two limits remain, verified
   live: the CLI's denylist does **not** contain `OPENAI_API_KEY` (0 occurrences
   in the 2.1.263 binary, against 21 for `GITHUB_TOKEN`), so the adapter deletes
   it explicitly; and the variable is a denylist, so bespoke secrets are still
   visible. An allowlist environment is the robust fix and remains open. The
   variable also forces the CLI's permission mode to `default`, so commands the
   static analyzer deems sensitive (for example `printenv`) need approval and are
   refused non-interactively; read-only review commands (`echo`, `git status`,
   `git diff`) were confirmed unaffected, with and without the variable.
4. **Codex project rules were still loaded.** `--ignore-user-config` covers only
   `$CODEX_HOME/config.toml`; user and project execpolicy `.rules` files have a
   separate switch. `--ignore-rules` is now passed. The related concern that a
   project `.codex/config.toml` could define write-capable MCP servers was
   tested and **not reproduced** on 0.154.0: with an empty `CODEX_HOME`, a
   project config setting `sandbox_mode = "danger-full-access"` had no effect
   (sandbox stayed `read-only`), while an explicit `-c sandbox_mode=...` did
   apply. `codex doctor`'s "project config" line describes project-name
   resolution, not the launch configuration. No refusal guard is warranted.

Also tightened: the Claude sandbox deny-write assertion now checks the exact
`//`-prefixed path instead of a substring that a wrong single-slash path would
also satisfy, and the Codex prompt is passed after `--` so an adapter caller
cannot have it parsed as a flag.

Post-fix verification: typecheck clean; 80 fixture tests pass; live Claude
checks with and without the scrub variable (Bash capability, `git status`
parity, credential-visibility probe).

### Packaging note

The repository root is a Pi package. Pi resolves a directory source through
`package.json`'s `pi.extensions` manifest (or a root `index.ts`), not through
`.pi/extensions/`, so `package.json` declares:

```json
"pi": { "extensions": ["./.pi/extensions/agent-dispatch/index.ts"] }
```

Without that manifest, a local install or directory `-e` resolves no entry and
Pi fails with `Cannot find module '<repo root>'`. The Pi runtime packages are
declared as `peerDependencies` with `"*"` (Pi bundles them); `@types/node` and
`typescript` remain dev-only.

### Review follow-up 2 (Codex review of the extension itself)

A live `dispatch` review flagged issues in this extension. Each was verified
against the source before acting.

Fixed:

1. **Invalid pid signalled PID 1.** `track(child, child.pid ?? -1)` combined with
   `process.kill(-pid, …)` meant a failed spawn probed/signalled group `1`
   (e.g. `kill(1, 0)`/`kill(1, SIGTERM)`), which is dangerous in a container
   running as root. A failed spawn now stores `0` and both `groupAlive` and
   `signalGroup` reject non-positive pids. Regression: a spy on `process.kill`
   proves a failed spawn never touches pid `1` or group `0`.
2. **Callback exceptions escaped cleanup.** A throw from `parseLine` or the
   caller's `onEvent` inside a stream `data` listener became an uncaught
   exception and skipped child cleanup. The listeners now capture the error,
   terminate the child, and `runAdapter` rethrows only after a `finally` block
   has guaranteed cleanup. Regressions: a throwing parser and a throwing
   `onEvent`, both asserting rejection plus a dead child.
3. **`runCaptured` ignored an already-aborted signal.** It now checks
   `signal.aborted` before spawning, like `runAdapter`. Regression: aborted
   signal spawns no process.
4. **Unbounded output.** A single unterminated stdout line and all stderr could
   grow without limit. stdout lines are now capped (1,000,000 chars → treated
   as a malformed stream and terminated); stderr is capped at 256 KiB with a
   truncation marker. Regression: an oversized line fails as `malformed-stream`.
5. **TOML inline comments.** `key = "x" # note` was parsed as `"x" # note`.
   Inline comments are now stripped outside quotes. Regression added.

Stream-parse failure now takes precedence over a generic signal outcome, so a
self-terminated invalid stream reports `malformed-stream` rather than `signal`.

Not changed, deliberately:

- **`ANTHROPIC_API_KEY` removal is spec-mandated.** Dropping it is required so
  Claude uses the working subscription login instead of the broken API key
  (verified earlier). A key-only install would indeed prefer the key; that
  trade-off is the documented design, not a defect to fix here.
- **No execution deadline.** Dispatch blocks until the CLI exits or the caller
  cancels. A deadline would cut off long reviews; it is out of scope.
- **Windows kills only the direct child.** POSIX process groups are the design;
  the limitation is now stated in the module comment.

One Codex claim was rejected: `profile` in `codex config.toml` is still a
documented selector in `codex-cli 0.154.0`, so the profile-aware resolution
stands.
