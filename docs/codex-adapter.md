# Codex native adapter

`CodexNativeHarnessAdapter` implements the internal harness contract from #12 for
one local Ace-created Codex thread and one text turn (#13). It is a building block
for the shared terminal interface in #14; this slice adds no CLI command or new
terminal application. Existing workflow commands still use their existing path.

## Supported lifecycle

Create an adapter, call `start`, observe its returned identity, then call
`sendInput`. Only one session may exist in an adapter at a time. `start` creates a
new native thread; it never reads, attaches, resumes, forks, or imports another
thread. `sendInput` reserves the one turn before sending it, so concurrent input
cannot accidentally steer or create additional work.

```ts
import { CodexNativeHarnessAdapter } from "./src/harness/index.js";

const adapter = new CodexNativeHarnessAdapter();
const started = await adapter.start({
  type: "session.start",
  sessionId: "example-session", // Unique within this adapter's lifetime.
  workspace: process.cwd(),
});
if (started.status !== "ok") throw new Error(JSON.stringify(started));
const session = started.value;
const observation = adapter.observe(
  { type: "session.observe", session },
  (event) => {
    // Render conversation, tools, changes, approvals, and native permission context.
    // A terminal session.completed, session.cancelled, or session.error ends this session.
  }
);
const submitted = await adapter.sendInput({
  type: "session.input",
  session,
  input: "Explain the project structure.",
});
// Keep observing until a terminal event or the user closes the session.
// On close, remove observation and await adapter.dispose({ type: "session.dispose", session }).
```

A successful command result means native request acceptance, not task completion.
`turn/completed` maps to `session.completed`, `session.cancelled`, or
`session.error`; unknown terminal statuses produce an explicit protocol error.
The current S1 contract makes these events terminal. Further input requires
`dispose` and `start` with a new local session ID. Multi-turn continuation and
same-harness restart/resume are later slices; `resume` is explicitly unsupported.

`interrupt` requires an acknowledged live turn and sends `turn/interrupt` once.
Its acknowledgment does not fabricate cancellation: the native terminal outcome
remains authoritative. Disposal clears observers and approvals immediately, closes
pending RPCs, and stops only the owned app-server child. Shutdown sends SIGTERM,
then SIGKILL after the configured grace period (one second by default).

## Native authority and approval behavior

The adapter launches `codex app-server --listen stdio://` without a shell. It
inherits native configuration and environment, sends `cwd` to `thread/start`, and
allows only an optional `nativeOptions.model` override. Generic config, sandbox,
approval policy, reviewer, environment, authentication, and existing-session
options are rejected before spawning. Ace does not change native permission rules.

The ready-state snapshot and later state/approval events expose Codex's reported
`approvalPolicy`, `approvalsReviewer`, and `sandbox` under
`nativeDetails.permissionContext`. Native rules may allow, deny, or route work to
native review without an Ace prompt. The adapter does not claim every operation
was approved through Ace.

Only native command execution and file change approval requests are supported.
Each prompt has a local `approvalId`, a request-specific `correlationId`, the
native request ID, native thread/turn/item context, and a list of supported
choices. Render the native reason and command, file, or network context before
submitting a user decision:

```ts
// `pending` is a currently displayed approval.requested event.
await adapter.respondToApproval({
  type: "approval.respond",
  session,
  approvalId: pending.approvalId,
  correlationId: pending.correlationId,
  decision: userSelectedChoice,
});
```

Choices are limited to `accept`, `decline`, and `cancel`, intersected with native
`availableDecisions` when supplied. Session-wide grants and policy amendments are
not offered. Unsupported interaction types (including permission grants, user
questions, and MCP elicitation) receive a protocol error and terminate the session
without an automatic decision.

Approval IDs use a fresh, non-persisted adapter namespace, and correlations include
local/native session and turn IDs. A reply is claimed before writing, preventing
duplicate/concurrent submissions.
`serverRequest/resolved` or item completion clears the prompt. `approval.resolved`
with `decision: "expired"` means the native request ended without an Ace reply;
`nativeDetails.resolution` explains why. A submitted decision is preserved with
`decisionSubmitted: true`; this does not assert that execution succeeded. Pending
requests expire on interruption, native resolution, item/turn completion,
disconnect, error, or disposal. Old replies and reused local session IDs are never
replayed, including when a later child reuses a native request ID.

## Events and failure handling

Conversation items retain native message IDs; deltas and authoritative completed
messages remain separate. Tools retain native status, arguments, results, and
errors. A declined file change is failed tool activity, not a reported edit.
Successful file-change items expose paths and native diffs. Aggregated turn diffs
are preserved in `nativeDetails.params.diff` without inferring filesystem state.
Workers are observations from native collaboration items, never an Ace scheduler.
Unmapped items, worker states, and notifications retain structured native details
without being normalized into success. Account notifications are not exposed.

Observers receive the current state or terminal snapshot when subscribing, then
new events. They do not receive transcript or approval replay. Observer exceptions
and mutations cannot change native approval state or corrupt another observer's
events; reentrant delivery preserves sequence order.

Missing Codex installation and missing native authentication return actionable
errors. Authentication status is checked with `account/read` and
`refreshToken: false`. Login remains a separate `codex login` action. Ace does not
read credential files, copy tokens, refresh authentication itself, or persist
account fields. Native stderr is drained without being retained or emitted.

Startup/RPC/write timeouts default to 30 seconds. Malformed messages, unsupported
required fields, unknown responses, truncated output, and frames over 1 MiB fail
closed. A timeout or disconnect can leave the native operation's outcome unknown;
the adapter never retries or resubmits automatically. A native terminal result for
the active turn can establish acceptance even if it precedes the corresponding
RPC response.

## Version evidence and verification

| Component | Evidence |
| --- | --- |
| Codex CLI | Exactly `codex-cli 0.153.4`; checked before app-server startup |
| Protocol | Local stdio, generated v2 schemas with experimental APIs disabled |
| Node.js | Tests run with `v22.21.1` |
| pnpm | `10.33.2` |
| Test runner / TypeScript | Vitest `3.2.4` / TypeScript `5.9.3` |

The adapter deliberately rejects other CLI versions until their generated
protocol and fixtures have been validated. It does not claim a general minimum
version or compatibility with arbitrary newer releases. The version check and
protocol generation were performed without starting a live model session:

```sh
codex --version
codex app-server generate-ts --out /tmp/ace-codex-protocol
pnpm exec vitest run tests/harness
pnpm test
pnpm lint
pnpm build
```

Protocol inspection covers initialize, account status, thread/turn start,
interrupt, item/turn notifications, command/file approvals, native request
resolution, and error/status enums. The fixture values are synthetic and authored
for tests; no generated account data, local transcripts, or credential material is
checked in. Tests include real Node subprocess fixtures with an empty environment
and require neither Codex installation nor live provider access. Native-auth smoke
testing was not performed; fixture success is not evidence of account/model access
or arbitrary attach/import support.

Official interface reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server).
Design and scope: [#11](https://github.com/aceteam-ai/ace/issues/11),
[contract #12](https://github.com/aceteam-ai/ace/issues/12),
[Codex slice #13](https://github.com/aceteam-ai/ace/issues/13).
