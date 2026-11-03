# Seed parity and local portability evidence

Ace runs the published v2 RC pair: `aceteam-workflow-engine==2.0.0rc16` and `aceteam-nodes[llm]==0.8.0`. The AceTeam MCP graph-template and schema-overview resources define the graph shape, and the workflow-engine library defines types and execution. Per the bundled-set decision, Ace tracks the three JSON graphs in the [v2.0.0rc16 workflow-engine examples](https://github.com/aceteam-ai/workflow-engine/tree/v2.0.0rc16/examples): `addition`, `append`, and `error`. Their file hashes match the tagged originals exactly; Ace adds listing metadata outside the graphs. The four earlier LLM graphs remain Ace examples for existing CLI and chat flows.

All 11 task graphs, four Ace examples, and three upstream examples passed the published engine validator. The tagged `addition` example executed locally; `hello-llm` executed with a synthetic LLM context, and `api-to-llm` fetched a loopback HTTP fixture and returned a synthetic summary. The `error` graph intentionally demonstrates a failing node. No provider credentials or live model calls were used. This establishes parity with the agreed versioned workflow-engine example set, not with deployed database seeds or organization-owned Flow records.

## Historical rc8 evidence

The checks below record the earlier rc8/0.5.1 baseline before migration. The then-unknown seed set is now resolved for Ace's bundled set by the workflow-engine example decision. Historical static UI candidates and Report Builder forms remain separate from the graph bundle.

Validation used `aceteam-nodes` **0.5.1** and
`aceteam-workflow-engine` **2.0.0rc8**, with no credentials, network access, or
model calls:

- All **11 bundled task graphs** passed native structural/schema validation.
- All **4 bundled authoring examples** passed the same validation. This does not
  prove execution compatibility; the existing APICall execution limitation still
  applies.
- **3 distinct static example candidates** were inspected separately. Each failed
  local validation because it required node types absent from the pinned local
  registry. Their graph and input-schema hashes differed from the bundled task
  graphs. They were not identified as canonical database seeds and had not yet
  been copied into Ace at that rc8 baseline.

Platform execution can use nodes supported by the platform even when they are
unavailable locally. Remote runs should require authorized graph retrieval and
typed input validation without Python bootstrap; only local runs require local
runtime compatibility checks.
