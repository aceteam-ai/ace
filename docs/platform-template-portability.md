# Seed parity and local portability evidence

Ace now runs the published v2 RC pair: `aceteam-workflow-engine==2.0.0rc16` and `aceteam-nodes[llm]==0.8.0`. The current graph contract is exposed by `aceteam://flows/graph-template` and `aceteam://flows/schema-overview` on the AceTeam MCP, with the workflow-engine library as the type and execution source. All 11 task graphs and 4 examples passed the engine validator. The bundled `hello-llm` graph executed with a synthetic context; `api-to-llm` fetched a loopback HTTP fixture and returned a synthetic summary. No provider credentials or live model calls were used. These checks prove current local compatibility, not parity with an org-specific database seed set.

The checks below record the earlier rc8/0.5.1 baseline before migration.

The canonical database template seed set remains unidentified, so exact bundled
parity is unproven. This does not establish that the deployed seed set is empty.
Form schemas and static UI examples are separate from database workflow templates
and must not be substituted for the canonical set.

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
  graphs. They were not identified as canonical database seeds and were not copied
  into Ace.

Completing the parity requirement needs an authoritative, versioned graph set
that is eligible for bundling, followed by exact comparison and local portability
validation. The current evidence supports the shared graph format, not a claim
that all platform templates run locally or match Ace's bundled tasks.

Platform execution can use nodes supported by the platform even when they are
unavailable locally. Remote runs should require authorized graph retrieval and
typed input validation without Python bootstrap; only local runs require local
runtime compatibility checks.
