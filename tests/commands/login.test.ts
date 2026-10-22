import { afterEach, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ value: undefined as unknown }));

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
        return { user_id: "user-1", organization_id: "org-a" };
      }
    },
  };
});

import { loginCommand } from "../../src/commands/login.js";

afterEach(() => {
  saved.value = undefined;
  process.exitCode = 0;
  vi.restoreAllMocks();
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
