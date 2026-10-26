import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false), mkdir: vi.fn(async () => {}), mkdtemp: vi.fn(async () => "/tmp/ace-uv-test"),
  rm: vi.fn(async () => {}), writeFile: vi.fn(async () => {}), digest: vi.fn(() => "bad"),
}));
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => ({ existsSync: fsMocks.existsSync }));
vi.mock("node:fs/promises", () => ({ mkdir: fsMocks.mkdir, mkdtemp: fsMocks.mkdtemp, rm: fsMocks.rm, writeFile: fsMocks.writeFile }));
vi.mock("node:crypto", () => ({ createHash: () => ({ update: () => ({ digest: fsMocks.digest }) }) }));
vi.mock("which", () => ({ default: vi.fn(async () => { throw new Error("missing"); }) }));
vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), spawn: spawnMock }));

import { ensureUv } from "../../src/utils/python.js";
const expected = "f4f45f7f5f213d96efc1978b8772b2c037d495d9161ffa7468f8167c6b031033";

function child(closeOnKill: boolean | "force" = false) {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  proc.kill = vi.fn((signal: string) => { if (closeOnKill === true || (closeOnKill === "force" && signal === "SIGKILL")) queueMicrotask(() => proc.emit("close", null)); return true; });
  return proc;
}
beforeEach(() => {
  vi.clearAllMocks(); fsMocks.existsSync.mockReturnValue(false); fsMocks.digest.mockReturnValue("bad");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })));
});

describe("uv bootstrap", () => {
  it("rejects an installer whose checksum does not match", async () => {
    await expect(ensureUv()).rejects.toThrow("checksum verification failed");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("reports offline download failures without creating install files", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(ensureUv()).rejects.toThrow("offline");
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
  });

  it("uses the verified official installer in an isolated unmanaged directory and cleans up", async () => {
    fsMocks.digest.mockReturnValue(expected);
    const proc = child();
    spawnMock.mockReturnValue(proc);
    fsMocks.existsSync.mockImplementation((path) => String(path).endsWith("/.ace/bin/uv"));
    // First existence check must miss; the post-install check succeeds.
    fsMocks.existsSync.mockReturnValueOnce(false);
    const run = ensureUv();
    await new Promise((resolve) => setTimeout(resolve, 0));
    proc.emit("close", 0);
    await expect(run).resolves.toContain("/.ace/bin/uv");
    const options = spawnMock.mock.calls[0][2];
    expect(options.env).toMatchObject({ UV_DISABLE_UPDATE: "1", UV_NO_MODIFY_PATH: "1" });
    expect(fsMocks.rm).toHaveBeenCalledWith("/tmp/ace-uv-test", { recursive: true, force: true });
  });


  it("waits for a stubborn child to receive SIGKILL before rejecting cancellation", async () => {
    vi.useFakeTimers();
    try {
      fsMocks.digest.mockReturnValue(expected);
      const proc = child("force"); spawnMock.mockReturnValue(proc);
      const controller = new AbortController();
      const run = ensureUv({ signal: controller.signal });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
      let settled = false;
      void run.catch(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(run).rejects.toMatchObject({ name: "AbortError" });
      expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");
      expect(fsMocks.rm).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills the installer on cancellation, waits for close, and cleans up", async () => {
    fsMocks.digest.mockReturnValue(expected);
    const proc = child(true); spawnMock.mockReturnValue(proc);
    const controller = new AbortController();
    const run = ensureUv({ signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(fsMocks.rm).toHaveBeenCalled();
  });
});
