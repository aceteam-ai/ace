import { afterEach, describe, expect, it, vi } from "vitest";
import { templatesCommand } from "../../src/commands/templates.js";

vi.mock("../../src/utils/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/config.js")>();
  return { ...actual, loadConfig: () => ({ control_plane: {
    kind: "api_key", mcp_url: "https://platform.example/mcp", access_token: KEY, active_org_id: "org-a",
  } }) };
});

vi.mock("../../src/utils/control-plane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/control-plane.js")>();
  return { ...actual, ControlPlaneClient: class { async ensureSelectedOrg() { return { organization_id: "org-a" }; } } };
});

const KEY = "act_synthetic_catalog_fixture_only";
const WORKFLOW_ID = "11111111-2222-4333-8444-555555555555";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("platform catalog credential redaction", () => {
  it.each([false, true])("redacts echoed keys in the actual list command (json=%s)", async (json) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      templates: [{
        workflow_id: WORKFLOW_ID,
        version_number: 3,
        title: `Title ${KEY}`,
        description: `Description ${KEY}`,
        template_category: `Category ${KEY}`,
      }],
    }), { headers: { "content-type": "application/json" } })));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await templatesCommand.parseAsync(["node", "ace", "list", ...(json ? ["--json"] : [])]);

    const displayed = log.mock.calls.flat().join("\n");
    expect(displayed).not.toContain(KEY);
    expect(displayed).toContain("Title [redacted]");
    expect(displayed).toContain("Category [redacted]");
    if (json) expect(displayed).toContain("Description [redacted]");
  });
});
