import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { NativeHarnessSessionIdentity } from "./types.js";

const MAX_BYTES = 1024 * 1024;
const MAX_RECORDS = 128;
const NO_FOLLOW = constants.O_NOFOLLOW || 0;

export interface WorkspaceIdentity {
  realPath: string;
  /** Null explicitly means that only canonical path association is available. */
  fileIdentity: { device: string; inode: string } | null;
}

export interface NativeSessionRecord {
  adapterId: string;
  sessionId: string;
  nativeSessionId: string;
  workspace: WorkspaceIdentity;
  createdAt: string;
  updatedAt: string;
}

interface SessionDocument {
  version: 1;
  records: NativeSessionRecord[];
}

export type SessionStoreErrorCode =
  | "corrupt_state" | "unsupported_version" | "unsafe_storage"
  | "store_busy" | "stale_lock" | "state_limit" | "identity_mismatch"
  | "workspace_unavailable" | "record_not_found" | "invalid_identity"
  | "aborted" | "storage_error" | "state_not_corrupt" | "lock_cleanup_failed"
  | "session_busy" | "stale_session_owner" | "unknown_session_owner" | "ownership_lost";

export class SessionStoreError extends Error {
  constructor(
    readonly code: SessionStoreErrorCode,
    message: string,
    readonly recoveryPath?: string,
  ) {
    super(message);
    this.name = "SessionStoreError";
  }
}

export interface SessionStoreOptions {
  directory?: string;
  lockTimeoutMs?: number;
  now?: () => Date;
}

export interface SessionStoreWriteOptions {
  signal?: AbortSignal;
}

export interface SessionRegistrationOptions extends SessionStoreWriteOptions {
  expectedWorkspace?: WorkspaceIdentity;
}

export type NativeSessionOwnerState = "available" | "active" | "stale" | "unknown";
export interface NativeSessionOwnership {
  /** A durable owner was established, but shared-lock cleanup needs recovery. */
  warning?: SessionStoreError;
  release(): Promise<void>;
}

type NativeSessionKey = { adapterId: string; nativeSessionId: string };
interface SessionOwner { version: 1; pid: number; nonce: string }


function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code) : undefined;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, names: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === names.length && keys.every((key) => names.includes(key));
}

