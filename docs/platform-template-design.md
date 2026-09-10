# Platform template client design

This slice implements the authenticated catalog and execution paths described in
[issue #5](https://github.com/aceteam-ai/ace/issues/5), for templates whose graph
is readable with the caller's current platform credentials. Interface behavior
has been checked against authorized source; no live authenticated platform run
or deployed catalog contents are assumed.

## Interface contract

- `GET /api/workflow-templates?category=general` returns
  `{templates:[{workflow_id,title,description,template_category,version_number}]}`.
  The category filter is optional. Description/category may be null. The list
  contains metadata, not graphs, and requires authentication.
- Select a listed UUID and positive integer version N. Read
  `GET /api/workflow-engine/{uuid}?version=N`. Require a nonnull `version`,
  matching `workflow.id`, `version.workflow_id`, and `version.version_number`,
  and a usable `version.graph`. Keep `version.id` for run-result correlation.
  A missing version can be represented by HTTP 200 with `version:null`.
- A template being listed does not guarantee graph access. An inaccessible or
  missing graph blocks local and remote execution. Never clone, switch
  organizations, or fall through to execution to work around a failed read.
- After successful graph authorization and input validation, remote execution is
  `POST /api/workflow-engine/run/{uuid}/{N}` with the input object itself as JSON.
  Pin the selected version record; the unversioned route can resolve a newer version.
  A version record can be updated without changing its number or ID. The current
  run interface has no graph-hash or conditional-write precondition, so this pins
  record identity, not the exact graph bytes previously displayed. Local runs use
  their fetched graph snapshot; remote runs use the platform's stored content at
  execution time. A second read cannot eliminate that server-side race.
  Do not wrap the input as `{input:...}` or submit a graph in its place.
- A normal result may be JSON or `text/event-stream`. Final JSON fields are
  `runId`, `output`, `error`, `workflowVersionId`, and `lowCredits`. Correlate
  the returned version ID with the authorized graph version. An empty error
  container is normal; inspect nonempty entries in `workflow_errors` and
  `node_errors` to distinguish failed execution from success.
- SSE uses JSON data with a `type` discriminator. `start` may provide a `jobId`;
  progress events are optional. `complete` carries the final result fields.
  `error` or `cancelled` can be followed by `complete`: terminal failure or
  cancellation is sticky and cannot become success. Retain available run/job IDs
  separately, without assuming they are interchangeable.
- A credit refusal is HTTP 402. Authentication/authorization/rate-limit failures
  remain 401/403/429. Show useful bounded status information; do not invent
  required scope names, change grants, or select another organization.

## Authentication and transport

Use an explicit platform origin and a platform API key supplied by the user.
Bearer transport is supported. A separate OAuth implementation is unnecessary
for this slice. Do not reuse or reinterpret Fabric credentials, endpoint
configuration, or its retry wrapper.

Proposed configuration is `~/.ace/platform/credentials.json`, an atomic complete
pair of HTTPS origin and key. Use a private directory (0700), exclusive temporary
file (0600), and atomic replacement. Reads must be bounded, regular-file only,
owned/private, and reject symlinks/nonregular files before opening, with
nonblocking/race-safe file checks. Keep the key out of arguments, logs, errors,
JSON command output, fixtures, and catalog caches. Store no account metadata.
The credential belongs to exactly its stored origin; an override of the origin
requires its own explicit credential. Environment override is an explicit
`ACETEAM_PLATFORM_URL` and `ACETEAM_PLATFORM_API_KEY` pair.

`ace templates login --url <https-origin>` prompts privately for an API key and
verifies it with the read-only catalog request before saving. A failed check does
not save the candidate. `ace templates logout` removes only this credential
pair. There is no credential prompt, settings read, or network request at initial
TUI startup. Do not mutate other credential files or native provider settings.

All credentialed requests reject redirects; especially do not allow a 307/308 to
resubmit a credit-consuming POST. No run POST is automatically retried. Reject
userinfo, query, fragment, or non-origin configuration URLs. Plain HTTP may be
allowed only for an explicit loopback test/development origin.

## Client and execution boundary

Create `src/platform/{types,client,config}.ts` and focused tests. The client owns
injected fetch, URL construction, bounds, response parsing, and transport errors:

- `listTemplates({category?,signal?}): Promise<PlatformTemplateSummary[]>`
- `getTemplate(summary,{signal?}): Promise<PlatformTemplate>`
- `runTemplate(template,input,{signal?,onProgress?}): Promise<PlatformRunResult>`

`PlatformTemplate` contains the validated identity/version metadata and graph.
Every execution path, including a direct UUID command, obtains it through the
catalog and authorized version read. Do not provide a bypass accepting only UUID
and arbitrary graph to `runTemplate`. Preserve the graph's engine metadata.

Use existing graph/input helpers for required values, typed defaults, structured
JSON values, and explicit model override rules. Local execution uses the pinned
local runtime after input validation, then its real graph/schema validation;
unsupported node types or parameters are an actionable compatibility error, not
a promise that every platform template is locally portable. If a temporary graph
file is necessary, use an owned temporary directory, a 0600 graph file, and
finally cleanup on completion, error, or cancellation.

Bound catalog/detail/error bodies and each SSE event independently. A streaming
parser must handle split UTF-8, CR/LF/CRLF, blank-line dispatch, multiple data
lines, and comments. The complete execution stream need not be retained in
memory. Ignore unsupported nonterminal event kinds, without inferring success.
Malformed terminal data, a missing/mismatched identity, or EOF/disconnect before
terminal evidence produces an unknown/incomplete outcome, never success or
confirmed cancellation. Do not retry uncertain submissions.

Abort closes local observation. It does not prove the platform job stopped;
report that the remote run may continue and consume credits. No server cancel
endpoint is included in this bounded design. Render only validated/sanitized
progress fields and the final output, with the existing terminal sanitizer and
Markdown renderer; never treat progress text as an instruction.

## CLI and shared TUI

- `ace templates list [--category <category>] [--json]` fetches platform metadata.
- `ace templates run <uuid>` obtains the pinned authorized graph and executes
  locally, using the same typed input collection as local workflow files.
- `ace run --remote <template-uuid>` uses the platform path above; UUID dispatch
  is explicit. Existing JSON-file remote execution remains its Fabric path.
  Unsupported named local tasks with `--remote` must reject before bootstrap.
- Add a platform-template panel using the shared shell. Opening it explicitly
  loads the catalog; search and categories filter metadata. Selecting a template
  loads its pinned graph before showing input details. The run choice names local
  execution versus platform execution consuming credits, and only an explicit
  run action submits work. Local bundled templates remain available offline.

Use an injected platform service in the panel. Reuse the existing typed workflow
form and terminal rendering; preserve displayed defaults, selected version
identity, and immutable reviewed input through execution. Remote confirmation
explains that the platform executes stored version content, which may change;
it does not promise execution of the exact locally reviewed graph snapshot. Do not add a background catalog fetch to the
startup path or silently download platform graphs into the bundled registry.

## Verification and remaining scope

Synthetic tests should cover actual list/detail/raw-run envelopes; null or stale
versions; inaccessible listed graph preventing every POST; pinned version path;
separate origins/credentials and 307/308 refusal; login rejection without save;
private atomic persistence and nonregular-file rejection; structured typed input;
local temporary-file cleanup; JSON and split UTF-8/SSE results; sticky error and
cancelled followed by complete; empty error containers; premature EOF/malformed
completion; bounded bodies/events; abort with no automatic retry; and TUI no
startup I/O, category/search/details and explicit credit-consuming confirmation.

This enables a supported client for readable templates. It does not prove that
all publicly listed templates are downloadable, nor that every platform node is
supported by the local pinned runtime. Exact bundled parity still requires an
identified canonical database seed set and a portability check. Do not call
unrelated form-schema seeds a WorkflowGraph catalog, substitute UI examples for
the canonical database seed set, or claim parity from a mock catalog. Keep #5
open until its remaining seed/access requirements are satisfied.
