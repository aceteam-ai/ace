# Claude Agent native adapter

Ace can host the pinned Claude Agent SDK as a local native session while leaving Claude's tools, instructions, permission rules, and sandbox under Claude's own settings. This adapter uses `@anthropic-ai/claude-agent-sdk` 0.3.267 and its bundled Claude Code 2.1.267 runtime. Ace loads the package only after an explicit Claude Agent start or resume action, so opening the workspace menu does not start Claude or inspect its authentication.

## Authentication

Set `ANTHROPIC_API_KEY` in the environment that starts Ace. The adapter accepts only the SDK's confirmed first-party API-key route. It rejects bearer/OAuth variables and enabled Bedrock, Vertex, or Foundry routes rather than silently changing providers. Ace does not copy the key into its config, session registry, events, or logs.

Before opening the native query, the adapter uses the SDK's public settings resolver and vendor trust filter for Claude's `user`, `project`, and `local` sources. It explicitly preserves `default`, `plan`, and `dontAsk`. It rejects other retained modes and visible managed `policyHelper`/`policyHelpers` configuration because this adapter does not execute a policy helper. A project escalation removed by the vendor filter resolves to `default`. Resume resolves current settings again and never restores a permission grant from Ace state.

The native query still loads Claude's `user`, `project`, and `local` settings sources. Native rules may allow or deny a tool before Ace receives a permission callback. When Claude does ask Ace, the UI offers a one-time allow or deny bound to that exact native request. An Ace approval does not create or persist a Claude permission rule. Structured `AskUserQuestion` tool calls are denied because this bounded UI cannot return the required answer schema. MCP elicitation uses the SDK default: native hooks may handle it first, and otherwise the SDK declines it because Ace supplies no elicitation handler.

## Session behavior

A new session becomes ready for input after the SDK has initialized and confirmed the authentication route. Its native session ID remains pending until the first turn's native `system/init` frame verifies the proposed ID, canonical workspace, runtime version, API-key source, and current permission mode. Ace registers that identity only after those checks.

Each submitted message receives an Ace-owned UUID. Ace waits for Claude to echo that UUID before reporting that the turn started or accepting the send. A turn becomes ready again only after both its correlated native result and Claude's authoritative idle state arrive. Missing correlation or idle evidence ends the connection with an actionable error; Ace never retries an input whose delivery is uncertain.

Resume is available only for an Ace-registered Claude session in the same canonical workspace. Before opening the query, the adapter checks the registration and the SDK's `getSessionInfo` result. Resume reopens the saved native history while resolving the current native permission settings again. It accepts no caller-supplied model or permission overrides.

Closing a session aborts callbacks, closes the owned input queue and query, and waits within a bounded deadline for the reader and SDK iterator to finish. If cleanup cannot be confirmed, Ace retains the session so closing can be retried instead of releasing ownership while native work might remain.

## Data shown in Ace

Ace renders assistant text, tool activity, native permission requests, verified local-agent tasks, and native Edit/Write change metadata. File changes use Claude's `structuredPatch` or `gitDiff`; Ace does not reconstruct diffs. Edit contents and original file bodies are excluded from emitted tool activity and change events. Session account metadata and transcript-like resume metadata are also excluded.

The adapter does not initiate a model call during startup, enumerate unrelated Claude projects, import transcripts, manage Claude login, or enable alternate cloud providers. The repository tests use a synthetic SDK boundary. A credential-free startup check with an invalid synthetic key verifies initialization route classification and owned cleanup only; it does not establish key validity, authenticated inference, or resume history.
