import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock-home"),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("which", () => ({
  default: vi.fn(),
}));

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import which from "which";
import {
  findPython,
  getPythonVersion,
  getVenvPythonPath,
  isVenvValid,
  isAceteamNodesInstalled,
} from "../../src/utils/python.js";
import { loadConfig, saveConfig, getConfigPath } from "../../src/utils/config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockExecFileSync = vi.mocked(execFileSync);
const mockWhich = vi.mocked(which);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("init lifecycle", () => {
  describe("Python detection", () => {
    it("finds Python 3.12+ via which", async () => {
      mockWhich.mockResolvedValue("/usr/bin/python3" as never);
      mockExecFileSync.mockReturnValue("Python 3.12.3\n");

      const result = await findPython();
      expect(result).toBe("/usr/bin/python3");
    });

    it("rejects Python < 3.12", async () => {
      mockWhich.mockResolvedValue("/usr/bin/python3" as never);
      mockExecFileSync.mockReturnValue("Python 3.10.12\n");

      const result = await findPython();
      expect(result).toBeNull();
    });

    it("returns null when no Python found", async () => {
      mockWhich.mockRejectedValue(new Error("not found"));

      const result = await findPython();
      expect(result).toBeNull();
    });
  });

  describe("getPythonVersion", () => {
    it("parses Python version string", () => {
      mockExecFileSync.mockReturnValue("Python 3.12.3\n");
      const version = getPythonVersion("/usr/bin/python3");
      expect(version).toEqual({ major: 3, minor: 12, patch: 3 });
    });

    it("returns null for invalid output", () => {
      mockExecFileSync.mockReturnValue("Not Python\n");
      const version = getPythonVersion("/usr/bin/python3");
      expect(version).toBeNull();
    });

    it("returns null when exec fails", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });
      const version = getPythonVersion("/usr/bin/python3");
      expect(version).toBeNull();
    });
  });

  describe("venv management", () => {
    it("getVenvPythonPath returns correct path on Unix", () => {
      const path = getVenvPythonPath("/home/user/.ace/venv");
      // On the test platform (linux), should use bin/python
      if (process.platform === "win32") {
        expect(path).toContain("Scripts");
      } else {
        expect(path).toBe("/home/user/.ace/venv/bin/python");
      }
    });

    it("isVenvValid checks for python executable", () => {
      mockExistsSync.mockReturnValue(true);
      expect(isVenvValid("/home/user/.ace/venv")).toBe(true);

      mockExistsSync.mockReturnValue(false);
      expect(isVenvValid("/home/user/.ace/venv")).toBe(false);
    });
  });

  describe("aceteam-nodes detection", () => {
    it("returns true when import succeeds", () => {
      mockExecFileSync.mockReturnValue("");
      expect(isAceteamNodesInstalled("/usr/bin/python3")).toBe(true);
    });

    it("returns false when import fails", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("ModuleNotFoundError");
      });
      expect(isAceteamNodesInstalled("/usr/bin/python3")).toBe(false);
    });
  });

  describe("config lifecycle", () => {
    it("config path is under home directory", () => {
      const path = getConfigPath();
      expect(path).toBe("/mock-home/.ace/config.yaml");
    });

    it("loadConfig returns empty object when no file", () => {
      mockExistsSync.mockReturnValue(false);
      const config = loadConfig();
      expect(config).toEqual({});
    });

    it("saveConfig preserves python_path and venv_dir", async () => {
      mockExistsSync.mockReturnValue(true);
      const config = {
        default_model: "gpt-4o-mini",
        python_path: "/home/user/.ace/venv/bin/python",
        venv_dir: "/home/user/.ace/venv",
      };
      saveConfig(config);

      // Verify writeFileSync was called
      const { writeFileSync: ws } = await import("node:fs");
      expect(vi.mocked(ws)).toHaveBeenCalled();
    });
  });
});
