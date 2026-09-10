import { Command } from "commander";
import { input as promptInput, password } from "@inquirer/prompts";
import ora from "ora";
import { PlatformClient, PlatformClientError, createPlatformClientFromConfig } from "../platform/client.js";
import { removePlatformCredentials, normalizePlatformOrigin, savePlatformCredentials } from "../platform/config.js";
import { getPlatformTemplateById } from "../platform/service.js";
import { collectPlatformTemplateInput, runPlatformTemplateLocally } from "../platform/workflow.js";
import type { PlatformRunResult, PlatformTemplate } from "../platform/types.js";
import type { WorkflowInputField } from "../ui/workflow-form.js";
import { sanitizeTerminalText } from "../ui/terminal.js";
import { withCommandSignal } from "../utils/command-signal.js";
import * as output from "../utils/output.js";

function repeat(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function formatPlatformError(error: unknown): string {
  const message = sanitizeTerminalText(error instanceof Error ? error.message : String(error)).slice(0, 16 * 1024);
  if (!(error instanceof PlatformClientError)) return message;
  const details = [
    error.status === undefined ? undefined : `HTTP status: ${error.status}`,
    error.runId ? `Run ID: ${sanitizeTerminalText(error.runId).slice(0, 512)}` : undefined,
    error.jobId ? `Job ID: ${sanitizeTerminalText(error.jobId).slice(0, 512)}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return details.length ? `${message}\n${details.join("\n")}` : message;
}

function fail(error: unknown): void {
  output.error(formatPlatformError(error));
  process.exitCode = 1;
}

function interactivePrompt(signal?: AbortSignal): ((field: WorkflowInputField) => Promise<string>) | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return (field) => promptInput({
    message: `${sanitizeTerminalText(field.schema.title ?? field.name)}${field.required ? "" : " (Enter uses default)"}:`,
  }, { signal });
}

export async function loadPlatformTemplateAndInput(
  client: PlatformClient,
  workflowId: string,
  pairs: string[],
  prompt?: (field: WorkflowInputField) => Promise<string>,
  signal?: AbortSignal,
): Promise<{ template: PlatformTemplate; input: Record<string, unknown> }> {
  const template = await getPlatformTemplateById(client, workflowId, { signal });
  const input = await collectPlatformTemplateInput(template, pairs, prompt ?? interactivePrompt(signal));
  return { template, input };
}

export function formatRemotePlatformResult(result: PlatformRunResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);
  if (result.status === "completed") {
    return typeof result.output === "string" ? sanitizeTerminalText(result.output) : JSON.stringify(result.output ?? {}, null, 2);
  }
  const detail = result.error?.message ?? `${result.status[0].toUpperCase()}${result.status.slice(1)} remote run.`;
  throw new PlatformClientError(sanitizeTerminalText(detail), `remote_${result.status}`, undefined, false, result.runId, result.jobId);
}

export async function runRemotePlatformTemplate(
  workflowId: string,
  pairs: string[],
  options: { signal?: AbortSignal; onProgress?: (message: string) => void } = {},
): Promise<PlatformRunResult> {
  const client = await createPlatformClientFromConfig();
  const { template, input } = await loadPlatformTemplateAndInput(client, workflowId, pairs, undefined, options.signal);
  return client.runTemplate(template, input, {
    signal: options.signal,
    onProgress: (event) => {
      const label = event.message ?? event.nodeName ?? event.type;
      options.onProgress?.(sanitizeTerminalText(label));
    },
  });
}

export const templatesCommand = new Command("templates")
  .description("Browse and run authorized platform templates");

templatesCommand
  .command("login")
  .description("Save a verified platform API key")
  .requiredOption("--url <https-origin>", "AceTeam platform origin")
  .action(async (options: { url: string }) => {
    try {
      const origin = normalizePlatformOrigin(options.url);
      const apiKey = (await password({ message: "Platform API key:", mask: "*" })).trim();
      if (!apiKey) throw new Error("Platform API key is required.");
      const spinner = ora("Verifying platform access...").start();
      try {
        const client = new PlatformClient(origin, apiKey);
        await client.listTemplates();
        await savePlatformCredentials({ origin, apiKey });
        spinner.succeed("Platform credentials verified and saved");
      } catch (error) {
        spinner.fail("Platform verification failed");
        throw error;
      }
    } catch (error) {
      fail(error);
    }
  });

templatesCommand
  .command("logout")
  .description("Remove saved platform credentials")
  .action(async () => {
    try {
      const removed = await removePlatformCredentials();
      const environmentActive = Boolean(process.env.ACETEAM_PLATFORM_URL && process.env.ACETEAM_PLATFORM_API_KEY);
      if (removed) output.success("Stored platform credentials removed");
      else output.info("No stored platform credentials found");
      if (environmentActive) output.warn("Platform environment credentials remain active for this process.");
    } catch (error) {
      fail(error);
    }
  });

templatesCommand
  .command("list")
  .description("List authorized platform template metadata")
  .option("--category <category>", "Filter by category")
  .option("--json", "Output JSON")
  .action(async (options: { category?: string; json?: boolean }) => {
    try {
      const client = await createPlatformClientFromConfig();
      const templates = await client.listTemplates({ category: options.category });
      if (options.json) console.log(JSON.stringify(templates, null, 2));
      else if (templates.length === 0) output.info("No platform templates found");
      else output.printTable(["UUID", "Version", "Title", "Category"], templates.map((item) => [
        item.workflowId,
        String(item.versionNumber),
        sanitizeTerminalText(item.title),
        sanitizeTerminalText(item.category ?? ""),
      ]));
    } catch (error) {
      fail(error);
    }
  });

templatesCommand
  .command("run <uuid>")
  .description("Run an authorized platform template locally")
  .option("-i, --input <key=value>", "Workflow input (repeatable)", repeat, [])
  .option("--json", "Output JSON")
  .action(async (workflowId: string, options: { input: string[]; json?: boolean }) => {
    await withCommandSignal(async (signal) => {
      let spinner: ReturnType<typeof ora> | undefined;
      try {
        const client = await createPlatformClientFromConfig();
        const { template, input } = await loadPlatformTemplateAndInput(client, workflowId, options.input, undefined, signal);
        spinner = ora(`Running ${sanitizeTerminalText(template.title)} locally...`).start();
        const result = await runPlatformTemplateLocally(client, template, input, {
          signal,
          onSetupProgress: (message) => { if (spinner) spinner.text = sanitizeTerminalText(message); },
          onProgress: (event) => { if (spinner) spinner.text = sanitizeTerminalText(event.nodeName ?? event.type); },
        });
        if (!result.success) throw new Error(result.error ?? "Workflow failed.");
        spinner.succeed("Local template run completed");
        console.log(options.json ? JSON.stringify(result, null, 2) : JSON.stringify(result.output ?? {}, null, 2));
      } catch (error) {
        spinner?.fail("Local template run failed");
        fail(error);
      }
    });
  });
