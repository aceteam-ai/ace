import React, { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import pkg from "../../package.json" with { type: "json" };
import { providerLabel } from "../utils/provider-detect.js";
import { initialWorkspaceState, workspaceReducer, type WorkspaceScreen } from "./state.js";
import { hasLocalProvider, taskService, type WorkspaceTaskService } from "./task-service.js";
import { sanitizeTerminalText } from "./terminal.js";

export interface WorkspacePanel {
  id: string;
  title: string;
  description: string;
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
  const [columns, setColumns] = useState(useStdout().stdout.columns ?? 80);
  const controller = useRef<AbortController>();
  const pending = useRef<Promise<void>>();
  const exiting = useRef(false);
  const { exit } = useApp();
  const patterns = useMemo(() => service.listPatterns(), [service]);
  const templates = useMemo(() => service.listTemplates(), [service]);
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

  const stdout = useStdout().stdout;
  useEffect(() => {
    const resize = () => setColumns(stdout.columns ?? 80);
    stdout.on("resize", resize);
    return () => { stdout.removeListener("resize", resize); };
  }, [stdout]);

  const finishExit = async () => {
    if (exiting.current) return;
    exiting.current = true;
    controller.current?.abort();
    try { await pending.current; } catch { /* the run reports its own failure */ }
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
    const textScreen = state.screen === "task-input" || state.screen === "workflow" || state.screen === "workflow-values" || state.screen === "template-output" || state.screen === "settings-edit";
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
      menuKeys(templates.length, (index) => dispatch({ type: "navigate", screen: "template-output", returnTo: "templates", selectedId: templates[index].id, input: "workflow.json" }))(input, key);
      return;
    }
    if (state.screen === "task-input" || state.screen === "workflow" || state.screen === "workflow-values" || state.screen === "template-output" || state.screen === "settings-edit") {
      if (key.escape) { dispatch({ type: "back" }); return; }
      if (key.backspace || key.delete) dispatch({ type: "input", value: state.input.slice(0, -1) });
      else if (key.return && state.input.trim()) {
        const value = state.input.trim();
        if (state.screen === "task-input") {
          const pattern = patterns.find((item) => item.id === state.selectedId);
          void begin(pattern?.name ?? "Task", (signal) => service.executePattern(state.selectedId!, value, { signal, model: state.provider?.model, onProgress: (progress) => dispatch({ type: "progress", progress }) }), value);
        } else if (state.screen === "workflow") {
          try {
            const fields = service.getWorkflowInputs(value);
            if (fields.length) dispatch({ type: "workflow-inputs", path: value, fields });
            else begin("Workflow output", (signal) => service.executeWorkflow(value, {}, { signal, onProgress: (progress) => dispatch({ type: "progress", progress }) }));
          } catch (error) { dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
        } else if (state.screen === "workflow-values") {
          const field = state.workflowFields?.[state.selected];
          if (!field) return;
          const values = { ...state.workflowValues, [field]: value };
          if (state.selected + 1 >= (state.workflowFields?.length ?? 0)) {
            begin("Workflow output", (signal) => service.executeWorkflow(state.workflowPath!, values, { signal, onProgress: (progress) => dispatch({ type: "progress", progress }) }));
          } else dispatch({ type: "workflow-value", field, value });
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
      } else if (!key.ctrl && !key.meta && input) dispatch({ type: "input", value: state.input + input });
      return;
    }
    if (state.screen === "settings" && input === "e") {
      dispatch({ type: "navigate", screen: "settings-edit", returnTo: "settings", input: service.getConfig().default_model ?? "gpt-4o-mini" });
      return;
    }
    if (state.screen === "result") {
      const lines = (state.result?.output ?? state.error ?? "").split("\n");
      const page = Math.max(3, (stdout.rows ?? 24) - 12);
      if (key.upArrow || input === "k") dispatch({ type: "select", index: Math.max(0, state.selected - 1) });
      else if (key.downArrow || input === "j") dispatch({ type: "select", index: Math.min(Math.max(0, lines.length - page), state.selected + 1) });
      else if (key.escape || key.return || input === "q") goHome();
      return;
    }
    if (state.screen === "settings" || state.screen === "provider") {
      if (key.escape || key.return || input === "q") goHome();
    }
  });

  const provider = sanitizeTerminalText(state.providerReady ? providerLabel(state.provider ?? { provider: null }) : "Checking providers…");
  const body = renderBody();
  return (
    <Box width={Math.max(1, columns)} flexDirection="column" paddingX={columns > 40 ? 2 : 0}>
      <Box justifyContent="space-between"><Text bold color="cyan">AceTeam</Text><Text dimColor>v{pkg.version}</Text></Box>
      <Text dimColor>{provider}</Text>
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

  function renderBody(): ReactNode {
    if (state.screen === "help") return <Box flexDirection="column"><Text bold>Keys</Text><Text>↑/↓ or j/k  Move</Text><Text>Enter       Select or submit</Text><Text>Esc or h    Back</Text><Text>?           Toggle this help</Text><Text>q           Quit or cancel</Text></Box>;
    if (state.screen === "home") return <Box flexDirection="column"><Text bold>What would you like to do?</Text>{list(homeItems, state.selected)}</Box>;
    if (state.screen === "tasks") return <Box flexDirection="column"><Text bold>Choose a task</Text>{!state.providerReady && <Text color="yellow">Provider check still running; you can browse now.</Text>}{list(patterns, state.selected)}</Box>;
    if (state.screen === "templates") return <Box flexDirection="column"><Text bold>Choose a workflow template</Text>{list(templates, state.selected)}</Box>;
    if (state.screen === "task-input") return <Box flexDirection="column"><Text bold>Enter text</Text><Text color="cyan">› {sanitizeTerminalText(state.input)}<Text inverse> </Text></Text></Box>;
    if (state.screen === "workflow-values") return <Box flexDirection="column"><Text bold>Input: {sanitizeTerminalText(state.workflowFields?.[state.selected] ?? "value")}</Text><Text color="cyan">› {sanitizeTerminalText(state.input)}<Text inverse> </Text></Text></Box>;
    if (state.screen === "workflow") return <Box flexDirection="column"><Text bold>Workflow JSON path</Text><Text color="cyan">› {sanitizeTerminalText(state.input)}<Text inverse> </Text></Text></Box>;
    if (state.screen === "settings-edit") return <Box flexDirection="column"><Text bold>Default model</Text><Text color="cyan">› {sanitizeTerminalText(state.input)}<Text inverse> </Text></Text></Box>;
    if (state.screen === "template-output") return <Box flexDirection="column"><Text bold>Output path</Text><Text color="cyan">› {sanitizeTerminalText(state.input)}<Text inverse> </Text></Text><Text dimColor>Existing files are left untouched.</Text></Box>;
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
    const resultText = sanitizeTerminalText(state.error ?? state.result?.output ?? "");
    const page = Math.max(3, (stdout.rows ?? 24) - 12);
    const shown = resultText.split("\n").slice(state.selected, state.selected + page).join("\n");
    return <Box flexDirection="column"><Text bold color={state.error ? "red" : "green"}>{sanitizeTerminalText(state.error ? "Could not complete" : state.result?.title ?? "Result")}</Text>{state.result?.sample && <Text color="yellow">Prerecorded sample — no model was called.</Text>}{state.result?.input && <><Text bold>{state.result.sample ? "Sample input" : "Input"}</Text><Text>{sanitizeTerminalText(state.result.input)}</Text></>}<Text bold>{state.error ? "Error" : "Output"}</Text><Text>{shown}</Text>{resultText.split("\n").length > page && <Text dimColor>↑/↓ Scroll</Text>}</Box>;
  }

  function footer(): string {
    if (state.screen === "running") return "Esc Cancel";
    if (state.screen === "home") return "↑↓ Move  Enter Select  q Exit  ? Keys";
    if (state.screen === "task-input" || state.screen === "workflow" || state.screen === "workflow-values" || state.screen === "template-output" || state.screen === "settings-edit") return "Enter Submit  Esc Back  Tab Keys";
    return "Enter/Esc Back  ? Keys";
  }
}
