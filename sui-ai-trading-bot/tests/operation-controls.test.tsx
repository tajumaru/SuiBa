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
      "通信の安全確認が未完了",
    );
    expect(startRejectionReason("PAPER_RECOVERY_REQUIRED")).toContain(
      "通信診断で復旧状況を確認",
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

  it("a refused start stays off the global banner — the bar tells it alone", () => {
    // The banner renders bannerError, and control() raises it for
    // every command except start, whose refusal the operation bar
    // already reports with the specific reason.
    expect(main).toContain("<Reason code={bannerError} />");
    expect(main).toContain('if (command !== "start") setBannerError(code);');
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
});

describe("operation icon buttons", () => {
  const buttonTag = (html: string, label: string) => {
    const at = html.indexOf(`aria-label="${label}"`);
    expect(at).toBeGreaterThanOrEqual(0);
    return html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at));
  };

  it("renders start and stop as icon buttons in the heading row", () => {
    const html = render({});
    // The buttons ride at the right end of the state heading's
    // row, after the heading — not in a button row of their own.
    const headAt = html.indexOf('class="paper-operation-head"');
    const startAt = html.indexOf('aria-label="PAPER運用開始"');
    const stopAt = html.indexOf('aria-label="PAPER運用停止"');
    expect(headAt).toBeGreaterThanOrEqual(0);
    expect(startAt).toBeGreaterThan(headAt);
    expect(stopAt).toBeGreaterThan(startAt);
    expect(html).toContain('class="paper-operation-actions"');
    // Icon only: the names live in aria-label and title, the
    // same wording the text buttons carried.
    expect(buttonTag(html, "PAPER運用開始")).toContain(
      'class="operation-icon-button start"',
    );
    expect(buttonTag(html, "PAPER運用開始")).toContain('title="PAPER運用開始"');
    expect(buttonTag(html, "PAPER運用停止")).toContain(
      'class="operation-icon-button stop"',
    );
    expect(buttonTag(html, "PAPER運用停止")).toContain('title="PAPER運用停止"');
    // Each button shows its line icon in the meaning colour.
    expect(html).toContain('stroke="#43dfb2"');
    expect(html).toContain('stroke="#ff7d9c"');
  });

  it("drops the per-button captions and the old button row", () => {
    const html = render({});
    expect(html).not.toContain("条件がそろうまで売買はしません");
    expect(html).not.toContain("保有中の仮想ポジションは残り");
    expect(html).not.toContain("control-action");
    expect(html).not.toContain('class="controls"');
  });

  it("keeps the start gate on the icon button", () => {
    expect(buttonTag(render({}), "PAPER運用開始")).not.toContain("disabled");
    expect(buttonTag(render({ running: true }), "PAPER運用開始")).toContain(
      "disabled",
    );
    expect(buttonTag(render({}, { dirty: true }), "PAPER運用開始")).toContain(
      "disabled",
    );
    expect(buttonTag(render({ emergency: true }), "PAPER運用開始")).toContain(
      "disabled",
    );
  });

  it("puts the release icon button at the top of the release section", () => {
    const html = render({ emergency: true });
    const releaseAt = html.indexOf('aria-label="停止解除（再開は手動）"');
    expect(html).toContain('class="stop-release-head"');
    expect(releaseAt).toBeGreaterThan(html.indexOf('class="stop-release"'));
    // The button sits in the heading row, above the explanation
    // and the steps it acts on.
    expect(releaseAt).toBeLessThan(html.indexOf("緊急停止が押され"));
    expect(buttonTag(html, "停止解除（再開は手動）")).toContain(
      'class="operation-icon-button release"',
    );
    expect(buttonTag(html, "停止解除（再開は手動）")).toContain(
      'title="停止解除（再開は手動）"',
    );
    expect(html).toContain('stroke="#edc980"');
    // The steps point at the button's new position.
    expect(html).toContain("原因を解消したら「停止を解除」を押します");
    expect(html).not.toContain("下のボタンで停止状態を解除します");
  });
});

describe("stop-state release section", () => {
  it("is always visible in an emergency, with no details to open", () => {
    const html = render({ emergency: true });
    expect(html).toContain("<h4>停止状態の解除</h4>");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
    expect(html).toContain("緊急停止が押され、PAPER運用を止めています。");
    expect(html).toContain("「停止を解除」を押します");
    expect(html).toContain("解除だけでは売買を始めません");
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
