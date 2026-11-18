# Changelog

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