function identifier(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length === 24 &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validWorkspace(value: unknown): value is WorkspaceIdentity {
  if (!object(value) || !exactKeys(value, ["realPath", "fileIdentity"]) ||
      !identifier(value.realPath, 4096) || !isAbsolute(value.realPath)) return false;
  const file = value.fileIdentity;
  return file === null || (object(file) && exactKeys(file, ["device", "inode"]) &&
    typeof file.device === "string" && /^\d{1,30}$/.test(file.device) &&
    typeof file.inode === "string" && /^[1-9]\d{0,29}$/.test(file.inode));
}

function validRecord(value: unknown): value is NativeSessionRecord {
  return object(value) && exactKeys(value, ["adapterId", "sessionId", "nativeSessionId", "workspace", "createdAt", "updatedAt"]) &&
    identifier(value.adapterId, 64) && identifier(value.sessionId) && identifier(value.nativeSessionId) &&
    validWorkspace(value.workspace) && timestamp(value.createdAt) && timestamp(value.updatedAt) &&
    value.updatedAt >= value.createdAt;
}

function key(record: Pick<NativeSessionRecord, "adapterId" | "sessionId">): string {
  return `${record.adapterId}\0${record.sessionId}`;
}

export function sameWorkspace(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
  return left.realPath === right.realPath &&
    left.fileIdentity?.device === right.fileIdentity?.device &&
    left.fileIdentity?.inode === right.fileIdentity?.inode;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SessionStoreError("aborted", "Session state operation cancelled.");
}

function checkPrivate(stats: BigIntStats, directory: boolean, allowReplacedFile = false): void {
  if (!(directory ? stats.isDirectory() : stats.isFile()) || (!directory && stats.nlink !== 1n && !(allowReplacedFile && stats.nlink === 0n))) {
    throw new SessionStoreError("unsafe_storage", "Session state must use a private directory and regular files with a single link.");
  }
  if (process.platform !== "win32") {
    if ((stats.mode & 0o777n) !== (directory ? 0o700n : 0o600n) ||
        (process.getuid && stats.uid !== BigInt(process.getuid()))) {
      throw new SessionStoreError("unsafe_storage", "Session state has unsafe ownership or permissions. Use an owned 0700 directory and 0600 files.");
    }
  }
}

export async function captureWorkspaceIdentity(workspace: string): Promise<WorkspaceIdentity> {
  if (!identifier(workspace, 4096) || !isAbsolute(workspace)) {
    throw new SessionStoreError("workspace_unavailable", "Select an existing absolute workspace directory.");
  }
  try {
    const realPath = await realpath(workspace);
    const stats = await lstat(realPath, { bigint: true });
    if (!stats.isDirectory()) throw new Error("Not a directory");
    return {
      realPath,
      fileIdentity: stats.ino > 0n ? { device: String(stats.dev), inode: String(stats.ino) } : null,
    };
  } catch {
    throw new SessionStoreError("workspace_unavailable", "The workspace directory is missing or unavailable. Restore it or start a new session in another workspace.");
  }
}

/** Local registration only. Native authentication and resume eligibility remain native. */
export class NativeSessionStore {
  readonly directory: string;
  readonly statePath: string;
  readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly now: () => Date;

  constructor(options: SessionStoreOptions = {}) {
    this.directory = resolve(options.directory ?? join(homedir(), ".ace", "sessions"));
    this.statePath = join(this.directory, "native-sessions.json");
    this.lockPath = join(this.directory, "native-sessions.lock");
    this.lockTimeoutMs = options.lockTimeoutMs ?? 1000;
    if (!Number.isFinite(this.lockTimeoutMs) || this.lockTimeoutMs < 0 || this.lockTimeoutMs > 10_000) {
      throw new Error("Lock timeout must be between 0 and 10000 milliseconds.");
    }
    this.now = options.now ?? (() => new Date());
  }

  async list(): Promise<NativeSessionRecord[]> {
    await this.ensureDirectory();
    return (await this.readDocument()).records;
  }

  /** Integration calls this only after a successful Ace-created adapter start. */
  async rememberCreatedSession(
    identity: NativeHarnessSessionIdentity,
    workspace: string,
    options: SessionRegistrationOptions = {},
  ): Promise<NativeSessionRecord> {
    if (!identifier(identity.adapterId, 64) || !identifier(identity.sessionId) || !identifier(identity.nativeSessionId)) {
      throw new SessionStoreError("invalid_identity", "A successful native session identity is required before registration.");
    }
    const registered = {
      adapterId: identity.adapterId,
      sessionId: identity.sessionId,
      nativeSessionId: identity.nativeSessionId,
    };
    const expectedWorkspace = options.expectedWorkspace && structuredClone(options.expectedWorkspace);
    if (expectedWorkspace && !validWorkspace(expectedWorkspace)) {
      throw new SessionStoreError("invalid_identity", "The expected workspace identity is invalid.");
    }
    checkAbort(options.signal);
    return this.withLock(options.signal, async () => {
      const canonicalWorkspace = await captureWorkspaceIdentity(workspace);
      if (expectedWorkspace && !sameWorkspace(expectedWorkspace, canonicalWorkspace)) {
        throw new SessionStoreError("identity_mismatch", "The workspace changed while the native session was opening. This session was not registered.");
      }
      const document = await this.readDocument();
      const existing = document.records.find((record) => key(record) === key(registered));
      if (existing && (existing.nativeSessionId !== registered.nativeSessionId || !sameWorkspace(existing.workspace, canonicalWorkspace))) {
        throw new SessionStoreError("identity_mismatch", "This Ace session is already registered to another native session or workspace.");
      }
      const now = this.now().toISOString();
      const record: NativeSessionRecord = {
        adapterId: registered.adapterId,
        sessionId: registered.sessionId,
        nativeSessionId: registered.nativeSessionId!,
        workspace: canonicalWorkspace,
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing && existing.updatedAt > now ? existing.updatedAt : now,
      };
      document.records = document.records.filter((item) => key(item) !== key(registered));
      document.records.push(record);
      if (document.records.length > MAX_RECORDS) {
        throw new SessionStoreError("state_limit", "The local session limit was reached. Forget an old registration before saving another session.");
      }
      checkAbort(options.signal);
      await this.writeDocument(document);
      return structuredClone(record);
    });
  }

  /** Called for an explicit user selection, before the native adapter resume call. */
  async resolveForResume(selection: {
    adapterId: string; sessionId: string; workspace: string;
  }): Promise<NativeSessionRecord> {
    const records = await this.list();
    const record = records.find((item) => key(item) === key(selection));
    if (!record) throw new SessionStoreError("record_not_found", "No locally registered session matches this adapter and Ace session.");
    const workspace = await captureWorkspaceIdentity(selection.workspace);
    if (!sameWorkspace(record.workspace, workspace)) {
      throw new SessionStoreError("identity_mismatch", "The workspace changed since this session was created. Select the original workspace or start a new session.");
    }
    return record;
  }

  async forget(selection: { adapterId: string; sessionId: string }, options: SessionStoreWriteOptions & { requireUnowned?: boolean } = {}): Promise<boolean> {
    return this.withLock(options.signal, async () => {
      const document = await this.readDocument();
      const previous = document.records.length;
      const selected = document.records.find((record) => key(record) === key(selection));
      if (selected && options.requireUnowned) {
        const ownership = await this.readOwner(this.ownerPath(selected));
        if (ownership.state === "active" || ownership.state === "unknown") {
          throw new SessionStoreError("session_busy", "Close or resolve the owning connection before forgetting this registration.");
        }
      }
      document.records = document.records.filter((record) => key(record) !== key(selection));
      if (document.records.length === previous) return false;
      checkAbort(options.signal);
      await this.writeDocument(document);
      return true;
    });
  }

  /** Explicit recovery only; backup bytes remain local and are never returned. */
  async quarantineCorruptState(options: SessionStoreWriteOptions = {}): Promise<{ backupPath: string }> {
    return this.withLock(options.signal, async () => {
      try {
        await this.readDocument();
      } catch (error) {
        if (!(error instanceof SessionStoreError) || !["corrupt_state", "unsupported_version"].includes(error.code)) throw error;
        checkAbort(options.signal);
        const backupPath = join(this.directory, `native-sessions.corrupt-${randomUUID()}.json`);
        await rename(this.statePath, backupPath);
        try {
          await this.writeDocument({ version: 1, records: [] });
        } catch (writeError) {
          await rename(backupPath, this.statePath);
          throw writeError;
        }
        return { backupPath };
      }
      throw new SessionStoreError("state_not_corrupt", "The session state is valid. Forget specific registrations instead of resetting it.");
    });
  }

  /** Cross-process local ownership coordinates managed Ace connections, not native grants. */
  async inspectOwnership(identity: NativeSessionKey): Promise<NativeSessionOwnerState> {
    await this.ensureDirectory();
    return (await this.readOwner(this.ownerPath(identity))).state;
  }

  async acquireOwnership(
    identity: NativeSessionKey,
    options: SessionStoreWriteOptions & { recoverStale?: boolean } = {},
  ): Promise<NativeSessionOwnership> {
    const path = this.ownerPath(identity);
    const owner: SessionOwner = { version: 1, pid: process.pid, nonce: randomUUID() };
    let established: NativeSessionOwnership | undefined;
    try {
      return await this.withLock(options.signal, async () => {
        const existing = await this.readOwner(path);
        if (existing.state === "active") throw new SessionStoreError("session_busy", "Another Ace connection owns this native session. Close that connection before resuming.", path);
        if (existing.state === "unknown") throw new SessionStoreError("unknown_session_owner", "The native session owner is unknown. Inspect its private owner file; do not remove an active or unknown owner.", path);
        if (existing.state === "stale") {
          if (!options.recoverStale) throw new SessionStoreError("stale_session_owner", "The previous native session owner exited. Select this saved session explicitly to recover its ownership and resume.", path);
          // All cooperating owner changes require this same write lock. No TTL stealing.
          await unlink(path);
        }
        checkAbort(options.signal);
        let file: FileHandle | undefined;
        let created = false;
        try {
          file = await open(path, "wx", 0o600);
          created = true;
          await file.writeFile(JSON.stringify(owner), "utf8");
          await file.sync();
          await file.close();
          file = undefined;
          checkAbort(options.signal);
        } catch {
          await file?.close().catch(() => {});
          if (created) await unlink(path).catch(() => {});
          checkAbort(options.signal);
          throw new SessionStoreError("storage_error", "Could not establish private native session ownership.", path);
        }
        let released = false;
        let releasing: Promise<void> | undefined;
        established = {
          release: () => {
            if (released) return Promise.resolve();
            if (releasing) return releasing;
            releasing = this.withLock(undefined, async () => {
              const current = await this.readOwner(path);
              if (current.state === "available") { released = true; return; }
              if (current.owner?.pid !== owner.pid || current.owner.nonce !== owner.nonce) {
                throw new SessionStoreError("ownership_lost", "Native session ownership changed. Another owner's file was left untouched.", path);
              }
              await unlink(path);
              released = true;
            }).finally(() => { releasing = undefined; });
            return releasing;
          },
        };
        return established;
      });
    } catch (error) {
      if (established && error instanceof SessionStoreError && error.code === "lock_cleanup_failed") {
        established.warning = error;
        return established; // Preserve the handle for an owner that was already committed.
      }
      throw error;
    }
  }

  private ownerPath(identity: NativeSessionKey): string {
    if (!identifier(identity.adapterId, 64) || !identifier(identity.nativeSessionId)) {
      throw new SessionStoreError("invalid_identity", "A provider and native session identity are required for local ownership.");
    }
    const hash = createHash("sha256").update(`${identity.adapterId}\0${identity.nativeSessionId}`).digest("hex");
    return join(this.directory, `native-owner-${hash}.json`);
  }

  private async readOwner(path: string): Promise<{ state: NativeSessionOwnerState; owner?: SessionOwner }> {
    let content: string | null;
    try { content = await this.readPrivateFile(path, 1024); }
    catch (error) {
      if (error instanceof SessionStoreError && error.code === "corrupt_state") return { state: "unknown" };
      throw error;
    }
    if (content === null) return { state: "available" };
    let value: unknown;
    try { value = JSON.parse(content); } catch { return { state: "unknown" }; }
    if (!object(value) || !exactKeys(value, ["version", "pid", "nonce"]) || value.version !== 1 ||
        !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || !identifier(value.nonce, 128)) {
      return { state: "unknown" };
    }
    const owner = value as unknown as SessionOwner;
    try { process.kill(owner.pid, 0); return { state: "active", owner }; }
    catch (error) { return { state: errorCode(error) === "ESRCH" ? "stale" : "unknown", owner }; }
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      checkPrivate(await lstat(this.directory, { bigint: true }), true);
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      throw new SessionStoreError("unsafe_storage", "Cannot use the session state directory. Check that it is an owned private directory, not a symlink.");
    }
  }

  private async readPrivateFile(path: string, limit: number, allowReplacedFile = false): Promise<string | null> {
    let file: FileHandle | undefined;
    try {
      checkPrivate(await lstat(path, { bigint: true }), false);
      // O_NOFOLLOW protects symlink replacement; nonblocking open also avoids FIFO hangs.
      file = await open(path, constants.O_RDONLY | NO_FOLLOW | (constants.O_NONBLOCK || 0));
      const stats = await file.stat({ bigint: true });
      checkPrivate(stats, false, allowReplacedFile);
      if (stats.size > BigInt(limit)) throw new SessionStoreError("corrupt_state", "Session state exceeds its allowed size. Quarantine it before creating new registrations.");
      const buffer = Buffer.alloc(limit + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > limit) throw new SessionStoreError("corrupt_state", "Session state exceeds its allowed size.");
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
      } catch {
        throw new SessionStoreError("corrupt_state", "Session state is not valid UTF-8. Quarantine it before saving new registrations.");
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      if (error instanceof SessionStoreError) throw error;
      if (["ELOOP", "EMLINK"].includes(errorCode(error) ?? "")) {
        throw new SessionStoreError("unsafe_storage", "Session state cannot be a symbolic link.");
      }
      throw new SessionStoreError("storage_error", "Cannot read session state. Check its file permissions.");
    } finally {
      await file?.close();
    }
  }

  private async readDocument(): Promise<SessionDocument> {
    const content = await this.readPrivateFile(this.statePath, MAX_BYTES, true);
    if (content === null) return { version: 1, records: [] };
    let value: unknown;
    try { value = JSON.parse(content); } catch {
      throw new SessionStoreError("corrupt_state", "Session state is not valid JSON. Quarantine it before saving new registrations.");
    }
    if (object(value) && "version" in value && value.version !== 1) {
      throw new SessionStoreError("unsupported_version", "Session state uses an unsupported version. Use a compatible Ace version or explicitly quarantine it.");
    }
    if (!object(value) || !exactKeys(value, ["version", "records"]) || value.version !== 1 ||
        !Array.isArray(value.records) || value.records.length > MAX_RECORDS || !value.records.every(validRecord) ||
        new Set(value.records.map(key)).size !== value.records.length) {
      throw new SessionStoreError("corrupt_state", "Session state contains invalid or unexpected records. Quarantine it before saving new registrations.");
    }
    return value as unknown as SessionDocument;
  }

  private async writeDocument(document: SessionDocument): Promise<void> {
    document.records.sort((a, b) => key(a).localeCompare(key(b)));
    const data = JSON.stringify(document) + "\n";
    if (Buffer.byteLength(data) > MAX_BYTES) throw new SessionStoreError("state_limit", "The local session state size limit was reached.");
    const temporaryPath = join(this.directory, `.native-sessions-${randomUUID()}.tmp`);
    let file: FileHandle | undefined;
    let created = false;
    try {
      file = await open(temporaryPath, "wx", 0o600);
      created = true;
      await file.writeFile(data, "utf8");
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporaryPath, this.statePath);
      created = false;
      // Some platforms do not support opening/fsyncing a directory.
      let directory: FileHandle | undefined;
      try { directory = await open(this.directory, "r"); await directory.sync(); }
      catch { /* File was flushed and atomically replaced; directory sync is best effort. */ }
      finally { await directory?.close(); }
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      throw new SessionStoreError("storage_error", "Could not save the local session registration. Existing state has been retained when replacement did not complete.");
    } finally {
      await file?.close();
      if (created) await unlink(temporaryPath).catch(() => {});
    }
  }

  private async withLock<T>(signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    checkAbort(signal);
    await this.ensureDirectory();
    const started = Date.now();
    const owner = { pid: process.pid, nonce: randomUUID() };
    let acquired = false;
    while (!acquired) {
      checkAbort(signal);
      let file: FileHandle | undefined;
      try {
        file = await open(this.lockPath, "wx", 0o600);
        acquired = true;
        await file.writeFile(JSON.stringify(owner), "utf8");
        await file.sync();
        await file.close();
        file = undefined;
      } catch (error) {
        if (acquired) {
          await file?.close().catch(() => {});
          file = undefined;
          await unlink(this.lockPath).catch(() => {});
          throw new SessionStoreError("storage_error", "Could not establish the session state write lock.");
        }
        if (errorCode(error) !== "EEXIST") throw new SessionStoreError("storage_error", "Cannot acquire the session state write lock.");
        await this.checkLockOwner();
        if (Date.now() - started >= this.lockTimeoutMs) {
          throw new SessionStoreError("store_busy", "Another or unknown writer owns the session state lock. Retry after it exits; do not remove an active lock.", this.lockPath);
        }
        try { await delay(Math.min(25, this.lockTimeoutMs), undefined, { signal }); }
        catch { checkAbort(signal); }
      } finally {
        await file?.close().catch(() => {});
      }
    }
    let actionFailed = false;
    try {
      checkAbort(signal);
      return await action();
    } catch (error) {
      actionFailed = true;
      throw error;
    } finally {
      try {
        const current = await this.readPrivateFile(this.lockPath, 1024);
        let matches = false;
        try { const value = JSON.parse(current ?? "null"); matches = value?.pid === owner.pid && value?.nonce === owner.nonce; }
        catch { /* Do not remove a lock that no longer has this writer's identity. */ }
        if (!matches) throw new Error("Lock ownership changed");
        await unlink(this.lockPath);
      } catch {
        // Preserve the primary error. A successful write may already be durable.
        if (!actionFailed) {
          throw new SessionStoreError("lock_cleanup_failed",
            "The state operation completed, but its write lock could not be released. Inspect saved registrations before retrying; do not repeat native session operations.",
            this.lockPath);
        }
      }
    }
  }

  private async checkLockOwner(): Promise<void> {
    let content: string | null;
    try { content = await this.readPrivateFile(this.lockPath, 1024); }
    catch (error) {
      if (error instanceof SessionStoreError && error.code === "unsafe_storage") throw error;
      return; // A partial/unknown lock never authorizes lock removal.
    }
    let owner: unknown;
    try { owner = JSON.parse(content ?? "null"); } catch { return; }
    if (!object(owner) || !exactKeys(owner, ["pid", "nonce"]) || !Number.isSafeInteger(owner.pid) ||
        (owner.pid as number) <= 0 || !identifier(owner.nonce, 128)) return;
    try { process.kill(owner.pid as number, 0); }
    catch (error) {
      if (errorCode(error) === "ESRCH") {
        throw new SessionStoreError("stale_lock", "The previous session-state writer is no longer running. Confirm no writer is active, remove this stale lock file, and retry.", this.lockPath);
      }
    }
  }
}
