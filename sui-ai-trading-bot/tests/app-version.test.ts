import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  fetchServedVersion,
  parseServedVersion,
  updateAvailable,
  versionSkew,
} from "../apps/dashboard/src/appVersion.ts";
import {
  UpdateBanner,
  VersionFooter,
} from "../apps/dashboard/src/VersionFooter.tsx";

it("parses only well-formed version payloads", () => {
  expect(
    parseServedVersion({ build: "abc1234", subject: "件名", builtAt: "t" }),
  ).toEqual({ build: "abc1234", subject: "件名", builtAt: "t" });
  expect(parseServedVersion({ build: "" })).toBeNull();
  expect(parseServedVersion({ subject: "x" })).toBeNull();
  expect(parseServedVersion(null)).toBeNull();
  expect(parseServedVersion("abc1234")).toBeNull();
});

it("raises an update only for two different real build ids", () => {
  const served = { build: "bbb2222", subject: "", builtAt: "" };
  expect(updateAvailable("aaa1111", served)).toBe(true);
  expect(updateAvailable("bbb2222", served)).toBe(false);
  expect(updateAvailable("dev", served)).toBe(false);
  expect(updateAvailable("aaa1111", { ...served, build: "dev" })).toBe(false);
  expect(updateAvailable("aaa1111", null)).toBe(false);
});

it("fetches version.json without cache and tolerates failure", async () => {
  const ok = (async (url: string, init?: RequestInit) => {
    expect(url).toBe("version.json");
    expect(init?.cache).toBe("no-store");
    return {
      ok: true,
      json: async () => ({ build: "abc1234", subject: "s", builtAt: "t" }),
    };
  }) as unknown as typeof fetch;
  expect(await fetchServedVersion(ok)).toEqual({
    build: "abc1234",
    subject: "s",
    builtAt: "t",
  });
  const missing = (async () => ({
    ok: false,
    json: async () => ({}),
  })) as unknown as typeof fetch;
  expect(await fetchServedVersion(missing)).toBeNull();
  const down = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  expect(await fetchServedVersion(down)).toBeNull();
});

it("renders the banner with the new build and the footer with this build", () => {
  const banner = renderToStaticMarkup(
    React.createElement(UpdateBanner, {
      served: { build: "bbb2222", subject: "新機能", builtAt: "" },
    }),
  );
  expect(banner).toContain("新しい版（bbb2222）があります");
  expect(banner).toContain("新機能");
  expect(banner).toContain("再読み込み");
  const footer = renderToStaticMarkup(React.createElement(VersionFooter));
  expect(footer).toContain("SuiBa 画面 dev");
});

it("flags a skew only between two different real build stamps", () => {
  expect(versionSkew("aaa1111", "bbb2222")).toBe(true);
  expect(versionSkew("aaa1111", "aaa1111")).toBe(false);
  expect(versionSkew("dev", "bbb2222")).toBe(false);
  expect(versionSkew("aaa1111", "unknown")).toBe(false);
  expect(versionSkew("aaa1111", null)).toBe(false);
  expect(versionSkew("aaa1111", undefined)).toBe(false);
  const footer = renderToStaticMarkup(
    React.createElement(VersionFooter, { workerBuild: "abc1234" }),
  );
  expect(footer).toContain("Bot abc1234");
  // In tests the page build is "dev", so no skew warning renders.
  expect(footer).not.toContain("版がズレています");
});
