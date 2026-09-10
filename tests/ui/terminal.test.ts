import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { sanitizeTerminalText, TerminalSession } from "../../src/ui/terminal.js";

class Input extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode = vi.fn((mode: boolean) => { this.isRaw = mode; return this; });
}
class Output extends EventEmitter {
  writes: string[] = [];
  write = vi.fn((text: string) => { this.writes.push(text); return true; });
}

describe("terminal lifecycle", () => {
  it("restores raw mode, cursor, and alternate screen exactly once", () => {
    const input = new Input();
    const output = new Output();
    const session = new TerminalSession(input as never, output as never);
    session.enter(vi.fn());
    input.isRaw = true;
    session.restore();
    session.restore();
    expect(output.write).toHaveBeenCalledTimes(2);
    expect(output.writes[0]).toContain("?1049h");
    expect(output.writes[1]).toContain("?1049l");
    expect(input.setRawMode).toHaveBeenCalledOnce();
    expect(input.setRawMode).toHaveBeenCalledWith(false);
  });

  it("routes SIGINT to the supplied shutdown callback", () => {
    const input = new Input();
    const output = new Output();
    const shutdown = vi.fn();
    const session = new TerminalSession(input as never, output as never);
    session.enter(shutdown);
    const listenersBefore = process.listenerCount("SIGINT");
    process.emit("SIGINT");
    expect(shutdown).toHaveBeenCalledOnce();
    expect(output.writes.at(-1)).toContain("?1049l");
    expect(output.write).toHaveBeenCalledTimes(2);
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
    session.restore();
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore - 1);
  });

  it("removes ANSI and OSC controls from external text", () => {
    expect(sanitizeTerminalText("ok\u001b[31m red\u001b[0m \u001b]8;;https://bad.invalid\u0007link\u001b]8;;\u0007"))
      .toBe("ok red link");
  });
});
