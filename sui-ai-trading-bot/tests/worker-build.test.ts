import { expect, it } from "vitest";
import { resolveWorkerBuild } from "../apps/worker/src/buildInfo.ts";

it("prefers an explicit SUIBA_BUILD stamp over git", () => {
  expect(
    resolveWorkerBuild({ SUIBA_BUILD: " pkg-1.2 " }, () => "abc1234"),
  ).toBe("pkg-1.2");
});

it("falls back to the git HEAD, and to unknown when neither works", () => {
  expect(resolveWorkerBuild({}, () => "abc1234\n")).toBe("abc1234");
  expect(resolveWorkerBuild({}, () => "")).toBe("unknown");
  expect(
    resolveWorkerBuild({}, () => {
      throw new Error("no git");
    }),
  ).toBe("unknown");
});
