import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("which", () => ({
  default: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import which from "which";
import {
  findUv,
  findPython,
  createVenv,
  installAceteamNodes,
} from "../../src/utils/python.js";

const mockExecFileSync = vi.mocked(execFileSync);
const mockWhich = vi.mocked(which);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findUv", () => {
  it("returns uv path when found", async () => {
    mockWhich.mockResolvedValue("/usr/bin/uv" as never);
    const result = await findUv();
    expect(result).toBe("/usr/bin/uv");
  });

  it("returns null when uv not installed", async () => {
    mockWhich.mockRejectedValue(new Error("not found"));
    const result = await findUv();
    expect(result).toBeNull();
  });
});

describe("findPython", () => {
  it("finds python3 when version >= 3.12", async () => {
    mockWhich.mockResolvedValue("/usr/bin/python3" as never);
    mockExecFileSync.mockReturnValue("Python 3.12.3\n");

    const result = await findPython();
    expect(result).toBe("/usr/bin/python3");
  });

  it("rejects python3 < 3.12 and tries python", async () => {
    mockWhich
      .mockResolvedValueOnce("/usr/bin/python3" as never)
      .mockResolvedValueOnce("/usr/bin/python" as never);
    mockExecFileSync
      .mockReturnValueOnce("Python 3.10.5\n")
      .mockReturnValueOnce("Python 3.13.0\n");

    const result = await findPython();
    expect(result).toBe("/usr/bin/python");
  });

  it("returns null when no suitable Python found", async () => {
    mockWhich.mockRejectedValue(new Error("not found"));
    const result = await findPython();
    expect(result).toBeNull();
  });
});

describe("createVenv", () => {
  it("uses uv venv when uv is available with python path", async () => {
    mockWhich.mockResolvedValue("/usr/bin/uv" as never);

    await createVenv("/usr/bin/python3", "/home/user/.ace/venv");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/bin/uv",
      ["venv", "/home/user/.ace/venv", "--python", "/usr/bin/python3"],
      { stdio: "pipe" }
    );
  });

  it("uses uv venv with --python 3.12 when no python path", async () => {
    mockWhich.mockResolvedValue("/usr/bin/uv" as never);

    await createVenv(null, "/home/user/.ace/venv");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/bin/uv",
      ["venv", "/home/user/.ace/venv", "--python", "3.12"],
      { stdio: "pipe" }
    );
  });

  it("falls back to python -m venv when uv unavailable", async () => {
    mockWhich.mockRejectedValue(new Error("not found"));

    await createVenv("/usr/bin/python3", "/home/user/.ace/venv");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/bin/python3",
      ["-m", "venv", "/home/user/.ace/venv"],
      { stdio: "pipe" }
    );
  });

  it("throws when no uv and no python", async () => {
    mockWhich.mockRejectedValue(new Error("not found"));

    await expect(createVenv(null, "/home/user/.ace/venv")).rejects.toThrow(
      "No Python found and uv is not installed"
    );
  });
});

describe("installAceteamNodes", () => {
  it("uses uv pip install when uv is available", async () => {
    mockWhich.mockResolvedValue("/usr/bin/uv" as never);

    await installAceteamNodes("/home/user/.ace/venv/bin/python");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/usr/bin/uv",
      ["pip", "install", "aceteam-nodes[llm]", "--python", "/home/user/.ace/venv/bin/python"],
      { stdio: ["ignore", "inherit", "inherit"] }
    );
  });

  it("falls back to python -m pip when uv unavailable", async () => {
    mockWhich.mockRejectedValue(new Error("not found"));

    await installAceteamNodes("/home/user/.ace/venv/bin/python");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "/home/user/.ace/venv/bin/python",
      ["-m", "pip", "install", "aceteam-nodes[llm]"],
      { stdio: ["ignore", "inherit", "inherit"] }
    );
  });

  it("does not inherit stdin (prevents readline conflicts)", async () => {
    mockWhich.mockRejectedValue(new Error("not found"));

    await installAceteamNodes("/usr/bin/python3");

    const [, , opts] = mockExecFileSync.mock.calls[0];
    expect((opts as { stdio: unknown[] }).stdio[0]).toBe("ignore");
  });
});
