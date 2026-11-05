import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { captureWorkspaceIdentity, type WorkspaceIdentity } from "./session-store.js";

const MAX_FILE = 64 * 1024;
export interface HandoffArtifact { readonly path: string; readonly label?: string }
export interface HandoffReview {
  readonly target: Readonly<{ adapterId: "codex" | "claude"; workspace: string }>;
  readonly workspaceIdentity: Readonly<WorkspaceIdentity>;
  readonly summary: string;
  readonly artifacts: readonly HandoffArtifact[];
  /** This immutable text is displayed in full and submitted unchanged after explicit confirmation. */
  readonly input: string;
}
export class HandoffError extends Error {
  constructor(message: string) { super(message); this.name = "HandoffError"; }
}
function invalid(message: string): never { throw new HandoffError(message); }
function object(value: unknown, fields: string[], required = fields): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Handoff fields must use the documented JSON object format.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !fields.includes(key)) || required.some((key) => !Object.hasOwn(record, key))) {
    return invalid("The handoff contains unknown or missing fields. Only summary, artifact references, and the target are supported.");
  }
  return record;
}
function text(value: unknown, limit: number, multiline = false): string {
  if (typeof value !== "string") return invalid("Handoff text fields must be strings.");
  if (!multiline && /[\r\n\t]/u.test(value)) return invalid("Handoff names and paths must fit on one line.");
  const normalized = value.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  // Reject control/hidden-direction bytes rather than displaying one value and submitting another.
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}|\p{Cs}/u.test(normalized) ||
      (!multiline && /[\n\t]/u.test(normalized))) return invalid("Handoff text contains unsupported terminal or hidden control characters.");
  if (!normalized.trim() || Buffer.byteLength(normalized, "utf8") > limit) return invalid("A handoff text field is empty or exceeds its documented size limit.");
  return normalized;
}

/** Reads only this envelope. Artifact references never cause reads, network requests, or execution. */
export async function loadHandoffReview(path: string): Promise<HandoffReview> {
  let raw: string;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.size > MAX_FILE) return invalid("Choose a regular handoff JSON file no larger than 64 KiB.");
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const current = await file.stat();
      if (!current.isFile() || current.size > MAX_FILE || current.dev !== before.dev || current.ino !== before.ino) return invalid("The handoff file changed while it was being opened. Review it again.");
      const bytes = Buffer.alloc(MAX_FILE + 1); let total = 0;
      while (total < bytes.length) {
        const read = await file.read(bytes, total, bytes.length - total, null);
        if (!read.bytesRead) break;
        total += read.bytesRead;
      }
      if (total > MAX_FILE) return invalid("The handoff file exceeds 64 KiB.");
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof HandoffError) throw error;
    return invalid("The handoff file could not be read as a bounded UTF-8 JSON file.");
  }
  return parseHandoffReview(raw);
}

export async function parseHandoffReview(raw: string): Promise<HandoffReview> {
  if (Buffer.byteLength(raw, "utf8") > MAX_FILE) return invalid("The handoff file exceeds 64 KiB.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return invalid("The handoff is not valid JSON."); }
  const envelope = object(value, ["version", "summary", "artifacts", "target"]);
  if (envelope.version !== 1) return invalid("This handoff version is unsupported. Use version 1.");
  const summary = text(envelope.summary, 16 * 1024, true);
  const target = object(envelope.target, ["adapterId", "workspace"]);
  if (target.adapterId !== "codex" && target.adapterId !== "claude") return invalid("Choose Codex or Claude Agent as the handoff target.");
  const workspace = text(target.workspace, 4096);
  if (!isAbsolute(workspace)) return invalid("The handoff target workspace must be an absolute local directory.");
  if (!Array.isArray(envelope.artifacts) || envelope.artifacts.length > 32) return invalid("A handoff supports at most 32 artifact references.");
  const artifacts = envelope.artifacts.map((value): HandoffArtifact => {
    const entry = object(value, ["path", "label"], ["path"]);
    const path = text(entry.path, 1024);
    if (isAbsolute(path) || path.includes("\\") || path.includes(":") || path.split("/").some((part) => !part || part === "." || part === "..")) {
      return invalid("Artifact references must be relative workspace paths without traversal or URLs.");
    }
    return Object.freeze({ path, ...(entry.label === undefined ? {} : { label: text(entry.label, 256) }) });
  });
  let workspaceIdentity: WorkspaceIdentity;
  try { workspaceIdentity = await captureWorkspaceIdentity(workspace); }
  catch { return invalid("The handoff target workspace must be an existing readable directory."); }
  // The resolved workspace is also reviewed, so symlink spelling cannot conceal the actual target.
  const canonicalWorkspace = text(workspaceIdentity.realPath, 4096);
  const input = `Handoff summary\n${summary}\n\nArtifact references\n${artifacts.length
    ? artifacts.map((entry) => `${entry.path}${entry.label ? ` - ${entry.label}` : ""}`).join("\n") : "(none)"}`;
  return Object.freeze({ target: Object.freeze({ adapterId: target.adapterId, workspace: canonicalWorkspace }),
    workspaceIdentity: Object.freeze({ ...workspaceIdentity }), summary, artifacts: Object.freeze(artifacts), input });
}
