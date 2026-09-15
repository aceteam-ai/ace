import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isAceteamNodesReady, listNodes, runWorkflow, validateWorkflow } from "../../src/utils/python.js";
import { getTemplateById, TEMPLATES } from "../../src/templates/index.js";
import { BUILTIN_PATTERNS } from "../../src/patterns/index.js";

const python = process.env.ACE_RC_PROOF_PYTHON;
const originalPythonPath = process.env.PYTHONPATH;
let directory: string | undefined;
afterEach(() => {
  process.env.PYTHONPATH = originalPythonPath;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("pinned workflow-engine example set", () => {
  it("keeps the three tagged rc16 graph files byte-for-byte", () => {
    const hashes = {
      addition: "2b733a9e08133e80cb21b61c57d9e0f5662c96ba6168773f7573d9d983e5f50c",
      append: "d78d86df0031843e66fa2c61fb121133e2e213085a56f307f12e8bf8eaa8947e",
      error: "cdf042423c00b23f465d3157694e2bf3535578ad32a3699a8b16af85e8ec0d3b",
    };
    const upstream = TEMPLATES.filter((template) => template.source === "workflow-engine-v2.0.0rc16");
    expect(upstream.map((template) => template.id)).toEqual(Object.keys(hashes).map((id) => `workflow-engine-${id}`));
    for (const [name, expected] of Object.entries(hashes)) {
      const file = new URL(`../../src/templates/workflow-engine-${name}.json`, import.meta.url);
      expect(createHash("sha256").update(readFileSync(file)).digest("hex"), name).toBe(expected);
    }
  });
});

describe.skipIf(!python)("published workflow-engine 2.0 RC boundary", () => {
  it("validates every bundled task and example against the pinned engine", async () => {
    directory = mkdtempSync(join(tmpdir(), "ace-rc-bundle-test-"));
    const graphs = [
      ...BUILTIN_PATTERNS.map((pattern) => ({ id: pattern.id, workflow: pattern.workflow })),
      ...TEMPLATES.map((template) => ({ id: template.id, workflow: template.workflow })),
    ];
    expect(graphs).toHaveLength(18);
    for (const { id, workflow } of graphs) {
      const path = join(directory, `${id}.json`);
      writeFileSync(path, JSON.stringify(workflow));
      const result = await validateWorkflow(python!, path);
      expect(result, id).toMatchObject({ valid: true });
    }
  }, 45_000);

  it("validates and executes bundled graphs through the current node entry points", async () => {
    directory = mkdtempSync(join(tmpdir(), "ace-rc-runner-test-"));
    writeFileSync(join(directory, "sitecustomize.py"), [
      "from aceteam_nodes.context import CLIContext",
      "async def fake_call(self, model, system_prompt, prompt):",
      "    return 'synthetic (' + model + '): ' + prompt",
      "CLIContext.call_llm = fake_call",
    ].join("\n") + "\n");
    process.env.PYTHONPATH = directory;
    const config = join(directory, "config.yaml");
    writeFileSync(config, "default_model: wrong-model\n");
    expect(await isAceteamNodesReady(python!)).toBe(true);
    const nodes = await listNodes(python!);
    expect((nodes.nodes as Array<{ type: string }>).map((node) => node.type)).toEqual(expect.arrayContaining(["Input", "Output", "LLM", "APICall"]));

    const hello = getTemplateById("hello-llm")!;
    const helloPath = join(directory, "hello.json");
    writeFileSync(helloPath, JSON.stringify(hello.workflow));
    expect((await validateWorkflow(python!, helloPath)).valid).toBe(true);
    const progress: string[] = [];
    const result = await runWorkflow(python!, helloPath, { prompt: "hello" }, {
      config, baseDir: join(directory, "runs"), onProgress: (event) => progress.push(event.type),
    });
    expect(result).toMatchObject({ success: true, output: { response: "synthetic (gpt-4o-mini): hello" } });
    expect(progress).toContain("node_done");

    const addition = getTemplateById("workflow-engine-addition")!;
    const additionPath = join(directory, "addition.json");
    writeFileSync(additionPath, JSON.stringify(addition.workflow));
    const sum = await runWorkflow(python!, additionPath, { c: 3 }, { config, baseDir: join(directory, "runs") });
    expect(sum).toMatchObject({ success: true, output: { sum: 2070 } });
  });

  it("runs the API example against a loopback fixture and returns a real engine result", async () => {
    directory = mkdtempSync(join(tmpdir(), "ace-rc-api-test-"));
    writeFileSync(join(directory, "sitecustomize.py"), [
      "from aceteam_nodes.context import CLIContext",
      "async def fake_call(self, model, system_prompt, prompt):",
      "    return 'synthetic summary: ' + prompt",
      "CLIContext.call_llm = fake_call",
    ].join("\n") + "\n");
    process.env.PYTHONPATH = directory;
    const config = join(directory, "config.yaml");
    writeFileSync(config, "{}\n");
    const template = getTemplateById("api-to-llm")!;
    const file = join(directory, "api.json");
    writeFileSync(file, JSON.stringify(template.workflow));
    expect((await validateWorkflow(python!, file)).valid).toBe(true);
    const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/plain" }); response.end("fixture body"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No fixture port");
      const result = await runWorkflow(python!, file, { url: `http://127.0.0.1:${address.port}/fixture` }, { config, baseDir: join(directory, "runs") });
      expect(result.success).toBe(true);
      expect(result.output?.summary).toContain("fixture body");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
