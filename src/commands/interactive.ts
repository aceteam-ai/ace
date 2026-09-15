import React from "react";
import { render } from "ink";
import { App, type WorkspacePanel } from "../ui/App.js";
import { TerminalSession } from "../ui/terminal.js";
import { createPlatformTemplatesPanel } from "../ui/PlatformTemplatesPanel.js";
import { createNativeSessionsPanel } from "../ui/NativeSessionsPanel.js";
import { runLauncherAction, type LauncherAction } from "../launcher.js";
import { taskService, type WorkspaceTaskService } from "../ui/task-service.js";

export interface InteractiveOptions {
  service?: WorkspaceTaskService;
  panels?: WorkspacePanel[];
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  launcher?: boolean;
  runAction?: typeof runLauncherAction;
}

/** Start the reusable terminal workspace without terminating the host process. */
export async function startInteractive(options: InteractiveOptions = {}): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Interactive mode needs a TTY. Run `ace --help` for command-line usage.");
  }

  const panels = options.panels ?? [createNativeSessionsPanel(), createPlatformTemplatesPanel()];
  const terminal = new TerminalSession(stdin as NodeJS.ReadStream & { setRawMode(mode: boolean): void }, stdout);
  let instance: ReturnType<typeof render> | undefined;
  const shutdown = new AbortController();
  let action: LauncherAction | undefined;
  terminal.enter(() => shutdown.abort());
  try {
    instance = render(
      React.createElement(App, { service: options.service ?? taskService, panels, launcher: options.launcher ?? true, onExternalAction: (next: LauncherAction) => { action = next; }, onExit: () => instance?.unmount(), shutdownSignal: shutdown.signal }),
      { stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false }
    );
    await instance.waitUntilExit();
  } finally {
    await Promise.allSettled(panels.map((panel) => Promise.resolve().then(() => panel.dispose?.())));
    instance?.unmount();
    terminal.restore();
  }
  if (action) {
    const code = await (options.runAction ?? runLauncherAction)(action, { stdin, stdout, stderr });
    if (code !== 0) throw new Error(`${action.harness.name} ${action.kind} exited with code ${code}`);
  }
}
