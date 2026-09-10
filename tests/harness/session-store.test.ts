import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { NativeSessionStore, SessionStoreError } from "../../src/harness/session-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink), open: vi.fn(actual.open) };
});

let root: string;
let workspace: string;
let store: NativeSessionStore;
const identity = (sessionId = "session-a", adapterId = "codex") => ({ adapterId, sessionId, nativeSessionId: `native-${sessionId}` });
const now = () => new Date("2026-01-01T00:00:00.000Z");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-session-store-test-"));
  workspace = join(root, "workspace");
  await mkdir(workspace);
  store = new NativeSessionStore({ directory: join(root, "state"), now });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(rename).mockClear();
  vi.mocked(unlink).mockClear();
  vi.mocked(open).mockClear();
  await rm(root, { recursive: true, force: true });
});

describe("local session registration", () => {
  it("survives restart with only allowlisted identity and workspace data", async () => {
    const input = { ...identity(), nativeOptions: { token: "synthetic-secret" }, transcript: "synthetic-content" };
    const registered = await store.rememberCreatedSession(input, workspace);
    const restarted = new NativeSessionStore({ directory: store.directory });
    expect(await restarted.list()).toEqual([registered]);
    expect(await restarted.resolveForResume({ adapterId: "codex", sessionId: "session-a", workspace })).toEqual(registered);
    const bytes = await readFile(store.statePath, "utf8");
    expect(bytes).not.toContain("synthetic-secret");
    expect(bytes).not.toContain("transcript");
    expect(bytes).not.toContain("approval");
    expect(Object.keys(JSON.parse(bytes).records[0]).sort()).toEqual([
      "adapterId", "sessionId", "nativeSessionId", "workspace", "createdAt", "updatedAt",
    ].sort());
  });

  it("serializes concurrent independent writers without losing records", async () => {
    const other = new NativeSessionStore({ directory: store.directory, now });
    await Promise.all([
      store.rememberCreatedSession(identity("first"), workspace),
      other.rememberCreatedSession(identity("second"), workspace),
      store.rememberCreatedSession(identity("third"), workspace),
    ]);
    expect((await store.list()).map((record) => record.sessionId).sort()).toEqual(["first", "second", "third"]);
    expect(await readdir(store.directory)).toEqual(["native-sessions.json"]);
  });

  it("keeps a stable original registration and rejects identity rebinding", async () => {
    const original = await store.rememberCreatedSession(identity(), workspace);
    const later = new NativeSessionStore({ directory: store.directory, now: () => new Date("2026-02-01T00:00:00.000Z") });
    const updated = await later.rememberCreatedSession(identity(), workspace);
    expect(updated.createdAt).toBe(original.createdAt);
    expect(updated.updatedAt).toBe("2026-02-01T00:00:00.000Z");
    await expect(store.rememberCreatedSession({ ...identity(), nativeSessionId: "other-native" }, workspace))
      .rejects.toMatchObject({ code: "identity_mismatch" });
    expect(await store.list()).toEqual([updated]);
  });

  it("keys local IDs by adapter and never resolves a different provider", async () => {
    await store.rememberCreatedSession(identity(), workspace);
    await expect(store.resolveForResume({ adapterId: "claude", sessionId: "session-a", workspace }))
      .rejects.toMatchObject({ code: "record_not_found" });
    await store.rememberCreatedSession(identity("session-a", "claude"), workspace);
    expect(await store.list()).toHaveLength(2);
    expect(await store.forget({ adapterId: "claude", sessionId: "session-a" })).toBe(true);
    expect(await store.forget({ adapterId: "claude", sessionId: "session-a" })).toBe(false);
    expect((await store.list())[0].adapterId).toBe("codex");
  });

  it("rejects missing native identity and snapshots identity before asynchronous work", async () => {
    await expect(store.rememberCreatedSession({ adapterId: "codex", sessionId: "pending" }, workspace))
      .rejects.toMatchObject({ code: "invalid_identity" });
    const input = identity();
    const save = store.rememberCreatedSession(input, workspace);
    input.nativeSessionId = "mutated-after-call";
    expect((await save).nativeSessionId).toBe("native-session-a");
  });
});

