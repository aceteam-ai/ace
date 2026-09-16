import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
const render = vi.hoisted(() => vi.fn());
vi.mock("ink", async (original) => ({ ...await original<typeof import("ink")>(), render }));
import { startInteractive } from "../../src/commands/interactive.js";

function streams(tty = true) {
  const input = Object.assign(new EventEmitter(), { isTTY: tty, isRaw: false, setRawMode: vi.fn() });
  const output = Object.assign(new EventEmitter(), { isTTY: tty, write: vi.fn(() => true) });
  return { input, output, options: { stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream } };
}

describe("interactive native teardown", () => {
  it("rejects non-TTY use before rendering or disposing an unstarted panel", async () => {
    render.mockReset(); const { options } = streams(false); const dispose = vi.fn(async () => {});
    await expect(startInteractive({ ...options, panels: [{ id: "fixture", title: "Fixture", description: "Fixture", render: () => null, dispose }] })).rejects.toThrow("needs a TTY");
    expect(render).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
  });

  it("awaits all native cleanup and restores the terminal after a render error", async () => {
    const { output, options } = streams(); render.mockImplementationOnce(() => { throw new Error("Synthetic render failure"); });
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
    const dispose = vi.fn(() => pending); const listeners = process.listenerCount("SIGINT");
    const running = startInteractive({ ...options, panels: [
      { id: "throws", title: "Throws", description: "Fixture", render: () => null, dispose: () => { throw new Error("Synthetic cleanup failure"); } },
      { id: "wait", title: "Wait", description: "Fixture", render: () => null, dispose },
    ] });
    const assertion = expect(running).rejects.toThrow("Synthetic render failure");
    await Promise.resolve(); expect(dispose).toHaveBeenCalledOnce(); expect(output.write).toHaveBeenCalledTimes(1);
    release(); await assertion;
    expect(output.write).toHaveBeenLastCalledWith(expect.stringContaining("?1049l"));
    expect(process.listenerCount("SIGINT")).toBe(listeners);
  });
});
