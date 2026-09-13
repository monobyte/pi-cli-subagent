## 1. Scaffold

- [ ] 1.1 Create the extension entry point and an `adapters/` directory, and verify `pi -e ./.pi/extensions/<entry>.ts` loads with no errors and no startup warnings
- [ ] 1.2 Define the `StreamEvent` union and the `CliAdapter` interface (`buildCommand`, `parseLine`, `extractResult`, `capabilities`, optional `discoverModels`) as shared types, including metadata events, requested versus confirmed identity, terminal-envelope state, and typed failure details; verify the project type-checks

## 2. Research and record per-CLI capabilities

- [ ] 2.1 Codex: re-verify that `-s read-only` blocks a write while permitting command execution, that an unclosed stdin causes a `<stdin>` append, and that `codex debug models` returns slugs with `supported_reasoning_levels`; record the exact version, flags, settings, and denial evidence in `design.md`. Also verify file-tool writes and inherited hook/MCP write paths are blocked or disabled by the complete launch configuration
- [ ] 2.2 Claude: determine and verify a read-only configuration that blocks file writes while still allowing reads and read-only commands. Record exact version, flags, settings, and actual denial evidence in `design.md`, covering shell writes, file tools, and inherited hook/MCP write paths. An agent declining a write is not proof. If no such configuration exists, record that dispatch must refuse for Claude rather than run unsandboxed
- [ ] 2.3 Claude: verify the environment requirement by running once with `ANTHROPIC_API_KEY` present and once with it removed, and record both observed outcomes in `design.md`
- [ ] 2.4 Claude: capture which JSON envelope fields carry the final text, usage, session id, error state, terminal completion, and confirmed model/effort, and record them for the adapter implementation
- [ ] 2.5 Capture each CLI's model and effort metadata for explicit overrides, inherited defaults, and effort-only requests; record unavailable fields as unreported. Establish how Codex resolves the effective configured model for effort-only pre-validation

## 3. Codex adapter

- [ ] 3.1 Implement `buildCommand` with read-only sandbox, model and reasoning-effort overrides, working directory, and a closed or ignored stdin; verify by running a dispatched no-op task that exits 0
- [ ] 3.2 Implement `parseLine` mapping Codex JSONL events to `StreamEvent`, and verify against a captured event log that agent messages, command executions, and confirmed identity metadata surface
- [ ] 3.3 Implement `extractResult` returning final text, usage, session identity, confirmed model/effort, terminal-envelope state, and error state; verify usage values match those in the raw event log
- [ ] 3.4 Implement `discoverModels` over `codex debug models`; verify it returns the slugs and per-model supported effort levels present in the catalogue
- [ ] 3.5 Validate a requested model and effort against the catalogue before spawning; verify an unsupported model and an unsupported effort are each rejected with valid alternatives named, and that no agent run starts. Cover effort-only requests against the effective configured model without adding a model override

## 4. Claude adapter

- [ ] 4.1 Implement `buildCommand` with the read-only configuration established in 2.2, model and effort overrides, removal of `ANTHROPIC_API_KEY` from the child environment, and a closed or ignored stdin; if 2.2 passes, verify a dispatched no-op task exits 0 with the ambient key still set in the parent environment. Otherwise keep the adapter disabled, verify refusal before spawn, and leave Claude execution acceptance open
- [ ] 4.2 Implement `parseLine` for Claude's streaming JSON events; verify agent text, tool activity, and available confirmed identity surface as `StreamEvent`s
- [ ] 4.3 Implement `extractResult` from the result envelope; verify a successful run yields text, usage, terminal state, and confirmed identity where reported, and that `is_error` retains diagnostics and usage in a reported failure
- [ ] 4.4 Confirm the adapter reports no model catalogue, and verify an unknown model name reaches the caller as the CLI's own error message rather than a crash

## 5. Dispatch tool

