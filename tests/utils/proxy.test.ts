import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  isProxyRunning,
  resolveProxyUpstream,
  startProxy,
} from "../../src/utils/proxy.js";

const mockExecFileSync = vi.mocked(execFileSync);
const originalEnv = process.env;

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...originalEnv };
  for (const key of [
    "UPSTREAM_OPENAI_BASE_URL",
    "UPSTREAM_ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AEP_TARGET_API_KEY",
    "ACE_PROXY_FORWARD_PROVIDER_KEY",
  ]) {
    delete process.env[key];
  }
  mockExecFileSync.mockReturnValue("" as never);
});

afterEach(() => {
  process.env = originalEnv;
});

describe("resolveProxyUpstream", () => {
  it("uses the explicit OpenAI upstream and removes the client /v1 suffix", () => {
    expect(resolveProxyUpstream({
      UPSTREAM_OPENAI_BASE_URL: "http://node.internal:8000/api/v1/",
    })).toEqual({ target: "http://node.internal:8000/api", provider: "openai", sourceEnv: "UPSTREAM_OPENAI_BASE_URL" });
  });

  it("removes a case-insensitive /V1 suffix", () => {
    expect(resolveProxyUpstream({ UPSTREAM_OPENAI_BASE_URL: "https://node.internal/api/V1/" }))
      .toEqual({ target: "https://node.internal/api", provider: "openai", sourceEnv: "UPSTREAM_OPENAI_BASE_URL" });
  });

  it("accepts an Anthropic base URL when no explicit upstream is set", () => {
    expect(resolveProxyUpstream({
      ANTHROPIC_BASE_URL: "https://anthropic.internal/",
    })).toEqual({ target: "https://anthropic.internal", provider: "anthropic", sourceEnv: "ANTHROPIC_BASE_URL" });
  });

  it("prefers an explicit upstream over an agent URL pointing at the proxy", () => {
    expect(resolveProxyUpstream({
      UPSTREAM_OPENAI_BASE_URL: "http://node.internal:8000/v1",
      OPENAI_BASE_URL: "http://localhost:8899/v1",
    })).toEqual({ target: "http://node.internal:8000", provider: "openai", sourceEnv: "UPSTREAM_OPENAI_BASE_URL" });
  });

  it("returns null when no upstream is configured", () => {
    expect(resolveProxyUpstream({})).toBeNull();
  });

  it("rejects competing provider upstreams", () => {
    expect(() => resolveProxyUpstream({
      UPSTREAM_OPENAI_BASE_URL: "https://openai.internal/v1",
      UPSTREAM_ANTHROPIC_BASE_URL: "https://anthropic.internal",
    })).toThrow("one upstream at a time");
  });

  it.each([
    ["ftp://node.internal/v1", "HTTP or HTTPS"],
    ["https://user:pass@node.internal/v1", "without credentials"],
    ["https://node.internal/v1?key=x", "without credentials"],
    ["http://localhost:8899/v1", "loopback"],
    ["http://localhost.:11434/v1", "loopback"],
    ["http://127.0.0.2:11434/v1", "loopback"],
    ["http://0.0.0.0:11434/v1", "loopback"],
    ["http://[::ffff:127.0.0.1]:11434/v1", "loopback"],
    ["http://[::1]:11434/v1", "loopback"],
    ["http://host.docker.internal:8899/v1", "points back"],
  ])("rejects unsafe upstream %s", (value, message) => {
    expect(() => resolveProxyUpstream({ UPSTREAM_OPENAI_BASE_URL: value })).toThrow(message);
  });
});

