import { expect, it } from "vitest";
import { planRelease } from "../../scripts/release-plan.mjs";

const registry = {
  "dist-tags": { latest: "0.3.0" },
  versions: { "0.3.0": {} },
};

it("publishes and tags a new version", () => {
  expect(planRelease("0.4.0", registry, false)).toEqual({ version: "0.4.0", publish: true, release: true });
});

it("skips a version already published and tagged", () => {
  expect(planRelease("0.3.0", registry, true)).toEqual({ version: "0.3.0", publish: false, release: false });
});

it("recovers a tag after publication without publishing twice", () => {
  expect(planRelease("0.3.0", registry, false)).toEqual({ version: "0.3.0", publish: false, release: true });
});

it("refuses to publish behind npm latest", () => {
  expect(() => planRelease("0.2.0", registry, false)).toThrow("Refusing to publish");
});
