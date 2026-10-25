import { afterEach, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ value: undefined as unknown }));
const prompt = vi.hoisted(() => ({ choice: "fabric", key: "fabric-key" }));
const auth = vi.hoisted(() => ({ error: null as Error | null }));

vi.mock("@inquirer/prompts", () => ({
  select: async () => prompt.choice,
  password: async () => prompt.key,
}));

vi.mock("../../src/utils/fabric.js", () => ({
  FabricClient: class {
    async status() { return {}; }
  },
}));

vi.mock("../../src/utils/config.js", () => ({
  loadConfig: () => saved.value || {},
  saveConfig: (config: unknown) => { saved.value = config; },
}));

vi.mock("../../src/utils/oauth.js", () => ({
  browserLogin: async () => ({
    kind: "oauth",
    mcp_url: "https://aceteam.ai/mcp",
    access_token: "oauth-access",
    refresh_token: "oauth-refresh",
  }),
}));

vi.mock("../../src/utils/control-plane.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/utils/control-plane.js")>();
  return {
    ...real,
    ControlPlaneClient: class {
      async identity() {
        if (auth.error) throw auth.error;
        return { user_id: "user-1", organization_id: "org-a" };
      }
    },
  };
});

import { loginCommand } from "../../src/commands/login.js";

afterEach(() => {
  saved.value = undefined;
  prompt.choice = "fabric";
  auth.error = null;
  process.exitCode = 0;
  for (const option of ["apiKey", "apiKeyEnv", "browser", "mcpUrl", "json", "quiet"]) {
    loginCommand.setOptionValue(option, undefined);
  }
  vi.restoreAllMocks();
});

it("keeps the provider menu and Fabric key path for interactive login", async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await loginCommand.parseAsync([], { from: "user" });
  expect(saved.value).toMatchObject({
    fabric_url: "https://app.aceteam.ai",
    fabric_api_key: "fabric-key",
  });
  expect(saved.value).not.toHaveProperty("control_plane");
});

it("saves the verified organization with a single-org API key", async () => {
  const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await loginCommand.parseAsync(["--api-key", "test-key", "--json"], { from: "user" });
  expect(saved.value).toMatchObject({
    control_plane: {
      kind: "api_key",
      access_token: "test-key",
      active_org_id: "org-a",
    },
  });
  expect(stdout).toHaveBeenCalledWith('{"authenticated":true,"organization_id":"org-a","user_id":"user-1"}');
});

it("rejects an insecure remote MCP URL before using or saving an API key", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await loginCommand.parseAsync([
    "--api-key", "test-key", "--mcp-url", "http://remote.example/mcp", "--json",
  ], { from: "user" });
  expect(process.exitCode).toBe(2);
  expect(saved.value).toBeUndefined();
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Control-plane URL must use HTTPS or local HTTP."));
});

it("retains the legacy Fabric key when control-plane verification is offline", async () => {
  auth.error = new Error("offline");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await loginCommand.parseAsync(["--api-key", "test-key", "--json"], { from: "user" });
  expect(process.exitCode).toBe(4);
  expect(saved.value).toMatchObject({ fabric_api_key: "test-key" });
  expect(saved.value).not.toHaveProperty("control_plane");
});

it("removes an old copied API key when browser login replaces it", async () => {
  saved.value = {
    control_plane: { kind: "api_key", mcp_url: "https://aceteam.ai/mcp", access_token: "old-key" },
    fabric_api_key: "old-key",
  };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await loginCommand.parseAsync(["--json"], { from: "user" });
  expect(saved.value).toMatchObject({ control_plane: { kind: "oauth", access_token: "oauth-access" } });
  expect(saved.value).not.toHaveProperty("fabric_api_key");
});
