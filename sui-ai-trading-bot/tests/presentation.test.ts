import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import {
  dateTime,
  number,
  percent,
  label,
  reason,
  nextStep,
  errorCode,
} from "../apps/dashboard/src/presentation.ts";
import { Reason } from "../apps/dashboard/src/Reason.tsx";

describe("日本語の表示", () => {
  it("maps decisions without changing their internal values", () => {
    const actions = ["BUY", "SELL", "WAIT"];
    expect(actions.map(label)).toEqual(["買い", "売り", "見送り"]);
    expect(actions).toEqual(["BUY", "SELL", "WAIT"]);
    expect(label("UNKNOWN")).toBe("未確認");
  });
  it("formats ratios and missing values while retaining decimal precision", () => {
    expect(number(1234.5678)).toBe("1,234.5678");
    expect(number("12345678901234567890.000001")).toBe(
      "12,345,678,901,234,567,890.000001",
    );
    expect(percent(0.015)).toBe("1.5%");
    expect(number(null)).toBe("—");
    expect(number(NaN)).toBe("—");
    expect(percent(null)).toBe("—");
  });
  it("uses Japan time independent of the machine timezone", () => {
    expect(dateTime(Date.UTC(2026, 0, 1, 15))).toBe(
      "2026/01/02 00:00:00（日本時間）",
    );
    expect(dateTime("invalid")).toBe("日時不明");
    expect(dateTime(null)).toBe("未取得");
  });
  it("shows Japanese first, preserves diagnostic codes and explains recovery", () => {
    const html = renderToStaticMarkup(
      React.createElement(Reason, { code: "UPSTREAM_HTTP_429" }),
    );
    expect(html.indexOf("APIの利用制限")).toBeLessThan(
      html.indexOf("コード："),
    );
    expect(html).toContain("UPSTREAM_HTTP_429");
    expect(reason("FUTURE_ERROR")).toContain("確認できません");
    expect(reason("条件未成立")).toBe("条件未成立");
    expect(nextStep("UPSTREAM_HTTP_429")).toContain("次回再試行可能時刻");
    expect(nextStep("PAPER_RECONCILIATION_FAILED")).toContain("照合記録");
    expect(errorCode(new Error("sensitive arbitrary upstream text"))).toBe(
      "REQUEST_FAILED",
    );
  });
});
