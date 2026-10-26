import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  LoginScreen,
  type LoginLockPort,
  type VerifyResult,
} from "../apps/dashboard/src/LoginScreen.tsx";
import {
  PatternEnrollmentOffer,
  type EnrollmentPort,
} from "../apps/dashboard/src/PatternEnrollment.tsx";

const verifyOk = async (): Promise<VerifyResult> => ({ ok: true });

function lockPort(over: Partial<LoginLockPort> = {}): LoginLockPort {
  return {
    supported: () => true,
    enrolled: () => false,
    dismissed: () => false,
    unlock: async () => null,
    clear: () => {},
    undismiss: () => {},
    ...over,
  };
}

describe("login gate (token mode)", () => {
  it("keeps the gatekeeper asleep and the token form intact", () => {
    const html = renderToStaticMarkup(
      <LoginScreen
        verify={verifyOk}
        onAuthenticated={() => {}}
        port={lockPort()}
      />,
    );
    expect(html).toContain("login-gate");
    expect(html).toContain("接続されるまで、番人は寝ています");
    expect(html).toContain("Zzz");
    expect(html).toContain("市場を検証する。");
    expect(html).toContain("管理トークン");
    expect(html).toContain('type="password"');
    expect(html).toContain(">接続</button>");
    expect(html).toContain("トークンはメモリ内でのみ保持します。");
    expect(html).not.toContain("pattern-pad");
  });

  it("offers to bring the enrolment offer back when dismissed", () => {
    const html = renderToStaticMarkup(
      <LoginScreen
        verify={verifyOk}
        onAuthenticated={() => {}}
        port={lockPort({ dismissed: () => true })}
      />,
    );
    expect(html).toContain("パターン登録の案内を再表示する");
  });
});

describe("login gate (pattern mode)", () => {
  it("leads with the pad, the keeper and the token fallback", () => {
    const html = renderToStaticMarkup(
      <LoginScreen
        verify={verifyOk}
        onAuthenticated={() => {}}
        port={lockPort({ enrolled: () => true })}
      />,
    );
    expect(html).toContain("pattern-pad");
    expect(html).toContain("パターンをなぞって起こしてね");
    expect((html.match(/pattern-dot/g) ?? []).length).toBe(9);
    expect(html).toContain("この端末専用の簡易ロックです");
    expect(html).toContain("トークンで入る");
    expect(html).toContain("この端末の登録を消す");
    // The token form is the fallback, not the first thing shown.
    expect(html).not.toContain('type="password"');
  });
});

describe("pattern enrolment offer", () => {
  const enrollPort = (over: Partial<EnrollmentPort> = {}): EnrollmentPort => ({
    supported: () => true,
    enrolled: () => false,
    dismissed: () => false,
    dismiss: () => {},
    enroll: async () => {},
    ...over,
  });

  it("offers enrolment after a token login", () => {
    const html = renderToStaticMarkup(
      <PatternEnrollmentOffer token="tok" port={enrollPort()} />,
    );
    expect(html).toContain("pattern-offer");
    expect(html).toContain("パターンを登録する");
    expect(html).toContain("今後表示しない");
  });

  it("stays silent when enrolled, dismissed or unsupported", () => {
    for (const over of [
      { enrolled: () => true },
      { dismissed: () => true },
      { supported: () => false },
    ]) {
      const html = renderToStaticMarkup(
        <PatternEnrollmentOffer token="tok" port={enrollPort(over)} />,
      );
      expect(html).toBe("");
    }
  });
});
