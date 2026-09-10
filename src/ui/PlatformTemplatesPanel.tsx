import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { PlatformTemplateSummary } from "../platform/types.js";
import type { WorkspacePanel } from "./App.js";
import { boundedTailText, boundedTextLines, formatMarkdownOutput, MarkdownOutput } from "./components/MarkdownOutput.js";
import { PlatformTemplateController, platformReviewJson, type PlatformTemplateReview } from "./platform-template-controller.js";
import { createPlatformTemplateService, type PlatformTemplateService } from "./platform-template-service.js";
import { sanitizeTerminalText } from "./terminal.js";
import { parseWorkflowInput, workflowFieldType } from "./workflow-form.js";

export function filterPlatformTemplates(templates: readonly PlatformTemplateSummary[], query: string, category?: string): PlatformTemplateSummary[] {
  const needle = query.toLocaleLowerCase();
  return templates.filter((template) => (!category || (template.category ?? "Uncategorized") === category) &&
    `${template.title}\n${template.description ?? ""}\n${template.category ?? ""}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => (a.category ?? "Uncategorized").localeCompare(b.category ?? "Uncategorized") || a.title.localeCompare(b.title));
}
function details(controller: PlatformTemplateController): string {
  const state = controller.getSnapshot(); const template = state.template;
  if (!template) return "";
  return [`# ${template.title}`, template.description ?? "No description.", "", `Template: ${template.workflowId}`,
    `Selected version: ${template.versionNumber}`, `Category: ${template.category ?? "Uncategorized"}`, "", "# Inputs",
    ...state.fields.flatMap((field) => [field.name, platformReviewJson(field.schema), ""]),
    ...(!state.fields.length ? ["This graph has no input fields."] : [])].join("\n");
}
function resultText(controller: PlatformTemplateController): string {
  const state = controller.getSnapshot(); const result = state.result;
  const output = result?.output;
  const rendered = typeof output === "string" ? output
    : output && typeof output === "object" && !Array.isArray(output) && Object.keys(output).length === 1 && "response" in output && typeof output.response === "string" ? output.response
      : output === undefined ? "" : platformReviewJson(output);
  const runId = result?.runId ?? state.runId;
  const jobId = result?.jobId ?? state.jobId;
  return [result ? `# ${result.status === "completed" ? "Completed" : result.status === "cancelled" ? "Cancelled by platform" : "Execution failed"}`
    : state.stopped ? "# Observation stopped" : "# Could not complete",
  ...(runId ? [`Run: ${runId}`] : []), ...(jobId ? [`Job: ${jobId}`] : []),
  ...(state.template ? [`Template version: ${state.template.versionNumber}`] : []),
  ...(state.error ? ["", state.error] : []),
  ...(result?.status === "failed" && !result.error?.message ? ["", "The platform reported an execution error."] : []), ...(result?.error ? ["", "# Error", typeof result.error === "string" ? result.error : platformReviewJson(result.error)] : []),
  ...(result?.lowCredits ? ["", "Platform credits are low."] : []), ...(rendered ? ["", "# Output", rendered] : [])].join("\n");
}

