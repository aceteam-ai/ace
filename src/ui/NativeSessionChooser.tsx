import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import wrapAnsi from "wrap-ansi";
import { NativeSessionManager, type SessionCandidate } from "../harness/session-manager.js";
import { SessionStoreError, type NativeSessionRecord } from "../harness/session-store.js";
import { nativeInlineText, nativeText } from "./native-session-state.js";

interface Props {
  manager: NativeSessionManager;
  adapterId: string;
  workspace: string;
  start: () => void;
  resume: (record: NativeSessionRecord) => void;
  back: () => void;
  runLocalOperation: <T>(action: () => Promise<T>) => Promise<T>;
}
type Problem = { code: string; message: string };
function problem(error: unknown): Problem {
  return error instanceof SessionStoreError ? { code: error.code, message: `${error.message}${error.recoveryPath ? ` Recovery path: ${error.recoveryPath}` : ""}` }
    : { code: "storage_error", message: "Saved sessions could not be read. Check local session storage and try again." };
}

/** Local registration browser. Native inspection occurs only after explicit resume. */
export function NativeSessionChooser({ manager, adapterId, workspace, start, resume, back, runLocalOperation }: Props): React.JSX.Element {
  const [route, setRoute] = useState<"action" | "saved" | "confirm-forget" | "confirm-recovery" | "details">("action");
  const [action, setAction] = useState(0);
  const [selected, setSelected] = useState(0);
  const [candidates, setCandidates] = useState<SessionCandidate[]>([]);
  const [error, setError] = useState<Problem>();
  const [notice, setNotice] = useState<string>();
  const [details, setDetails] = useState("");
  const [detailScroll, setDetailScroll] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<NativeSessionRecord>();
  const active = useRef(true); const generation = useRef(0); const pending = useRef(false);
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
  useEffect(() => {
    active.current = true;
    const resize = () => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", resize);
    return () => { active.current = false; ++generation.current; stdout.removeListener("resize", resize); };
  }, [stdout]);
  const tooSmall = size.columns < 40 || size.rows < 24;
  const candidate = candidates[selected];
  const rows = Math.max(1, Math.min(8, size.rows - 16));
  const offset = Math.min(Math.max(0, selected - rows + 1), Math.max(0, candidates.length - rows));
  const detailPage = Math.max(1, size.rows - 9);
  const detailLines = wrapAnsi(nativeText(details).replace(/\t/g, "    "), Math.max(1, size.columns - (size.columns > 40 ? 4 : 0)), { hard: true, trim: false }).split("\n");
  const detailOffset = Math.min(detailScroll, Math.max(0, detailLines.length - detailPage));
  const canRecover = error?.code === "corrupt_state" || error?.code === "unsupported_version";
  const canForget = candidate && candidate.ownership !== "active" && candidate.ownership !== "unknown";

  const list = async (keepNotice = false) => {
    if (pending.current) return;
    pending.current = true; const request = ++generation.current;
    setBusy(true); setError(undefined); if (!keepNotice) setNotice(undefined);
    try {
      const entries = await runLocalOperation(() => manager.listCandidates(workspace));
      if (active.current && request === generation.current) {
        setCandidates(entries.map((entry) => entry.record.adapterId === adapterId ? entry : { ...entry, eligible: false, reason: "Choose the native provider that created this registration." }));
        setSelected(0);
      }
    } catch (error) { if (active.current && request === generation.current) { setError(problem(error)); setCandidates([]); } }
    finally { pending.current = false; if (active.current && request === generation.current) setBusy(false); }
  };
  const mutate = async (action: () => Promise<string>) => {
    if (pending.current) return;
    pending.current = true; const request = ++generation.current; setBusy(true); setNotice(undefined);
    try { const result = await runLocalOperation(action); if (active.current && request === generation.current) { setNotice(result); setError(undefined); } }
    catch (error) { if (active.current && request === generation.current) setNotice(problem(error).message); }
    finally {
      pending.current = false;
      if (active.current && request === generation.current) { setBusy(false); setRoute("saved"); setConfirmation(undefined); void list(true); }
    }
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") return;
    if (tooSmall) { if (key.escape || input === "q") back(); return; }
    if (busy || pending.current) return; // A confirmed local mutation finishes before another action can be selected.
    if (key.escape || input === "q") {
      if (route === "action") back(); else { setRoute(route === "details" ? "saved" : "action"); setConfirmation(undefined); }
      return;
    }
    if (route === "details") {
      if (key.pageDown || key.downArrow) setDetailScroll(Math.min(Math.max(0, detailLines.length - detailPage), detailOffset + (key.pageDown ? detailPage : 1)));
      if (key.pageUp || key.upArrow) setDetailScroll(Math.max(0, detailOffset - (key.pageUp ? detailPage : 1)));
      if (input === "d" || key.return) setRoute("saved");
      return;
    }
    if (route === "action") {
      if (key.upArrow || key.downArrow || input === "j" || input === "k") setAction((value) => 1 - value);
      if (key.return) {
        if (action === 0) start();
        else { setRoute("saved"); void list(); }
      }
      return;
    }
    if (route === "confirm-forget" || route === "confirm-recovery") {
      // Confirmation is a separate explicit keystroke; Enter never accepts a default destructive choice.
      if (input === "y") {
        if (route === "confirm-forget" && confirmation) {
          const selection = { adapterId: confirmation.adapterId, sessionId: confirmation.sessionId };
          void mutate(async () => await manager.forget(selection) ? "Local registration forgotten. Native history was not deleted." : "This local registration was already absent.");
        } else if (route === "confirm-recovery" && canRecover) {
          void mutate(async () => `Saved-session state recovered. Private backup: ${(await manager.quarantineCorruptState()).backupPath}`);
        }
      }
      if (input === "n") { setRoute("saved"); setConfirmation(undefined); }
      return;
    }
    if (input === "d") {
      setDetails([error?.message, notice, candidate ? `Provider: ${candidate.record.adapterId}\nNative session: ${candidate.record.nativeSessionId}\nLocal registration: ${candidate.record.sessionId}\nWorkspace: ${candidate.record.workspace.realPath}\nSaved: ${candidate.record.updatedAt}\n${candidate.reason ?? "Native history, sign-in, and version are checked on explicit resume."}` : undefined].filter(Boolean).join("\n\n") || "No additional local details.");
      setDetailScroll(0); setRoute("details"); return;
    }
    if (input === "r") { void list(); return; }
    if (input === "c" && canRecover) { setRoute("confirm-recovery"); return; }
    if ((key.upArrow || input === "k") && candidates.length) setSelected((index) => Math.max(0, index - 1));
    if ((key.downArrow || input === "j") && candidates.length) setSelected((index) => Math.min(candidates.length - 1, index + 1));
    if (input === "f" && canForget) { setConfirmation({ ...candidate.record }); setRoute("confirm-forget"); return; }
    if (key.return && candidate) {
      if (candidate.eligible) resume({ ...candidate.record });
      else setNotice(candidate.reason ?? "This registration cannot be resumed.");
    }
  });

  if (tooSmall) return <Box flexDirection="column"><Text bold>Saved native sessions</Text><Text wrap="truncate-end">Resize to at least 40 columns × 24 rows.</Text><Text wrap="truncate-end">Actions paused. Esc Back  Ctrl+C Exit</Text></Box>;
  if (route === "details") return <Box flexDirection="column"><Text bold>Saved-session details</Text>
    <Box flexDirection="column" height={detailPage}>{detailLines.slice(detailOffset, detailOffset + detailPage).map((line, index) => <Text key={index} wrap="truncate-end">{line || " "}</Text>)}</Box>
    <Text dimColor>Lines {detailOffset + 1}–{Math.min(detailLines.length, detailOffset + detailPage)} of {detailLines.length}</Text>
    <Text dimColor wrap="truncate-end">↑↓ Scroll  PgUp/PgDn Page  Esc Back</Text></Box>;
  if (route === "action") return <Box flexDirection="column">
    <Text bold>Open a native session</Text><Text wrap="truncate-middle">Workspace: {nativeInlineText(workspace)}</Text>
    <Text color={action === 0 ? "cyan" : undefined}>{action === 0 ? "❯" : " "} Start new session</Text>
    <Text color={action === 1 ? "cyan" : undefined}>{action === 1 ? "❯" : " "} Resume saved session</Text>
    <Text dimColor wrap="truncate-end">↑↓ Choose  Enter Open  Esc Back</Text>
  </Box>;
  if (route === "confirm-forget" || route === "confirm-recovery") return <Box flexDirection="column">
    <Text bold>{route === "confirm-forget" ? "Forget this local registration?" : "Recover saved-session storage?"}</Text>
    <Text wrap="truncate-middle">{route === "confirm-forget" ? nativeInlineText(confirmation?.nativeSessionId) : "Move corrupt or unsupported state to a private backup."}</Text>
    <Text wrap="truncate-end">{route === "confirm-forget" ? "Native history remains with its provider." : "An empty registration list will replace the saved file."}</Text>
    <Text dimColor>{busy ? "Finishing local storage operation…" : "y Confirm  n Cancel  Esc Back"}</Text>
  </Box>;
  return <Box flexDirection="column">
    <Text bold>Saved native sessions</Text><Text wrap="truncate-middle">Workspace: {nativeInlineText(workspace)}</Text>
    <Text dimColor wrap="truncate-end">Local registrations only. Enter explicitly resumes.</Text>
    {busy && <Text>Reading local registrations…</Text>}
    {!busy && !error && candidates.length === 0 && <Text>No saved sessions. Start a new session to register it.</Text>}
    {candidates.slice(offset, offset + rows).map((entry, index) => <Text key={`${entry.record.adapterId}:${entry.record.sessionId}`} color={offset + index === selected ? "cyan" : undefined} wrap="truncate-middle">
      {offset + index === selected ? "❯" : " "} {nativeInlineText(entry.record.adapterId)} · {nativeInlineText(entry.record.nativeSessionId)} · {entry.eligible ? "Available" : "Unavailable"}
    </Text>)}
    {candidate && <><Text wrap="truncate-end">Saved: {nativeInlineText(candidate.record.updatedAt)} · {selected + 1}/{candidates.length}</Text>
      <Text wrap="truncate-middle">{nativeInlineText(candidate.record.workspace.realPath)}</Text>
      <Text wrap="truncate-end">{nativeInlineText(candidate.reason ?? "Native history, sign-in, and version are checked on resume.")}</Text></>}
    {error && <Text color="yellow" wrap="truncate-end">{nativeInlineText(error.message)}</Text>}
    {notice && <Text color="yellow" wrap="truncate-end">{nativeInlineText(notice)}</Text>}
    {canRecover && <Text color="yellow" wrap="truncate-end">c Recover corrupt state into a private backup</Text>}
    <Text dimColor wrap="truncate-end">↑↓ Select  Enter Resume  d Details  r Refresh{canForget ? "  f Forget" : ""}  Esc Back</Text>
  </Box>;
}
