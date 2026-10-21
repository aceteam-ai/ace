import { afterEach, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("../../src/utils/config.js", () => ({
  loadConfig: () => ({}),
  saveConfig: (config: unknown) => { saved.value = config; },
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
