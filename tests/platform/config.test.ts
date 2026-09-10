import { afterEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizePlatformOrigin,
  readPlatformCredentials,
  removePlatformCredentials,
  resolvePlatformCredentials,
  savePlatformCredentials,
} from "../../src/platform/config.js";

const roots: string[] = [];
async function fixturePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ace-platform-config-test-"));
  roots.push(root);
  return join(root, "private", "credentials.json");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("platform origin validation", () => {
  it("accepts HTTPS origins and explicit loopback HTTP only", () => {
    expect(normalizePlatformOrigin("https://EXAMPLE.com:443/")).toBe("https://example.com");
    expect(normalizePlatformOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(() => normalizePlatformOrigin("http://example.com")).toThrow("HTTPS");
  });

  it.each([
    "https://user@example.com",
    "https://example.com/path",
    "https://example.com?org=x",
    "https://example.com/#fragment",
  ])("rejects non-origin URL configuration: %s", (value) => {
    expect(() => normalizePlatformOrigin(value)).toThrow("origin");
  });
});

describe("private platform credentials", () => {
  it("writes an atomic complete pair with private modes and reads it back", async () => {
    const path = await fixturePath();
    await savePlatformCredentials({ origin: "https://platform.example/", apiKey: " synthetic-key " }, path);
    await expect(readPlatformCredentials(path)).resolves.toEqual({ origin: "https://platform.example", apiKey: "synthetic-key" });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(path, ".."))).mode & 0o777).toBe(0o700);
    expect(await readFile(path, "utf8")).toBe(JSON.stringify({ origin: "https://platform.example", apiKey: "synthetic-key" }) + "\n");
    expect((await readdir(join(path, ".."))).filter((name) => name !== "credentials.json")).toEqual([]);
  });

  it("resolves only complete environment pairs and keeps origins separate", async () => {
    const path = await fixturePath();
    await savePlatformCredentials({ origin: "https://stored.example", apiKey: "stored-key" }, path);
    await expect(resolvePlatformCredentials({
      credentialsPath: path,
      env: { ACETEAM_PLATFORM_URL: "https://override.example", ACETEAM_PLATFORM_API_KEY: "override-key" },
    })).resolves.toEqual({ origin: "https://override.example", apiKey: "override-key" });
    await expect(resolvePlatformCredentials({ credentialsPath: path, env: { ACETEAM_PLATFORM_URL: "https://override.example" } })).rejects.toThrow("must be set together");
  });

  it("rejects public, symlink, directory, and oversized credential files without replacing valid data", async () => {
    const path = await fixturePath();
    await savePlatformCredentials({ origin: "https://platform.example", apiKey: "valid-key" }, path);
    await expect(savePlatformCredentials({ origin: "https://platform.example/path", apiKey: "bad" }, path)).rejects.toThrow("origin");
    await expect(readPlatformCredentials(path)).resolves.toMatchObject({ apiKey: "valid-key" });

    await chmod(path, 0o644);
    await expect(readPlatformCredentials(path)).rejects.toThrow("0600");
    await chmod(path, 0o600);

    const link = join(path, "..", "linked.json");
    await symlink(path, link);
    await expect(readPlatformCredentials(link)).rejects.toThrow("regular file");

    const directory = join(path, "..", "directory.json");
    await mkdir(directory);
    await expect(readPlatformCredentials(directory)).rejects.toThrow("regular file");

    const tooLarge = join(path, "..", "large.json");
    await writeFile(tooLarge, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
    await expect(readPlatformCredentials(tooLarge)).rejects.toThrow("too large");
  });

  it("removes only the stored credential file", async () => {
    const path = await fixturePath();
    await savePlatformCredentials({ origin: "https://platform.example", apiKey: "key" }, path);
    await expect(removePlatformCredentials(path)).resolves.toBe(true);
    await expect(removePlatformCredentials(path)).resolves.toBe(false);
  });
});
