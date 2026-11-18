#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";

export function compareStableVersions(left, right) {
  const parse = (value) => {
    if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
      throw new Error(`Expected a stable package version, got ${JSON.stringify(value)}`);
    }
    return value.split(".").map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  }
  return 0;
}

export function planRelease(version, registry, releaseExists) {
  const latest = registry["dist-tags"]?.latest;
  const published = Object.hasOwn(registry.versions ?? {}, version);
  if (!published && latest && compareStableVersions(version, latest) <= 0) {
    throw new Error(`Refusing to publish ${version}: npm latest is ${latest}`);
  }
  return { version, publish: !published, release: !releaseExists };
}

async function main() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const version = pkg.version;
  compareStableVersions(version, version);
  const response = await fetch("https://registry.npmjs.org/@aceteam%2face", {
    headers: { Accept: "application/vnd.npm.install-v1+json" },
  });
  if (!response.ok) throw new Error(`npm registry lookup failed with HTTP ${response.status}`);
  const registry = await response.json();
  const releaseResponse = await fetch(`https://api.github.com/repos/aceteam-ai/ace/releases/tags/v${version}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ace-release-plan",
      ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
    },
  });
  if (releaseResponse.status !== 200 && releaseResponse.status !== 404) {
    throw new Error(`GitHub release lookup failed with HTTP ${releaseResponse.status}`);
  }
  const plan = planRelease(version, registry, releaseResponse.status === 200);
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${plan.version}\npublish=${plan.publish}\nrelease=${plan.release}\n`);
  console.log(`Release ${version}: publish=${plan.publish}, release=${plan.release}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
