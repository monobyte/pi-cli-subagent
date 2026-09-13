# TODO

Known caveats, deferred work, and open verification for `pi-cli-subagent`.

Items are ordered roughly by how much they matter for trusting a dispatch
result. Nothing here is a blocker for using dispatch as a **read-only** review
tool; they matter when confidentiality or guaranteed termination is the point.

---

## 1. The child environment is a denylist, not an allowlist

**Status:** mitigation in place, gap deliberately open.

The Claude adapter hands the child process a **copy of your entire shell
environment**, then deletes a list of known-dangerous variable names
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, AWS keys, …), plus sets
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` so the CLI also scrubs credentials from the
subprocesses *it* spawns.

The problem: a denylist only removes names someone thought of. Anything not on
it — a `DATABASE_URL`, an internal service token, an unexpected vendor key — is
still readable from the agent's Bash tool. Verified during review:
`OPENAI_API_KEY` appears **0** times in the Claude 2.1.263 binary (against 21 for
`GITHUB_TOKEN`), so the CLI's own scrub list misses it; the adapter deletes it
explicitly. The rest of the gap remains.

**Impact:** a prompt injected from repository content can exfiltrate ambient
credentials through the Bash tool. Read-only enforcement protects the working
tree, not your secrets.

**Suggested fix:** construct the child environment as an **allowlist** — start
from `{}` and add back only what the CLI needs (`PATH`, `HOME`, `TERM`, `LANG`,
`SHELL`, `TMPDIR`, …). Then an unanticipated secret is excluded by default
rather than leaked by default.

**Why it wasn't done:** Claude's login lives in `~/.claude` and depends on that
environment. An allowlist that is too tight breaks authentication and dispatch
stops working entirely. This needs deliberate design plus live verification, not
a drive-by change.

**How to verify a fix:** with sentinel values set in the parent environment for
variables *not* on any list (e.g. `INTERNAL_TOKEN=sentinel`), confirm a
dispatched Claude run cannot see them, and confirm authentication still works.

---

## 2. A Codex top-level `error` event is assumed fatal

**Status:** assumption embedded in the parser; unproven.

Codex can emit a top-level `{"type":"error"}` event. The adapter treats it as
**sticky** — once seen, the run is marked failed even if a later
`turn.completed` arrives with exit 0. This closed a real bug where a failed run
was reported as success.

That is correct *if* Codex only emits `error` when it has genuinely given up.
That has **not** been proven. Codex binaries contain retry/recovery strings
("stream disconnected - retrying sampling request", "; retrying after auth
recovery"); it is unknown whether any of those surface as this event.

**Impact:** if Codex emits `error` for a hiccup it recovers from, a successful
run would be reported as a failure.

**Mitigation already in place:** `extractResult` keeps *both* the error message
and the agent's answer (joined). Worst case you get a failure message that still
contains the complete answer, rather than a silently truncated result. The
runner names the failure from the first line, which is the error.

**How to verify:** force Codex into a transient failure (kill the network
mid-run) and observe the raw `--json` event sequence. If a recoverable error
emits `error` followed by a successful completion, switch to clearing
`isError` on a later `turn.completed`.

---

## 3. Detached descendants escape process-group cleanup

**Status:** known limitation, not fixed.

Cleanup signals the child's **process group** (`kill(-pid)`). A tool command can
call `setsid()` or spawn with `{ detached: true }`, moving itself into a new
process group; it then survives completion, cancellation, and session shutdown.

The lifecycle fixture spawns its descendant *without* `detached`, so every
existing test keeps the descendant inside the group that gets killed — the
escape is untested.

**Impact:** orphaned processes accumulate after dispatches that launch
self-detaching children.

**Suggested fix:** OS-level containment that descendants cannot escape — a
cgroup or PID namespace on Linux, a job object on Windows. Otherwise weaken the
cleanup claim and document it honestly.

**How to verify a fix:** add a fixture whose descendant sets `detached: true`,
assert its PID is dead after completion, cancellation, and shutdown.

---

## 4. No execution deadline (intentional)

**Status:** deliberate design decision, documented in
`openspec/changes/add-agent-dispatch/design.md`.

Dispatch blocks until the CLI exits or the caller cancels. There is no overall
deadline and no inactivity timeout. A CLI that hangs — network stall, CLI
lifecycle bug, or a process that emits a terminal envelope but never exits —
holds the tool call and the child process until you cancel.

A deadline was rejected because it would cut off legitimately long reviews.

**Revisit if:** dispatches hang in practice. A reasonable compromise is a long
overall deadline plus a short grace period after the terminal envelope, routed
through the same process-group cleanup and returned as a typed timeout failure.

---

## 5. Windows only terminates the direct child

**Status:** documented platform limitation.

There are no POSIX process groups on Windows, so cleanup kills only the direct
child; descendants are out of scope there. Not exercised by the test suite (CI
is not set up, and the fixture relies on POSIX signals).

---

## 6. No live verification after the latest fix round

**Status:** verification debt.

The most recent four fixes are covered by fixture tests (80 passing) and by
targeted live Claude checks (Bash capability, `git status` parity, scrub-var
side effects). The **full** `scripts/live-check.mts` matrix has not been re-run
since, so the recorded read-only evidence in `design.md` predates these changes.

**Action:** re-run `node --experimental-strip-types scripts/live-check.mts
<throwaway-repo>` and update the validation matrix in
`openspec/changes/add-agent-dispatch/design.md`.

---

## 7. Behavior change worth knowing: scrub var forces permission mode

**Status:** intentional, documented, benign for review workflows.

Setting `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` forces Claude's permission mode to
`default`. Commands the static analyzer deems sensitive (e.g. `printenv`) then
require approval and are **refused** in non-interactive dispatch. Verified live
that read-only review commands (`echo`, `git status`, `git diff`) are unaffected.

**Impact:** a dispatched agent that tries to inspect the environment will get a
denial. Acceptable and arguably desirable — but it is a narrowing of what the
agent can run.

---

## Deferred work (explicitly out of scope)

These were named as non-goals in the original proposal. Not bugs; do not
implement without a new change proposal.

- Background execution, or children intentionally left running after return.
- Multi-CLI fan-out as a distinct feature.
- Persistence across Pi restarts; session resume or follow-up turns.
- Structured / schema-constrained results.
- Write-enabled dispatch.
- Publishing to npm and CI (the package currently installs from a local path or git).