- [ ] 5.1 Register the `dispatch` tool with `task`, `cli`, optional `model`, optional `effort`, and optional `scope` parameters; verify it appears in `pi.getAllTools()` and is callable
- [ ] 5.2 Assemble the outgoing prompt as `Assess the evidence independently.` plus caller task plus scope hint; verify the caller's text and response format remain unmodified and no compulsory disagreement or counterargument is added
- [ ] 5.3 Run the adapter blocking, forwarding parsed events through `onUpdate`; verify the caller sees incremental progress during a multi-second run
- [ ] 5.4 Register active CLI and discovery process groups and implement shared idempotent cleanup on abort and `session_shutdown`; stop new spawns during shutdown, check abort before spawn, send SIGTERM, then SIGKILL after at most two seconds, and reap direct children. Verify cancellation during startup and repeated cleanup leave no surviving dispatch child or signal to an unrelated process
- [ ] 5.5 Return collected failures with diagnostic content, usage, and typed failure details. Add a `tool_result` handler scoped to `dispatch` that patches `isError: true` without losing those fields. Verify the final Pi message is an error for non-zero exit and an error envelope with exit zero
- [ ] 5.6 Attach reported usage once to the final tool result; verify Pi session totals for success, a failure envelope with non-zero usage, and cancelled/incomplete runs with usage. Verify repeated cumulative reports are not double-counted and missing usage is not invented
- [ ] 5.7 Resolve the requested CLI and fail clearly for missing, uninstalled, or unsupported agents; verify each of those three cases produces a distinct, legible error
- [ ] 5.8 Refuse to dispatch when the resolved adapter reports it cannot enforce read-only; verify the refusal path by exercising a stub adapter with that capability disabled
- [ ] 5.9 Require exit zero plus a valid successful terminal envelope and no parsing failure. Add deterministic fixtures for malformed/truncated JSONL, exit zero without a terminal envelope, signal termination, unknown well-formed events, split stdout chunks, and a complete final line without a newline
- [ ] 5.10 Use local child-process fixtures to verify shutdown during dispatch/discovery, descendants left after direct-child exit, and SIGTERM-resistant descendants. Confirm bounded forced cleanup; document that forced parent death can skip cleanup

## 6. TUI presentation

- [ ] 6.1 Show CLI and requested model/effort or `CLI default` initially, with confirmation pending. Update from adapter metadata and retain confirmed identity in final details; verify unavailable values show `not reported` instead of echoed arguments presented as facts
- [ ] 6.2 Implement `renderResult` streaming a live tail of agent activity while `isPartial`; verify a long dispatch shows updating command activity rather than a static spinner
- [ ] 6.3 Implement the settled view as a one- or two-line summary that expands to the full response, using `keyHint` for the expand affordance; verify collapse and expand both render correctly
- [ ] 6.4 Implement the error view; verify a failed dispatch renders the agent's error text legibly

## 7. Integration verification

- [ ] 7.1 Verify the complete read-only configuration for each enabled adapter with recorded actual denied shell and file-tool write attempts and an unchanged working tree. Exercise inherited write-capable hooks/MCP and prove they are disabled or denied. An agent declining to write does not pass this gate
- [ ] 7.2 Verify that reviewing uncommitted changes works with no diff supplied by the caller, in a repository with an uncommitted modification
- [ ] 7.3 Verify explicit model/effort overrides, inherited defaults, and effort-only requests against CLI-reported metadata from 2.5. Confirm the row matches that independent evidence. Where a CLI does not report a value, verify truthful labelling and record the remaining verification limit; the row alone does not prove an override took effect
- [ ] 7.4 Verify every scenario in the `agent-dispatch` spec is satisfied, and that `openspec validate add-agent-dispatch --strict` passes

- [ ] 7.5 Run the validation matrix below and record commands, fixture results, tested CLI versions, and live evidence in the change artifacts. Keep blocked or unrun checks open; distinguish a verified refusal path from working Claude support

## Validation matrix

Use deterministic event fixtures and local fake CLI processes for extension behavior. Use live CLI runs only for behavior those fixtures cannot establish. Assert final Pi messages and session totals through the real extension/tool pipeline, not only adapter return values. Use temporary repositories for write probes and uncommitted-change tests. Do not print credentials in logs or captured fixtures.

