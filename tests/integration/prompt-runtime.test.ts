import { PassThrough } from "node:stream";
import { confirm, input, password, select } from "@inquirer/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";

// Exercise the installed dependency on each CI Node version. Mocked command
// tests cannot detect import-time failures or incompatible interactive APIs.
const fixtures: Array<{ stdin: PassThrough; stdout: PassThrough; controller: AbortController }> = [];
const pending: Promise<unknown>[] = [];

function terminal() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const controller = new AbortController();
  let rendered = "";
  stdout.on("data", (chunk: Buffer) => { rendered += chunk.toString(); });
  fixtures.push({ stdin, stdout, controller });
  return {
    context: { input: stdin, output: stdout, signal: controller.signal },
    write: (value: string) => stdin.write(value),
    rendered: () => rendered,
  };
}

function track<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
}

afterEach(async () => {
  for (const fixture of fixtures) fixture.controller.abort();
  await Promise.allSettled(pending.splice(0));
  for (const fixture of fixtures.splice(0)) {
    fixture.stdin.destroy();
    fixture.stdout.destroy();
  }
});

describe("installed interactive prompt compatibility", () => {
  it("accepts typed input through the public prompt API", async () => {
    const view = terminal();
    const answer = track(input({ message: "Synthetic label:" }, view.context));
    await vi.waitFor(() => expect(view.rendered()).toContain("Synthetic label:"));
    view.write("fixture text\n");
    await expect(answer).resolves.toBe("fixture text");
  });

  it("returns the selected value from described choices", async () => {
    const view = terminal();
    const answer = track(select({
      message: "Synthetic choice:",
      choices: [
        { name: "First", value: "first", description: "First fixture choice" },
        { name: "Second", value: "second", description: "Second fixture choice" },
      ],
    }, view.context));
    await vi.waitFor(() => expect(view.rendered()).toContain("Synthetic choice:"));
    view.write("\u001b[B\n");
    await expect(answer).resolves.toBe("second");
  });

  it("validates password input and keeps synthetic values out of its output", async () => {
    const view = terminal();
    const answer = track(password({
      message: "Synthetic password:",
      validate: (value) => value.trim() ? true : "A fixture value is required",
    }, view.context));
    await vi.waitFor(() => expect(view.rendered()).toContain("Synthetic password:"));
    view.write("\n");
    await vi.waitFor(() => expect(view.rendered()).toContain("A fixture value is required"));
    view.write("synthetic-not-a-credential\n");
    await expect(answer).resolves.toBe("synthetic-not-a-credential");
    expect(view.rendered()).not.toContain("synthetic-not-a-credential");
  });

  it("honors an explicit decline even when confirmation defaults to yes", async () => {
    const view = terminal();
    const answer = track(confirm({ message: "Synthetic confirmation?", default: true }, view.context));
    await vi.waitFor(() => expect(view.rendered()).toContain("Synthetic confirmation?"));
    view.write("n\n");
    await expect(answer).resolves.toBe(false);
  });

  it("rejects an explicit Ctrl+C without accepting a default", async () => {
    const view = terminal();
    const answer = track(confirm({ message: "Synthetic cancellation?", default: true }, view.context));
    await vi.waitFor(() => expect(view.rendered()).toContain("Synthetic cancellation?"));
    view.write("\u0003");
    await expect(answer).rejects.toMatchObject({ name: "ExitPromptError" });
  });
});
