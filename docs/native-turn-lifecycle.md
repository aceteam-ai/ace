# Native turn lifecycle amendment for #14

This reviewed amendment extends the [original #11 Design of Record](https://github.com/aceteam-ai/ace/issues/11#issuecomment-5606434501)
and [S1 contract](https://github.com/aceteam-ai/ace/pull/17) before the
[shared terminal panels in #14](https://github.com/aceteam-ai/ace/issues/14).
[#13](https://github.com/aceteam-ai/ace/pull/22) deliberately implements one native
thread and one turn against the original terminal-session contract.

A conversation needs follow-up turns in the same native thread. The
[official Codex thread/turn lifecycle](https://learn.chatgpt.com/docs/app-server)
provides that distinction. This amendment adds it explicitly rather than changing
the meaning of existing terminal events.

## Contract

Add two event variants:

- `turn.started`: required `nativeTurnId`; optional structured native details.
- `turn.completed`: required `nativeTurnId` and `outcome` (`completed`,
  `interrupted`, or `failed`); optional `result`, structured `error`, native state,
  and native details. A failed turn is distinct from a dead session.

All events retain adapter, local/native session identity, sequence, timestamp,
and correlation metadata. Turn-related events can additionally carry a native
turn ID in their shared envelope. Approval correlation still identifies the
specific request; it is not replaced by a turn ID.

`session.completed`, `session.cancelled`, and `session.error` remain terminal for
the local session. No ready-state update can reopen them. Disposal invalidates the
local identity and closes its observers and owned resources.

`sendInput` requires a ready live session. It reserves the turn before any await
or observer callback; input while starting, running, waiting for approval, or
ending is rejected. This slice does not expose native steering. A native turn
starts once, completes once, clears that turn's approvals, emits its outcome, and
returns the still-connected session to ready. Subsequent explicit input starts a
new turn on the same native thread, without spawning or authenticating again.

Interrupt targets only the active acknowledged native turn. It invalidates local
approval replies immediately, then waits for native confirmation of the turn's
outcome. It does not terminate a healthy thread. Transport/startup/protocol errors
still end the session. A native failed turn retains its error details and allows
another explicit input after completion; a non-retrying error notification does
not by itself fabricate readiness before `turn/completed`.

## Races and approval authority

The active turn owns its pending requests. A completed turn's late items,
notifications, errors, resolutions, and approvals cannot reopen a prompt, alter a
new turn, or make the session appear successful. Native request IDs, local approval
IDs, and turn IDs remain separate; reused native request IDs cannot match a prior
local approval. Unknown native states never become a successful turn.

A terminal turn notification can precede its start or interrupt RPC response.
That matching outcome settles the corresponding command without replaying it;
a late response cannot affect a later turn, and a timeout for a superseded RPC
must not kill a healthy next turn. A turn whose start response is missing and
whose native acceptance is unproven still fails with an unknown outcome.

Before notifying turn-completion observers, invalidate the old turn's approvals.
The session becomes ready only after the completion event is delivered, preventing
reentrant follow-up input from being overwritten by cleanup for the prior turn.
Never reset or retain an old approval while beginning a new turn. Native permission
and authentication ownership, offered decision restrictions, and unsupported
interaction behavior remain as documented in [the Codex adapter](codex-adapter.md).

## Fake and tests

The deterministic fake receives the same turn events and ready/busy rules. It
continues to support direct terminal-session fixtures, and those rejection tests
remain valid. Its synthetic interrupt completes the active turn as interrupted;
a test may still emit `session.cancelled` to simulate actual session termination.

Required regression cases: two successive turns in one native thread; completed,
interrupted, and failed turn followed by new input; terminal session cannot reopen;
one-start/one-completion event per turn; concurrent/reentrant input; pending
approval expiry before completion observers; stale late turn events; reused
request IDs and item IDs in later turns; native completion before start/interrupt
RPC response; no retry or restart on ambiguous transport failure; and disposal
between turns. Tests use synthetic protocol streams only.

The shared UI consumes these events through its existing application and teardown
surface. This amendment does not itself add a second TUI, persistence, arbitrary
attach/import, external-message intake, or cross-provider state transfer.
