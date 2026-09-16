import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isMainModule } from "../../src/index.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CLI entry detection", () => {
  it("recognizes a symlinked package bin as the bundled entry module", () => {
    const directory = mkdtempSync(join(tmpdir(), "ace-cli-entry-"));
    directories.push(directory);
    const bundledEntry = join(directory, "package", "dist", "index.js");
    mkdirSync(join(directory, "package", "dist"), { recursive: true });
    mkdirSync(join(directory, "bin"));
    writeFileSync(bundledEntry, "// synthetic entry\n");
    const linkedBin = join(directory, "bin", "ace");
    symlinkSync(bundledEntry, linkedBin);

    expect(isMainModule(new URL(`file://${bundledEntry}`).href, linkedBin)).toBe(true);
  });

  it("does not treat a missing argv entry as the main module", () => {
    expect(isMainModule(import.meta.url, "/missing/ace-entry")).toBe(false);
  });
});
