import { vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

/**
 * Create a mock child process that emits events.
 */
export function createMockProcess(options?: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;

  const mockStdout = new Readable({ read() {} });
  const mockStderr = new Readable({ read() {} });

  proc.stdout = mockStdout as ChildProcess["stdout"];
  proc.stderr = mockStderr as ChildProcess["stderr"];
  proc.stdin = null;
  proc.pid = 12345;
  proc.killed = false;
  proc.connected = false;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.spawnargs = [];
  proc.spawnfile = "";
  proc.kill = vi.fn();
  proc.send = vi.fn();
  proc.disconnect = vi.fn();
  proc.unref = vi.fn();
  proc.ref = vi.fn();
  proc[Symbol.dispose] = vi.fn();

  // Schedule data/close events
  setTimeout(() => {
    if (options?.stdout) {
      mockStdout.push(options.stdout);
    }
    mockStdout.push(null);

    if (options?.stderr) {
      mockStderr.push(options.stderr);
    }
    mockStderr.push(null);

    proc.emit("close", options?.exitCode ?? 0);
  }, 0);

  return proc;
}

/**
 * Create a mock fetch response.
 */
export function createMockResponse(options: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
  text?: string;
}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    json: () => Promise.resolve(options.body ?? {}),
    text: () => Promise.resolve(options.text ?? JSON.stringify(options.body ?? {})),
    headers: new Headers(),
    redirected: false,
    type: "basic",
    url: "",
    clone: vi.fn(),
    body: null,
    bodyUsed: false,
    arrayBuffer: vi.fn(),
    blob: vi.fn(),
    formData: vi.fn(),
    bytes: vi.fn(),
  } as unknown as Response;
}
