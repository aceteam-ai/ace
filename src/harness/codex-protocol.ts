import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** Offline protocol evidence: codex app-server generate-ts, CLI 0.153.4, v2. */
export const TESTED_CODEX_VERSION = "0.153.4";

export type CodexProcessFactory = (
  executable: string,
  args: readonly string[],
  workspace: string
) => ChildProcessWithoutNullStreams;

export const spawnCodex: CodexProcessFactory = (executable, args, cwd) =>
  spawn(executable, [...args], { cwd, stdio: "pipe", shell: false });

export type RpcId = string | number;
export type JsonObject = Record<string, unknown>;

export function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rpcId(value: unknown): value is RpcId {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value));
}

export class CodexError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: JsonObject
  ) {
    super(message);
  }
}

export function asCodexError(error: unknown): CodexError {
  if (error instanceof CodexError) return error;
  if (object(error) && error.code === "ENOENT") {
    return new CodexError("codex_not_installed", "Install Codex CLI 0.153.4 and ensure codex is on PATH.");
  }
  return new CodexError("codex_process_error", "Codex could not run. Check the executable and workspace.");
}

/** Bounded shutdown of the one child we own. Never signals other Codex processes. */
export function stopChild(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(killTimer);
      clearTimeout(endTimer);
      child.removeListener("close", finish);
      resolve();
    };
    const killTimer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const endTimer = setTimeout(finish, timeoutMs * 2);
    child.once("close", finish);
    child.stdin.destroy();
    child.kill("SIGTERM");
  });
}

export async function checkCodexVersion(
  factory: CodexProcessFactory,
  executable: string,
  workspace: string,
  timeoutMs: number,
  shutdownTimeoutMs: number,
  onChild: (child: ChildProcessWithoutNullStreams) => void
): Promise<void> {
  const child = factory(executable, ["--version"], workspace);
  onChild(child);
  try {
    const version = await new Promise<string>((resolve, reject) => {
      let output = "";
      let settled = false;
      const finish = (error?: CodexError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(output.trim());
      };
      const timer = setTimeout(() => finish(new CodexError("codex_timeout", "Codex version check timed out.")), timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        output += chunk.toString("utf8");
        if (output.length > 4096) finish(new CodexError("incompatible_codex", "Codex returned an invalid version response."));
      });
      child.stderr.resume(); // Do not retain or expose native stderr or account data.
      child.on("error", (error) => finish(asCodexError(error)));
      child.stdin.on("error", (error) => finish(asCodexError(error)));
      child.stdout.on("error", (error) => finish(asCodexError(error)));
      child.stderr.on("error", (error) => finish(asCodexError(error)));
      child.once("close", (code) => finish(code === 0 ? undefined :
        new CodexError("codex_startup_failed", "Codex version check failed. Check the installation.")));
    });
    if (version !== `codex-cli ${TESTED_CODEX_VERSION}`) {
      throw new CodexError("incompatible_codex", `This adapter requires tested Codex CLI ${TESTED_CODEX_VERSION}. Other versions need protocol validation before use.`);
    }
  } finally {
    await stopChild(child, shutdownTimeoutMs);
  }
}

export interface CodexRpcCall {
  result: Promise<JsonObject>;
  readonly completedFromNative: boolean;
  /** Settle only when correlated native evidence establishes this request's outcome. */
  completeFromNative(result: JsonObject): void;
}

interface PendingRpc {
  resolve: (value: JsonObject) => void;
  reject: (error: CodexError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Private newline-delimited stdio transport; no sockets, shell, retries, or auth overrides. */
export class CodexRpc {
  private readonly pending = new Map<RpcId, PendingRpc>();
  private readonly retired = new Set<RpcId>();
  private readonly decoder = new StringDecoder("utf8");
  private readonly writes = new Set<{ reject: (error: CodexError) => void; resolve: () => void; clientRequestId?: RpcId; timer: ReturnType<typeof setTimeout> }>();
  private buffer = "";
  private nextId = 0;
  private ended = false;
  private stopping?: Promise<void>;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
    private readonly shutdownTimeoutMs: number,
    private readonly onMessage: (method: string, params: JsonObject, id?: RpcId) => void,
    private readonly onFailure: (error: CodexError) => void
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.read(this.decoder.write(chunk)));
    child.stderr.resume();
    child.on("error", (error) => this.fail(asCodexError(error)));
    child.stdin.on("error", () => this.fail(new CodexError("codex_disconnected", "Codex input closed. Start a new session.")));
    child.stdout.on("error", () => this.fail(new CodexError("codex_disconnected", "Codex output closed. Start a new session.")));
    child.stderr.on("error", () => this.fail(new CodexError("codex_disconnected", "Codex process stream failed. Start a new session.")));
    child.stdout.once("end", () => {
      if (!this.ended) this.fail(new CodexError("codex_disconnected", "Codex output ended before the session closed.", { truncatedMessage: this.buffer.length > 0 }));
    });
    child.once("close", (exitCode, signal) => this.fail(new CodexError(
      "codex_process_exit", "Codex exited before the session completed. Start a new session.", { exitCode, signal }
    )));
  }

