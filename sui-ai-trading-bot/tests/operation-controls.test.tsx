import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaults } from "../packages/shared/src/index.ts";
import type { BotEngine } from "../apps/worker/src/engine.ts";
import {
  PaperOperationControls,
  type SettingsEditor,
} from "../apps/dashboard/src/SettingsPage.tsx";
import { startRejectionReason } from "../apps/dashboard/src/operationLabels.ts";

type State = ReturnType<BotEngine["snapshot"]>;
type Runtime = State["runtime"];

const settingsPage = readFileSync(
  resolve("apps/dashboard/src/SettingsPage.tsx"),
  "utf8",
);
const main = readFileSync(resolve("apps/dashboard/src/main.tsx"), "utf8");

const editor = (
  flags: Partial<Pick<SettingsEditor, "busy" | "dirty" | "conflict">> & {
    switchTo?: SettingsEditor["switchTo"];
  } = {},
): SettingsEditor =>
  ({
    busy: false,
    dirty: false,
    conflict: false,
    switchTo: null,
    ...flags,
  }) as unknown as SettingsEditor;

function render(
  runtime: Partial<Runtime>,
  editorFlags?: Parameters<typeof editor>[0],
) {
  const data = {
    settings: defaults,
    runtime: { running: false, emergency: false, error: null, ...runtime },
  } as unknown as State;
  return renderToStaticMarkup(
    <PaperOperationControls
      data={data}
      editor={editor(editorFlags)}
      control={async () => null}
    />,
  );
}

describe("start rejection reasons (server 409 codes)", () => {
  it("translates every start-gate code into a next step in Japanese", () => {
    expect(startRejectionReason("MARKET_FETCH_IN_PROGRESS")).toContain(
      "市場データの取得が終わっていない",
    );
    expect(startRejectionReason("PAPER_RECOVERY_REQUIRED")).toContain(
      "通信の復旧確認が完了していない",
    );
    expect(startRejectionReason("PAPER_RECOVERY_REQUIRED")).toContain(
      "「運用検証」の診断で接続状態を確認",
    );
    expect(startRejectionReason("API_BACKOFF")).toContain("再試行待機中");
    expect(startRejectionReason("RESET_REQUIRED")).toContain(
      "停止状態が解除されていない",
    );
    expect(startRejectionReason("HEALTH_CHECK_REQUIRED")).toContain(
      "Sui接続の状態確認",
    );
    expect(startRejectionReason("ACCOUNTING_CHECK_REQUIRED")).toContain(
      "帳簿の整合性チェック",
    );
    const mapped = [
      "MARKET_FETCH_IN_PROGRESS",
      "PAPER_RECOVERY_REQUIRED",
      "API_BACKOFF",
      "RESET_REQUIRED",
      "HEALTH_CHECK_REQUIRED",
      "ACCOUNTING_CHECK_REQUIRED",
    ].map(startRejectionReason);
    expect(new Set(mapped).size).toBe(6);
  });

  it("falls back to a generic retry message for unknown codes", () => {
    expect(startRejectionReason("REQUEST_FAILED")).toContain(
      "サーバーが開始を受け付けませんでした",
    );
  });

  it("is wired into the operation controls as an alert", () => {
    // control() hands the code back and the controls translate and
    // show it where the start button was pressed.
    expect(main).toContain("Promise<string | null>");
    expect(main).toContain("return code;");
    expect(settingsPage).toContain('setStartFailure(await control("start"))');
    expect(settingsPage).toContain("startRejectionReason(startFailure)");
    expect(settingsPage).toContain('role="alert"');
  });
});

describe("paper operation controls clarity", () => {
  it("spells out why start is blocked by unsaved edits", () => {
    const html = render({}, { dirty: true });
    expect(html).toContain("今は開始できません");
    expect(html).toContain(
      "未保存の変更があります。開始には保存済みの設定を使うため",
    );
    expect(html).not.toContain("停止状態の解除");
  });

  it("spells out a settings conflict", () => {
    const html = render({}, { conflict: true });
    expect(html).toContain("この画面の内容と競合しています");
    expect(html).toContain("画面を再読み込みして");
  });

  it("spells out a pending style switch and a save in progress", () => {
    expect(render({}, { switchTo: "safe" })).toContain(
      "運用スタイルの切り替えが保留中です",
    );
    expect(render({}, { busy: true })).toContain("設定を保存中です");
  });

  it("shows the plain start guidance when nothing blocks start", () => {
    const html = render({});
    expect(html).not.toContain("今は開始できません");
    expect(html).toContain("開始すると、保存済みの設定で仮想売買を行います。");
  });

  it("keeps the running state explicit", () => {
    expect(render({ running: true })).toContain(
      "運用中です。保存済みの設定で仮想売買を行っています。",
    );
  });

  it("explains what each button does", () => {
    const html = render({});
    expect(html).toContain(
      "保存済みの設定で仮想売買を始めます。条件がそろうまで売買はしません。",
    );
    expect(html).toContain(
      "仮想売買を止めます。保有中の仮想ポジションは残り、再開後に管理を続けます。",
    );
  });
});

describe("stop-state release section", () => {
  it("is always visible in an emergency, with no details to open", () => {
    const html = render({ emergency: true });
    expect(html).toContain("<h4>停止状態の解除</h4>");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
    expect(html).toContain("緊急停止が押され、PAPER運用を止めています。");
    expect(html).toContain("停止状態を解除します");
    expect(html).toContain("解除だけでは自動で再開しません");
    expect(html).toContain("停止解除（再開は手動）");
    // The start area points at the release steps as well.
    expect(html).toContain("先に下の手順で停止状態を解除してください");
  });

  it("shows the recorded stop reason in a safety stop", () => {
    const html = render({ error: "UPSTREAM_HTTP_504" });
    expect(html).toContain("<h4>停止状態の解除</h4>");
    expect(html).not.toContain("<details");
    expect(html).toContain("安全停止中です。停止理由：");
    expect(html).toContain("外部APIの中継先が時間切れです");
  });

  it("does not render while the bot is merely stopped or running", () => {
    expect(render({})).not.toContain("停止状態の解除");
    expect(render({ running: true })).not.toContain("停止状態の解除");
  });
});
