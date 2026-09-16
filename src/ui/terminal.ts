import stripAnsi from "strip-ansi";
import type { ReadStream, WriteStream } from "node:tty";

const ENTER_ALT = "\u001B[?1049h\u001B[?25l";
const LEAVE_ALT = "\u001B[?25h\u001B[?1049l";

export class TerminalSession {
  private visualsRestored = false;
  private cleaned = false;
  private interrupted = false;
  private readonly wasRaw: boolean;
  private signalHandler?: () => void;

  constructor(private readonly input: ReadStream, private readonly output: WriteStream) {
    this.wasRaw = Boolean(input.isRaw);
  }

  enter(onInterrupt: () => void): void {
    this.output.write(ENTER_ALT);
    this.signalHandler = () => {
      // Repair visuals synchronously, then keep consuming SIGINT until the
      // awaited shutdown completes and `restore()` removes this listener.
      this.restoreVisuals();
      if (!this.interrupted) {
        this.interrupted = true;
        onInterrupt();
      }
    };
    process.on("SIGINT", this.signalHandler);
  }

  private restoreVisuals(): void {
    if (this.visualsRestored) return;
    this.visualsRestored = true;
    if (this.input.isTTY && this.input.setRawMode && !this.wasRaw && this.input.isRaw) {
      this.input.setRawMode(false);
    }
    this.output.write(LEAVE_ALT);
  }

  restore(): void {
    this.restoreVisuals();
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.signalHandler) process.removeListener("SIGINT", this.signalHandler);
  }
}

export function supportsInteractiveTerminal(input: NodeJS.ReadStream, output: NodeJS.WriteStream): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

export function sanitizeTerminalText(value: string): string {
  return stripAnsi(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}
