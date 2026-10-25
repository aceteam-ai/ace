import { describe, expect, it, vi } from "vitest";

import { inspectProxyForInit, resolveProxyUpstream } from "../../src/utils/proxy.js";

describe("ace init proxy inspection", () => {
  it("checks an existing proxy before resolving agent base URLs", () => {
    const isRunning = vi.fn(() => true);
    const resolve = vi.fn(resolveProxyUpstream);
    const result = inspectProxyForInit(
      { OPENAI_BASE_URL: "http://localhost:8899/v1" },
      8899,
      { isRunning, resolve }
    );
    expect(isRunning).toHaveBeenCalledWith(8899);
    expect(resolve).not.toHaveBeenCalled();
    expect(result).toEqual({
      alreadyRunning: true, upstream: null, warning: null, error: null,
    });
  });

  it.each([
    { OPENAI_BASE_URL: "http://localhost:8899/v1" },
    { OPENAI_BASE_URL: "https://one.example/v1", ANTHROPIC_BASE_URL: "https://two.example/v1" },
  ])("warns and uses the default target for an unusable standard base URL", (env) => {
    const result = inspectProxyForInit(env, 8899, {
      isRunning: () => false,
      resolve: resolveProxyUpstream,
    });
    expect(result.alreadyRunning).toBe(false);
    expect(result.upstream).toBeNull();
    expect(result.warning).toContain("Ignoring agent base URL");
    expect(result.error).toBeNull();
  });

  it("treats an explicit upstream error as a startup error", () => {
    const result = inspectProxyForInit(
      { UPSTREAM_OPENAI_BASE_URL: "http://127.0.0.2:11434/v1" },
      8899,
      { isRunning: () => false, resolve: resolveProxyUpstream }
    );
    expect(result.upstream).toBeNull();
    expect(result.warning).toBeNull();
    expect(result.error).toContain("loopback");
  });

  it("selects a valid explicit upstream", () => {
    const result = inspectProxyForInit(
      {
        UPSTREAM_OPENAI_BASE_URL: "http://host.docker.internal:11434/v1",
        OPENAI_BASE_URL: "http://localhost:8899/v1",
      },
      8899,
      { isRunning: () => false, resolve: resolveProxyUpstream }
    );
    expect(result.upstream).toEqual({
      target: "http://host.docker.internal:11434", provider: "openai",
      sourceEnv: "UPSTREAM_OPENAI_BASE_URL",
    });
    expect(result.warning).toBeNull();
    expect(result.error).toBeNull();
  });
});
