# @aceteam/ace

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

## Requirements

- Node.js 18+
- Python 3.12+ (for workflow execution)
- `aceteam-nodes` Python package (auto-installed on first run)

## How It Works

The TypeScript CLI handles file validation, Python detection, and output formatting. Workflow execution is delegated to the `aceteam-nodes` Python package via subprocess, which uses `litellm` for multi-provider LLM support (OpenAI, Anthropic, Google, and 100+ more).

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

## License

MIT
