import { afterEach, expect, it, vi } from "vitest";

const fakeClient = vi.hoisted(() => ({
  ensureSelectedOrg: vi.fn(async () => ({ organization_id: "org-a" })),
  getTool: vi.fn(async () => ({
    name: "forge_pr_list",
    inputSchema: {
      type: "object",
      required: ["owner", "repo"],
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        expected_org_id: { type: "string" },
      },
    },
  })),
  callTool: vi.fn(async () => ({
    content: [{ type: "text", text: '{"pulls":[1]}' }],
  })),
}));

vi.mock("../../src/utils/control-plane.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/utils/control-plane.js")>();
  return { ...real, configuredClient: () => fakeClient };
});

const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

it("routes ace mcp --json object to tool args and emits machine JSON", async () => {
  process.argv = [
    "node",
    "ace",
    "mcp",
    "forge_pr_list",
    "--json",
    '{"owner":"aceteam-ai","repo":"ace"}',
  ];
  const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await import("../../src/index.js");

  expect(fakeClient.callTool).toHaveBeenCalledWith("forge_pr_list", {
    owner: "aceteam-ai",
    repo: "ace",
    expected_org_id: "org-a",
  });
  expect(stdout).toHaveBeenCalledWith('{"pulls":[1]}');
  expect(process.exitCode || 0).toBe(0);
});
