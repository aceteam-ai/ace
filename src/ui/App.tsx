import React, { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import pkg from "../../package.json" with { type: "json" };
import { providerLabel } from "../utils/provider-detect.js";
import { initialWorkspaceState, workspaceReducer, type WorkspaceScreen } from "./state.js";
import { hasLocalProvider, taskService, type WorkspaceTaskService } from "./task-service.js";
import { sanitizeTerminalText } from "./terminal.js";
import { filterLocalTemplates, localTemplateDetailText, LocalTemplateDetail, LocalTemplateList } from "./components/LocalTemplates.js";
import { boundedTailText, boundedTextLines, formatMarkdownOutput, MarkdownOutput } from "./components/MarkdownOutput.js";
import { parseWorkflowInput, workflowFieldType } from "./workflow-form.js";

export interface WorkspacePanel {
  id: string;
  title: string;
  description: string;
  providerLabel?: string;
  dispose?: () => Promise<void>;
  render: (context: { back: () => void; sanitize: (value: string) => string }) => ReactNode;
}
export interface AppProps {
  service?: WorkspaceTaskService;
  panels?: WorkspacePanel[];
  onExit?: () => void;
  shutdownSignal?: AbortSignal;
}

interface MenuItem { id: string; label: string; description: string; screen?: WorkspaceScreen }
const BASE_ACTIONS: MenuItem[] = [
  { id: "tasks", label: "Run a task", description: "Summarize, explain, transform, and more", screen: "tasks" },
  { id: "workflow", label: "Run a workflow", description: "Open a local workflow JSON file", screen: "workflow" },
  { id: "templates", label: "Create a workflow", description: "Start from a built-in template", screen: "templates" },
  { id: "settings", label: "Settings", description: "View the active model and connection", screen: "settings" },
  { id: "provider", label: "Provider", description: "Connect or change an LLM provider", screen: "provider" },
];

function visibleWindow<T>(items: T[], selected: number, rows: number): { items: T[]; offset: number } {
  if (items.length <= rows) return { items, offset: 0 };
  const offset = Math.min(Math.max(0, selected - Math.floor(rows / 2)), items.length - rows);
  return { items: items.slice(offset, offset + rows), offset };
}

export function App({ service = taskService, panels = [], onExit, shutdownSignal }: AppProps): React.JSX.Element {
  const [state, dispatch] = useReducer(workspaceReducer, initialWorkspaceState);
  const stdout = useStdout().stdout;
  const [terminalSize, setTerminalSize] = useState({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
  const controller = useRef<AbortController>();
  const pending = useRef<Promise<void>>();
  const exiting = useRef(false);
  const { exit } = useApp();
  const patterns = useMemo(() => service.listPatterns(), [service]);
  const templates = useMemo(() => service.listTemplates(), [service]);
  const filteredTemplates = useMemo(() => filterLocalTemplates(templates, state.templateQuery), [templates, state.templateQuery]);
  const homeItems = useMemo<MenuItem[]>(() => [
    ...BASE_ACTIONS,
    ...panels.map((panel) => ({ id: panel.id, label: panel.title, description: panel.description, screen: `panel:${panel.id}` as WorkspaceScreen })),
    { id: "exit", label: "Exit", description: "Return to your terminal" },
  ], [panels]);

  useEffect(() => {
    let mounted = true;
    service.detectProvider().then(
      (provider) => { if (mounted) dispatch({ type: "provider", provider }); },
      () => { if (mounted) dispatch({ type: "provider", provider: { provider: null } }); }
    );
    return () => { mounted = false; controller.current?.abort(); };
  }, [service]);

  useEffect(() => {
    const resize = () => setTerminalSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", resize);
    return () => { stdout.removeListener("resize", resize); };
  }, [stdout]);

  const { columns, rows: terminalRows } = terminalSize;
  const contentWidth = Math.max(1, columns - (columns > 40 ? 4 : 0));
  const resultText = sanitizeTerminalText(state.error ?? state.result?.output ?? "");
  const resultLines = useMemo(() => formatMarkdownOutput(resultText, contentWidth), [resultText, contentWidth]);
  const resultInputLines = state.result?.input
    ? boundedTextLines(state.result.input, contentWidth, terminalRows <= 14 ? 1 : 2)
    : [];
  const resultReservedRows = 7 + (state.result?.sample ? 1 : 0) + (resultInputLines.length ? 1 + resultInputLines.length : 0);
  const resultAvailableRows = Math.max(1, terminalRows - resultReservedRows);
  const resultNeedsIndicator = resultLines.length > resultAvailableRows && resultAvailableRows > 1;
  const resultPage = resultNeedsIndicator ? resultAvailableRows - 1 : resultAvailableRows;
  const resultOffset = Math.min(state.selected, Math.max(0, resultLines.length - resultPage));
  const activeTemplate = templates.find((item) => item.id === state.selectedId);
  const templateDetailPage = Math.max(1, terminalRows - 5);
  const templateDetailLines = useMemo(
    () => activeTemplate ? formatMarkdownOutput(localTemplateDetailText(activeTemplate), contentWidth) : [],
    [activeTemplate, contentWidth]
  );
  const templateDetailOffset = Math.min(state.selected, Math.max(0, templateDetailLines.length - templateDetailPage));

  const finishExit = async () => {
    if (exiting.current) return;
    exiting.current = true;
    controller.current?.abort();
    try { await pending.current; } catch { /* the run reports its own failure */ }
    await Promise.allSettled(panels.map((panel) => Promise.resolve().then(() => panel.dispose?.())));
    onExit?.();
    exit();
  };
  useEffect(() => {
    const stop = () => { void finishExit(); };
    shutdownSignal?.addEventListener("abort", stop, { once: true });
    return () => shutdownSignal?.removeEventListener("abort", stop);
  });
  const goHome = () => dispatch({ type: "navigate", screen: "home", returnTo: "home" });
  const begin = (title: string, run: (signal: AbortSignal) => Promise<string>, input?: string) => {
    const work = (async () => {
    const current = new AbortController();
    controller.current = current;
    dispatch({ type: "run", message: "Preparing local runtime" });
    try {
      const output = await run(current.signal);
      dispatch({ type: "result", title, output, input });
    } catch (error) {
      if (current.signal.aborted) dispatch({ type: "error", message: "Run cancelled" });
      else dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (controller.current === current) controller.current = undefined;
    }
    })();
    pending.current = work;
    void work.then(
      () => { if (pending.current === work) pending.current = undefined; },
      () => { if (pending.current === work) pending.current = undefined; }
    );
  };

  const menuKeys = (length: number, choose: (index: number) => void, back = goHome) => (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => {
    if (key.upArrow || input === "k") dispatch({ type: "select", index: (state.selected - 1 + length) % length });
    else if (key.downArrow || input === "j") dispatch({ type: "select", index: (state.selected + 1) % length });
    else if (key.return) choose(state.selected);
    else if (key.escape || key.backspace || input === "h") back();
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") { if (state.screen === "running") controller.current?.abort(); else void finishExit(); return; }
    if (state.screen.startsWith("panel:")) return; // Active panels own text input, help, focus, and back keys.
    const textScreen = state.screen === "templates" || state.screen === "task-input" || state.screen === "workflow" || state.screen === "workflow-values" || state.screen === "template-output" || state.screen === "settings-edit";
    if (((input === "?" && !textScreen) || key.tab) && state.screen !== "running") {
      dispatch({ type: "help" });
      return;
    }
    if (state.screen === "help") { if (key.escape || key.return || input === "q") dispatch({ type: "help" }); return; }
    if (state.screen === "running") { if (key.escape || input === "q") controller.current?.abort(); return; }
    if (state.screen === "home") {
      menuKeys(homeItems.length, (index) => {
        const item = homeItems[index];
        if (item.id === "exit") void finishExit();
        else dispatch({ type: "navigate", screen: item.screen!, returnTo: "home" });
      }, () => { void finishExit(); })(input, key);
      if (input === "q") void finishExit();
      return;
    }
    if (state.screen === "tasks") {
      if (input === "q") { void finishExit(); return; }
      menuKeys(patterns.length, (index) => {
        const pattern = patterns[index];
        if (!state.providerReady) return;
        if (!hasLocalProvider(state.provider)) {
          const demo = service.getDemo(pattern.id);
          if (demo) dispatch({ type: "result", title: `${pattern.name} sample`, input: demo.input, output: demo.output, sample: true });
          else dispatch({ type: "error", message: "This task needs an LLM provider. Open Provider for setup commands." });
        } else dispatch({ type: "navigate", screen: "task-input", returnTo: "tasks", selectedId: pattern.id });
      })(input, key);
      return;
    }
    if (state.screen === "templates") {
      if (key.upArrow) dispatch({ type: "select", index: (state.selected - 1 + Math.max(1, filteredTemplates.length)) % Math.max(1, filteredTemplates.length) });
      else if (key.downArrow) dispatch({ type: "select", index: (state.selected + 1) % Math.max(1, filteredTemplates.length) });
      else if (key.backspace || key.delete) dispatch({ type: "template-query", value: state.templateQuery.slice(0, -1) });
      else if (key.escape) {
        if (state.templateQuery) dispatch({ type: "template-query", value: "" });
        else goHome();
      } else if (key.return && filteredTemplates[state.selected]) {
        dispatch({ type: "navigate", screen: "template-detail", returnTo: "templates", selectedId: filteredTemplates[state.selected].id });
      } else if (!key.ctrl && !key.meta && input) dispatch({ type: "template-query", value: state.templateQuery + input });
      return;
    }
    if (state.screen === "template-detail") {
      const lastOffset = Math.max(0, templateDetailLines.length - templateDetailPage);
      if (key.upArrow || input === "k") dispatch({ type: "select", index: Math.max(0, templateDetailOffset - 1) });
      else if (key.downArrow || input === "j") dispatch({ type: "select", index: Math.min(lastOffset, templateDetailOffset + 1) });
      else if (key.pageUp) dispatch({ type: "select", index: Math.max(0, templateDetailOffset - templateDetailPage) });
      else if (key.pageDown) dispatch({ type: "select", index: Math.min(lastOffset, templateDetailOffset + templateDetailPage) });
      else if (key.escape || input === "h") dispatch({ type: "back" });
      else if (key.return) dispatch({ type: "navigate", screen: "template-output", returnTo: "template-detail", selectedId: state.selectedId, input: "workflow.json" });
      return;
    }
    if (state.screen === "task-input" || state.screen === "workflow" || state.screen === "workflow-values" || state.screen === "template-output" || state.screen === "settings-edit") {
      if (key.escape) { dispatch({ type: "back" }); return; }
      if (key.backspace || key.delete) dispatch({ type: "input", value: state.input.slice(0, -1) });
      else if (key.return && (state.input.trim() || state.screen === "workflow-values")) {
        const value = state.screen === "workflow-values" ? state.input : state.input.trim();
        if (state.screen === "task-input") {
          const pattern = patterns.find((item) => item.id === state.selectedId);
          void begin(pattern?.name ?? "Task", (signal) => service.executePattern(state.selectedId!, value, { signal, onProgress: (progress) => dispatch({ type: "progress", progress }) }), value);
        } else if (state.screen === "workflow") {
          try {
            const fields = service.getWorkflowInputs(value);
            if (fields.length) dispatch({ type: "workflow-inputs", path: value, fields });
            else begin("Workflow output", (signal) => service.executeWorkflow(value, {}, { signal, onProgress: (progress) => dispatch({ type: "progress", progress }) }));
          } catch (error) { dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
        } else if (state.screen === "workflow-values") {
          const field = state.workflowFields?.[state.selected];
          if (!field) return;
          const parsed = parseWorkflowInput(state.input, field);
          if (parsed.error) { dispatch({ type: "form-error", message: parsed.error }); return; }
          const values = { ...state.workflowValues };
          if (parsed.include) values[field.name] = parsed.value;
          if (state.selected + 1 >= (state.workflowFields?.length ?? 0)) {
            begin("Workflow output", (signal) => service.executeWorkflow(state.workflowPath!, values, { signal, onProgress: (progress) => dispatch({ type: "progress", progress }) }));
          } else dispatch({ type: "workflow-value", field: field.name, include: parsed.include, value: parsed.value });
        } else if (state.screen === "settings-edit") {
          try {
            service.updateDefaultModel(value);
            dispatch({ type: "result", title: "Settings saved", output: `Default model: ${value}` });
          } catch (error) {
            dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
          }
        } else {
          try { dispatch({ type: "result", title: "Workflow created", output: service.createWorkflow(state.selectedId!, value) }); }
          catch (error) { dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
        }
      } else if (!key.ctrl && !key.meta && input) dispatch({ type: "append-input", value: input });
      return;
    }
    if (state.screen === "settings" && input === "e") {
      dispatch({ type: "navigate", screen: "settings-edit", returnTo: "settings", input: service.getConfig().default_model ?? "gpt-4o-mini" });
      return;
    }
    if (state.screen === "result") {
      if (key.upArrow || input === "k") dispatch({ type: "select", index: Math.max(0, resultOffset - 1) });
      else if (key.downArrow || input === "j") dispatch({ type: "select", index: Math.min(Math.max(0, resultLines.length - resultPage), resultOffset + 1) });
      else if (key.escape || key.return || input === "q") goHome();
      return;
    }
    if (state.screen === "settings" || state.screen === "provider") {
      if (key.escape || key.return || input === "q") goHome();
    }
  });

  const activePanel = panels.find((panel) => `panel:${panel.id}` === state.screen);
  const provider = sanitizeTerminalText(activePanel?.providerLabel ?? (state.providerReady ? providerLabel(state.provider ?? { provider: null }) : "Checking providers…"));
  const body = renderBody();
  return (
    <Box width={Math.max(1, columns)} flexDirection="column" paddingX={columns > 40 ? 2 : 0}>
      <Box justifyContent="space-between"><Text bold color="cyan">AceTeam</Text><Text dimColor>v{pkg.version}</Text></Box>
      <Text dimColor wrap="truncate-end">{provider}</Text>
      <Box marginTop={1} flexDirection="column">{body}</Box>
      <Box marginTop={1}><Text dimColor>{footer()}</Text></Box>
    </Box>
  );

  function list(items: Array<{ label?: string; name?: string; description: string }>, selected: number): ReactNode {
    const rows = Math.max(4, Math.min(12, (stdout.rows ?? 24) - 9));
    const window = visibleWindow(items, selected, rows);
    return window.items.map((item, index) => {
      const actual = index + window.offset;
      return <Text key={actual} color={actual === selected ? "cyan" : undefined}>{actual === selected ? "❯ " : "  "}{sanitizeTerminalText(item.label ?? item.name ?? "")} <Text dimColor>— {sanitizeTerminalText(item.description)}</Text></Text>;
    });
  }

  function inputLine(): ReactNode {
    const preview = boundedTailText(state.input, Math.max(1, contentWidth - 3));
    return <Box width={contentWidth}><Text color="cyan">{"› " + preview + "▌"}</Text></Box>;
  }

  function renderBody(): ReactNode {
    if (state.screen === "help") return <Box flexDirection="column"><Text bold>Keys</Text><Text>↑/↓ or j/k  Move</Text><Text>Enter       Select or submit</Text><Text>Esc or h    Back</Text><Text>?           Toggle this help</Text><Text>q           Quit or cancel</Text></Box>;
    if (state.screen === "home") return <Box flexDirection="column"><Text bold>What would you like to do?</Text>{list(homeItems, state.selected)}</Box>;
    if (state.screen === "tasks") return <Box flexDirection="column"><Text bold>Choose a task</Text>{!state.providerReady && <Text color="yellow">Provider check still running; you can browse now.</Text>}{list(patterns, state.selected)}</Box>;
    if (state.screen === "templates") return <LocalTemplateList templates={filteredTemplates} selected={state.selected} query={state.templateQuery} width={contentWidth} maxRows={Math.max(3, terminalRows - 5)} />;
    if (state.screen === "template-detail") {
      return activeTemplate
        ? <LocalTemplateDetail template={activeTemplate} width={contentWidth} maxRows={templateDetailPage} offset={templateDetailOffset} physical={templateDetailLines} />
        : <Text color="red">Template unavailable</Text>;
    }
    if (state.screen === "task-input") return <Box flexDirection="column"><Text bold>Enter text</Text>{inputLine()}</Box>;
    if (state.screen === "workflow-values") {
      const field = state.workflowFields?.[state.selected];
      return <Box flexDirection="column">
        <Text bold wrap="truncate-end">{sanitizeTerminalText(field?.schema.title || field?.name || "Input")}</Text>
        {field?.schema.description && <Text dimColor wrap="truncate-end">{sanitizeTerminalText(field.schema.description)}</Text>}
        <Text dimColor wrap="truncate-end">{field ? sanitizeTerminalText(workflowFieldType(field)) : "value"}{field?.required ? " · required" : " · default available"}{field && "default" in field.schema ? ` · Enter uses ${sanitizeTerminalText(JSON.stringify(field.schema.default))}` : ""}{Array.isArray(field?.schema.enum) && field.schema.enum.includes("") ? ' · type "" for empty' : ""}</Text>
        {inputLine()}
        {state.formError && <Text color="red" wrap="truncate-end">{sanitizeTerminalText(state.formError)}</Text>}
      </Box>;
    }
    if (state.screen === "workflow") return <Box flexDirection="column"><Text bold>Workflow JSON path</Text>{inputLine()}</Box>;
    if (state.screen === "settings-edit") return <Box flexDirection="column"><Text bold>Default model</Text>{inputLine()}</Box>;
    if (state.screen === "template-output") return <Box flexDirection="column"><Text bold>Output path</Text>{inputLine()}<Text dimColor>Existing files are left untouched.</Text></Box>;
    if (state.screen === "running") return <Box flexDirection="column"><Text bold color="cyan">Working…</Text>{state.progress.map((item, index) => <Text key={index}>{index === state.progress.length - 1 ? "●" : "✓"} {sanitizeTerminalText(item.message)}</Text>)}</Box>;
    if (state.screen === "settings") {
      const config = service.getConfig();
      return <Box flexDirection="column"><Text bold>Settings</Text><Text>Default model  {sanitizeTerminalText(config.default_model ?? "gpt-4o-mini")}</Text><Text dimColor>Press e to edit the default model.</Text><Text>Local runtime {config.python_path ? "managed" : "installed on first live run"}</Text><Text>Fabric        {config.fabric_api_key ? "connected for remote workflows" : "not connected"}</Text></Box>;
    }
    if (state.screen === "provider") return <Box flexDirection="column"><Text bold>Provider setup</Text><Text>OpenAI     export OPENAI_API_KEY=…</Text><Text>Anthropic  export ANTHROPIC_API_KEY=…</Text><Text>Ollama     ollama serve</Text><Text>AceTeam    ace login (remote workflows)</Text></Box>;
    if (state.screen.startsWith("panel:")) {
      const panel = panels.find((item) => `panel:${item.id}` === state.screen);
      return panel?.render({ back: goHome, sanitize: sanitizeTerminalText }) ?? <Text>Panel unavailable</Text>;
    }
    return <Box flexDirection="column">
      <Text bold color={state.error ? "red" : "green"}>{sanitizeTerminalText(state.error ? "Could not complete" : state.result?.title ?? "Result")}</Text>
      {state.result?.sample && <Text color="yellow">Prerecorded sample — no model was called.</Text>}
      {resultInputLines.length > 0 && <><Text bold>{state.result?.sample ? "Sample input" : "Input"}</Text>{resultInputLines.map((line, index) => <Text key={index}>{line}</Text>)}</>}
      <Text bold>{state.error ? "Error" : "Output"}</Text>
      <MarkdownOutput physical={resultLines} offset={resultOffset} maxLines={resultPage} />
      {resultNeedsIndicator && <Text dimColor>↑/↓ Scroll</Text>}
    </Box>;
  }

  function footer(): string {
    if (state.screen.startsWith("panel:")) return "Ctrl+C Exit workspace";
    if (state.screen === "running") return "Esc Cancel";
    if (state.screen === "templates") return "Type Filter  ↑↓ Move  Enter Open  Esc Back";
    if (state.screen === "template-detail") return "↑↓ Scroll PgUp/Dn Enter Create Esc Back";
    if (state.screen === "tasks") return "↑↓ Move  Enter Select  Esc Menu  q Exit  ? Keys";
    if (state.screen === "home") return "↑↓ Move  Enter Select  q Exit  ? Keys";
    if (state.screen === "task-input" || state.screen === "workflow" || state.screen === "workflow-values" || state.screen === "template-output" || state.screen === "settings-edit") return "Enter Submit  Esc Back  Tab Keys";
    return "Enter/Esc Back  ? Keys";
  }
}
