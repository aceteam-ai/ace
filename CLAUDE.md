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
node dist/index.js workflow run examples/hello.json --input prompt="test"

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
│   └── workflow.ts        # ace workflow run/validate/list-nodes — delegates to Python
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
