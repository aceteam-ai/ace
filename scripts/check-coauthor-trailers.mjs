#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const marker = /co-authored-by\s*:/i;
const trailer = /^co-authored-by\s*:/im;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function requireSha(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`Missing or invalid ${field} SHA in pull request event`);
  }
  return value;
}

function main() {
  if (!process.env.GITHUB_EVENT_PATH) {
    throw new Error("GITHUB_EVENT_PATH is required");
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request;
  if (!pr) {
    throw new Error("A pull_request event is required");
  }

  const base = requireSha(pr.base?.sha, "base");
  const head = requireSha(pr.head?.sha, "head");
  const mergeBase = git("merge-base", base, head);
  const commits = git("rev-list", `${mergeBase}..${head}`).split("\n").filter(Boolean);
  const offenders = [];

  for (const sha of commits) {
    const message = execFileSync("git", ["show", "-s", "--format=%B", sha], {
      encoding: "utf8",
    });
    const parsed = execFileSync("git", ["interpret-trailers", "--parse"], {
      input: message,
      encoding: "utf8",
    });
    if (trailer.test(parsed)) {
      offenders.push(`commit ${sha}`);
    }
  }
  if (marker.test(pr.title ?? "")) offenders.push("PR title");
  if (marker.test(pr.body ?? "")) offenders.push("PR body");

  if (offenders.length > 0) {
    console.error(`Co-author attribution is forbidden in ${offenders.join(", ")}.`);
    console.error("Amend the named commits or reword the PR title/body without the attribution trailer, then push again.");
    process.exitCode = 1;
  } else {
    console.log(`Checked ${commits.length} PR commit(s) and the squash-message inputs: clean.`);
  }
}

try {
  main();
} catch (error) {
  console.error(`Cannot check PR attribution: ${error.message}`);
  process.exitCode = 1;
}
