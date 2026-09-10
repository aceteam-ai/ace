import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import wrapAnsi from "wrap-ansi";
import type { NativeHarnessAdapter, NativeHarnessOperation } from "../harness/types.js";
import { NativeSessionManager } from "../harness/session-manager.js";
import { CodexNativeHarnessAdapter } from "../harness/codex.js";
import { ManagedNativeWorkspace, nativeProviderDescription } from "./ManagedNativeWorkspace.js";
import { NativeWorkspaceController } from "./native-workspace-controller.js";
import { NativeSessionChooser } from "./NativeSessionChooser.js";
import type { WorkspacePanel } from "./App.js";
import { NativeSessionService } from "./native-session-service.js";
import { nativeInlineText, nativePermissionSummary, nativeProviderLabel, nativeText, type NativeSessionState } from "./native-session-state.js";
import { sanitizeTerminalText } from "./terminal.js";

const TABS = ["Conversation", "Activity", "Changes", "Approvals"] as const;
const PHASE_LABELS = { idle: "Not started", starting: "Starting", ready: "Ready", running: "Working", waiting_for_approval: "Waiting for approval", closing: "Closing", closed: "Closed", error: "Error" } as const;
function capabilityReason(adapter: NativeHarnessAdapter, operation: NativeHarnessOperation): string | undefined {
  const capability = adapter.capabilities[operation];
  return capability.supported ? undefined : capability.reason;
}
function displayLines(state: NativeSessionState, tab: number, approvalIndex: number): string[] {
  if (tab === 0) return state.messages.length
    ? state.messages.flatMap((message) => [`${message.role}${message.complete ? "" : " (streaming)"}`, message.text, ""])
    : [state.connectionKind === "resumed" ? "Session resumed. Earlier conversation is not loaded. Send a new message when ready." : "No conversation output yet."];
  if (tab === 1) return [...(state.registrationNotice ? ["Local registration", state.registrationNotice, ""] : []), "Native permissions", nativeText(state.permissionContext ?? "Not reported"), "", "Native workers",
    ...state.workers.flatMap((worker) => [`${worker.name}: ${worker.state}`, worker.details]),
    "", "Native tool activity", ...state.tools.flatMap((tool) => [`${tool.name}: ${tool.state}`, tool.details, ""])];
  if (tab === 2) return state.changes.length ? ["Native-reported changes", ...state.changes.flatMap((change) => [
    ...(change.files.length ? change.files : ["Aggregated turn diff"]), change.patch ?? "Patch unavailable; only a file summary was reported.", "",
  ])] : ["No file changes have been reported."];
  const approval = state.approvals[approvalIndex];
  return approval ? ["Review the native action and scope", approval.prompt, approval.details, "", nativePermissionSummary(state)] : ["No pending approvals."];
}

export interface NativeSessionsPanelProps {
  service: NativeSessionService;
  back: () => void;
  workspace?: string;
  manager?: NativeSessionManager;
  initialRoute?: "choose" | "workspace";
  chooseProvider?: () => void;
}

