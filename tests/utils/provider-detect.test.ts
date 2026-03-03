import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/utils/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

import { loadConfig } from "../../src/utils/config.js";
import { detectProvider, providerLabel, type ProviderInfo } from "../../src/utils/provider-detect.js";

const mockLoadConfig = vi.mocked(loadConfig);

describe("detectProvider", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    // Stub global.fetch to prevent real Ollama calls
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no ollama"))));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("detects AceTeam fabric as highest priority", async () => {
    mockLoadConfig.mockReturnValue({
      fabric_api_key: "ace-key-123",
      fabric_url: "https://app.aceteam.ai",
    });
    process.env.OPENAI_API_KEY = "sk-test"; // lower priority

    const result = await detectProvider();
    expect(result.provider).toBe("aceteam");
    expect(result.detail).toBe("https://app.aceteam.ai");
  });

  it("detects OpenAI via env var", async () => {
    mockLoadConfig.mockReturnValue({ default_model: "gpt-4o" });
    process.env.OPENAI_API_KEY = "sk-test";

    const result = await detectProvider();
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4o");
  });

  it("uses gpt-4o-mini as default OpenAI model", async () => {
    mockLoadConfig.mockReturnValue({});
    process.env.OPENAI_API_KEY = "sk-test";

    const result = await detectProvider();
    expect(result.model).toBe("gpt-4o-mini");
  });

  it("detects Anthropic via env var", async () => {
    mockLoadConfig.mockReturnValue({});
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    const result = await detectProvider();
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("prefers OpenAI over Anthropic when both set", async () => {
    mockLoadConfig.mockReturnValue({});
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    const result = await detectProvider();
    expect(result.provider).toBe("openai");
  });

  it("detects Ollama when running locally", async () => {
    mockLoadConfig.mockReturnValue({});
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ models: [{ name: "llama3" }] }),
        })
      )
    );

    const result = await detectProvider();
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("ollama/llama3");
  });

  it("returns null provider when nothing available", async () => {
    mockLoadConfig.mockReturnValue({});

    const result = await detectProvider();
    expect(result.provider).toBeNull();
  });

  it("returns null when Ollama fetch times out", async () => {
    mockLoadConfig.mockReturnValue({});
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((_, reject) => setTimeout(() => reject(new Error("aborted")), 10)))
    );

    const result = await detectProvider();
    expect(result.provider).toBeNull();
  });
});

describe("providerLabel", () => {
  it("labels AceTeam provider", () => {
    const info: ProviderInfo = { provider: "aceteam", detail: "https://app.aceteam.ai" };
    expect(providerLabel(info)).toBe("AceTeam Fabric (https://app.aceteam.ai)");
  });

  it("labels OpenAI provider", () => {
    const info: ProviderInfo = { provider: "openai", model: "gpt-4o" };
    expect(providerLabel(info)).toBe("OpenAI (gpt-4o)");
  });

  it("labels Anthropic provider", () => {
    const info: ProviderInfo = { provider: "anthropic", model: "claude-sonnet-4-6" };
    expect(providerLabel(info)).toBe("Anthropic (claude-sonnet-4-6)");
  });

  it("labels Ollama provider", () => {
    const info: ProviderInfo = { provider: "ollama", model: "ollama/llama3" };
    expect(providerLabel(info)).toBe("Ollama local (ollama/llama3)");
  });

  it("labels null provider", () => {
    const info: ProviderInfo = { provider: null };
    expect(providerLabel(info)).toBe("No provider configured");
  });
});
