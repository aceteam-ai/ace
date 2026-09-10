# @aceteam/ace

[![npm version](https://img.shields.io/npm/v/@aceteam/ace.svg)](https://www.npmjs.com/package/@aceteam/ace)
[![License: Elastic-2.0](https://img.shields.io/badge/License-Elastic--2.0-green.svg)](LICENSE)

AceTeam CLI for the control plane and local workflows.

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

## Control plane

`ace login` opens the provider menu. Choose AceTeam Fabric to configure the
existing local workflow runner, or AceTeam control plane for browser
authorization. `ace login --browser` goes directly to browser authorization.
After approving the connection, the CLI saves a renewable session in
`~/.ace/config.yaml`. Select the
multi-org checkbox on the consent screen if you need `ace org use`. A single-org
API key also works for read and tool calls:

```bash
ace login --browser
ace whoami --json
ace org list
ace org use "My organization"
ace mcp --list forge
ace mcp --schema forge_pr_list --json
ace mcp forge_pr_list --json '{"owner":"aceteam-ai","repo":"ace"}'
printf '%s\n' '{"owner":"aceteam-ai","repo":"ace"}' | ace mcp forge_pr_list --json -
ace mcp forge_pr_list --arg owner=aceteam-ai --arg repo=ace
ace agent list
ace agent ask "Researcher" "Summarize this week's customer feedback"
ace logout

# For a single organization in a script. The key also configures Fabric.
ace login --api-key-env ACETEAM_API_KEY
```

API-key connections cannot switch organizations. Browser login with multi-org
consent is required for `ace org use`. The selected organization is restored
on later commands, including after an OAuth token refresh. API-key login saves
the Fabric credential even if control-plane verification fails, then exits
with an error so a script does not mistake the control-plane session for ready.

`ace agent ask` sends one independent, governed turn to the selected agent.
Use an agent ID from `ace agent list` if names collide. The control plane
returns the response or its approval status when the turn finishes; the current
agent MCP tool does not stream tokens or keep a conversation history.

`--json` emits machine-readable output on every command, and `--quiet`
suppresses successful output. For `ace mcp`, `--json` alone selects JSON
output; `--json '{...}'` supplies tool arguments, and `--json -` reads a JSON
object from standard input (up to 1 MiB). Invalid input exits
with status 2, authentication failures with 3, and control-plane failures
with 4. The config file is restricted to its owner. Set `ACE_CONFIG_DIR`
to use a different config directory. A custom `--mcp-url` requires HTTPS,
except for a local HTTP server on `localhost`, `127.0.0.1`, or `::1`.
Commands that prompt for input require normal terminal output.

Shell completion is available for Bash, Zsh, and Fish. Add the matching line
to your shell setup, or save the Fish script to its completion directory:

```bash
eval "$(ace completion bash)" # ~/.bashrc
eval "$(ace completion zsh)"  # ~/.zshrc
ace completion fish > ~/.config/fish/completions/ace.fish
```

In Zsh, run `compinit` before the `eval` line so `compdef` is available.

Completion suggests commands and flags from the installed CLI. Use
`ace mcp --list` to discover live tool names.

The first live local run provisions Python and workflow dependencies as needed.
Progress appears in the workspace, and Esc cancels the operation. Browse with
arrow keys, use Enter to select, and open keyboard help with `?` (Tab while
entering text). Settings and provider setup are available from the home menu.

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

### Observe an OpenAI-compatible node through the AEP proxy

Set the upstream URL before running `ace init`. The URL must be reachable from
the proxy container. Use a node hostname or container-accessible host address,
not a loopback address such as `localhost` or `127.0.0.1`. The proxy accepts
one upstream at a time.

For a model server on your own machine, including Ollama or LiteLLM, use
`http://host.docker.internal:<port>/v1` as the upstream. On Linux, Docker needs
`--add-host=host.docker.internal:host-gateway`; `ace init` adds that mapping
when it starts a Docker proxy for this host. Use the same option in a manual
`docker run` command. Podman can use `host.containers.internal` instead.

```bash
export UPSTREAM_OPENAI_BASE_URL=http://node.internal:8000/v1
ace init
```

Then point the coding agent at the local proxy:

```bash
export OPENAI_BASE_URL=http://localhost:8899/v1
```

Requests sent through that URL appear in the local AEP dashboard at
`http://localhost:8899/dashboard/`. The proxy appends the request path, so
`ace init` removes a trailing `/v1` from the upstream base URL before passing
it to the container. A custom Anthropic endpoint can use
`UPSTREAM_ANTHROPIC_BASE_URL` and an agent-side `ANTHROPIC_BASE_URL` instead.

For compatibility, `ace init` also accepts `OPENAI_BASE_URL` or
`ANTHROPIC_BASE_URL` as the upstream before the agent is pointed at the proxy.
The `UPSTREAM_` names take precedence, avoiding a loop when the agent's base
URL already points to `localhost:8899`. If a standard base URL points back to
the proxy or both standard base URLs are set, `ace init` warns and uses the
default proxy target. Invalid or competing `UPSTREAM_` URLs stop proxy startup
until corrected. An existing proxy keeps its current target until it is
stopped and started again.

For a custom upstream, the proxy forwards the coding agent's authentication
header by default. To have the proxy use the provider key from the host
environment instead, set `ACE_PROXY_FORWARD_PROVIDER_KEY=1` before `ace init`.
The selected provider's key is passed as `AEP_TARGET_API_KEY` and, for
compatibility with older images, under the provider variable the image reads.
The value is not included in the container command arguments. When a standard
`OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL` points exactly to that provider's
official API host, `ace init` forwards its matching key automatically. It
prints the selected target and source variable before startup.

If automatic startup fails, the equivalent manual container command for the
example node is:

```bash
docker run -d --name safeclaw-proxy -p 8899:8899 \
  ghcr.io/aceteam-ai/aep-proxy:latest \
  proxy --port 8899 --host 0.0.0.0 --target http://node.internal:8000
```

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

## Native harness development

The internal [Codex adapter](docs/codex-adapter.md) supports one Ace-created native
thread and one turn using Codex CLI 0.153.4. It preserves native authentication and
permissions and has credential-free synthetic tests. Shared terminal integration
and restart/resume are subsequent slices; no new CLI command is exposed yet.

## Related

- **[aceteam-nodes](https://github.com/aceteam-ai/aceteam-nodes)** — Python workflow node library (the execution engine behind this CLI)
- **[Workflow Engine](https://github.com/adanomad/workflow-engine)** — DAG-based workflow execution engine

## License

MIT