export function NativeSessionsPanel({ service, back, workspace: defaultWorkspace = process.cwd(), manager, initialRoute = "choose", chooseProvider }: NativeSessionsPanelProps): React.JSX.Element {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  const [route, setRoute] = useState<"choose" | "workspace" | "open" | "session">(state.phase === "idle" || (initialRoute === "workspace" && service.canStartFresh()) ? initialRoute : "session");
  const providerLabel = nativeProviderLabel(service.adapter.adapterId);
  const [workspace, setWorkspace] = useState(defaultWorkspace);
  const [input, setInput] = useState("");
  const [focus, setFocus] = useState<"view" | "input">("view");
  const [tab, setTab] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [selection, setSelection] = useState<{ approvalId: string; index: number }>();
  const choice = selection?.approvalId === state.approvals[Math.min(approvalIndex, Math.max(0, state.approvals.length - 1))]?.id ? selection?.index : undefined;
  const [help, setHelp] = useState(false);
  const [localNotice, setLocalNotice] = useState<string>();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
  useEffect(() => {
    const resize = () => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", resize);
    return () => { stdout.removeListener("resize", resize); };
  }, [stdout]);
  const approval = state.approvals[Math.min(approvalIndex, Math.max(0, state.approvals.length - 1))];
  useEffect(() => { setSelection(undefined); setScroll(0); }, [approval?.id]);
  useEffect(() => { if (state.phase !== "ready") setFocus("view"); }, [state.phase]);
  const tooSmall = size.columns < 40 || size.rows < 24;
  const width = Math.max(1, size.columns - (size.columns > 40 ? 4 : 0));
  const page = Math.max(1, size.rows - 16 - (tab === 3 && approval ? approval.choices.length + 2 : 0));
  const content = displayLines(state, tab, Math.min(approvalIndex, Math.max(0, state.approvals.length - 1))).join("\n");
  // Sanitize before wrapping so output cannot execute terminal controls or falsify measured rows.
  const lines = wrapAnsi(sanitizeTerminalText(content).replace(/\t/g, "    "), width, { hard: true, trim: false }).split("\n");
  const offset = Math.min(scroll, Math.max(0, lines.length - page));
  const blocked = (operation: NativeHarnessOperation): boolean => {
    const reason = capabilityReason(service.adapter, operation);
    if (!reason) return false;
    setLocalNotice(sanitizeTerminalText(reason)); return true;
  };
  const selectTab = (index: number) => { setTab(index); setScroll(0); setSelection(undefined); };

  useInput((value, key) => {
    if (key.ctrl && value === "c") return; // Shared App owns awaited terminal shutdown.
    if (tooSmall) { if (key.escape || value === "q") back(); return; }
    if (help) { if (key.escape || key.return || value === "?" || key.tab) setHelp(false); return; }
    if (route === "workspace" || focus === "input") {
      if (key.escape) { route === "workspace" ? chooseProvider ? chooseProvider() : setRoute("choose") : setFocus("view"); return; }
      if (key.tab) { route === "workspace" ? setHelp(true) : setFocus("view"); return; }
      if (key.backspace || key.delete) {
        const shorten = (text: string) => [...text].slice(0, -1).join("");
        route === "workspace" ? setWorkspace(shorten) : setInput(shorten); return;
      }
      if (key.return) {
        if (route === "workspace" && workspace.trim()) {
          if (blocked("start")) return;
          setRoute(manager ? "open" : "session"); setFocus("view"); setLocalNotice(undefined);
          if (!manager) void service.start(workspace.trim());
        } else if (focus === "input" && input.trim()) {
          if (blocked("sendInput")) return;
          const submitted = input; setFocus("view");
          void service.sendInput(submitted).then((result) => { if (result.status === "ok") setInput(""); });
        }
        return;
      }
      if (!key.ctrl && !key.meta && value) {
        const safe = sanitizeTerminalText(value);
        route === "workspace" ? setWorkspace((text) => (text + safe).slice(0, 4096)) : setInput((text) => (text + safe).slice(0, 40_000));
      }
      return;
    }
    if (value === "?") { setHelp(true); return; }
    if (key.escape || value === "q") { back(); return; }
    if (route === "choose") {
      if (key.return && !blocked("start")) { setRoute("workspace"); setLocalNotice(undefined); }
      return;
    }
    if (value === "n" && ["closed", "error"].includes(state.phase)) { chooseProvider ? chooseProvider() : setRoute("choose"); return; }
    if (value === "x" && !blocked("dispose")) { void service.close(); return; }
    if (value === "i" && !blocked("interrupt")) { void service.interrupt(); return; }
    if (key.leftArrow) { selectTab((tab + TABS.length - 1) % TABS.length); return; }
    if (key.rightArrow) { selectTab((tab + 1) % TABS.length); return; }
    if (key.tab || (key.return && tab !== 3)) {
      if (state.phase === "ready" && !blocked("sendInput")) { setFocus("input"); selectTab(0); }
      else if (key.tab) selectTab((tab + 1) % TABS.length);
      return;
    }
    if (tab === 3 && approval) {
      if (value === "[" || value === "]") {
        setApprovalIndex((index) => (index + (value === "]" ? 1 : -1) + state.approvals.length) % state.approvals.length);
        setSelection(undefined); setScroll(0); return;
      }
      if (key.upArrow || key.downArrow) {
        if (approval.status !== "waiting") return;
        if (!approval.choices.length) return;
        setSelection({ approvalId: approval.id, index: choice === undefined ? key.downArrow ? 0 : approval.choices.length - 1
          : (choice + (key.downArrow ? 1 : -1) + approval.choices.length) % approval.choices.length });
        return;
      }
      // No default selection: opening/focusing a prompt or pressing Enter cannot grant it.
      if (key.return && choice !== undefined && approval.status === "waiting" && !blocked("respondToApproval")) {
        const decision = approval.choices[choice];
        if (decision) void service.respond(approval.id, decision);
        return;
      }
    }
    if (key.pageDown || (tab !== 3 && key.downArrow)) setScroll(Math.min(Math.max(0, lines.length - page), offset + (key.pageDown ? page : 1)));
    if (key.pageUp || (tab !== 3 && key.upArrow)) setScroll(Math.max(0, offset - (key.pageUp ? page : 1)));
  }, { isActive: route !== "open" });

  if (route === "open" && manager) return <NativeSessionChooser manager={manager} adapterId={service.adapter.adapterId} workspace={workspace.trim()}
    runLocalOperation={service.runLocalOperation} back={() => setRoute("workspace")}
    start={() => { setRoute("session"); void service.start(workspace.trim()); }}
    resume={(record) => { setRoute("session"); void service.resume(record, workspace.trim()); }} />;
  if (tooSmall) return <Box flexDirection="column"><Text bold wrap="truncate-end">{providerLabel} · {PHASE_LABELS[state.phase]}</Text><Text wrap="truncate-end">Resize to at least 40 columns × 24 rows.</Text><Text wrap="truncate-end">{state.approvals.length} approvals pending; actions paused.</Text><Text dimColor wrap="truncate-end">Esc Back  Ctrl+C Exit workspace</Text></Box>;
  if (help) return <Box flexDirection="column"><Text bold>Native session keys</Text><Text>←/→ Panels  ↑/↓ Scroll or choose  PgUp/PgDn Page</Text><Text>Enter/Tab Compose when ready  i Interrupt turn</Text><Text>Approvals: ↑/↓ explicitly choose, then Enter sends</Text><Text>[ / ] Previous/next approval  x Close session</Text><Text>Esc/q Back (session keeps running)  Ctrl+C Exit</Text><Text>While typing: ? and q are text; Tab leaves input.</Text><Text>Esc/Enter Close help</Text></Box>;
  if (route === "choose") return <Box flexDirection="column"><Text bold>Native coding session</Text><Text color="cyan">❯ {providerLabel}</Text><Text>{nativeProviderDescription(service.adapter.adapterId)}</Text><Text>No Python setup or AceTeam account is required.</Text><Text dimColor>Enter Choose workspace  Esc Back  ? Keys</Text>{localNotice && <Text color="yellow">{nativeInlineText(localNotice)}</Text>}</Box>;
  if (route === "workspace") return <Box flexDirection="column"><Text bold>{providerLabel} workspace directory</Text><Text wrap="truncate-start">› {nativeInlineText(workspace)}<Text inverse> </Text></Text><Text dimColor>Enter {manager ? "Choose new or saved session" : "Start new session"}  Esc Back  Tab Keys</Text>{localNotice && <Text color="yellow">{nativeInlineText(localNotice)}</Text>}</Box>;
  return <Box flexDirection="column">
    <Text bold>{providerLabel} · {PHASE_LABELS[state.phase]}{state.interruptPending ? " · interrupt requested" : ""}</Text>
    <Text wrap="truncate-middle" dimColor>Session {nativeInlineText(state.identity?.sessionId ?? "closed")} · {nativeInlineText(state.workspace ?? workspace)}</Text>
    <Text wrap="truncate-end">{nativePermissionSummary(state)}</Text>
    <Text wrap="truncate-end">{width < 60 ? `${tab + 1}/4 ${TABS[tab]}  ←→ Panels` : TABS.map((label, index) => `${index === tab ? "[" : " "}${label}${index === tab ? "]" : " "}`).join(" ")}</Text>
    {state.approvals.length > 0 && <Text color="yellow" wrap="truncate-end">{state.approvals.length} native approval(s) pending · open Approvals to review</Text>}
    <Box flexDirection="column" height={page}>{lines.slice(offset, offset + page).map((line, index) => <Text key={index} wrap="truncate-end">{line || " "}</Text>)}</Box>
    <Text dimColor wrap="truncate-end">Lines {lines.length ? offset + 1 : 0}–{Math.min(lines.length, offset + page)} of {lines.length}</Text>
    {tab === 3 && approval && <Box flexDirection="column"><Text bold wrap="truncate-end">Request {Math.min(approvalIndex + 1, state.approvals.length)}/{state.approvals.length} · {approval.status}</Text>
      {approval.choices.map((decision, index) => <Text key={decision} wrap="truncate-end" color={choice === index ? "cyan" : undefined}>{choice === index ? "❯" : " "} {nativeInlineText(decision)}</Text>)}
      <Text dimColor wrap="truncate-end">{approval.status === "waiting" ? "Choose with ↑/↓, then Enter confirms that decision." : "Waiting for native resolution; replies are disabled."}</Text></Box>}
    {focus === "input" && <Text color="cyan" wrap="truncate-start">› {nativeInlineText(input)}<Text inverse> </Text></Text>}
    {state.registrationNotice && <Text color={state.registrationStatus === "pending" ? undefined : "yellow"} dimColor={state.registrationStatus === "pending"} wrap="truncate-end">Registration: {nativeInlineText(state.registrationNotice)} · details in Activity</Text>}
    {(localNotice || state.notice) && <Text color="yellow" wrap="truncate-end">{nativeInlineText(localNotice ?? state.notice ?? "")}</Text>}
    <Text dimColor wrap="truncate-end">{focus === "input" ? "Enter Send  Tab/Esc Panels  ? is text" : "←→ Panels  Enter Compose  i Interrupt  x Close  Esc Back  ? Keys"}</Text>
    {["closed", "error"].includes(state.phase) && <Text dimColor>n New session</Text>}
  </Box>;
}