| Acceptance area | Scenarios | Required evidence | Method |
| --- | --- | --- | --- |
| Tool contract and prompt | Tool registration; task with quotes, newlines, Unicode, and an explicit response format; omitted optional fields | Tool is callable; child receives the exact task and scope, with only the standing instruction added; no forced critique format | Extension test and fake CLI argv/stdin capture |
| CLI resolution | Supported installed CLI; unsupported name; supported binary absent from PATH; binary present but spawn fails | Correct adapter is selected; legible error distinguishes unsupported, missing, and launch failure; no fallback CLI starts | Controlled PATH and fake executables |
| Model and effort | No overrides; explicit model and effort; effort only; unsupported model/effort with catalogue; CLI rejection without catalogue | Arguments are passed unchanged; absent overrides stay absent; effort-only validation uses the effective configured model; invalid combinations start no agent run; CLI errors retain their text | Adapter fixtures plus live metadata checks in 2.5 and 7.3 |
| Environment | Parent has the conflicting Claude key; Codex uses the same parent environment; child launch succeeds or fails | Claude child omits the key; Codex behavior is unchanged; parent environment is unchanged on either path; working Claude login is demonstrated | Fake CLI environment assertions without secret output, plus live Claude authentication check |
| Read-only guarantee | Attempted shell and file-tool create/modify; inherited hook and MCP writes; read-only shell command; unverified adapter | Exact attempted-write denial or disabled-path evidence; no working-tree content, status, or diff change; reads succeed; unverified adapter starts no process | Live configuration probes in a temporary repository; deterministic refusal test |
| Parsing and completion | Both CLI event formats; text and command activity; metadata; unknown valid events; split lines and UTF-8 bytes; final line without newline | Final answer is extracted without duplicating progress text; metadata reaches details; valid chunking does not change results; unknown events do not count as completion | Captured, sanitized JSONL replayed with controlled chunk boundaries |
| Error reporting | Non-zero exit with stderr; error envelope with exit zero; malformed/truncated JSONL; exit zero without terminal result; signal exit | Final Pi tool message has `isError: true`; diagnostic text names the failure; partial text is not reported as a successful answer | Fake CLI processes through the Pi tool pipeline |
| Usage | Successful result; failure envelope with usage; cancellation/incomplete stream after usage; missing usage; repeated cumulative reports | Final persisted result retains reported usage; session totals increase exactly once by the normalized amount; absent usage is not fabricated | Pi session integration tests using deterministic usage fixtures |
| Process lifecycle | Already-aborted signal; abort during spawn and active output; discovery cancellation; session shutdown; normal exit leaving a descendant; child ignores SIGTERM; repeated cleanup | No new spawn after shutdown; owned groups terminate; direct children are reaped; force-kill follows the two-second grace period with scheduling tolerance; unrelated sentinel process survives | Local fake CLI and descendant processes, including a SIGTERM-resistant fixture |
| Concurrent calls | Two dispatches with interleaved events and different identity/usage; cancel one while the other completes | Progress, identity, errors, and usage stay attached to the correct tool call; cancelling one does not terminate the other; shutdown cleans all remaining groups | Pi parallel-tool integration fixture with deterministic barriers |
| Working directory | Pi cwd differs from extension directory; temporary repository has staged, unstaged, and untracked changes | Child cwd matches Pi; dispatched review can inspect those states without an injected diff; repository remains unchanged | Fake CLI cwd assertion plus live read-only review |
| TUI | Partial progress; confirmed metadata; missing metadata; collapsed and expanded completion; failure | Progress updates are visible; requested values are not labelled as confirmed; `not reported` is shown where needed; full final response expands; errors remain legible | Renderer fixtures and one real Pi TUI inspection |
| Adapter extensibility | Register a third stub adapter with the same event/result contract | Existing tool schema and result format are unchanged; shared runner and renderer need no CLI-name branch | Adapter contract test |

A sandbox test passes only when an operation is denied or its execution path is demonstrably disabled. A model choosing not to write is inconclusive. A displayed model or effort is not proof of the effective setting without independent CLI evidence. Parser and lifecycle fixtures do not prove real CLI sandbox or authentication behavior. OpenSpec validation proves artifact structure, not runtime behavior.
