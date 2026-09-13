# pi-cli-subagent

A [Pi](https://pi.dev) extension that adds a `dispatch` tool: hand a task to an
installed external CLI coding agent — **Codex CLI** or **Claude Code** — and get
its response back inline in your Pi session.

Dispatch is **blocking and read-only**. The external agent can read your
workspace and run read-only commands, but it cannot modify your working tree.

- **Why:** it produces genuinely independent verification — a different model,
  a different toolchain, a different set of habits — without pulling all of that
  agent's context into your Pi session.
- **Not:** background execution, session resume, or write-enabled delegation.

## Requirements

| Requirement | Notes |
| --- | --- |
| Pi with extension support | The host that loads this package. |
| Node.js ≥ 22.6 | Only for development (`--experimental-strip-types`). Runtime uses Pi's Node. |
| `codex` on `PATH` | Codex CLI, installed **and authenticated**. Needed for `cli: "codex"`. |
| `claude` on `PATH` | Claude Code, installed **and authenticated**. Needed for `cli: "claude"`. |

You only need the CLI(s) you actually intend to dispatch to. If a CLI is
missing, that dispatch fails with a clear `cli-not-installed` error rather than
hanging.

The CLIs are **runtime dependencies of your environment**, not bundled by this
package. Authentication is entirely theirs — this extension never handles your
credentials.

## Installation

### Use it as a project-local extension

The extension is already wired into this repository at
`.pi/extensions/agent-dispatch/index.ts`. Run Pi from this directory and the
`dispatch` tool is available.

### Install as a Pi package

```bash
pi install /absolute/path/to/pi-cli-subagent
pi install ./relative/path/to/pi-cli-subagent
pi install git:github.com/user/pi-cli-subagent@v1
```

Or try it without installing:

```bash
pi -e /absolute/path/to/pi-cli-subagent
```

The package manifest (`pi.extensions` in `package.json`) points at the extension
entry point:

```json
"pi": { "extensions": ["./.pi/extensions/agent-dispatch/index.ts"] }
```

Enable or disable it with `pi config` (press <kbd>Tab</kbd> to switch between
global and project settings).

## Usage

The extension registers exactly one tool, `dispatch`.

| Parameter | Required | Description |
| --- | --- | --- |
| `task` | yes | The task to hand to the external agent. Passed through unchanged. |
| `cli` | yes | Which agent to run: `"codex"` or `"claude"`. |
| `model` | no | Model identifier passed to the CLI **unmodified**. Omit to use the CLI's own configured default. |
| `effort` | no | Reasoning effort level. Omit to use the CLI's configured default. |
| `scope` | no | Optional scope hint appended after the task (e.g. a directory or file list). |

You rarely call this tool by hand — Pi's model decides to, based on your request:

> Have Codex review my uncommitted changes for risk.

> Ask Claude, on high effort, to review this file for race conditions.

> Get a second opinion from Codex on the schema in `src/db.ts`.

Because `task` is passed through verbatim, review framing, output format, and
"second opinion" behavior are all just prompts — nothing is hardcoded. The only
standing instruction added is a short nudge to assess the evidence independently.
`model` and `effort` are never translated between CLIs; if you name them, they go
straight to the CLI.

### Model and effort resolution

- Omit `model`/`effort` → the CLI's own configured default is used.
- Name `model`/`effort` → passed through unvalidated, except for Codex, which
  is pre-validated against its model catalogue (`codex debug models`) so an
  unsupported value fails fast with the valid alternatives listed.
- The result reports **CLI-confirmed** model/effort separately from what you
  requested. Values the CLI does not report are labelled `not reported` rather
  than guessed.

## The read-only guarantee

Dispatch refuses to run at all if it cannot enforce read-only across the
*complete* launch configuration — shell, file tools, hooks, and MCP servers —
not just shell commands. This is enforced by each CLI's own sandbox, never by
asking the agent nicely.

| CLI | Key launch restrictions |
| --- | --- |
| Codex | `-s read-only`, `--ignore-user-config`, `--ignore-rules`, `--disable hooks`, `--disable plugins` |
| Claude | `--safe-mode`, `--strict-mcp-config`, `--tools Read,Bash`, sandbox forced on with `allowUnsandboxedCommands: false` and the workspace root in `denyWrite` |

Note that read-only protects your **working tree**. It does not establish
confidentiality or prevent network side effects. See [TODO.md](TODO.md).

## Failures

Failures are typed and reported with diagnostics rather than thrown. A failed
dispatch sets `isError: true` and names the cause.

| Kind | Meaning |
| --- | --- |
| `missing-cli` / `unsupported-cli` | No `cli`, or an unrecognized one. |
| `cli-not-installed` | The CLI binary is not on `PATH`. |
| `read-only-unavailable` | The adapter cannot enforce read-only; dispatch refuses. |
| `invalid-request` | Rejected by preflight (e.g. an unsupported Codex model). |
| `spawn` | The process could not be launched. |
| `nonzero-exit` / `signal` | The CLI exited non-zero or was killed by a signal. |
| `error-envelope` | The CLI reported an error in its terminal envelope. |
| `malformed-stream` | The CLI emitted unparseable output. |
| `missing-terminal` | Exit 0 with no recognizable terminal result. |
| `cancelled` / `shutdown` | Cancelled by the caller, or the session is shutting down. |

Reported usage (tokens/cost) is preserved on both success and failure.

## Development

### Setup

```bash
npm run link-deps   # symlink Pi runtime packages from your installed Pi
npm run typecheck   # tsc --noEmit
npm test            # node --test over test/*.test.ts
```

`link-deps` exists so `tsc` and the test runner resolve the Pi peer packages
(`@earendil-works/*`, `typebox`) from your local Pi installation without a
network install. Only the Pi runtime packages and `@types/node` are linked.

### Tests

All tests run against a **fake CLI** (`test/fixtures/fake-cli.mjs`) that emits
scripted JSONL, so the suite is deterministic, fast, and free. It covers stream
parsing, failure classification, process lifecycle and cleanup, cancellation,
signal handling, and argument construction.

### Live checks

```bash
node --experimental-strip-types scripts/live-check.mts <repo>
```

This harness makes **real, paid CLI calls** and is run manually, not in CI. It
verifies the things fixtures cannot: that each CLI accepts the launch flags,
that read-only denials actually happen and the tree is unchanged, and that live
streams parse. Use a throwaway repo.

### Architecture

```
.pi/extensions/agent-dispatch/
  index.ts             Extension entry: owns the process registry, wires tools
  tool.ts              `dispatch` tool registration + isError patching
  dispatch-core.ts     CLI-agnostic dispatch logic (no Pi imports)
  runner.ts            Spawn, stream, terminate, classify the outcome
  process-registry.ts  Tracks child process groups; kills on cancel/shutdown
  adapters/            One module per CLI: codex.ts, claude.ts, util.ts
  prompt.ts, render.ts, types.ts
```

Adding a CLI means adding **one adapter** and no changes to the tool. An adapter
implements `CliAdapter` (`types.ts`):

- `buildCommand(req, defaults)` → the exact argv/env to spawn (required)
- `parseLine(line, state)` → normalized stream events (required)
- `extractResult(state)` → final text, usage, identity, terminal/error flags (required)
- `preflight(req, ctx)` → validate a request and resolve defaults (optional)
- `discoverModels(ctx)` → enumerate models/efforts (optional)

Every adapter normalizes its CLI's output into the same event stream, so
`dispatch-core.ts` contains zero CLI-specific knowledge.

## Known limitations

Security caveats and deferred work are tracked in [TODO.md](TODO.md). The two
most important: the child environment uses a **denylist**, not an allowlist; and
detached descendants can escape process-group cleanup.

## License

[MIT](LICENSE) © 2026 Daniel Carter
