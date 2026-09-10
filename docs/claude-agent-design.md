# Claude Agent SDK adapter and reviewed local handoff

Design for [#16](https://github.com/aceteam-ai/ace/issues/16), after the native
panels in #14 and managed registration/resume in #15. The adapter preserves
Claude's native execution, history, and permission semantics. It does not require
optional AceTeam collaboration.

## Tested boundary and public sources

Pin `@anthropic-ai/claude-agent-sdk` to **0.3.267**, with its bundled native
runtime **2.1.267** and the resolved npm lockfile. Use its supported `query`
streaming-input API, not the browser/bridge APIs, undocumented control writes,
a parsed interactive terminal, or the removed TypeScript V2 session interface.
The package supports Node >=18; include the platform optional runtime dependencies.
Load the SDK through an injected async factory only on explicit native start/resume;
the initial Ace menu must not import the runtime or read native auth/settings.
Do not silently switch to an arbitrary global runtime when the pinned bundle is
missing. Its installation error should identify the required package/runtime.

Public documentation checked for this design:

- [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview): third-party
  products must use supported API-key authentication unless separately approved
  for subscription authentication. Use the UI label `Claude Agent`.
- [Quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart): the SDK reads
  `ANTHROPIC_API_KEY` from the environment and bundles the runtime through optional
  platform dependencies.
- [Permissions](https://code.claude.com/docs/en/agent-sdk/permissions): native
  hooks, rules, and modes may approve or deny before `canUseTool`; the callback
  does not represent every tool action.
- [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions): native resume
  uses the provider's own session history. This is separate from cross-provider
  handoff.

Version-specific API details below come from the exact package's exported
`sdk.d.ts`, `sdk-tools.d.ts`, and package metadata. Two credential-free isolated
startup smokes used an async input stream that never yielded, empty test settings,
and disabled network routes. Both initialized and closed with no stream events.
With a clearly synthetic invalid API key, initialization reported
`account.apiKeySource === "ANTHROPIC_API_KEY"` and
`account.apiProvider === "firstParty"`. It did not report a session ID. This
proves pre-input route classification and local startup/cleanup, not key validity,
authenticated inference, or successful native history materialization.

## Explicit authentication and native permissions

For this bounded adapter, require a nonempty user-configured
`ANTHROPIC_API_KEY`. Do not read a key from Ace config, accept a key through generic
native options, copy credentials to local session records, or provide subscription
login/rate-limit UI. Reject conflicting OAuth/bearer environment routes or enabled
cloud-provider route switches with an actionable configuration error. Additional
supported vendor API providers can be a later explicit capability.

Create the query with an empty, controlled async input queue. Before permitting
that queue to yield any user message, await `initializationResult()` and require
its account metadata to confirm the environment API-key source and first-party
provider. An absent/unknown route blocks input and disposes the owned query. Mere
presence of `tokenSource` is not a rejection: the synthetic API-key smoke also
reported that field. Do not retain or emit the account object, email, organization,
subscription fields, or source values beyond the checked nonsecret classification.
An actual invalid/expired key remains a native authentication error on inference.

Explicitly set `settingSources: ["user", "project", "local"]` in production to
load the intended native permission/instruction settings. The smoke's empty
settings list is test isolation only. Do not depend on changing SDK defaults.
Leave native permission mode/rules, tools, MCP servers, hooks, instructions, and
sandbox configuration under the native settings cascade. Do not inject
`allowedTools`, `bypassPermissions`, `allowDangerouslySkipPermissions`, additional
directories, custom hooks, or persistent permission updates. Initial bounded
`nativeOptions` permits only a model on a new session; resume accepts no overrides.
Set `agentProgressSummaries: false` and `promptSuggestions: false`; neither auxiliary
model feature is needed for the native event UI.

The exported initialization response has no permission-mode field. Show permission
context as awaiting native confirmation until the first `system/init`; do not
invent a default. That event confirms actual mode, cwd, runtime version, and
API-key source. Native `status.permissionMode` updates can refresh the displayed
mode. The UI explicitly explains that native rules can act before an Ace callback.

## Input readiness and confirmed native identity

`SDKSystemMessage` (`system/init`) is emitted at the beginning of each turn, not
as a guaranteed idle startup event. Waiting for it in `start()` would deadlock a
new conversation. Do not send an empty prompt to manufacture initialization.

For a new session, allocate a UUID and pass it as supported `options.sessionId`.
It is a proposed native ID until native confirmation. `start()` completes after
pre-input initialization/auth-route checks with a ready input surface and a local
identity whose `nativeSessionId` is absent. Use a clear native state such as
`initialized_awaiting_native_identity`. Native session history is not yet claimed
or registered. Keep one SDK query and one input queue for successive explicit
turns; reject input while a turn is queued/running/awaiting approval/ending.

On the first `system/init`, require its session ID to match the allocated UUID,
cwd to match the captured workspace identity, `claude_code_version` to equal
2.1.267, and API-key source to match the approved route. Later init events must
retain the same identity and workspace. They update native permission context,
not create a new session or reopen a terminal one.

Add a narrow asynchronous `onNativeSessionConfirmed(identity)` adapter hook for
this delayed boundary. The manager's factory receives an optional second argument
with this hook, while existing `(store) => adapter` factories remain valid. The
managed wrapper verifies its live local ID/generation and original workspace,
acquires ownership, registers the first confirmed identity once, and updates its
live identity. Registration errors become notices without repeating the already
submitted turn; ownership collisions close the connection. Resumes already hold
ownership and retain their existing registration.

Invoke the hook only after native identity checks and before publishing that
identity. If a permission callback races identity confirmation, it waits for the
same bounded confirmation barrier or denies on failure/cancellation; it never
receives an automatic allow. Native rules may already resolve tools independently,
which is why this bookkeeping must not be represented as native permission gating.

The shared service adopts an absent-to-confirmed native ID only from a matching
adapter/local session event. A conflicting rebinding terminates the session; an
old local incarnation cannot upgrade or replace the current one. The manager
keeps delayed registration/ownership cleanup attached to the same cancellation
generation, so closing during confirmation cannot leak a lease or register a
closed connection. A session closed before its first native confirmation has no
saved registration.

## Honest turn identities and outcomes

Claude does not expose a Codex-style native-minted thread turn ID. Amend the
common contract additively: `turn.started` and `turn.completed` require at least
one of `nativeTurnId` or local `turnId`. Existing Codex events stay valid. Claude
uses a local turn ID equal to its stamped input UUID and leaves `nativeTurnId`
absent. Preserve native-echoed `user_message_uuid`/`user_message_uuids` and result
UUID in native details without relabeling them. Shared state/fake fixtures use
`nativeTurnId ?? turnId` for turn association.

Each explicit input yields exactly one `SDKUserMessage` with `uuid`, expected
session ID, `parent_tool_use_id: null`, and ordinary user text. No synthetic/meta
flag, system origin, hidden replay, or `shouldQuery:false` intake is used. Reserve
its turn synchronously. A matching native echo acknowledges the send; emit one
`turn.started`. Results/frames for completed or unrelated local sends cannot alter
a later turn. Missing correlation on a failure with unknown acceptance produces
an honest session/unknown-outcome error, without resubmission.

The SDK documents exactly one `result` as the turn-complete signal. A success
subtype with `is_error:true` is still an error. Derive outcomes from native result
subtype, `is_error`, and `terminal_reason`: native abort reasons are interrupted,
ordinary successful completion is completed, and error/unknown terminals never
become success. Expire that turn's approvals before publishing its outcome.

`session_state_changed: idle` is authoritative overall idleness after held-back
results/background work. Require both the matching result and an ensuing valid
idle state before accepting another turn. Handle either arrival order without
emitting completion twice. Keep the session busy if no authoritative idle follows;
a bounded reconciliation failure reports the uncertainty instead of inventing
readiness. Session EOF, transport failure, and disposal stay terminal.

## Conversation, tools, changes, and workers

- Stream text only from text deltas in `stream_event`; use complete assistant
  message IDs to settle displayed text without duplicating it. Preserve native
  message IDs. Do not render hidden thinking blocks as conversation text.
- Track native assistant `tool_use` IDs/names, `tool_progress`, and matching user
  `tool_result` blocks. `is_error` and native denial evidence determine failed
  activity. An absent Ace approval callback is not evidence of approval.
- The matching `SDKUserMessage.tool_use_result` holds native structured output.
  For Edit/Write, use `FileEditOutput`/`FileWriteOutput.filePath` and
  `structuredPatch`/native `gitDiff`; do not reconstruct a filesystem diff or
  claim a denied/proposed edit happened. Do not persist `originalFile` or content.
- Worker state comes from verified local-agent task kinds/subagent metadata in
  `task_started`, `task_progress`, `task_updated`, and `task_notification`, keyed
  by native task IDs. Other tasks remain tool/background activity; an MCP task or
  shell task is not automatically a worker. Preserve unknown native states as
  unknown details rather than mapping them to completed. Artifact/output file
  references remain references, with no implicit read or upload.
- Native `permission_denied` is advisory; `result.permission_denials` is the
  authoritative native denial record. Display denials even when no callback ran.

## Approval callback and interruption

Handle `canUseTool` only when invoked. Bind each pending reply to the live local
session, local turn, `requestId`, and `toolUseID`; a random local approval ID prevents
reuse. Show native title/description/reason and the requested input. Offer only
allow once and deny, plus cancellation if explicitly supported by the adapter.
Allow returns `{behavior:"allow", updatedInput: originalInput, toolUseID}`;
deny returns `{behavior:"deny", message, toolUseID}`. Never return permission
suggestions as `updatedPermissions`. Do not return null, which means an out-of-band
response and would otherwise park the native request indefinitely.

Correlated duplicate callbacks share their pending result; resolved/stale callbacks
cannot recreate approvals. Validate every decision against the original choices.
Abort signals, interrupt, terminal outcomes, and disposal invalidate callbacks
before notifying UI observers. Resolve denial/cancellation to unblock the SDK and
never claim that the underlying tool executed merely because the callback returned.
Unsupported structured questions/elicitation are explicitly denied or reported as
unsupported, not fabricated from a generic approval button.

`Query.interrupt()` is a supported control API with an optional native receipt.
Use it once for an active turn, invalidate pending approvals, and await the native
result instead of treating receipt as completion. The receipt's `still_queued`
list can contain user messages that would still run. Ace queues at most its one
active explicit input. If its own input survives interruption and there is no
supported public cancellation method for it, close the owned query and end the
local session rather than silently letting a queued turn run. Ignore unrelated
native queue IDs as grants; do not invent private cancel-control calls. Cover
result-before-interrupt-response and first-input prewait races in fixtures.

Disposal aborts owned callbacks/input, closes the queue, calls supported
`Query.close()`, and awaits `Query.return()`/reader completion with a bounded
cleanup deadline. A close call alone does not prove process exit. Unconfirmed
cleanup retains manager ownership and a recoverable cleanup error. Do not signal
unrelated Claude processes or restart the SDK on ambiguous failures.

## Eligible same-harness resume

The manager resolves the original local Claude registration and holds its local
ownership lease. The adapter independently checks the same registered ID and
workspace, the pinned SDK/runtime package, and API-key route. Use supported
`getSessionInfo(nativeId, {dir: canonicalWorkspace})`; require exact ID and a
matching available cwd. Ignore `summary`, `firstPrompt`, and other transcript-like
metadata rather than retaining or displaying it. Missing metadata/history is
recoverable. Never search all projects, parse native history files, or use
`getSessionMessages`/import APIs.

Open a fresh SDK query with `options.resume` set to exactly the registered ID,
without `sessionId`, `continue`, `forkSession`, truncation, config, or model
overrides. Keep the input iterator empty during initialization/auth checks. The
native metadata and accepted resume configuration establish the resumed input
surface; the first explicit turn's init must confirm the same native ID/cwd/runtime
before displaying confirmed native context. Describe that pending confirmation
honestly. Resume never submits a prior prompt, invokes a pending approval, or
hydrates a portable transcript. It returns a fresh local incarnation.

## Explicit local handoff

Use a small local JSON envelope and a shared UI review screen, not automatic
summarization, transcript scraping, or external intake. Exact version-1 fields:
`summary`, `artifacts` (relative workspace paths plus optional labels), and
`target` (`adapterId`, `workspace`), alongside `version`. Reject all unknown fields,
including native session IDs, transcripts, commands, authentication, permissions,
and grants. Bound the file to 64 KiB, summary to 16 KiB, artifact count to 32, and
individual paths/labels; require a regular readable file. Artifact references are
not read, fetched, executed, or uploaded by the handoff importer.

The shared panel opens the file, validates the target/workspace, and displays the
full summary and artifact references with the selected target before confirmation.
Reject terminal control sequences and ambiguous hidden direction controls in the
envelope; normalize allowed line endings once before building the immutable review
snapshot. The exact reviewed text is the text submitted. Paginate the full summary
and artifact references; never silently truncate them before acceptance.
The user may decline or go back without creating a session. Confirmation uses an
immutable reviewed snapshot and starts a NEW managed target session with a fresh
local ID, then submits exactly one ordinary text input containing the reviewed
summary/references. It never calls resume and never sends into an existing live
session. If the single-session UI already owns a connection, the user must close
it first. Repeated confirm keys share one acceptance operation. Unknown submission
outcomes are not retried; restart does not auto-replay the envelope.

The envelope is deliberately user-authored review content. The importer excludes
ambient credentials and native hidden state by construction; it does not claim
that arbitrary user-written prose can be automatically proved secret-free. The
screen calls this a new-session handoff, never native session portability.

## Build ownership and verification

Sol can build the adapter independently after this design is reviewed:

- New `src/harness/claude.ts`, a small injectable SDK boundary/async input queue,
  `tests/harness/claude.test.ts`, synthetic SDK fixtures, and `docs/claude-adapter.md`.
- Exact dependency/lockfile pin and exported adapter; keep loading lazy so ordinary
  local workflows and Codex do not start or import native Claude execution.
- Options include injected SDK/query/metadata seams and
  `onNativeSessionConfirmed`; no UI-owned state or copied credentials.

Astra/root integration owns the common turn-ID amendment, manager confirmation
hook, shared reducer identity upgrade, provider selector, and handoff envelope/
review UI/tests. Coordinate these files with the agent finishing #15's chooser;
no parallel edits to its service/panel until the clean checkpoint.

Required fixtures: empty-input startup, absent/conflicting auth, source confirmation
before any prompt yield, actual permission mode, first-turn native identity,
changed cwd/version/ID, delayed registration cancellation, two explicit turns,
result+idle ordering, native error success-subtype, stale/deduped callbacks,
preapproved/denied native tools without callbacks, workers distinct from other
tasks, native edit patches, interrupt receipt survivors/races, abrupt EOF, bounded
cleanup, missing/wrong native resume history, new local incarnation, and no replay.
Shared UI fixtures must run both providers' distinct turn IDs/permissions and show
unsupported operations. Handoff fixtures prove review-before-start, new-session
only, no resume, exact once input, decline/cancel, rejected hidden fields, no
artifact I/O, and no retry on uncertain acceptance.

Run focused adapter/manager/shared-state/handoff tests, full tests, lint, build,
and synthetic PTY startup/close/approval/resume/handoff checks. Credential-free SDK
startup smoke is useful runtime evidence; no live model call or real credential
is required to make this implementation reviewable.
