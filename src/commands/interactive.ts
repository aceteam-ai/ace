import React from "react";
import { render } from "ink";
import { App, type WorkspacePanel } from "../ui/App.js";
import { TerminalSession } from "../ui/terminal.js";
import { taskService, type WorkspaceTaskService } from "../ui/task-service.js";

export interface InteractiveOptions {
  service?: WorkspaceTaskService;
  panels?: WorkspacePanel[];
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

/** Start the reusable terminal workspace without terminating the host process. */
export async function startInteractive(options: InteractiveOptions = {}): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Interactive mode needs a TTY. Run `ace --help` for command-line usage.");
  }

  const terminal = new TerminalSession(stdin as NodeJS.ReadStream & { setRawMode(mode: boolean): void }, stdout);
  let instance: ReturnType<typeof render> | undefined;
  const shutdown = new AbortController();
  terminal.enter(() => shutdown.abort());
  try {
    instance = render(
      React.createElement(App, { service: options.service ?? taskService, panels: options.panels, onExit: () => instance?.unmount(), shutdownSignal: shutdown.signal }),
      { stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false }
    );
    await instance.waitUntilExit();
  } finally {
    terminal.restore();
  }
}
