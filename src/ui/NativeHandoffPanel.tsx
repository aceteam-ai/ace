import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import wrapAnsi from "wrap-ansi";
import { HandoffError, loadHandoffReview, type HandoffReview } from "../harness/handoff.js";
import type { NativeWorkspaceController } from "./native-workspace-controller.js";
import { nativeInlineText, nativeProviderLabel } from "./native-session-state.js";
import { sanitizeTerminalText } from "./terminal.js";

interface Props { controller: NativeWorkspaceController; back: () => void; opened: () => void }
export function NativeHandoffPanel({ controller, back, opened }: Props): React.JSX.Element {
  const [path, setPath] = useState(""); const [review, setReview] = useState<HandoffReview>();
  const [notice, setNotice] = useState<string>(); const [busy, setBusy] = useState(false);
  const [scroll, setScroll] = useState(0); const [seen, setSeen] = useState({ layout: "", through: 0 });
  const active = useRef(true); const pending = useRef(false); const consumed = useRef(false); const cancelling = useRef(false);
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
  useEffect(() => {
    active.current = true;
    const resize = () => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", resize);
    return () => { active.current = false; stdout.removeListener("resize", resize); };
  }, [stdout]);
  const tooSmall = size.columns < 40 || size.rows < 24;
  const width = Math.max(1, size.columns - 4); const page = Math.max(1, size.rows - 12);
  const content = useMemo(() => review ? `Target: ${nativeProviderLabel(review.target.adapterId)}\nWorkspace: ${review.target.workspace}\n\nExact input to the new session:\n${review.input}` : "", [review]);
  // The parser rejects terminal/hidden controls and normalizes once. Do not sanitize or truncate reviewed input here.
  const lines = useMemo(() => wrapAnsi(content, width, { hard: true, trim: false }).split("\n"), [content, width]);
  const layout = `${width}:${page}:${content.length}`;
  const offset = Math.min(scroll, Math.max(0, lines.length - page));
  useEffect(() => { setScroll(0); setSeen({ layout, through: page }); }, [layout, page, review]);
  const reviewedAll = seen.layout === layout && seen.through >= lines.length;
  const load = async () => {
    pending.current = true; setBusy(true); setNotice(undefined);
    try {
      const snapshot = await controller.runLocalOperation(() => loadHandoffReview(path));
      if (!controller.providerIds.includes(snapshot.target.adapterId)) throw new HandoffError("The handoff target provider is unavailable.");
      if (active.current) { setReview(snapshot); consumed.current = false; }
    } catch (error) { if (active.current) setNotice(error instanceof HandoffError ? error.message : "The handoff could not be loaded. No native session was started."); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  };
  const confirm = async () => {
    if (!review || consumed.current) return;
    consumed.current = true; pending.current = true; setBusy(true);
    try {
      const result = await controller.confirmHandoff(review);
      if (active.current && !cancelling.current) {
        if (controller.handoffService(review) && controller.handoffService(review) === controller.selectedService) opened();
        else setNotice(result.status === "ok" ? "Input submitted." : result.status === "unsupported" ? result.reason : result.message);
      }
    } catch { if (active.current && !cancelling.current) setNotice("The handoff outcome is unknown. It will not be retried; close this review and inspect the native session."); }
    finally { if (!cancelling.current) { pending.current = false; if (active.current) setBusy(false); } }
  };
  const cancel = async () => {
    if (!review || cancelling.current) return;
    cancelling.current = true; pending.current = true; setBusy(true);
    try {
      const closed = await controller.cancelHandoff(review);
      if (active.current) {
        if (closed) back();
        else if (controller.handoffService(review)) opened(); // Retained cleanup remains reachable through explicit Close.
        else setNotice("Native cleanup is unconfirmed. Exit the workspace to retry owned cleanup.");
      }
    } catch { if (active.current) setNotice("Native cleanup is unconfirmed. Exit the workspace to retry owned cleanup."); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  };
  useInput((value, key) => {
    if (key.ctrl && value === "c") return;
    if (key.escape) {
      if (pending.current && review && consumed.current) void cancel();
      else if (!cancelling.current) back();
      return;
    }
    if (tooSmall || pending.current) return;
    if (!review) {
      if (key.backspace || key.delete) setPath((current) => [...current].slice(0, -1).join(""));
      else if (key.return && path) void load();
      else if (!key.ctrl && !key.meta && value) setPath((current) => (current + sanitizeTerminalText(value).replace(/[\n\t]/g, "")).slice(0, 4096));
      return;
    }
    if (value === "n" || value === "q") { back(); return; }
    if (value === "y" && reviewedAll && !consumed.current) { void confirm(); return; }
    if (key.pageDown || key.downArrow) {
      const next = Math.min(Math.max(0, lines.length - page), offset + (key.pageDown ? page : 1));
      setScroll(next); setSeen({ layout, through: Math.max(seen.layout === layout ? seen.through : 0, next + page) });
    }
    if (key.pageUp || key.upArrow) setScroll(Math.max(0, offset - (key.pageUp ? page : 1)));
  });
  if (tooSmall) return <Box flexDirection="column"><Text bold>Review a new-session handoff</Text><Text wrap="truncate-end">Resize to at least 40 columns × 24 rows.</Text><Text wrap="truncate-end">{pending.current && consumed.current ? "Esc Stop handoff  Ctrl+C Exit" : "Confirmation paused. Esc Back  Ctrl+C Exit"}</Text></Box>;
  if (!review) return <Box flexDirection="column"><Text bold>Load a local handoff file</Text><Text>JSON summary, artifact references, and target workspace.</Text><Text>File references are not read or uploaded by Ace.</Text><Text wrap="truncate-start">› {nativeInlineText(path)}<Text inverse> </Text></Text>
    {notice && <Text color="yellow">{nativeInlineText(notice)}</Text>}<Text dimColor>{busy ? "Reading handoff…" : "Enter Load for review  Esc Cancel"}</Text></Box>;
  return <Box flexDirection="column"><Text bold wrap="truncate-end">Review a new-session handoff</Text><Text wrap="truncate-end">Fresh session · one reviewed input</Text>
    <Box flexDirection="column" height={page}>{lines.slice(offset, offset + page).map((line, index) => <Text key={index} wrap="truncate-end">{line || " "}</Text>)}</Box>
    <Text dimColor wrap="truncate-end">Lines {offset + 1}–{Math.min(lines.length, offset + page)} of {lines.length}</Text>
    <Text dimColor wrap="truncate-end">Ace does not read artifact references.</Text>
    <Box height={1}><Text color="yellow" wrap="truncate-end">{notice ? nativeInlineText(notice) : " "}</Text></Box>
    <Text dimColor wrap="truncate-end">{busy ? cancelling.current ? "Stopping the handoff…" : "Opening the reviewed new session…" : consumed.current ? "No automatic retry. Esc Back" : reviewedAll ? "y Confirm once  n Decline  ↑↓ Review" : "↓/PgDn Read all pages before confirm"}</Text>
    <Text dimColor wrap="truncate-end">{busy && consumed.current ? "Esc Stop handoff  Ctrl+C Exit" : "Enter never confirms. Esc Cancel"}</Text></Box>;
}
