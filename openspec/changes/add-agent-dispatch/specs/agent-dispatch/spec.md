## Purpose

Lets a Pi session hand a task to an external CLI coding agent — such as Codex or Claude Code — and receive that agent's result in the conversation, using that agent's own models, reasoning levels, and tooling.

## ADDED Requirements

### Requirement: Dispatch a task to an installed CLI agent

The system SHALL provide a `dispatch` tool that runs a caller-supplied task on a selected installed CLI agent and returns that agent's final response inline in the Pi conversation. The tool SHALL block until the agent completes.

#### Scenario: Successful dispatch

- **WHEN** the caller invokes `dispatch` with a task and a supported CLI that is installed and authenticated
- **THEN** the tool returns that agent's final response text as the tool result

#### Scenario: Requested CLI is not installed

- **WHEN** the caller invokes `dispatch` naming a CLI that is not installed or not available on `PATH`
- **THEN** the tool fails with an error naming the missing CLI and does not silently run a different agent

#### Scenario: Unsupported CLI name

- **WHEN** the caller invokes `dispatch` naming a CLI the system does not support
- **THEN** the tool fails with an error listing the supported agents

### Requirement: Read-only execution

A dispatched agent MUST NOT be able to modify files in the working tree. The system SHALL enforce this through the agent's own sandbox or permission configuration, not merely by instructing the agent to avoid writes. The verified launch configuration SHALL cover shell commands, file tools, inherited hooks, and MCP servers. Paths outside the enforcement boundary SHALL be disabled or constrained before launch.

#### Scenario: Agent attempts to write

- **WHEN** a dispatched agent attempts to create or modify a file
- **THEN** the write is blocked and the working tree is left unchanged

#### Scenario: Agent runs read-only commands

- **WHEN** a dispatched agent runs shell commands that only read state
- **THEN** those commands execute and their output is available to the agent

#### Scenario: Read-only enforcement is not established

- **WHEN** an adapter cannot establish read-only enforcement for the complete launch configuration
- **THEN** dispatch refuses to launch and explains the unsupported configuration

#### Scenario: Inherited hooks or MCP servers attempt writes

- **WHEN** inherited hook or MCP configuration can modify the working tree
- **THEN** the adapter disables that path or enforces denial of its writes before it can modify the tree

#### Scenario: Read-only verification evidence

- **WHEN** an adapter is verified for read-only support
- **THEN** verification records actual denied shell and file-tool write attempts, an unchanged working tree, and evidence that inherited hook and MCP write paths are disabled or denied
- **AND** an agent declining to attempt a write does not count as enforcement evidence

### Requirement: Model selection

The system SHALL allow the caller to name a model for a dispatch, and SHALL pass a named model to the target CLI unmodified. When the caller names no model, the target CLI SHALL use its own configured default.

#### Scenario: No model named

- **WHEN** the caller invokes `dispatch` without a model
- **THEN** the target CLI runs with its own configured default model

#### Scenario: Model named

- **WHEN** the caller names a model
- **THEN** that identifier is passed to the target CLI unmodified, with no translation between the system's own model names and the CLI's identifier space

### Requirement: Invalid model and effort are rejected or surfaced

Where a target CLI can enumerate its supported models and reasoning levels, the system SHALL reject an unsupported combination before starting an agent run. Where it cannot, the system SHALL surface the CLI's own error message.

#### Scenario: Unsupported model rejected before execution

- **WHEN** the caller names a model the target CLI does not support and that CLI can enumerate its models
- **THEN** the tool fails with an error naming valid alternatives and no agent run is started

#### Scenario: Unsupported model surfaced from the CLI

- **WHEN** the caller names a model the target CLI rejects and that CLI cannot enumerate its models
- **THEN** the tool fails and includes the CLI's own error message

### Requirement: Reasoning effort selection

The system SHALL allow the caller to specify a reasoning effort level for a dispatch, and SHALL pass it to the target CLI when the selected model supports that level.

#### Scenario: Supported effort applied

- **WHEN** the caller names an effort level the target model supports
- **THEN** the dispatch runs at that effort level

#### Scenario: Unsupported effort does not silently degrade

- **WHEN** the caller names an effort level the target model does not support
- **THEN** the tool fails rather than running at a different level, naming the supported levels where the target CLI can enumerate them and otherwise including the CLI's own error message

#### Scenario: Effort supplied without a model

- **WHEN** the caller specifies effort but omits the model and the CLI supports pre-validation
- **THEN** validation uses the effective configured model for the same working directory and CLI configuration, and the adapter passes no model override

### Requirement: Independent assessment

The extension SHALL prepend `Assess the evidence independently.` to the caller's unchanged task and scope hint. It SHALL leave the requested response format to the caller and SHALL NOT require disagreement or a counterargument.

#### Scenario: Caller requests a specific response format

- **WHEN** the caller supplies a task with a response format
- **THEN** the extension preserves that task and adds no compulsory critique format

### Requirement: Per-agent environment isolation

Each CLI agent SHALL be launched with an environment adapted to that agent, so ambient variables that render an agent non-functional are not inherited.

#### Scenario: Ambient API key overrides a working login

- **WHEN** an ambient environment variable is known to make a CLI select a non-functional credential instead of a working login
- **THEN** that variable is removed from the child process environment and the dispatch uses the working credential