export function PlatformTemplatesPanel({ controller, back }: { controller: PlatformTemplateController; back: () => void }): React.JSX.Element {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { stdout } = useStdout(); const [size, setSize] = useState({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
  const [route, setRoute] = useState<"detail" | "input" | "mode" | "review">("detail");
  const [query, setQuery] = useState(""); const [category, setCategory] = useState<string>(); const [selected, setSelected] = useState(0);
  const [scroll, setScroll] = useState(0); const [fieldIndex, setFieldIndex] = useState(0); const [answer, setAnswer] = useState("");
  const [input, setInput] = useState<Record<string, unknown>>({}); const [drafts, setDrafts] = useState<Record<string, string>>({}); const [modeIndex, setModeIndex] = useState(0);
  const [review, setReview] = useState<PlatformTemplateReview>(); const [notice, setNotice] = useState<string>();
  const [seen, setSeen] = useState<{ key: object | null; through: number }>({ key: null, through: 0 });
  useEffect(() => { void controller.load(); }, [controller]);
  useEffect(() => {
    const resize = () => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", resize); return () => { stdout.removeListener("resize", resize); };
  }, [stdout]);
  const width = Math.max(1, size.columns - (size.columns > 40 ? 4 : 0)); const page = Math.max(1, size.rows - 12);
  const tooSmall = size.columns < 40 || size.rows < 24;
  const busy = ["loading", "opening", "running", "stopping"].includes(state.phase);
  const catalog = state.phase === "catalog" || state.phase === "idle";
  const categories = useMemo(() => [...new Set(state.templates.map((template) => template.category ?? "Uncategorized"))].sort(), [state.templates]);
  const filtered = useMemo(() => filterPlatformTemplates(state.templates, query, category), [state.templates, query, category]);
  const selection = Math.min(selected, Math.max(0, filtered.length - 1));
  const field = state.fields[fieldIndex];
  const catalogRows = useMemo(() => {
    const rows: string[] = []; const positions: number[] = []; let group: string | undefined;
    for (const [index, template] of filtered.entries()) {
      const nextGroup = template.category ?? "Uncategorized";
      if (group !== nextGroup) { rows.push(boundedTextLines(`[${nextGroup}]`, width, 1)[0]); group = nextGroup; }
      positions.push(rows.length); rows.push(boundedTextLines(`${index === selection ? "❯" : " "} ${template.title} · v${template.versionNumber}`, width, 1)[0]);
    }
    if (!rows.length) rows.push("No matching templates.");
    return { rows, positions };
  }, [filtered, selection, width]);
  const content = useMemo(() => {
    if (catalog) return catalogRows.rows.join("\n");
    if (state.phase === "loading") return "Loading the authenticated platform catalog…";
    if (state.phase === "opening") return "Loading and authorizing the selected template version…";
    if (state.phase === "running" || state.phase === "stopping") return [
      state.mode === "remote" ? "Platform run may consume credits." : "Running with the local runtime.",
      ...state.progress.map((progress) => progress.message),
      ...(state.mode === "remote" ? ["", "Stopping observation does not cancel the remote job."] : []),
    ].join("\n");
    if (state.phase === "result") return resultText(controller);
    if (route === "detail") return details(controller);
    if (route === "input") return field ? [
      `# ${field.name}`, `Type: ${workflowFieldType(field)}`, field.required ? "Required input" : "Blank input uses the original typed default.",
      ...(field.schema.description ? [field.schema.description] : []), "", "# Schema and default", platformReviewJson(field.schema),
    ].join("\n") : "No input fields.";
    if (route === "mode") return ["Choose where to execute", "", `${modeIndex === 0 ? "❯" : " "} Local runtime`,
      "  No platform execution credits. Local model providers may charge.", "", `${modeIndex === 1 ? "❯" : " "} Platform (remote)`,
      "  Consumes platform credits.", "  The platform executes stored version contents, which may change before execution.", "", "The next screen reviews the version and exact input before submission."].join("\n");
    return review?.text ?? "";
  }, [catalog, catalogRows, state, controller, route, field, modeIndex, review]);
  const lines = useMemo(() => formatMarkdownOutput(content, width), [content, width]);
  const catalogOffset = Math.min(Math.max(0, (catalogRows.positions[selection] ?? 0) - Math.floor(page / 2)), Math.max(0, lines.length - page));
  const offset = catalog ? catalogOffset : Math.min(scroll, Math.max(0, lines.length - page));
  const reviewActive = state.phase === "ready" && route === "review" && !!review;
  const reviewKey = useMemo(() => ({ review, width, page }), [review, width, page]);
  const through = seen.key === reviewKey ? seen.through : 0;
  useEffect(() => { if (reviewActive) setScroll(0); }, [reviewActive, reviewKey]);
  useEffect(() => {
    if (!reviewActive || tooSmall) return;
    setSeen((previous) => {
      const old = previous.key === reviewKey ? previous.through : 0;
      if (offset > old) return previous;
      const next = Math.max(old, Math.min(lines.length, offset + page));
      return previous.key === reviewKey && old === next ? previous : { key: reviewKey, through: next };
    });
  }, [reviewActive, reviewKey, offset, page, lines.length, tooSmall]);
  const reviewed = reviewActive && through >= lines.length;
  const resetScroll = () => { setScroll(0); setNotice(undefined); };
  const beginInputs = () => { setInput({}); setDrafts({}); setModeIndex(0); setFieldIndex(0); setAnswer(""); setRoute(state.fields.length ? "input" : "mode"); resetScroll(); };

  useInput((value, key) => {
    if (key.ctrl && value === "c") return; // Shared App owns awaited shutdown.
    if (key.escape) {
      if (busy) { void controller.stop(); return; }
      if (tooSmall || catalog) { back(); return; }
      resetScroll();
      if (state.phase === "result" || route === "detail") controller.backToCatalog();
      else if (route === "review") setRoute("mode");
      else if (route === "mode") { setRoute(state.fields.length ? "input" : "detail"); setFieldIndex(Math.max(0, state.fields.length - 1)); setAnswer(drafts[state.fields.at(-1)?.name ?? ""] ?? ""); }
      else setRoute("detail");
      return;
    }
    if (tooSmall || busy) return;
    if (catalog) {
      if (key.ctrl && value === "r") { setSelected(0); void controller.load(true); return; }
      if (key.tab) { const index = category === undefined ? -1 : categories.indexOf(category); setCategory(index + 1 < categories.length ? categories[index + 1] : undefined); setSelected(0); return; }
      if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
        const step = key.pageUp || key.pageDown ? Math.max(1, page - 2) : 1;
        setSelected(Math.min(Math.max(0, filtered.length - 1), Math.max(0, selection + (key.upArrow || key.pageUp ? -step : step)))); return;
      }
      if (key.return && filtered[selection]) { setRoute("detail"); resetScroll(); void controller.open(filtered[selection]); return; }
      if (key.backspace || key.delete) { setQuery((current) => [...current].slice(0, -1).join("")); setSelected(0); return; }
      if (!key.ctrl && !key.meta && value) { setQuery((current) => (current + sanitizeTerminalText(value).replace(/[\r\n]/g, " ")).slice(0, 256)); setSelected(0); }
      return;
    }
    if (state.phase === "result" && key.return) { controller.backToCatalog(); resetScroll(); return; }
    if (state.phase === "ready" && route === "detail" && key.return) { beginInputs(); return; }
    if (state.phase === "ready" && route === "input") {
      if (key.return && field) {
        const parsed = parseWorkflowInput(answer, field);
        if (parsed.error) { setNotice(parsed.error); return; }
        setInput((current) => ({ ...current, [field.name]: parsed.value })); setDrafts((current) => ({ ...current, [field.name]: answer })); setAnswer(drafts[state.fields[fieldIndex + 1]?.name ?? ""] ?? ""); resetScroll();
        if (fieldIndex + 1 < state.fields.length) setFieldIndex(fieldIndex + 1); else setRoute("mode");
        return;
      }
      if (key.backspace || key.delete) { setAnswer((current) => [...current].slice(0, -1).join("")); return; }
      if (!key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.pageUp && !key.pageDown && value) {
        const next = answer + sanitizeTerminalText(value);
        if (Buffer.byteLength(next, "utf8") > 64 * 1024) setNotice("Input exceeds the 64 KiB per-field terminal limit."); else setAnswer(next);
        return;
      }
    }
    if (state.phase === "ready" && route === "mode") {
      if (key.upArrow || key.downArrow) { setModeIndex((index) => 1 - index); return; }
      if (key.return) {
        try { setReview(controller.review(modeIndex ? "remote" : "local", input)); setRoute("review"); resetScroll(); setSeen({ key: null, through: 0 }); }
        catch (error) { setNotice(error instanceof Error ? error.message : "The run could not be reviewed."); }
        return;
      }
    }
    if (reviewActive && value === "y") {
      if (!reviewed) { setNotice("Read every input page before confirming."); return; }
      resetScroll(); void controller.run(review!); return;
    }
    if (key.downArrow || key.pageDown) setScroll(Math.min(Math.max(0, lines.length - page), offset + (key.pageDown ? page : 1)));
    if (key.upArrow || key.pageUp) setScroll(Math.max(0, offset - (key.pageUp ? page : 1)));
  });

  if (tooSmall) return <Box flexDirection="column"><Text>Enlarge to 40×24 to review platform work.</Text><Text>{busy ? "Esc Stop observation" : "Esc Back"}</Text></Box>;
  let footer = ["↑↓ / PgUp/PgDn Scroll", "Esc Back"];
  if (catalog) footer = ["Type Search  ↑↓ Select  Enter Details", "Tab Category  Ctrl+R Reload  Esc Back"];
  else if (busy) footer = [state.phase === "stopping" ? "Waiting for cleanup…" : "Esc Stop observation", state.mode === "remote" ? "A remote job may continue after stopping." : "Ctrl+C Exit workspace"];
  else if (state.phase === "result") footer = ["↑↓ / PgUp/PgDn Scroll output", "Enter / Esc Catalog"];
  else if (route === "detail") footer = ["↑↓ / PgUp/PgDn Scroll details", "Enter Inputs  Esc Catalog"];
  else if (route === "input") footer = ["Enter Accept value  PgUp/PgDn Schema", "Esc Details; input is reviewed before run"];
  else if (route === "mode") footer = ["↑↓ Choose execution  Enter Review", "Esc Inputs"];
  else footer = [reviewed ? review?.mode === "remote" ? "y Submit platform run (uses credits)" : "y Run locally" : "PgDown Read all input before confirming", "↑↓ / PgUp/PgDn Scroll  Esc Change mode"];
  const title = busy ? state.phase === "loading" ? "Loading platform templates" : state.phase === "opening" ? "Authorizing template version" : "Platform template execution"
    : state.phase === "result" ? "Platform template result" : reviewActive ? "Review before execution" : "Platform templates";
  const subtitle = catalog ? `${filtered.length} templates · ${category ?? "All categories"}` : state.template ? `${state.template.title} · version ${state.template.versionNumber}` : "";
  const inputLine = catalog ? `Search: ${query}` : state.phase === "ready" && route === "input" ? `› ${answer}` : " ";
  return <Box flexDirection="column">
    <Text bold wrap="truncate-end">{sanitizeTerminalText(title)}</Text>
    <Text dimColor wrap="truncate-end">{sanitizeTerminalText(subtitle)}</Text>
    <MarkdownOutput physical={lines} offset={offset} maxLines={page} />
    <Text dimColor wrap="truncate-end">{lines.length ? `${offset + 1}–${Math.min(lines.length, offset + page)} / ${lines.length}` : " "}</Text>
    <Text color="yellow" wrap="truncate-end">{sanitizeTerminalText(notice ?? state.error ?? " ")}</Text>
    <Text>{boundedTailText(inputLine, width)}</Text>
    <Text dimColor wrap="truncate-end">{footer[0]}</Text><Text dimColor wrap="truncate-end">{footer[1]}</Text>
  </Box>;
}

export function createPlatformTemplatesPanel(options: { service?: PlatformTemplateService } = {}): WorkspacePanel {
  const controller = new PlatformTemplateController(options.service ?? createPlatformTemplateService());
  return { id: "platform-templates", title: "Platform templates", description: "Browse platform templates and choose local or credit-consuming execution",
    providerLabel: "Platform templates use a separate AceTeam connection",
    dispose: () => controller.dispose(), render: ({ back }) => <PlatformTemplatesPanel controller={controller} back={back} /> };
}
