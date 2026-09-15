# Ace launcher

Run `ace` in a terminal to open the launcher. **Chat** runs the bundled local LLM workflow with the detected local provider and keeps prior turns in the prompt. **Code** opens Ace's managed native coding session chooser. **Work** opens bundled tasks, local workflows, workflow creation, and the authenticated platform template browser. Remote runs still require an explicit review and credit confirmation. Bare `ace` outside a terminal prints command help; flags and subcommands keep their existing behavior.

The harness list below Chat, Code, and Work checks executable commands on `PATH`. Enter launches an installed harness or starts its installer when the `(install)` badge appears. Ace exits its terminal UI and restores the terminal before the child starts. The bundled entries are Claude Code, Codex, OpenCode, Hermes, Cline, Droid, and Copilot. Their installers follow [Claude Code](https://code.claude.com/docs/en/setup), [Codex](https://github.com/openai/codex), [OpenCode](https://opencode.ai/en/docs), [Hermes](https://hermes-agent.nousresearch.com/docs/), [Cline](https://docs.cline.bot/getting-started/installing-cline), [Droid](https://docs.factory.ai/droid-cli/cli-reference), and [Copilot](https://docs.github.com/en/copilot/get-started/cli-quickstart) setup guides. Installs need the vendor's own prerequisites and may ask for sign-in or setup afterward. ↑/↓ selects, → opens configuration, and Esc goes back.

Press → on a harness to edit its launch argument array as JSON, then Enter to save. For example, Codex accepts `["--model", "my-model"]` when that flag is supported by the installed Codex version. Other model or node flags should follow the selected harness's CLI. Ace saves this edit in `~/.ace/launcher/registry.json`.

The registry is a JSON array of complete manifest entries. It can override a bundled entry by `id` or add up to 30 entries. Each entry has `id`, `name`, `description`, `detect` (executable name), `launch` (`command` and string `args` array), optional `install` in the same command format, and optional `configure.description`. Ace passes the argument array literally to the child process.

```json
[
  {
    "id": "my-agent",
    "name": "My Agent",
    "description": "Local coding agent",
    "detect": "my-agent",
    "launch": { "command": "my-agent", "args": ["--model", "local"] },
    "install": { "command": "npm", "args": ["install", "-g", "my-agent"] },
    "configure": { "description": "Model and node flags supported by this CLI" }
  }
]
```
