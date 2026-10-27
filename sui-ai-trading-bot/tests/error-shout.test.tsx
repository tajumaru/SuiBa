import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  errorShout,
  type SafetyLike,
} from "../apps/dashboard/src/errorShout.ts";
import { AgentHeaderAvatar } from "../apps/dashboard/src/AgentNarration.tsx";

const main = readFileSync(resolve("apps/dashboard/src/main.tsx"), "utf8");

const safety = (patch: Partial<SafetyLike> = {}): SafetyLike => ({
  botState: "RUNNING",
  connectivity: "HEALTHY",
  ...patch,
});

describe("errorShout derivation", () => {
  it("shouts only for genuine error states", () => {
    expect(errorShout(safety(), false)).toBeNull();
    expect(
      errorShout(safety({ connectivity: "RECOVERING" }), false),
    ).toBeNull();
    expect(errorShout(safety({ botState: "MANUAL_STOP" }), false)).toBeNull();
    expect(errorShout(null, false)).toBeNull();
  });

  it("maps each error state to its fixed label and line", () => {
    expect(errorShout(safety({ botState: "EMERGENCY_STOP" }), false)).toEqual({
      kind: "emergency",
      label: "緊急停止中",
      message: "止まってるよ！",
    });
    expect(errorShout(safety({ botState: "ABNORMAL_STOP" }), false)).toEqual({
      kind: "abnormal",
      label: "安全停止中",
      message: "止まっちゃった！",
    });
    expect(errorShout(safety({ connectivity: "DEGRADED" }), false)).toEqual({
      kind: "connectivity",
      label: "通信異常",
      message: "つながらない…！",
    });
    expect(errorShout(null, true)).toEqual({
      kind: "unknown",
      label: "状態取得失敗",
      message: "確認できないよ",
    });
  });

  it("does not claim current stop or connectivity from stale evidence", () => {
    expect(errorShout(safety({ botState: "EMERGENCY_STOP" }), true)?.kind).toBe(
      "unknown",
    );
    expect(errorShout(safety({ botState: "ABNORMAL_STOP" }), true)?.kind).toBe(
      "unknown",
    );
    expect(errorShout(safety({ connectivity: "DEGRADED" }), true)?.kind).toBe(
      "unknown",
    );
  });
});

describe("header avatar shout rendering", () => {
  const shout = errorShout(safety({ botState: "EMERGENCY_STOP" }), false);

  it("screams with a bubble and an alert pill, whatever the pose was", () => {
    const html = renderToStaticMarkup(
      <AgentHeaderAvatar pose="sleep" shout={shout} />,
    );
    expect(html).toContain("pose-normal shouting");
    expect(html).toContain('data-pose="normal"');
    expect(html).toContain("agent-avatar-scream");
    expect(html).toContain("agent-avatar-bubble");
    expect(html).toContain("止まってるよ！");
    expect(html).toContain("agent-avatar-pill shout");
    expect(html).toContain("緊急停止中");
  });

  it("stays quiet without an error state", () => {
    const html = renderToStaticMarkup(
      <AgentHeaderAvatar pose="sleep" shout={null} />,
    );
    expect(html).not.toContain("shouting");
    expect(html).not.toContain("agent-avatar-scream");
    expect(html).not.toContain("agent-avatar-bubble");
  });

  it("is wired from the app shell's safety snapshot and fetch error", () => {
    expect(main).toContain("errorShout(data?.safety ?? null, stateStale)");
    expect(main).toContain("shout={shout}");
  });
});
