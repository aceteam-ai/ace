import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
vi.mock("../../src/utils/config.js", () => ({ loadConfig: vi.fn(() => ({})), saveConfig: vi.fn() }));
vi.mock("../../src/utils/python.js", () => ({
  createVenv: vi.fn(async () => {}),
  getPythonVersion: vi.fn(() => ({ major: 3, minor: 12, patch: 3 })),
  getVenvPythonPath: vi.fn(() => "/managed/bin/python"),
  installAceteamNodes: vi.fn(async () => {}),
  isAceteamNodesReady: vi.fn(async () => false),
}));

import { loadConfig, saveConfig } from "../../src/utils/config.js";
import { createVenv, installAceteamNodes, isAceteamNodesReady } from "../../src/utils/python.js";
import { ensurePython, resetPythonBootstrapForTests } from "../../src/utils/ensure-python.js";

const ready = vi.mocked(isAceteamNodesReady);
const install = vi.mocked(installAceteamNodes);
beforeEach(() => {
  vi.clearAllMocks();
  resetPythonBootstrapForTests();
  vi.mocked(loadConfig).mockReturnValue({});
  ready.mockResolvedValue(false);
  install.mockResolvedValue();
});

describe("lazy Python bootstrap", () => {
  it("reuses a verified configured runtime without installing", async () => {
    vi.mocked(loadConfig).mockReturnValue({ python_path: "/configured/python", patterns_dir: "/keep" });
    ready.mockResolvedValue(true);
    await expect(ensurePython()).resolves.toBe("/configured/python");
    expect(createVenv).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("creates, installs, verifies, and preserves unrelated config", async () => {
    vi.mocked(loadConfig).mockReturnValue({ patterns_dir: "/keep" });
    ready.mockImplementation(async () => install.mock.calls.length > 0);
    await expect(ensurePython()).resolves.toBe("/managed/bin/python");
    expect(createVenv).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledOnce();
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ patterns_dir: "/keep", python_path: "/managed/bin/python" }));
  });

  it("retries after a failed install", async () => {
    install.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce();
    ready.mockImplementation(async () => install.mock.calls.length > 0);
    await expect(ensurePython()).rejects.toThrow("offline");
    ready.mockImplementation(async () => install.mock.calls.length > 1);
    await expect(ensurePython()).resolves.toBe("/managed/bin/python");
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("shares one bootstrap among concurrent callers", async () => {
    let release!: () => void;
    install.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    ready.mockResolvedValue(false);
    const first = ensurePython();
    const second = ensurePython();
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(install).toHaveBeenCalledOnce();
    ready.mockResolvedValue(true);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["/managed/bin/python", "/managed/bin/python"]);
  });

  it("cancels the shared work when its only caller aborts", async () => {
    install.mockImplementation((_path, options) => new Promise<void>((_resolve, reject) => options?.signal?.addEventListener("abort", () => {
      const error = new Error("cancelled"); error.name = "AbortError"; reject(error);
    })));
    const controller = new AbortController();
    const run = ensurePython({ signal: controller.signal });
    while (install.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });
});
