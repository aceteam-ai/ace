# Local workflow terminal verification

Synthetic terminal checks exercised the local template browser, typed workflow
forms, and Markdown output. The terminal ran in an isolated temporary home with
no provider configuration or model call.

## Typed defaults with the pinned Python runtime

Four blank form answers produced `3`, `false`, `["sample"]`, and `"synthetic"`
with their JSON types preserved. A synthetic Input-to-Output workflow executed
through aceteam-nodes 0.5.1 and workflow-engine 2.0.0rc8. The fixture injected the
already installed isolated Python runtime to test the form/runtime boundary;
this check did not exercise runtime installation.

```text
AceTeam                                                               v0.3.0
  No provider configured

  Workflow output
  Output
  {
    "success": true,
    "output": {
      "count": 3,
      "enabled": false,
      "items": [
        "sample"
      ],
      "label": "synthetic"
    }
  }


  Enter/Esc Back  ? Keys
```

## Long content and resize

The fixture supplied a long single-line fenced output and a long template
description. Keyboard scrolling reached each final marker. Height-only resize
and wider-terminal resize kept both views readable and scrollable. These are
synthetic content checks, not live model streaming evidence.

```text
AceTeam                                                                                                       v0.3.0
  No provider configured

  description. Full synthetic description. Full synthetic description. Full synthetic description. Full synthetic
  description. Full synthetic description. Full synthetic description. Full synthetic description. Full synthetic
  description. Full synthetic description. Full synthetic description. Full synthetic description. Full synthetic
  description. Full synthetic description. Full synthetic description. Full synthetic description. Full synthetic
  description. Full synthetic description. Full synthetic description. Full synthetic description. Full synthetic
  description. Full synthetic description. Full synthetic description. Full synthetic description. Full synthetic
  description. Full synthetic description. Full synthetic description. Full synthetic description. Full synthetic
  description. Full synthetic description. Full synthetic description. Full synthetic description. Full synthetic
  description. Full synthetic description. Full synthetic description. Full synthetic description. Full synthetic
  description. Full synthetic description. Full synthetic description. Full synthetic description. Full synthetic
  description. Full synthetic description. Full synthetic description. Full synthetic description. Full synthetic
  description. Full synthetic description. Full synthetic description. Full synthetic description. Full synthetic
  description. Full synthetic description. Full synthetic description. Full synthetic description. Full synthetic
  description. Full synthetic description. Full synthetic description. Full synthetic description. Full synthetic
  description.  DETAIL_END
  Category: synthetic · 1 node
  ⚠ Synthetic runtime warning
  Input schema
    • Prompt (string · required) — The prompt to send to the LLM

  ↑↓/PgUp/PgDn Scroll  Enter Create  Esc Back  ? Keys
```

Both terminal runs exited with code 0 without a forced kill and restored terminal
flags. The local browser lists bundled templates; platform catalog access and
remote template execution remain pending their public contract.
