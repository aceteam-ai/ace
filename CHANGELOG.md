# Changelog

## 0.6.0 - 2026-11-24

### Local workflow runtime

- Pin the managed local runtime to workflow-engine 2.0.0rc22 with aceteam-nodes 0.8.0. Ordinary Decimal workflow outputs are now JSON numbers instead of strings; very high-precision values still come back as strings (#63).
- The managed environment moves to `~/.ace/venv-workflow2-rc22`. Installs configured for the previous managed `~/.ace/venv-workflow2-rc20` switch to a freshly provisioned rc22 environment on the next run or `ace init`. A custom `venv_dir` is upgraded in place. The old environment is left on disk (#63).

## 0.5.1 - 2026-11-22

### Session liveness hooks

- Claude Code liveness hooks now include a `PreToolUse` observer for `AskUserQuestion`. The session reports as blocked on `human:input` while it waits for an operator answer. The hook only observes: it returns no decision and never answers or blocks the question (#35).

## 0.5.0 - 2026-11-19

### Local WorkflowGraphs

- Run local WorkflowGraphs with workflow-engine 2.0.0rc20 and aceteam-nodes 0.8.0. Bundle the tagged `addition`, `append`, and `error` examples byte for byte, and keep the earlier Ace examples available (#31).

### Native Codex sessions

- Add external peer-output intake through Codex `functionCallOutput`, with delivery correlation, busy-turn queuing, interrupt cancellation, and bounded input handling (#32).
- Tighten duplicate delivery receipts so a reused ID cannot change peer identity or content, cancelled deliveries require a new ID, and output matches the native turn that received it (#56).

### Test stability

- Wait for Ink screen and callback updates in native handoff, template, and model tests to remove render timing races (#54).

## 0.4.0 - 2026-11-18

### Native sessions and launcher

- Add the native harness adapter contract and local Codex app-server sessions (#17, #22).
- Add reusable turns, shared terminal panels, session resume, and an instant terminal workspace (#23, #24, #26).
- Add Claude Agent sessions and reviewed local handoffs (#27).
- Make bare `ace` a Chat, Code, Work, and harness launcher (#30).

### Control plane and workflows

- Add WorkflowGraph tasks and a local template workspace (#21).
- Add authenticated platform template browsing and workflow access (#28).
- Add control-plane login, schema-driven MCP calls, JSON stdin arguments, shell completion, and one-shot agent turns (#37-#40).
- Route custom model upstream calls through the AEP proxy (#41).

### Hooks

- Install Claude Code and Codex liveness hooks (#34).
- Fix Codex hook lifecycle handling (#48).

### Other

- Document optional collaboration prerequisites (#25).
- Change the license to Elastic License 2.0 (#10).

## 0.3.0 - 2026-03-05

- Previous published release.
