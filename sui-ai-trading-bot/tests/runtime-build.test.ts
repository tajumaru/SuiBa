import { expect, it } from "vitest";
import { runtimeBuild, digest } from "../apps/worker/src/runtime-build.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { ValidationRecorder } from "../apps/worker/src/validation.ts";
it("records only fixed provenance fields and seals the session's initial settings hash", () => {
  const build = runtimeBuild(
    {
      SUIBA_BUILD_SHA: "a".repeat(40),
      SUIBA_IMAGE_ID: "sha256:" + "b".repeat(64),
      ADMIN_TOKEN: "never-record-this",
    },
    "fixture-lock",
  );
  expect(JSON.stringify(build)).not.toContain("never-record-this");
  expect(build.lockSha256).toBe(digest("fixture-lock"));
  const db = new BotDatabase(":memory:");
  try {
    db.set("runtime_build", build);
    const r = new ValidationRecorder(db);
    r.begin();
    const first = r.session()!.build!;
    expect(first.settingsSha256).toBe(digest(JSON.stringify(db.settings())));
    db.set("runtime_build", runtimeBuild({}, "different-lock"));
    db.updateSettings({ ...db.settings(), maxOrder: 2 });
    expect(r.session()!.build).toEqual(first);
  } finally {
    db.close();
  }
});
it("does not invent provenance when omitted and rejects malformed declarations", () => {
  expect(runtimeBuild({}, "lock")).toMatchObject({
    declaredSha: null,
    declaredImage: null,
  });
  expect(() => runtimeBuild({ SUIBA_BUILD_SHA: "not-a-sha" }, "lock")).toThrow(
    "INVALID_BUILD_SHA",
  );
  expect(() => runtimeBuild({ SUIBA_IMAGE_ID: "mutable-tag" }, "lock")).toThrow(
    "INVALID_IMAGE_ID",
  );
});

it("keeps a build change across restart as an integrity fault instead of validating mixed versions", () => {
  const db = new BotDatabase(":memory:");
  try {
    const build = runtimeBuild(
      {
        SUIBA_BUILD_SHA: "a".repeat(40),
        SUIBA_IMAGE_ID: "sha256:" + "b".repeat(64),
      },
      "lock",
    );
    db.set("runtime_build", build);
    const r = new ValidationRecorder(db);
    r.begin();
    r.closed();
    db.set("runtime_build", { ...build, declaredSha: "c".repeat(40) });
    r.boot();
    expect(r.report().integrityFault).toBe("EXECUTION_BUILD_CHANGED");
    expect(r.session()!.build!.declaredSha).toBe(build.declaredSha);
  } finally {
    db.close();
  }
});
