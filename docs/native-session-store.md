# Local native session identity store

This is the persistence boundary for [#15](https://github.com/aceteam-ai/ace/issues/15).
The store does not start a native process. The [session manager and verified
Codex resume](native-session-resume.md) connect it to the shared terminal UI.

Store a record only after an Ace-created native session has successfully
started. Records are locally registered provenance, not cryptographic proof.
There is no command to import an arbitrary native session ID. A record contains
only adapter ID, Ace session ID, native session ID, canonical workspace identity,
and creation/update timestamps. Credentials, conversation text, native options,
permission grants, pending approvals, turns, and commands are never serialized.

The default directory is `~/.ace/sessions`; `native-sessions.json` is the state
file. On POSIX systems the directory is private (0700) and state/lock/temporary
files are private (0600). Symlinks and unexpected file types are rejected.
Existing insecure ownership or permissions produce an actionable error instead
of reading potentially exposed state. The state file has a version, bounded
size and record count, and exact validated fields. Unknown versions or malformed
records are never silently treated as an empty store.

Workspace association uses the canonical real path plus filesystem device and
inode when available. A replaced or moved directory is a recoverable mismatch;
start a new session there instead of silently rebinding an old record. On
platforms that do not expose a usable inode, records explicitly use path-only
association. This limitation is visible in the stored workspace identity and
must not be represented as a stronger filesystem identity guarantee.

An exclusive lock serializes read-modify-write operations across processes.
Writers reload state after acquiring the lock, write a private temporary file,
flush it, and atomically rename it into place. Directory flush is best effort
where unsupported. Readers see either the old or new complete document. No
clock-based lock expiry or automatic lock stealing occurs.

A busy lock reports `store_busy`; an owner PID confirmed absent reports
`stale_lock`. The error's `recoveryPath` identifies the lock file. After checking
that no other Ace process is writing the store, remove that specific stale lock
file and retry. Never remove an active lock or one with an unknown owner. This
manual recovery avoids racing another process during lock replacement. PID
reuse can conservatively leave a stale lock classified as busy. Reading the
last committed state remains available while a lock is present.

A `lock_cleanup_failed` error explicitly means the operation already completed
but its lock could not be released. Inspect saved registrations before retrying;
never repeat a native session start or turn because of this persistence error.
If an action itself failed, that primary error is preserved even when cleanup
also fails.

For malformed or unsupported state, an explicit `quarantineCorruptState()` call
moves the original file into a private local backup and initializes an empty
store under the same write lock. It refuses to discard a valid state file.
Backup content is never printed or uploaded. Recovering a stale lock is required
before quarantine if the previous writer crashed while holding it.

On explicit user resume, resolve the selected local record for the requested
adapter and workspace. A matching store record is only a candidate: the native
adapter must still reject unsupported versions, missing history, or unavailable
authentication. Pending approvals and previously submitted commands are never
restored or resent. A store failure must not prevent an otherwise usable local
native session from running; show that restart/resume registration is unavailable.

Tests use synthetic identities and temporary directories, with no credentials,
model calls, native process execution, or personal transcript fixtures.


Managed connections use separate `native-owner-<hash>.json` files with only a
version, PID, and random owner nonce. The filename hashes provider/native identity.
Ownership changes share the state write lock, so competing Ace processes cannot
both acquire a managed native session. Active or unknown owners reject resume;
only explicit resume can recover an owner PID confirmed absent. There is no TTL
or claim of excluding non-Ace native clients. Ownership remains held between turns
and through navigation, until native disposal confirms owned-resource cleanup.
Release is idempotent and never removes another nonce's file. A failed shared-lock
cleanup after successful acquisition returns the committed ownership handle with
a warning, so it is still available for eventual disposal.

`forget(selection, {requireUnowned: true})` checks ownership and removes the
registration under the same write lock. This prevents an acquisition between an
eligibility check and deletion. A creation-time workspace precondition prevents
registration if the selected directory changed while the native session opened.
