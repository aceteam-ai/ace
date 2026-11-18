import { expect, it } from "vitest";
import { planRelease } from "../../scripts/release-plan.mjs";

const sourceSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const registry = {
  "dist-tags": { latest: "0.3.0" },
  versions: { "0.3.0": {} },
};

it("publishes and tags a new version", () => {
  expect(planRelease("0.4.0", registry, false, sourceSha)).toEqual({ version: "0.4.0", publish: true, release: true });
});

it("skips a version already published and tagged", () => {
  expect(planRelease("0.3.0", registry, true, sourceSha, sourceSha)).toEqual({ version: "0.3.0", publish: false, release: false });
});

it("recovers a release only when the npm source is this checkout", () => {
  const published = { ...registry, versions: { "0.3.0": { gitHead: sourceSha } } };
  expect(planRelease("0.3.0", published, false, sourceSha, sourceSha)).toEqual({
    version: "0.3.0", publish: false, release: true,
  });
});

it("refuses recovery when the npm source differs", () => {
  const published = { ...registry, versions: { "0.3.0": { gitHead: otherSha } } };
  expect(() => planRelease("0.3.0", published, false, sourceSha)).toThrow("npm source commit differs");
});

it("refuses recovery without npm source evidence", () => {
  expect(() => planRelease("0.3.0", registry, false, sourceSha)).toThrow("no source commit");
});

it("refuses a conflicting existing GitHub tag", () => {
  expect(() => planRelease("0.4.0", registry, false, sourceSha, otherSha)).toThrow("tag points to another commit");
});

it("refuses a GitHub release whose tag is missing", () => {
  expect(() => planRelease("0.3.0", registry, true, sourceSha)).toThrow("without its tag");
});

it("refuses to publish behind npm latest", () => {
  expect(() => planRelease("0.2.0", registry, false, sourceSha)).toThrow("Refusing to publish");
});
