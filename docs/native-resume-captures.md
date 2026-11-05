# Synthetic native resume captures

These 80×24 screens come from `tests/ui/fixtures/native-resume-entry.tsx`
in isolated PTYs. The fixture seeds synthetic native history independently of
the registration store. No Codex process, model, authentication, or displayed
command is used. Temporary fixture path prefixes are replaced by `/synthetic`;
a session/path row truncated by Ink is normalized to a synthetic connection label.
Trailing terminal padding is removed. All identities and content are synthetic.

The check launched four processes: create and close, explicit clean resume,
an intentionally killed process with a pending turn, and explicit resume after
that crash. Listing never opened a native connection. Both resumes used a fresh
local connection ID, the original registration, and the same synthetic native
thread. No input or approval was replayed, and one registration remained.

Normal exits restored terminal flags, cursor, and alternate screen with exit
code zero. The intentional SIGKILL is untrappable and did not restore its terminal;
the subsequent recovery process exited normally and restored its own terminal.

See [saved-session controls and recovery](native-sessions.md).

## Choose new or saved session

```text
  AceTeam                                                               v0.3.0
  Codex manages its own sign-in and permissions

  Open a native session
  Workspace: /synthetic/workspace
  ❯ Start new session
    Resume saved session
  ↑↓ Choose  Enter Open  Esc Back

  Ctrl+C Exit workspace
```

## Saved local registration after restart

```text
  AceTeam                                                               v0.3.0
  Codex manages its own sign-in and permissions

  Saved native sessions
  Workspace: /synthetic/workspace
  Local registrations only. Enter explicitly resumes.
  ❯ codex · synthetic-native-thread · Available
  Saved: 2026-09-10T06:31:21.525Z · 1/1
  /synthetic/workspace
  Native history, sign-in, and version are checked on resume.
  ↑↓ Select  Enter Resume  d Details  r Refresh  f Forget  Esc Back

  Ctrl+C Exit workspace
```

## Explicit resume with an empty local view

```text
  AceTeam                                                               v0.3.0
  Codex manages its own sign-in and permissions

  Codex · Ready
  Session [synthetic local connection] · /synthetic/workspace
  Approval: on-request | Reviewer: user | Sandbox: workspace-write
  [Conversation]  Activity   Changes   Approvals
  Session resumed. Earlier conversation is not loaded. Send a new message when
   ready.






  Lines 1–2 of 2
  ←→ Panels  Enter Compose  i Interrupt  x Close  Esc Back  ? Keys

  Ctrl+C Exit workspace
```

## Exited-owner registration before explicit recovery

```text
  AceTeam                                                               v0.3.0
  Codex manages its own sign-in and permissions

  Saved native sessions
  Workspace: /synthetic/workspace
  Local registrations only. Enter explicitly resumes.
  ❯ codex · synthetic-native-thread · Available
  Saved: 2026-09-10T06:31:21.525Z · 1/1
  /synthetic/workspace
  Explicit resume will recover the previous exited owner's registration.
  ↑↓ Select  Enter Resume  d Details  r Refresh  f Forget  Esc Back

  Ctrl+C Exit workspace
```
