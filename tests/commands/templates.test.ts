import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  password: vi.fn(async () => "synthetic-key"),
  listTemplates: vi.fn(async () => []),
  createClient: vi.fn(async () => ({})),
  saveCredentials: vi.fn(async () => undefined),
  removeCredentials: vi.fn(async () => false),
  getTemplate: vi.fn(),
  collectInput: vi.fn(async () => ({})),
  runLocal: vi.fn(),
  spinner: { start: vi.fn(), stop: vi.fn(), succeed: vi.fn(), fail: vi.fn(), text: "" },
}));

vi.mock("@inquirer/prompts", () => ({
  password: mocks.password,
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
    PlatformClient: vi.fn(function () { return { listTemplates: mocks.listTemplates }; }),
    createPlatformClientFromConfig: mocks.createClient,
  };
});

vi.mock("../../src/platform/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/platform/config.js")>();
  return {
    ...actual,
    savePlatformCredentials: mocks.saveCredentials,
    removePlatformCredentials: mocks.removeCredentials,
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
  mocks.password.mockResolvedValue("synthetic-key");
  mocks.listTemplates.mockResolvedValue([]);
  mocks.saveCredentials.mockResolvedValue(undefined);
  mocks.createClient.mockResolvedValue({});
});

describe("templates command", () => {
  it("does not save a candidate key when read-only catalog verification fails", async () => {
    mocks.listTemplates.mockRejectedValueOnce(new Error("denied"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await templatesCommand.parseAsync(["node", "ace", "login", "--url", "https://platform.example"]);
      expect(process.exitCode).toBe(1);
      expect(mocks.saveCredentials).not.toHaveBeenCalled();
      expect(mocks.spinner.fail).toHaveBeenCalledWith("Platform verification failed");
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });

  it("saves only the verified normalized origin and private prompt value", async () => {
    const previousExitCode = process.exitCode;
    try {
      await templatesCommand.parseAsync(["node", "ace", "login", "--url", "https://PLATFORM.example/"]);
      expect(mocks.listTemplates).toHaveBeenCalledTimes(1);
      expect(mocks.saveCredentials).toHaveBeenCalledWith({ origin: "https://platform.example", apiKey: "synthetic-key" });
      expect(process.exitCode).toBe(previousExitCode);
    } finally {
      process.exitCode = previousExitCode;
    }
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