describe("workspace association", () => {
  it("rejects wrong or replaced workspace directories", async () => {
    const record = await store.rememberCreatedSession(identity(), workspace);
    const other = join(root, "other");
    await mkdir(other);
    await expect(store.resolveForResume({ adapterId: "codex", sessionId: "session-a", workspace: other }))
      .rejects.toMatchObject({ code: "identity_mismatch" });
    await rename(workspace, join(root, "original-workspace"));
    await mkdir(workspace);
    if (record.workspace.fileIdentity) {
      await expect(store.resolveForResume({ adapterId: "codex", sessionId: "session-a", workspace }))
        .rejects.toMatchObject({ code: "identity_mismatch" });
    }
  });

  it("canonicalizes workspace symlinks and reports missing workspaces", async () => {
    const alias = join(root, "alias");
    await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
    const record = await store.rememberCreatedSession(identity(), alias);
    expect((await store.resolveForResume({ adapterId: "codex", sessionId: "session-a", workspace })).workspace).toEqual(record.workspace);
    await rm(workspace, { recursive: true });
    await expect(store.resolveForResume({ adapterId: "codex", sessionId: "session-a", workspace }))
      .rejects.toMatchObject({ code: "workspace_unavailable" });
  });
});

describe("private and validated persistence", () => {
  it.skipIf(process.platform === "win32")("creates 0700 directory and 0600 state, rejecting insecure existing permissions", async () => {
    await store.rememberCreatedSession(identity(), workspace);
    expect((await lstat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(store.statePath)).mode & 0o777).toBe(0o600);
    await chmod(store.statePath, 0o644);
    await expect(store.list()).rejects.toMatchObject({ code: "unsafe_storage" });
  });

  it("rejects state-file symlinks and hardlinks without reading target data", async () => {
    await store.list();
    const target = join(root, "target.json");
    await writeFile(target, "synthetic-private-target", { mode: 0o600 });
    await symlink(target, store.statePath);
    await expect(store.list()).rejects.toMatchObject({ code: "unsafe_storage" });
    await rm(store.statePath);
    await link(target, store.statePath);
    await expect(store.list()).rejects.toMatchObject({ code: "unsafe_storage" });
    expect(await readFile(target, "utf8")).toBe("synthetic-private-target");
  });

  it("does not accept a symlink for its state directory", async () => {
    await symlink(workspace, store.directory, process.platform === "win32" ? "junction" : "dir");
    await expect(store.list()).rejects.toMatchObject({ code: "unsafe_storage" });
  });

  it("rejects malformed and unknown state without exposing or overwriting bytes", async () => {
    await store.list();
    const corrupt = '{"synthetic-secret":';
    await writeFile(store.statePath, corrupt, { mode: 0o600 });
    await expect(store.rememberCreatedSession(identity(), workspace)).rejects.toMatchObject({ code: "corrupt_state" });
    expect(await readFile(store.statePath, "utf8")).toBe(corrupt);
    try { await store.list(); } catch (error) {
      expect(String(error)).not.toContain("synthetic-secret");
    }
    await writeFile(store.statePath, JSON.stringify({ version: 999, records: [] }));
    await expect(store.list()).rejects.toMatchObject({ code: "unsupported_version" });
  });

  it("rejects unexpected fields, duplicate identities, oversized data, and excessive records", async () => {
    const record = await store.rememberCreatedSession(identity(), workspace);
    const invalid = [
      { version: 1, records: [{ ...record, token: "synthetic-secret" }] },
      { version: 1, records: [record, record] },
      { version: 1, records: Array.from({ length: 129 }, (_, index) => ({ ...record, sessionId: `session-${index}` })) },
    ];
    for (const value of invalid) {
      await writeFile(store.statePath, JSON.stringify(value));
      await expect(store.list()).rejects.toMatchObject({ code: "corrupt_state" });
    }
    await writeFile(store.statePath, "x".repeat(1024 * 1024 + 1));
    await expect(store.list()).rejects.toMatchObject({ code: "corrupt_state" });
  });

  it("requires explicit quarantine, preserves private backup bytes, and refuses to reset valid state", async () => {
    await store.list();
    const corrupt = "synthetic-corrupt-state";
    await writeFile(store.statePath, corrupt, { mode: 0o600 });
    const recovery = await store.quarantineCorruptState();
    expect(await readFile(recovery.backupPath, "utf8")).toBe(corrupt);
    expect(await store.list()).toEqual([]);
    if (process.platform !== "win32") expect((await lstat(recovery.backupPath)).mode & 0o777).toBe(0o600);
    await store.rememberCreatedSession(identity(), workspace);
    await expect(store.quarantineCorruptState()).rejects.toMatchObject({ code: "state_not_corrupt" });
    expect(await store.list()).toHaveLength(1);
  });

  it("retains committed state and cleans private temporary files when replacement fails", async () => {
    const record = await store.rememberCreatedSession(identity(), workspace);
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("synthetic-hidden-error"), { code: "EIO" }));
    await expect(store.rememberCreatedSession(identity("next"), workspace)).rejects.toMatchObject({ code: "storage_error" });
    expect(await store.list()).toEqual([record]);
    expect(await readdir(store.directory)).toEqual(["native-sessions.json"]);
  });
});

