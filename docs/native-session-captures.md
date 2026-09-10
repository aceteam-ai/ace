# Synthetic native terminal captures

These screens were captured from a real PTY and terminal emulator using
`tests/ui/fixtures/native-ui-entry.tsx`. Every message, command, worker, path,
permission, and approval is a synthetic fixture value. No Codex process, model
call, authentication, or displayed command was executed. Trailing terminal padding
is removed below; the screen content is otherwise preserved.

The check verified that Enter without a selected decision leaves the approval
pending, 48×12 resize disables hidden actions, an explicit decision completes the
turn, a second turn can be interrupted, and closing/exiting restores terminal flags,
cursor, and alternate screen with exit code zero and no forced termination.

See [usage and verification](native-sessions.md) for controls and limitations.

## Conversation, 80×24

```text
  AceTeam                                                               v0.3.0
  Codex manages its own sign-in and permissions

  Codex · Waiting for approval
  Session 28a7edbe-4e53-47cb-8b4d-87121ecf3391 · /synthetic/workspace
  Approval: on-request | Reviewer: user | Sandbox: workspace-write
  [Conversation]  Activity   Changes   Approvals
  1 native approval(s) pending · open Approvals to review
  user
  Check synthetic fixture? q

  assistant
  Reviewing the synthetic example. Turn 1.
  Evidence line 1: local fixture output.
  Evidence line 2: local fixture output.
  Evidence line 3: local fixture output.
  Lines 1–8 of 24
  ←→ Panels  Enter Compose  i Interrupt  x Close  Esc Back  ? Keys

  Ctrl+C Exit workspace
```

## Observed activity, 80×24

```text
  AceTeam                                                               v0.3.0
  Codex manages its own sign-in and permissions

  Codex · Waiting for approval
  Session 28a7edbe-4e53-47cb-8b4d-87121ecf3391 · /synthetic/workspace
  Approval: on-request | Reviewer: user | Sandbox: workspace-write
   Conversation  [Activity]  Changes   Approvals
  1 native approval(s) pending · open Approvals to review

  Workers observed by Codex
  Synthetic observed helper: running
  {
    "origin": "native observation fixture"
  }

  Native tool activity
  Lines 9–16 of 22
  ←→ Panels  Enter Compose  i Interrupt  x Close  Esc Back  ? Keys

  Ctrl+C Exit workspace
```

## Native patch, 80×24

```text
  AceTeam                                                               v0.3.0
  Codex manages its own sign-in and permissions

  Codex · Waiting for approval
  Session 28a7edbe-4e53-47cb-8b4d-87121ecf3391 · /synthetic/workspace
  Approval: on-request | Reviewer: user | Sandbox: workspace-write
   Conversation   Activity  [Changes]  Approvals
  1 native approval(s) pending · open Approvals to review
  Native-reported changes
  modified example.ts
  --- a/example.ts
  +++ b/example.ts
  @@ -1 +1 @@
  -const answer = 1;
  +const answer = 2;

  Lines 1–8 of 8
  ←→ Panels  Enter Compose  i Interrupt  x Close  Esc Back  ? Keys

  Ctrl+C Exit workspace
```

## Explicit approval, 80×24

```text
  AceTeam                                                               v0.3.0
  Codex manages its own sign-in and permissions

  Codex · Waiting for approval
  Session 28a7edbe-4e53-47cb-8b4d-87121ecf3391 · /synthetic/workspace
  Approval: on-request | Reviewer: user | Sandbox: workspace-write
   Conversation   Activity   Changes  [Approvals]
  1 native approval(s) pending · open Approvals to review
    "command": "pnpm test --offline",
    "cwd": "/synthetic/workspace",
    "nativeAction": "{\n  \"input\": \"pnpm test --offline\",\n  \"cwd\":
  Lines 4–6 of 12
  Request 1/1 · waiting
    accept
    decline
    cancel
  Choose with ↑/↓, then Enter confirms that decision.
  ←→ Panels  Enter Compose  i Interrupt  x Close  Esc Back  ? Keys

  Ctrl+C Exit workspace
```

## Small terminal, 48×12

```text
  AceTeam                               v0.3.0
  Codex manages its own sign-in and permissio…

  Codex · Waiting for approval
  Resize to at least 40 columns × 24 rows.
  1 approvals pending; actions paused.
  Esc Back  Ctrl+C Exit workspace

  Ctrl+C Exit workspace
```

## Turn completed on the same session, 80×24

```text
  AceTeam                                                               v0.3.0
  Codex manages its own sign-in and permissions

  Codex · Ready
  Session 28a7edbe-4e53-47cb-8b4d-87121ecf3391 · /synthetic/workspace
  Approval: on-request | Reviewer: user | Sandbox: workspace-write
   Conversation   Activity   Changes  [Approvals]
  No pending approvals.







  Lines 1–1 of 1
  Turn completed.
  ←→ Panels  Enter Compose  i Interrupt  x Close  Esc Back  ? Keys

  Ctrl+C Exit workspace
```
