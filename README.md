# @aceteam/ace

[![npm version](https://img.shields.io/npm/v/@aceteam/ace.svg)](https://www.npmjs.com/package/@aceteam/ace)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

AceTeam CLI - Run AI workflows locally from your terminal.

## Install

```bash
# From npm (once published)
npm install -g @aceteam/ace

# Or run without installing
npx @aceteam/ace

# Or build from source
git clone https://github.com/aceteam-ai/ace.git
cd ace
pnpm install && pnpm build
node dist/index.js          # run directly
npm link                    # or install globally as `ace`
```

## Quick Start

```bash
# 1. Set up Python venv, install dependencies, create config
ace init

# 2. Browse available workflow templates
ace workflow list-templates

# 3. Create a workflow from a template
ace workflow create hello-llm -o my-workflow.json

# 4. Run it
ace workflow run my-workflow.json --input prompt="Explain AI in one sentence"
```

## How It Works

```
ace CLI (TypeScript)
  │
  ├── ace init ──────────────> Detect Python 3.12+, create ~/.ace/venv,
  │                            install aceteam-nodes, save config
  │
  ├── ace workflow create ──> Pick a bundled template, customize params,
  │                            write workflow JSON
  │
  └── ace workflow run ─────> Validate input, show real-time progress
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
- An LLM provider — cloud API key **or** a local model server (see below)

## Commands

### `ace init`

Interactive setup that:
1. Detects Python 3.12+ (shows specific version error if too old)
2. Creates a managed virtual environment at `~/.ace/venv/`
3. Installs `aceteam-nodes` into the venv
4. Prompts for default model and saves `~/.ace/config.yaml`

```bash
$ ace init

AceTeam CLI Setup

1. Prerequisites
✓ Python 3.12.3 (/usr/bin/python3)

2. Virtual environment
✓ Created venv: /home/user/.ace/venv

3. Dependencies
✓ aceteam-nodes installed

4. Configuration
Default model [gpt-4o-mini]:

Setup complete:
  ✓ Python 3.12.3 (/home/user/.ace/venv/bin/python)
  ✓ aceteam-nodes installed
  ✓ Config: /home/user/.ace/config.yaml
  ✓ Model: gpt-4o-mini
```

### `ace workflow list-templates`

List bundled workflow templates.

```bash
$ ace workflow list-templates
ID              Name            Category  Inputs
────────────────────────────────────────────────────────────
hello-llm       Hello LLM       basics    prompt
text-transform  Text Transform  basics    text, instructions
llm-chain       LLM Chain       chains    prompt
api-to-llm      API to LLM      chains    url

# Filter by category
$ ace workflow list-templates --category basics
```

### `ace workflow create [template-id] [-o file]`

Create a workflow from a bundled template. Prompts for template selection if no ID given, then lets you customize node parameters.

```bash
# Interactive: pick a template and customize
ace workflow create

# Direct: use a specific template
ace workflow create hello-llm -o my-workflow.json
```

### `ace workflow run <file> [options]`

Run a workflow from a JSON file. Shows real-time progress as nodes execute.

```bash
ace workflow run workflow.json --input prompt="Hello"
```

Options:
- `-i, --input <key=value...>` - Input values
- `-v, --verbose` - Show raw stderr debug output
- `--config <path>` - Custom config file path
- `--remote` - Run on remote Fabric node instead of locally

Errors are automatically classified with suggested fixes:
```
✗ Missing module: aceteam_nodes
  Run `ace init` to install dependencies

✗ Authentication failed
  Set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable
```

### `ace workflow validate <file>`

Validate a workflow JSON file against the schema.

### `ace workflow list-nodes`

List all available node types with descriptions.

### `ace fabric login`

Authenticate with the AceTeam Sovereign Compute Fabric for remote workflow execution.

### `ace fabric discover [--capability <tag>]`

Discover available Citadel nodes on the Fabric.

### `ace fabric status`

Show connected node load metrics.

## Using Local LLMs (Ollama, vLLM, etc.)

Workflows use [litellm](https://docs.litellm.ai/) under the hood, which supports 100+ LLM providers — including local model servers. No API key needed for local models.

### Ollama

```bash
# 1. Start Ollama (https://ollama.com)
ollama serve
ollama pull llama3

# 2. Create a workflow using the Ollama model
ace workflow create hello-llm -o local-chat.json
# When prompted for "model", enter: ollama/llama3

# 3. Run it
ace workflow run local-chat.json --input prompt="Hello from local LLM"
```

### vLLM

```bash
# 1. Start vLLM server
vllm serve meta-llama/Llama-3-8b --port 8000

# 2. Set the base URL and create a workflow
export OPENAI_API_BASE=http://localhost:8000/v1
ace workflow create hello-llm -o vllm-chat.json
# When prompted for "model", enter: openai/meta-llama/Llama-3-8b

# 3. Run it
ace workflow run vllm-chat.json --input prompt="Hello from vLLM"
```

### Cloud APIs

```bash
export OPENAI_API_KEY=sk-...          # OpenAI
export ANTHROPIC_API_KEY=sk-ant-...   # Anthropic
export GEMINI_API_KEY=...             # Google Gemini
```

The model name in your workflow JSON determines which provider is used. Examples:
- `gpt-4o-mini` — OpenAI
- `claude-3-haiku-20240307` — Anthropic
- `gemini/gemini-pro` — Google
- `ollama/llama3` — Ollama (local)
- `openai/model-name` + `OPENAI_API_BASE` — vLLM, LM Studio, or any OpenAI-compatible server

See [litellm provider docs](https://docs.litellm.ai/docs/providers) for the full list.

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Build in watch mode
pnpm dev

# Type check
pnpm lint

# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run tests with coverage
pnpm test:coverage

# Run integration tests only
pnpm test:integration
```

## Related

- **[aceteam-nodes](https://github.com/aceteam-ai/aceteam-nodes)** — Python workflow node library (the execution engine behind this CLI)
- **[Workflow Engine](https://github.com/adanomad/workflow-engine)** — DAG-based workflow execution engine

## License

MIT