### Requirement: Failed dispatches are reported as errors

The system SHALL report success only after exit code zero and a recognized successful terminal envelope, with no stream parsing failure. Non-zero exit, termination by signal, an error envelope, malformed or truncated JSONL, or a missing terminal envelope SHALL produce a tool failure. Available diagnostics and reported usage SHALL be preserved.

#### Scenario: Agent exits non-zero

- **WHEN** a dispatched agent exits with a non-zero status
- **THEN** the tool result is marked as an error and includes the agent's own error output

#### Scenario: CLI reports an error envelope

- **WHEN** the CLI emits an error envelope, even if its exit code is zero
- **THEN** the final Pi tool result is marked as an error and retains the CLI's diagnostic text

#### Scenario: Incomplete or malformed stream

- **WHEN** stdout contains malformed or truncated JSONL, or the CLI exits zero without a recognized terminal envelope
- **THEN** dispatch reports an incomplete or invalid response as an error, preserving available diagnostics and usage

#### Scenario: CLI terminated by signal

- **WHEN** the CLI terminates by signal
- **THEN** dispatch reports failure with the signal or cancellation reason and preserves available usage

#### Scenario: Complete JSON line split across chunks

- **WHEN** valid JSONL arrives across multiple stdout chunks or its final complete line has no trailing newline
- **THEN** the adapter parses it correctly without treating chunk boundaries as malformed output

### Requirement: Cancellation and session cleanup

The extension SHALL track active subprocess groups and use idempotent cleanup on abort, session shutdown, and dispatch completion or failure. Cleanup SHALL send SIGTERM, wait at most two seconds, then force termination of surviving groups and reap direct children. Shutdown SHALL prevent new spawns. Discovery subprocesses SHALL follow the same lifecycle. Abrupt parent death that prevents cleanup is outside this guarantee; the system SHALL NOT claim children always die with Pi.

#### Scenario: Cancel an active dispatch

- **WHEN** the caller cancels a dispatch, including during subprocess startup
- **THEN** the extension terminates its process group and leaves no surviving child from that dispatch

#### Scenario: Session shuts down during dispatch

- **WHEN** Pi emits `session_shutdown` while a CLI or discovery subprocess is active
- **THEN** the extension prevents new spawns and completes group cleanup before its shutdown handler returns

#### Scenario: Descendant ignores graceful termination

- **WHEN** a descendant ignores SIGTERM or remains after the direct CLI exits
- **THEN** cleanup forcibly terminates the surviving group after the bounded grace period
- **AND** repeated cleanup calls do not signal unrelated processes

### Requirement: Usage reporting

Where a dispatched agent reports token usage, the system SHALL attach that usage once to the final tool result so it participates in Pi's usage accounting. This applies to successful, failed, cancelled, and incomplete dispatches. Missing usage SHALL NOT be invented, and cumulative reports SHALL NOT be counted repeatedly.

#### Scenario: Usage included in the result

- **WHEN** a dispatched agent reports token usage
- **THEN** that usage is attached to the tool result and counted in session totals

#### Scenario: Failed dispatch reports usage

- **WHEN** an error envelope, cancelled run, or incomplete stream includes token usage
- **THEN** the final Pi result is marked as an error and its reported usage is counted once in session totals

### Requirement: Working directory scope

A dispatched agent SHALL run against the Pi session's current working directory and SHALL be able to inspect repository state, including uncommitted changes.

#### Scenario: Reviewing uncommitted changes

- **WHEN** the caller asks a dispatched agent to review uncommitted changes
- **THEN** the agent can inspect the working tree and repository state, including the diff of uncommitted changes, without the caller supplying that diff

### Requirement: Live progress and compact results

While a dispatch is running, the system SHALL display the dispatched agent's activity as it occurs. On completion, the system SHALL display a compact summary that expands on demand to the full response. The row SHALL identify the CLI and distinguish requested model and effort from CLI-confirmed values. Before confirmation it SHALL show the requested values or `CLI default` with confirmation pending. Values that the CLI does not expose SHALL be labelled `not reported`, never presented as confirmed from echoed arguments or catalogue defaults.

#### Scenario: Progress while running

- **WHEN** a dispatch is in progress
- **THEN** the tool row shows the agent's recent activity, including commands it runs, and updates until the dispatch finishes

#### Scenario: Compact finished result

- **WHEN** a dispatch completes successfully
- **THEN** the tool row shows a summary of one or two lines and the full response is revealed when the row is expanded

#### Scenario: Identity visible

- **WHEN** a dispatch row is displayed, whether running or finished
- **THEN** the CLI and requested model and effort are visible, alongside CLI-confirmed values when available
- **AND** pending or unreported values are labelled explicitly

#### Scenario: CLI confirms inherited defaults or overrides

- **WHEN** the CLI reports the effective model or effort for a dispatch, including a default-model or effort-only request
- **THEN** normalized adapter metadata updates the row and final result with those reported values, retaining the request separately

### Requirement: Adding a new CLI agent

The set of supported CLI agents SHALL be extensible without changing the `dispatch` tool's parameters or result shape.

#### Scenario: New agent added

- **WHEN** support for an additional CLI agent is added
- **THEN** the `dispatch` tool's arguments and result format are unchanged
