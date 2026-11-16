import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(async () => ({})),
  getTemplate: vi.fn(),
  collectInput: vi.fn(async () => ({})),
  runLocal: vi.fn(),
  spinner: { start: vi.fn(), stop: vi.fn(), succeed: vi.fn(), fail: vi.fn(), text: "" },
}));

vi.mock("@inquirer/prompts", () => ({
  input: vi.fn(),
}));

vi.mock("ora", () => ({
  default: vi.fn(() => {
    mocks.spinner.start.mockReturnValue(mocks.spinner);
    mocks.spinner.stop.mockReturnValue(mocks.spinner);
    mocks.spinner.succeed.mockReturnValue(mocks.spinner);
    mocks.spinner.fail.mockReturnValue(mocks.spinner);
    return mocks.spinner;
  }),
}));

vi.mock("../../src/platform/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/platform/client.js")>();
  return {
    ...actual,
    createPlatformClientFromConfig: mocks.createClient,
  };
});

vi.mock("../../src/platform/service.js", () => ({
  getPlatformTemplateById: mocks.getTemplate,
}));

vi.mock("../../src/platform/workflow.js", () => ({
  collectPlatformTemplateInput: mocks.collectInput,
  runPlatformTemplateLocally: mocks.runLocal,
}));

import { templatesCommand } from "../../src/commands/templates.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue({});
});

describe("templates command", () => {
  it("propagates OAuth-only REST denial as exit 2", async () => {
    const { CliError } = await import("../../src/utils/control-plane.js");
    mocks.createClient.mockRejectedValueOnce(new CliError(2, "Run ace login --api-key-env KEY"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await templatesCommand.parseAsync(["node", "ace", "list"]);
      expect(process.exitCode).toBe(2);
      expect(mocks.createClient).toHaveBeenCalledTimes(1);
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });

  it("does not offer a second template login or logout", () => {
    expect(templatesCommand.commands.map((command) => command.name())).toEqual(["list", "run"]);
  });

  it("fails and stops the local spinner when runtime execution rejects", async () => {
    const template = { title: "Synthetic" };
    mocks.getTemplate.mockResolvedValueOnce(template);
    mocks.runLocal.mockRejectedValueOnce(new Error("runtime failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await templatesCommand.parseAsync(["node", "ace", "run", "11111111-2222-4333-8444-555555555555"]);
      expect(process.exitCode).toBe(1);
      expect(mocks.spinner.fail).toHaveBeenCalledWith("Local template run failed");
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });
});
