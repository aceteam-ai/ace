# Synthetic provider and handoff terminal checks

These selected excerpts come from three real terminal processes using fake
Codex/Claude adapters. No SDK, native model, credentials, or artifact contents
were used. Temporary workspace paths and local connection IDs are normalized.

The driver reviewed a long envelope at 40 columns, rejected early confirmation
and confirmation at 48×12, then changed the source file before confirming twice.
Exactly one new Claude session received exactly the original reviewed text.
The native mode appeared after delayed identity confirmation, no approval was
answered, and an unsupported fixture interrupt caused no adapter call.

```text
AceTeam                           v0.3.0
Native providers manage their own authe…

Review a new-session handoff
Fresh session · one reviewed input
Synthetic reviewed context.
Synthetic reviewed context.
Synthetic reviewed context.
Synthetic reviewed context.
Synthetic reviewed context.
Synthetic reviewed context.
Synthetic reviewed context.
Synthetic reviewed context.
SUMMARY_END

Artifact references
never-read.ts — Reference only
Lines 54–65 of 65
Ace does not read artifact references.

y Confirm once  n Decline  ↑↓ Review
Enter never confirms. Esc Cancel

Ctrl+C Exit workspace
```

After shutdown, browsing saved records caused no native operation. Explicit
resume opened the same synthetic native history through a fresh local connection,
without replaying the handoff input or pending approval.

```text
AceTeam                                                               v0.3.0
  Native providers manage their own authentication and permissions

  Claude Agent · Ready
  Session <synthetic local ID> · /synthetic/workspace
  Claude mode: default | Native rules may act before an Ace approval prompt
  [Conversation]  Activity   Changes   Approvals
  Session resumed. Earlier conversation is not loaded. Send a new message when
   ready.






  Lines 1–2 of 2
  ←→ Panels  Enter Compose  i Interrupt  x Close  Esc Back  ? Keys

  Ctrl+C Exit workspace
```

A third process declined a Codex handoff without starting anything, then explicitly
reviewed and confirmed a new handoff. The native permission context remained
provider-specific.

```text
AceTeam                                                               v0.3.0
  Native providers manage their own authentication and permissions

  Codex · Waiting for approval
  Session <synthetic local ID> · /synthetic/workspace
  Approval: on-request | Reviewer: user | Sandbox: workspace-write
  [Conversation]  Activity   Changes   Approvals
  1 native approval(s) pending · open Approvals to review
  user
  Handoff summary
  Codex SUMMARY_END

  Artifact references
  never-read.ts — Reference only

  assistant
  Lines 1–8 of 10
  ←→ Panels  Enter Compose  i Interrupt  x Close  Esc Back  ? Keys

  Ctrl+C Exit workspace
```

All three processes exited with code 0 without forced termination and restored
terminal flags. This proves the shared UI and local lifecycle through synthetic
adapters; it does not claim live Claude inference or external-message delivery.
