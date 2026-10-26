import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LoginScreen } from "../apps/dashboard/src/LoginScreen.tsx";
it("keeps the character and token form while explaining retirement in Japanese", () => {
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
  expect(html).toContain("トークンはメモリ内でのみ保持します。");
  expect(html).toContain("パターンでのログイン・登録を停止しました");
  expect(html).not.toContain("pattern-pad");
  expect(html).not.toContain("パターンを登録する");
});