describe("proxy container startup", () => {
  it("checks the image's dashboard health route", () => {
    expect(isProxyRunning(8899)).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "curl",
      ["-sf", "http://localhost:8899/dashboard/api/state"],
      { stdio: "ignore", timeout: 2000 }
    );
  });

  it("accepts an older cached image's /aep health route", () => {
    mockExecFileSync.mockImplementationOnce(() => { throw new Error("404"); });
    expect(isProxyRunning(8899)).toBe(true);
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      "curl",
      ["-sf", "http://localhost:8899/aep/api/state"],
      { stdio: "ignore", timeout: 2000 }
    );
  });

  it("passes a selected upstream without forwarding provider keys by default", () => {
    process.env.OPENAI_API_KEY = "test-openai-secret";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-secret";
    const upstream = resolveProxyUpstream({
      UPSTREAM_OPENAI_BASE_URL: "http://node.internal:8000/v1",
    });

    expect(startProxy("docker", 8899, upstream)).toBe(true);
    const run = mockExecFileSync.mock.calls.find(
      ([command, args]) => command === "docker" && args?.[0] === "run"
    );
    expect(run).toBeDefined();
    expect(run?.[1]).toEqual([
      "run", "-d", "--name", "safeclaw-proxy", "-p", "8899:8899",
      "ghcr.io/aceteam-ai/aep-proxy:latest",
      "proxy", "--port", "8899", "--host", "0.0.0.0",
      "--target", "http://node.internal:8000",
    ]);
    expect(JSON.stringify(run?.[1])).not.toContain("test-openai-secret");
    expect(JSON.stringify(run?.[1])).not.toContain("test-anthropic-secret");
  });

  it("uses the image default command without a configured upstream", () => {
    expect(startProxy("podman", 8899, null)).toBe(true);
    const run = mockExecFileSync.mock.calls.find(
      ([command, args]) => command === "podman" && args?.[0] === "run"
    );
    expect(run?.[1]?.at(-1)).toBe("ghcr.io/aceteam-ai/aep-proxy:latest");
  });

  it("uses an Anthropic target with an unrelated host without forwarding either key", () => {
    process.env.OPENAI_API_KEY = "test-openai-secret";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-secret";
    const upstream = resolveProxyUpstream({
      UPSTREAM_ANTHROPIC_BASE_URL: "https://sovereign.example/v1",
    });

    expect(startProxy("podman", 8899, upstream)).toBe(true);
    const run = mockExecFileSync.mock.calls.find(
      ([command, args]) => command === "podman" && args?.[0] === "run"
    );
    expect(run?.[1]).not.toContain("ANTHROPIC_API_KEY");
    expect(run?.[1]).not.toContain("OPENAI_API_KEY");
    expect(run?.[1]?.slice(-2)).toEqual(["--target", "https://sovereign.example"]);
  });

  it("forwards an explicitly opted-in Anthropic key through the current image", () => {
    process.env.OPENAI_API_KEY = "test-unrelated-key";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.ACE_PROXY_FORWARD_PROVIDER_KEY = "1";
    const upstream = resolveProxyUpstream({
      UPSTREAM_ANTHROPIC_BASE_URL: "https://sovereign.example/v1",
    });

    expect(startProxy("docker", 8899, upstream)).toBe(true);
    const run = mockExecFileSync.mock.calls.find(
      ([command, args]) => command === "docker" && args?.[0] === "run"
    );
    expect(run?.[1]).toContain("OPENAI_API_KEY");
    expect(run?.[1]).toContain("AEP_TARGET_API_KEY");
    expect(run?.[1]).not.toContain("ANTHROPIC_API_KEY");
    expect(run?.[2]?.env?.OPENAI_API_KEY).toBe("test-anthropic-key");
    expect(run?.[2]?.env?.AEP_TARGET_API_KEY).toBe("test-anthropic-key");
    expect(JSON.stringify(run?.[1])).not.toContain("test-anthropic-key");
  });

  it.each([
    ["OPENAI_BASE_URL", "https://api.openai.com/v1", "OPENAI_API_KEY"],
    ["ANTHROPIC_BASE_URL", "https://api.anthropic.com/v1", "ANTHROPIC_API_KEY"],
  ])("forwards the %s key for its official host", (baseKey, url, apiKey) => {
    process.env[apiKey] = "test-official-key";
    const upstream = resolveProxyUpstream({ [baseKey]: url });
    expect(startProxy("docker", 8899, upstream)).toBe(true);
    const run = mockExecFileSync.mock.calls.find(
      ([command, args]) => command === "docker" && args?.[0] === "run"
    );
    expect(run?.[1]).toContain(apiKey);
    expect(run?.[1]).toContain("AEP_TARGET_API_KEY");
    expect(run?.[2]?.env?.AEP_TARGET_API_KEY).toBe("test-official-key");
    expect(JSON.stringify(run?.[1])).not.toContain("test-official-key");
  });

  it("does not forward a key to a lookalike official host", () => {
    process.env.OPENAI_API_KEY = "test-official-key";
    const upstream = resolveProxyUpstream({ OPENAI_BASE_URL: "https://api.openai.com.evil.test/v1" });
    expect(startProxy("docker", 8899, upstream)).toBe(true);
    const run = mockExecFileSync.mock.calls.find(
      ([command, args]) => command === "docker" && args?.[0] === "run"
    );
    expect(run?.[1]).not.toContain("OPENAI_API_KEY");
    expect(run?.[1]).not.toContain("AEP_TARGET_API_KEY");
  });

  it("adds the Linux Docker gateway mapping for a host-local upstream", () => {
    const upstream = resolveProxyUpstream({
      UPSTREAM_OPENAI_BASE_URL: "http://host.docker.internal:11434/v1",
    });
    expect(startProxy("docker", 8899, upstream)).toBe(true);
    const run = mockExecFileSync.mock.calls.find(
      ([command, args]) => command === "docker" && args?.[0] === "run"
    );
    if (process.platform === "linux") {
      expect(run?.[1]).toContain("--add-host=host.docker.internal:host-gateway");
    }
  });

  it("catches default upstream resolution errors inside startup", () => {
    process.env.UPSTREAM_OPENAI_BASE_URL = "http://localhost:8899/v1";
    expect(startProxy("docker")).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