  request(method: string, params: JsonObject): Promise<JsonObject> {
    return this.beginRequest(method, params).result;
  }

  beginRequest(method: string, params: JsonObject): CodexRpcCall {
    const id = `ace-${++this.nextId}`;
    let completedFromNative = false;
    const result = new Promise<JsonObject>((resolve, reject) => {
      if (this.ended) { reject(new CodexError("codex_disconnected", "Codex is disconnected.")); return; }
      const timer = setTimeout(() => this.fail(new CodexError("codex_timeout", `Codex did not answer ${method}. The outcome is unknown; start a new session.`)), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.send({ id, method, params }, id).catch((error) => this.fail(asCodexError(error)));
    });
    return {
      result,
      get completedFromNative() { return completedFromNative; },
      completeFromNative: (value) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        completedFromNative = true;
        this.settleRequestWrite(id);
        clearTimeout(pending.timer);
        this.pending.delete(id);
        this.retired.add(id);
        pending.resolve(value);
      },
    };
  }

  send(message: JsonObject, clientRequestId?: RpcId): Promise<void> {
    if (this.ended) return Promise.reject(new CodexError("codex_disconnected", "Codex is disconnected."));
    return new Promise((resolve, reject) => {
      const write = {
        reject, resolve, clientRequestId,
        timer: setTimeout(() => this.fail(new CodexError("codex_timeout", "Codex write timed out. The outcome is unknown; start a new session.")), this.timeoutMs),
      };
      this.writes.add(write);
      try {
        this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (!this.writes.has(write)) return;
          if (error) {
            this.fail(new CodexError("codex_disconnected", "Could not send to Codex. The outcome is unknown; start a new session."));
          } else {
            clearTimeout(write.timer);
            this.writes.delete(write);
            resolve();
          }
        });
      } catch {
        this.fail(new CodexError("codex_disconnected", "Could not write to Codex. The outcome is unknown; start a new session."));
      }
    });
  }

  close(): Promise<void> {
    if (!this.stopping) {
      this.ended = true;
      this.rejectPending(new CodexError("codex_disconnected", "The Codex session has closed."));
      this.stopping = stopChild(this.child, this.shutdownTimeoutMs);
    }
    return this.stopping;
  }

  private fail(error: CodexError): void {
    if (this.ended) return;
    this.ended = true;
    this.rejectPending(error);
    this.onFailure(error);
    void this.close();
  }

  private rejectPending(error: CodexError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const write of this.writes) {
      clearTimeout(write.timer);
      write.reject(error);
    }
    this.writes.clear();
  }

  private settleRequestWrite(id: RpcId): void {
    // A correlated native response/outcome proves the request bytes reached Codex.
    for (const write of this.writes) {
      if (write.clientRequestId === id) {
        clearTimeout(write.timer);
        this.writes.delete(write);
        write.resolve();
      }
    }
  }

  private read(chunk: string): void {
    if (this.ended) return;
    this.buffer += chunk;
    let end: number;
    while (!this.ended && (end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > 1024 * 1024) {
        this.fail(new CodexError("codex_malformed_message", "Codex exceeded the 1 MiB protocol frame limit."));
        return;
      }
      if (line.trim().length === 0) continue;
      try {
        this.message(JSON.parse(line));
      } catch (error) {
        this.fail(error instanceof CodexError ? error : new CodexError("codex_malformed_message", "Codex returned a malformed protocol message."));
      }
    }
    if (Buffer.byteLength(this.buffer) > 1024 * 1024) {
      this.fail(new CodexError("codex_malformed_message", "Codex exceeded the 1 MiB protocol frame limit."));
    }
  }

  private message(value: unknown): void {
    if (!object(value) || ("jsonrpc" in value && value.jsonrpc !== "2.0")) throw new CodexError("codex_malformed_message", "Invalid Codex protocol envelope.");
    if (typeof value.method === "string") {
      if (!object(value.params) || "result" in value || "error" in value || ("id" in value && !rpcId(value.id))) {
        throw new CodexError("codex_malformed_message", "Invalid Codex request or notification.");
      }
      this.onMessage(value.method, value.params, value.id as RpcId | undefined);
      return;
    }
    if (!rpcId(value.id) || ("result" in value) === ("error" in value)) throw new CodexError("codex_malformed_message", "Invalid Codex response.");
    // A proven native turn outcome may precede this response. Never let it alter a later turn.
    if (this.retired.has(value.id)) return;
    const pending = this.pending.get(value.id);
    if (!pending) throw new CodexError("codex_malformed_message", "Codex replied to an unknown request.");
    if ("error" in value) {
      if (!object(value.error) || typeof value.error.message !== "string" || typeof value.error.code !== "number") {
        throw new CodexError("codex_malformed_message", "Invalid Codex error response.");
      }
      this.settleRequestWrite(value.id);
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      pending.reject(new CodexError(value.error.code === -32601 || value.error.code === -32602 ? "incompatible_codex_protocol" : "codex_request_failed", value.error.message, { rpcError: value.error }));
    } else {
      if (!object(value.result)) throw new CodexError("codex_malformed_message", "Invalid Codex result.");
      this.settleRequestWrite(value.id);
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      pending.resolve(value.result);
    }
  }
}
