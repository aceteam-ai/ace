import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/check-coauthor-trailers.mjs", import.meta.url));
const fixtures: string[] = [];

function fixture(message = "feat: clean change") {
  const root = mkdtempSync(join(tmpdir(), "ace-coauthor-guard-"));
  fixtures.push(root);
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: root };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();

  git("init", "-q");
  git("config", "user.name", "Fixture Author");
  git("config", "user.email", "fixture@example.test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "file"), "base\n");
  git("add", "file");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "file"), "change\n");
  git("add", "file");
  git("commit", "-q", "-m", message);
  const head = git("rev-parse", "HEAD");

  const run = (title = "Clean title", body = "Clean body") => {
    const eventPath = join(root, "event.json");
    writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head }, title, body } }));
    return spawnSync(process.execPath, [script], {
      cwd: root,
      env: { ...env, GITHUB_EVENT_PATH: eventPath },
      encoding: "utf8",
    });
  };
  return { run, head };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("passes a clean PR", () => {
  const result = fixture().run();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("clean");
});

it("names the commit with a case-insensitive co-author trailer", () => {
  const { run, head } = fixture("feat: change\n\ncO-AuThOrEd-By: Jason Sun <alias@example.test>");
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`commit ${head}`);
  expect(result.stderr).toContain("Amend");
});

it("rejects the title and body used by a default squash message", () => {
  const { run } = fixture();
  const result = run("Co-Authored-By: alias", "Notes\nco-authored-by: another alias");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("PR title");
  expect(result.stderr).toContain("PR body");
});
