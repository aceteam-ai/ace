# Review a local handoff into a new native session

In **Native coding session**, press `h` to load a local JSON handoff file. Close
any existing native session first. Ace reads the envelope, checks its target
workspace, and shows the complete input and target before opening a session.
Page through the full review, then press `y` to confirm or `n`/Esc to decline.
Enter never confirms. Small terminals pause confirmation until the review fits.

```json
{
  "version": 1,
  "summary": "Continue reviewing the parser. The next step is to check malformed inputs.",
  "artifacts": [
    { "path": "src/parser.ts", "label": "Parser implementation" }
  ],
  "target": {
    "adapterId": "claude",
    "workspace": "/absolute/path/to/project"
  }
}
```

`adapterId` selects `codex` or `claude`. The workspace must exist and use an absolute
local path; its resolved path appears in the review. Artifact paths are relative
to that workspace and cannot contain traversal, absolute paths, or URLs. Ace does
not read, fetch, upload, or execute the referenced artifacts during handoff.

The envelope allows only these fields. It cannot carry native session IDs,
transcripts, commands, authentication, permission grants, or pending approvals.
The maximum file size is 64 KiB; the summary allows 16 KiB of UTF-8 text, with at
most 32 references, 1024-byte paths, and 256-byte labels. Ace requires a regular
UTF-8 JSON file and rejects terminal controls and hidden formatting characters.
Line endings become newlines and tabs become four spaces once, before review.
The resulting immutable text is both displayed and submitted without truncation.
Changing the file afterward does not change an already loaded review.

Confirmation starts a fresh managed native session and sends exactly one ordinary
user input. It does not resume a session or send into an existing conversation.
Provider authentication, permission checks, and model access remain native. The
workspace is checked again before opening and before input. A changed workspace,
failed startup, or cancellation before input prevents submission. During opening,
Esc stops that handoff and awaits owned cleanup; input already delivered to the
provider cannot be retracted. Duplicate confirmation keys
share one operation, and uncertain delivery is not retried automatically.

Handoff uses user-authored summary text. Ace does not automatically summarize or
extract a transcript, and does not claim to detect every secret someone might
write in that summary. No handoff input is saved in Ace's session registry. A
handoff is a new conversation with reviewed context, not native session portability.

## Offline terminal fixture

`tests/ui/fixtures/native-handoff-entry.tsx` takes absolute paths for an isolated
workspace, registration directory, and synthetic trace file. It uses injected fake
Codex and Claude providers with distinct permissions, local/native turn IDs, and
capabilities. Claude confirms its ID on the first input. Fake native history is
seeded independently of Ace records before product calls are traced, allowing
restart checks to distinguish explicit resume from replay. The fixture never
loads the SDK, executes a displayed tool, reads authentication, or calls a model.
Use synthetic text only: its private trace intentionally records test inputs.
