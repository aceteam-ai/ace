# Local turn IDs and delayed native identity

This additive #16 foundation supports native providers that do not mint turn IDs
or confirm a new session ID before the first input. See the reviewed
[Claude adapter and handoff design](claude-agent-design.md).

`NativeHarnessTurnIdentity` requires a native `nativeTurnId`, a local `turnId`, or
both. `turn.started` and `turn.completed` include this identity, and other events
can carry either ID in their common envelope. Existing Codex events keep their
native ID. A client-stamped input UUID stays a local `turnId` even if the native
provider echoes it. Approval request correlation remains separate. The fake can
use `turnIdentity: "local"`; shared synthetic provider fixtures preserve both
providers' distinct identity and permission shapes.

Manager adapter factories receive `(store, hooks)`, with existing one-argument
factories still valid. `NativeSessionFactoryHooks.onNativeSessionConfirmed(identity)`
returns a promise. A deferred adapter calls it after checking native evidence and
before binding/publishing the confirmed native identity. It must await the hook and
publish no confirmed event when the hook rejects. Factory construction and listing
registrations do not authorize process startup or identity confirmation.

A successful new session may initially return only adapter/local IDs. The manager
keeps it usable and reports `native_identity_pending`; it does not guess a native
ID or save a registration. The first matching hook checks the captured workspace,
acquires local ownership, and registers the confirmed identity. Duplicate matching
hooks share one operation; different provider/local identities and rebinding are
rejected. Failed optional registration reports a notice without replaying input.
Successful persistence reports `native_registration_ready`, replacing the pending
registration status. The UI treats a pending identity as normal startup state and
clears its pending notice on this success code; a persistence failure retains its
actionable notice. Confirmation after cancellation, terminal events, or disposal
is rejected, including terminal events received while registration is in flight.

After the hook resolves, the manager accepts commands using the confirmed identity.
The shared service must adopt the absent-to-confirmed native ID from the following
matching event. An event cannot change identity without the hook; the manager
reports an error and stops the owned connection. Confirmation failure and identity
violations fan out one manager-generated terminal error to every existing observer;
native events and their provider-specific content otherwise remain unchanged. This foundation does not itself
change the UI reducer or add the Claude runtime dependency.

Cancellation waits for pending confirmation and native disposal before releasing
ownership. A registration that commits during cancelled confirmation is removed
when storage permits. Hook failure rejects promptly and schedules cleanup: it
must not await native disposal from inside a reader that is itself awaiting the
hook. Explicit manager disposal still awaits cleanup. A failed cleanup retains
ownership and remains available to a later explicit close. Adapters should accept
the reserved local identity for disposal during the brief confirmation boundary.

Tests cover both turn identity variants, approval expiry, duplicate/stale hooks,
workspace replacement, delayed registration, unconfirmed identity events, terminal
sessions, cancellation after durable registration, and both orderings of a native
reader awaiting the hook while disposal awaits the reader. No model, credential,
or native process is needed for these fixtures.
