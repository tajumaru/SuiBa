import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LoginScreen } from "../apps/dashboard/src/LoginScreen.tsx";
it("keeps the login screen minimal: character, caption and the token form only", () => {
  const html = renderToStaticMarkup(
    <LoginScreen
      verify={async () => ({ ok: true })}
      onAuthenticated={() => {}}
    />,
  );
  expect(html).toContain("login-gate");
  expect(html).toContain("Zzz");
  expect(html).toContain("接続されるまで、番人は寝ています");
  expect(html).toContain("管理トークン");
  expect(html).toContain('type="password"');
  // No explanatory prose on the everyday path: the headline, the
  // tagline, the memory note and the pattern-retirement notice are
  // gone. The retirement story is told only on a browser whose
  // legacy pattern registration was actually removed (the migration
  // notice), never as an always-on wall of text.
  expect(html).not.toContain("市場を検証する");
  expect(html).not.toContain("実資金を使わない");
  expect(html).not.toContain("トークンはメモリ内でのみ保持します");
  expect(html).not.toContain("推測されるおそれがあるため");
  expect(html).not.toContain("pattern-pad");
  expect(html).not.toContain("パターンを登録する");
});
