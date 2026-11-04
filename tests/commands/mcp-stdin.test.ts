import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readToolJsonStdin } from "../../src/commands/control-plane.js";

describe("MCP JSON standard input", () => {
  it("joins split UTF-8 chunks", async () => {
    const input = Buffer.from('{"message":"é"}');
    const stream = Readable.from([input.subarray(0, 13), input.subarray(13, 14), input.subarray(14)]);
    expect(await readToolJsonStdin(stream)).toBe('{"message":"é"}');
  });

  it("rejects an empty pipe", async () => {
    await expect(readToolJsonStdin(Readable.from([]))).rejects.toMatchObject({
      exitCode: 2,
      message: "Standard input is empty.",
    });
  });

  it("rejects oversized input", async () => {
    await expect(readToolJsonStdin(Readable.from([Buffer.alloc(1_048_577)]))).rejects.toMatchObject({
      exitCode: 2,
      message: "The JSON input exceeds 1 MiB.",
    });
  });
});
