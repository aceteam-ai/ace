# Native coding sessions in the terminal workspace

Run `ace`, press Esc to open the home menu, and choose **Native coding session**.
Select Codex, check or edit the workspace directory, then press Enter. Choose **Start new session** or **Resume saved session**.
The panel uses your installed Codex CLI and its own sign-in, model, configuration,
and permissions. Browsing and native sessions require neither Python setup nor
an AceTeam account. This integration currently validates exactly Codex CLI
`0.153.4`; missing installation, unsupported versions, and missing native sign-in
produce an actionable error. Sign in separately using `codex login` if needed.

A ready session accepts text with Enter or Tab. Enter sends it as a new turn on
the same native thread. While typing, `?` and `q` are ordinary text; Tab or Esc
returns focus to the panels. Input is unavailable while a turn is running or
waiting for approval. Native turn completion, failure, and interruption return a
healthy session to ready for explicit follow-up. Transport failure ends the local
session. Nothing is retried automatically.

## Panels and controls

| Panel | What it shows |
| --- | --- |
| Conversation | Native user and assistant messages. A completed message replaces its accumulated deltas. |
| Activity | Effective native permission context, observed workers, and tool arguments/status/results. Workers are observations; this panel does not schedule them. |
| Changes | Native-reported file changes and actual patches. When only paths are reported, it explicitly says the patch is unavailable. |
| Approvals | The pending native action and workspace/scope, available decisions, and request details. |

Left/right switches panels. Up/down scrolls ordinary panels; Page Up/Page Down
scrolls every panel, including long approval details. Lines wrap to the terminal
width before pagination. Native text is sanitized before display; terminal escape
sequences and direction controls cannot alter the screen. Display histories keep
the latest 200 messages, tool entries, worker entries, and change entries, with
40,000 characters per displayed value. This is an in-memory view, not a transcript
archive.

In Approvals, use up/down to **select a decision**, then Enter to submit it.
There is no default selection. Focusing a request, opening help, or pressing
Enter without selecting a decision cannot approve it. `[` and `]` switch between
pending requests. Selection belongs to one request; it does not carry into a
replacement request. A submitted reply is disabled while awaiting native
resolution. Expired or resolved requests cannot be replayed. These controls send
only the decisions offered by the native adapter and do not widen native
permissions.

`i` interrupts the current turn; `x` closes the session. Esc or `q` returns to the
workspace and keeps the session running, including pending approvals. Reopening
the panel restores the current session view. `n` starts a new session after the
previous one closes or fails. Ctrl+C exits the workspace and awaits owned native
resource cleanup. The terminal restores its raw mode, cursor, and alternate screen
on normal exit, interruption, and render errors.

## Saved sessions and recovery

A successfully opened native session is registered locally for later explicit
resume. Open the workspace's saved-session list, select a registration, and press
Enter. The list shows availability and reasons for unavailable records without
starting Codex or inspecting native history. Native history, current sign-in,
workspace identity, and the tested CLI version are checked on that explicit action.

Resume uses a fresh local connection for the same recorded native thread. Earlier
conversation is not loaded into the panel. Pending approvals and old commands are
never restored or resent. An unavailable native session produces an error; it does
not fall back to creating a new session. A stale owner left by an exited Ace process
can be recovered only by this explicit resume action; active or unknown owners block it.

In the saved list, `d` opens full details for the selected record, error, or recovery
notice. Up/down and Page Up/Page Down scroll long paths and messages. `r` refreshes
the list. `f` opens a separate confirmation to forget a local registration; press
`y` to confirm or `n` to cancel. Forgetting a registration does not delete native
history, and an active or unknown owner cannot be forgotten.

Malformed or unsupported local state offers `c` for recovery. A separate `y`
confirmation moves the original state into a private backup and starts an empty
registration list. The full backup path is available in Details. Unsafe storage
and stale shared locks require the specific manual recovery described in the
error; they are not reset automatically. Native sessions that open successfully
but cannot be registered stay usable with a visible registration notice and full
details in Activity. Registration failure never repeats native work.

The default registration directory is `~/.ace/sessions`. It contains bounded
provider/local/native identity records, canonical workspace identity, timestamps,
and local ownership files. Conversation, prompts, credentials, permission grants,
and pending approvals are not stored. See [registration and recovery](native-session-store.md)
and [native resume verification](native-session-resume.md) for exact boundaries.

The session panel needs at least **40 columns × 24 rows**. Smaller terminals show
a compact resize notice with pending-approval count; session actions are disabled
until the panel is visible again. Esc and Ctrl+C remain available.

Arbitrary attach/import, external-message intake, and cross-provider state transfer
are not exposed here. Only locally registered Ace-created sessions can be selected.
See the [adapter](codex-adapter.md) and [reviewed turn lifecycle amendment](native-turn-lifecycle.md)
for native protocol and authority boundaries.

## Verification and offline fixture

UI checks use React `18.3.1`, Ink `5.2.1`, ink-testing-library `4.0.0`, and
wrap-ansi `9.0.2`, with Node `22.21.1` and pnpm `10.33.2`. Regression tests cover
stream/final deduplication, exact request selection, pending submission, stale
replies, command failures, startup/close races, reentrant listeners, repeated
turns, shared input focus, navigation without disposal, awaited teardown, and
narrow-terminal resize.

```sh
pnpm exec vitest run tests/harness tests/ui
pnpm test
pnpm lint
pnpm build
```

`tests/ui/fixtures/native-ui-entry.tsx` is an offline terminal fixture with an
injected fake adapter. It never launches Codex, executes its displayed command,
reads native authentication, or calls a model. Bundle this test entry with the
repository's build tooling to inspect the synthetic conversation, observed
worker/tool, patch, approval, follow-up turn, interruption, and cleanup. The
fixture is not a production command or runtime test mode.

[Terminal captures](native-session-captures.md) show the fixture in a real PTY at
80×24 and 48×12. The PTY check also verified an ordinary zero exit without forced
termination, restored terminal flags/cursor/alternate screen, and no Python/runtime
state creation. These checks do not establish live account or model access.


The additional `tests/ui/fixtures/native-resume-entry.tsx` accepts three absolute
paths inside an isolated test directory: workspace, registration directory, and
trace file. It seeds synthetic native history independently of the registration
store and can be launched twice against the same registration directory. Its
trace records product start/resume/input/approval/dispose calls after fixture
setup, so the restart check can verify no implicit native open or replay. All
trace input must be synthetic; this fixture is not a production entry point.

[Restart captures](native-resume-captures.md) show clean resume and explicit
recovery after an intentionally killed process, with no command or approval replay.
