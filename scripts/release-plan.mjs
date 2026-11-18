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

export function planRelease(version, registry, releaseExists, sourceSha, tagSha = null) {
  if (!/^[a-f0-9]{40}$/i.test(sourceSha ?? "")) {
    throw new Error("A full source commit SHA is required");
  }
  const latest = registry["dist-tags"]?.latest;
  const published = Object.hasOwn(registry.versions ?? {}, version);
  if (!published && latest && compareStableVersions(version, latest) <= 0) {
    throw new Error(`Refusing to publish ${version}: npm latest is ${latest}`);
  }
  if (published && !releaseExists) {
    const publishedHead = registry.versions[version]?.gitHead;
    if (!/^[a-f0-9]{40}$/i.test(publishedHead ?? "")) {
      throw new Error(`Cannot recover ${version}: npm publication has no source commit`);
    }
    if (publishedHead.toLowerCase() !== sourceSha.toLowerCase()) {
      throw new Error(`Cannot recover ${version}: npm source commit differs from this checkout`);
    }
  }
  if (tagSha !== null && tagSha.toLowerCase() !== sourceSha.toLowerCase()) {
    throw new Error(`Refusing ${version}: existing GitHub tag points to another commit`);
  }
  if (releaseExists && tagSha === null) {
    throw new Error(`Refusing ${version}: GitHub release exists without its tag`);
  }
  return { version, publish: !published, release: !releaseExists };
}

async function githubGet(path) {
  const response = await fetch(`https://api.github.com/repos/aceteam-ai/ace/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ace-release-plan",
      ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub lookup failed with HTTP ${response.status}`);
  return response.json();
}

async function tagCommitSha(version) {
  const ref = await githubGet(`git/ref/tags/v${version}`);
  if (!ref) return null;
  let object = ref.object;
  for (let depth = 0; depth < 3 && object?.type === "tag"; depth++) {
    const tag = await githubGet(`git/tags/${object.sha}`);
    if (!tag) throw new Error(`GitHub tag v${version} could not be resolved`);
    object = tag.object;
  }
  if (object?.type !== "commit" || !/^[a-f0-9]{40}$/i.test(object.sha ?? "")) {
    throw new Error(`GitHub tag v${version} does not resolve to a commit`);
  }
  return object.sha;
}

async function main() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const version = pkg.version;
  compareStableVersions(version, version);
  const response = await fetch("https://registry.npmjs.org/@aceteam%2face", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`npm registry lookup failed with HTTP ${response.status}`);
  const registry = await response.json();
  const [release, tagSha] = await Promise.all([
    githubGet(`releases/tags/v${version}`),
    tagCommitSha(version),
  ]);
  const plan = planRelease(version, registry, release !== null, process.env.GITHUB_SHA, tagSha);
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
