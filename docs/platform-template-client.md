# Platform template client

Ace can browse platform workflow templates, inspect an authorized graph version, run that fetched graph locally, or submit typed input to the platform. Platform access is explicit and does not run during ordinary CLI or terminal workspace startup.

## Credentials

Platform templates use their own origin and API key. They do not reuse Fabric or model-provider credentials.

```console
ace templates login --url https://app.example.com
ace templates logout
```

Login prompts privately for the key and verifies it with a read-only catalog request before saving anything. Stored credentials use `~/.ace/platform/credentials.json` in a private directory. The complete environment alternative is:

```console
ACETEAM_PLATFORM_URL=https://app.example.com
ACETEAM_PLATFORM_API_KEY=...
```

Both variables are required together. The URL must be an HTTPS origin without a path, query, user information, or fragment. Explicit loopback development origins may use HTTP. Logout removes the stored pair; environment credentials remain active until the environment is changed.

## Catalog and local execution

```console
ace templates list
ace templates list --category general --json
ace templates run 11111111-2222-4333-8444-555555555555 --input prompt="Review this"
```

The catalog supplies metadata and a positive version number. Ace then requests that exact version and validates its workflow identity and graph before collecting schema-aware input. Local execution uses the fetched graph snapshot and the managed pinned Python runtime. It reports platform-only node types as local compatibility errors and always removes its private temporary graph.

Every declared input key must have a typed value or graph default. Structured values use JSON:

```console
ace templates run TEMPLATE_UUID \
  --input count=3 \
  --input enabled=false \
  --input 'items=["one","two"]'
```

The platform owns the graph's model selection. Model overrides are not applied.

## Remote execution

```console
ace run --remote TEMPLATE_UUID --input prompt="Review this"
```

Ace first finds the UUID in the authorized catalog, reads its selected version, validates typed input, and posts the input object to the versioned run route. The graph itself is not posted. The server-side record can change without receiving a new version identifier, so the requested version and returned version ID identify the selected record rather than promising byte-for-byte immutability during a remote run. Local execution continues to use the graph snapshot already fetched.

Remote submission is never retried. Redirects are refused. Authentication, authorization, credit, and rate-limit responses remain distinct. A disconnect, malformed terminal response, server timeout, or local interruption after submission has an unknown outcome: the job may continue and consume credits. When available, Ace prints the separate run and job identifiers for investigation. A failure or cancellation event remains terminal even if a later completion frame arrives.

JSON responses and bounded SSE streams are supported. SSE parsing accepts split UTF-8 and standard CR, LF, or CRLF framing. Progress is advisory; only a complete, correlated terminal envelope establishes success. `--json` still exits nonzero for failed or cancelled runs.

JSON workflow files keep their existing Fabric route:

```console
ace run workflow.json --remote --input prompt="Review this"
```

Named local tasks are not treated as platform templates. Use a template UUID for platform execution.

## Current boundary

A listed template can still be inaccessible to the current credential. Ace does not clone it, change organization context, or submit a run as a workaround. Platform templates can also use nodes that the pinned local runtime does not support; remote execution remains available without Python compatibility checks. Catalog parity with every deployed template depends on an identified canonical seed set and separate portability validation.