describe("write-lock lifecycle", () => {
  it("keeps committed state readable while an active or unknown writer owns the lock", async () => {
    const record = await store.rememberCreatedSession(identity(), workspace);
    const impatient = new NativeSessionStore({ directory: store.directory, lockTimeoutMs: 0 });
    const active = JSON.stringify({ pid: process.pid, nonce: "synthetic-owner" });
    await writeFile(store.lockPath, active, { mode: 0o600 });
    await expect(impatient.rememberCreatedSession(identity("next"), workspace)).rejects.toMatchObject({ code: "store_busy", recoveryPath: store.lockPath });
    expect(await store.list()).toEqual([record]);
    expect(await readFile(store.lockPath, "utf8")).toBe(active);
    await writeFile(store.lockPath, "partial lock");
    await expect(impatient.forget({ adapterId: "codex", sessionId: "session-a" })).rejects.toMatchObject({ code: "store_busy" });
    expect(await readFile(store.lockPath, "utf8")).toBe("partial lock");
  });

  it("reports a confirmed dead owner as stale without stealing its lock", async () => {
    await store.list();
    const owner = JSON.stringify({ pid: 2147483647, nonce: "synthetic-dead-owner" });
    await writeFile(store.lockPath, owner, { mode: 0o600 });
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("absent"), { code: "ESRCH" }); });
    await expect(store.rememberCreatedSession(identity(), workspace)).rejects.toMatchObject({ code: "stale_lock", recoveryPath: store.lockPath });
    expect(await readFile(store.lockPath, "utf8")).toBe(owner);
    expect(await store.list()).toEqual([]);
  });

  it("cancels a waiting writer without deleting another writer's lock", async () => {
    await store.list();
    const lock = JSON.stringify({ pid: process.pid, nonce: "synthetic-owner" });
    await writeFile(store.lockPath, lock, { mode: 0o600 });
    const controller = new AbortController();
    const pending = store.rememberCreatedSession(identity(), workspace, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(SessionStoreError);
    await expect(store.rememberCreatedSession(identity(), workspace, { signal: controller.signal }))
      .rejects.toMatchObject({ code: "aborted" });
    expect(await readFile(store.lockPath, "utf8")).toBe(lock);
  });
});


describe("nonregular files and lock cleanup failures", () => {
  it.skipIf(process.platform === "win32")("rejects real state and lock FIFOs promptly", async () => {
    await store.list();
    await promisify(execFile)("mkfifo", ["-m", "600", store.statePath]);
    await expect(store.list()).rejects.toMatchObject({ code: "unsafe_storage" });
    await rm(store.statePath);
    await promisify(execFile)("mkfifo", ["-m", "600", store.lockPath]);
    await expect(store.rememberCreatedSession(identity(), workspace)).rejects.toMatchObject({ code: "unsafe_storage" });
  }, 1000);

  it("reports a cleanup failure honestly after an already committed write", async () => {
    vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error("synthetic-hidden-error"), { code: "EACCES" }));
    await expect(store.rememberCreatedSession(identity(), workspace)).rejects.toMatchObject({
      code: "lock_cleanup_failed", recoveryPath: store.lockPath,
    });
    expect((await store.list()).map((record) => record.sessionId)).toEqual(["session-a"]);
    expect(await readFile(store.lockPath, "utf8")).toContain('"pid":');
  });

  it("preserves the primary action error when lock cleanup also fails", async () => {
    await store.list();
    await writeFile(store.statePath, "synthetic-corrupt-state", { mode: 0o600 });
    vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error("hidden"), { code: "EACCES" }));
    await expect(store.rememberCreatedSession(identity(), workspace)).rejects.toMatchObject({ code: "corrupt_state" });
    expect(await readFile(store.statePath, "utf8")).toBe("synthetic-corrupt-state");
  });
});


describe("atomic read integrity", () => {
  it("reads an already-open old document after atomic replacement unlinks its inode", async () => {
    const record = await store.rememberCreatedSession(identity(), workspace);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode);
      const replacement = join(store.directory, "replacement.tmp");
      await actual.writeFile(replacement, JSON.stringify({ version: 1, records: [] }), { mode: 0o600 });
      await actual.rename(replacement, store.statePath);
      return handle;
    });
    expect(await store.list()).toEqual([record]);
    expect(await store.list()).toEqual([]);
  });

  it("rejects invalid UTF-8 instead of changing a native identity during decoding", async () => {
    await store.rememberCreatedSession(identity(), workspace);
    const data = await readFile(store.statePath);
    const marker = data.indexOf("native-session-a");
    data[marker] = 255;
    await writeFile(store.statePath, data);
    await expect(store.list()).rejects.toMatchObject({ code: "corrupt_state" });
  });
});
