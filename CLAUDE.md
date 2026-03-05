# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@aceteam/ace` is a TypeScript CLI for running AceTeam AI workflows locally. It provides the user-facing interface — setup, input parsing, output formatting — and delegates actual workflow execution to the `aceteam-nodes` Python package via subprocess.

## Development Commands

```bash
# Setup
pnpm install                       # Install dependencies

# Build
pnpm build                         # Build with tsup (output in dist/)
pnpm dev                           # Build in watch mode

# Lint
pnpm lint                          # TypeScript type checking (tsc --noEmit)

# Run locally (after build)
node dist/index.js init
node dist/index.js run examples/hello.json --input prompt="test"

# Release
./scripts/release.sh -v v0.2.0 --dry-run  # Preview release
./scripts/release.sh -v v0.2.0 -y         # Publish to npm + GitHub
```

## Architecture

### Source Structure

```
src/
├── index.ts               # Entry point — Commander program setup, version
├── commands/
│   ├── init.ts            # ace init — Python detection, aceteam-nodes install, config setup
│   ├── run.ts             # ace run — unified task + workflow execution
│   └── workflow.ts        # ace workflow validate/list-nodes/create — authoring commands
└── utils/
    ├── config.ts          # Config file loading (~/.ace/config.yaml)
    ├── output.ts          # Terminal output formatting (chalk, ora spinners)
    └── python.ts          # Python detection, pip install, subprocess execution
```

### Build System

- **tsup** for TypeScript bundling (ESM output)
- Output goes to `dist/index.js` (specified in `package.json` `bin` field)
- Published as `@aceteam/ace` on npm with `--access public`

### Key Patterns

- **Commander** for CLI argument parsing
- **chalk** for colored terminal output
- **ora** for progress spinners
- **which** for finding Python executable
- **yaml** for config file parsing

### Dependencies on aceteam-nodes

The CLI auto-installs `aceteam-nodes` on first run (via `ace init`). Workflow commands shell out to `python -m aceteam_nodes.cli` with the appropriate arguments.

## Conventions

- ESM modules (`"type": "module"` in package.json)
- TypeScript strict mode via tsup
- Version is tracked in both `package.json` and `src/index.ts` `.version()` call
- Node.js 18+ required

### Pull Request Descriptions

PR descriptions must tell the full story — not just what changed, but **why it matters, what vision it serves, and how it fits into the bigger picture**. A reviewer (or future engineer) reading the PR should understand the motivation and design decisions without needing to read the issue or ask questions.

**Required sections:**

1. **Context** — Always structure as **Why / What / How**: **Why** — what problem does this solve, what motivated the change? **What** — what is being built or changed at a high level? **How** — what approach was taken and why? Include a code snippet or user-facing example if it helps convey the experience.
2. **Summary** — What was built, organized by component. Each item should explain both the *what* and the *why* (e.g., "Atomic Lua scripts for concurrency safety" not just "Added Lua scripts"). Include architectural decisions and their rationale.
3. **Test plan** — Table or checklist of test groups with counts and coverage areas. Be specific about what edge cases are covered (e.g., "concurrent atomicity: 5 parallel requests").
4. **Related** — Link to parent issues, prior PRs, and protocol proposals that provide additional context.

**Style guidelines:**

- Lead with the *why* before the *what*. The first paragraph should make the reader understand the motivation.
- If the work is part of a multi-phase plan, explain where this fits and what comes next (e.g., "Level 1 of a 3-level scaling architecture").
- Use tables for structured information (test coverage, architecture levels, component summaries).
- Include code examples when they help convey the user/developer experience better than prose.
- Reference issue numbers inline so reviewers can trace decisions back to discussions.
