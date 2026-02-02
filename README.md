# @aceteam/ace

[![npm version](https://img.shields.io/npm/v/@aceteam/ace.svg)](https://www.npmjs.com/package/@aceteam/ace)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

AceTeam CLI - Run AI workflows locally from your terminal.

## Install

```bash
npm install -g @aceteam/ace
# or
npx @aceteam/ace
```

## Quick Start

```bash
# Set up config and check dependencies
ace init

# Run a workflow
ace workflow run hello-llm.json --input prompt="Explain AI in one sentence"

# Validate a workflow file
ace workflow validate hello-llm.json

# List available node types
ace workflow list-nodes
```

## How It Works

```
ace CLI (TypeScript)
  │
  ├── ace init ────────> Detect Python, install aceteam-nodes, create config
  │
  └── ace workflow run ─> Validate input
                            │
                            ▼
                     python -m aceteam_nodes.cli
                            │
                            ▼
                     aceteam-nodes (Python)
                       ├── litellm (100+ LLM providers)
                       ├── httpx (API calls)
                       └── workflow-engine (DAG execution)
```

The TypeScript CLI handles file validation, Python detection, and output formatting. Workflow execution is delegated to the `aceteam-nodes` Python package via subprocess, which uses `litellm` for multi-provider LLM support (OpenAI, Anthropic, Google, and 100+ more).

## Requirements

- Node.js 18+
- Python 3.12+ (for workflow execution)
- `aceteam-nodes` Python package (auto-installed on first run)

## Commands

### `ace init`

Interactive setup: checks Python, installs `aceteam-nodes`, and creates `~/.ace/config.yaml`.

### `ace workflow run <file> [options]`

Run a workflow from a JSON file.

```bash
ace workflow run workflow.json --input prompt="Hello" --verbose
```

Options:
- `-i, --input <key=value...>` - Input values
- `-v, --verbose` - Show progress messages
- `--config <path>` - Custom config file path

### `ace workflow validate <file>`

Validate a workflow JSON file against the schema.

### `ace workflow list-nodes`

List all available node types with descriptions.

## Development

```bash
# Setup
pnpm install

# Build
pnpm build

# Build in watch mode
pnpm dev

# Type check
pnpm lint
```

## Related

- **[aceteam-nodes](https://github.com/aceteam-ai/aceteam-nodes)** — Python workflow node library (the execution engine behind this CLI)
- **[Workflow Engine](https://github.com/adanomad/workflow-engine)** — DAG-based workflow execution engine

## License

MIT
