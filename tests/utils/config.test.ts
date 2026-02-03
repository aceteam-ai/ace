import { describe, it, expect, vi, beforeEach } from "vitest";
import YAML from "yaml";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock-home"),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadConfig, saveConfig, getConfigPath } from "../../src/utils/config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("config utilities", () => {
  describe("getConfigPath()", () => {
    it("returns path under home directory", () => {
      const path = getConfigPath();
      expect(path).toBe("/mock-home/.ace/config.yaml");
    });
  });

  describe("loadConfig()", () => {
    it("returns empty object when no config file exists", () => {
      mockExistsSync.mockReturnValue(false);
      const config = loadConfig();
      expect(config).toEqual({});
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });

    it("returns parsed YAML config", () => {
      const yamlContent = YAML.stringify({
        fabric_url: "https://app.aceteam.ai",
        fabric_api_key: "test-key",
      });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(yamlContent);

      const config = loadConfig();
      expect(config).toEqual({
        fabric_url: "https://app.aceteam.ai",
        fabric_api_key: "test-key",
      });
    });
  });

  describe("saveConfig()", () => {
    it("writes YAML to config path", () => {
      mockExistsSync.mockReturnValue(true);
      const config = { fabric_url: "https://example.com", fabric_api_key: "key123" };
      saveConfig(config);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        "/mock-home/.ace/config.yaml",
        YAML.stringify(config),
        "utf-8"
      );
    });

    it("creates directory if it does not exist", () => {
      mockExistsSync.mockReturnValue(false);
      const config = { fabric_url: "https://example.com" };
      saveConfig(config);

      expect(mockMkdirSync).toHaveBeenCalledWith("/mock-home/.ace", {
        recursive: true,
      });
      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });

  describe("config fields", () => {
    it("preserves fabric_url and fabric_api_key fields", () => {
      const yamlContent = YAML.stringify({
        fabric_url: "https://custom.url",
        fabric_api_key: "secret-key-123",
        default_model: "gpt-4",
      });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(yamlContent);

      const config = loadConfig();
      expect(config.fabric_url).toBe("https://custom.url");
      expect(config.fabric_api_key).toBe("secret-key-123");
      expect(config.default_model).toBe("gpt-4");
    });
  });
});