export type NativeSessionPanelOptions = { workspace?: string } & ({ adapter?: NativeHarnessAdapter; manager?: never } | { manager: NativeSessionManager; adapter?: never });
export function createNativeSessionsPanel(options: NativeSessionPanelOptions = {}): WorkspacePanel {
  if (options.adapter && options.manager) throw new Error("Use a managed adapter factory or a standalone test adapter, not both.");
  const manager = options.manager ?? (options.adapter ? undefined : new NativeSessionManager({ adapters: { codex: (store) => new CodexNativeHarnessAdapter({ sessionStore: store }) } }));
  if (manager) {
    const controller = new NativeWorkspaceController(manager);
    return {
      id: "native", title: "Native coding session", description: "Native conversation, activity, changes, approvals, and reviewed handoff",
      providerLabel: "Native providers manage their own authentication and permissions",
      dispose: () => controller.dispose(),
      render: ({ back }) => <ManagedNativeWorkspace controller={controller} workspace={options.workspace} back={back} />,
    };
  }
  const service = new NativeSessionService(options.adapter!);
  const label = nativeProviderLabel(options.adapter!.adapterId);
  return {
    id: "native", title: "Native coding session", description: `${label} conversation, activity, changes, and approvals`,
    providerLabel: `${label} manages its own sign-in and permissions`,
    dispose: () => service.dispose(),
    render: ({ back }) => <NativeSessionsPanel service={service} workspace={options.workspace} back={back} />,
  };
}
