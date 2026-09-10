import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHandoffReview, parseHandoffReview } from "../../src/harness/handoff.js";

let root: string; let workspace: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ace-handoff-")); workspace = join(root, "workspace"); await mkdir(workspace); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const envelope = () => ({ version: 1, summary: "Review the synthetic change.", artifacts: [{ path: "missing-example.ts", label: "Reference only" }], target: { adapterId: "claude", workspace } });

describe("reviewed local handoff", () => {
  it("normalizes once, freezes the review and keeps missing artifacts as references", async () => {
    const value = { ...envelope(), summary: "First line\r\nSecond\tline" };
    const review = await parseHandoffReview(JSON.stringify(value));
    value.summary = "Changed later";
    expect(review.summary).toBe("First line\nSecond    line");
    expect(review.input).toBe("Handoff summary\nFirst line\nSecond    line\n\nArtifact references\nmissing-example.ts — Reference only");
    for (const item of [review, review.target, review.workspaceIdentity, review.artifacts, review.artifacts[0]]) expect(Object.isFrozen(item)).toBe(true);
  });

  it.each([
    (value: ReturnType<typeof envelope>) => ({ ...value, nativeSessionId: "hidden" }),
    (value: ReturnType<typeof envelope>) => ({ ...value, permissions: { allow: true } }),
    (value: ReturnType<typeof envelope>) => ({ ...value, target: { ...value.target, commands: ["hidden"] } }),
    (value: ReturnType<typeof envelope>) => ({ ...value, artifacts: [{ path: "file.ts", transcript: "hidden" }] }),
    (value: ReturnType<typeof envelope>) => ({ ...value, version: 2 }),
    (value: ReturnType<typeof envelope>) => ({ ...value, summary: "x".repeat(16 * 1024 + 1) }),
    (value: ReturnType<typeof envelope>) => ({ ...value, summary: "é".repeat(9000) }),
    (value: ReturnType<typeof envelope>) => ({ ...value, artifacts: Array.from({ length: 33 }, () => ({ path: "file.ts" })) }),
  ])("rejects hidden fields and bounded schema violations", async (mutate) => {
    await expect(parseHandoffReview(JSON.stringify(mutate(envelope())))).rejects.toThrow();
  });

  it.each(["\u001b[2Jhidden", "ordinary\u202etext", "text\u200bhidden", "text\u0000hidden", "\ud800"])("rejects invisible/control content before review", async (summary) => {
    await expect(parseHandoffReview(JSON.stringify({ ...envelope(), summary }))).rejects.toThrow(/control/);
  });

  it.each(["../outside", "/absolute", "https://example.invalid/artifact", "C:\\secret", "a/../b", "a//b", "./file"])("rejects nonlocal/traversing artifact paths", async (path) => {
    await expect(parseHandoffReview(JSON.stringify({ ...envelope(), artifacts: [{ path }] }))).rejects.toThrow(/relative/);
  });

  it("loads the exact bounded regular UTF-8 envelope and rejects links, oversized files and malformed bytes", async () => {
    const path = join(root, "handoff.json"); await writeFile(path, JSON.stringify(envelope()));
    expect((await loadHandoffReview(path)).target.workspace).toBe(workspace);
    const link = join(root, "link.json"); await symlink(path, link);
    await expect(loadHandoffReview(link)).rejects.toThrow(/regular/);
    await writeFile(path, "x".repeat(64 * 1024 + 1)); await expect(loadHandoffReview(path)).rejects.toThrow(/64 KiB/);
    await writeFile(path, Buffer.from([0xff, 0xfe])); await expect(loadHandoffReview(path)).rejects.toThrow(/UTF-8/);
  });

  it.skipIf(process.platform === "win32")("rejects an actual FIFO promptly without waiting for a writer", async () => {
    const path = join(root, "handoff.fifo"); await promisify(execFile)("mkfifo", [path]);
    await expect(loadHandoffReview(path)).rejects.toThrow(/regular/);
  }, 1000);
});
