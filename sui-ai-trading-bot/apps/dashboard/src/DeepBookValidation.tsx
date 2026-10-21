import React, { useState } from "react";
import type { ValidationReport } from "../../worker/src/validation.ts";
import { validationMarkdown } from "../../../packages/shared/src/validation-presentation.ts";
import type { SettingsApi } from "./settingsPresets.ts";
import { dateTime, number, errorCode } from "./presentation.ts";
import { Reason } from "./Reason.tsx";
const rate = (n: number | null | undefined) =>
  n == null ? "未計測" : `${(n * 100).toFixed(2)}%`;
const ms = (n: number | null | undefined) =>
  n == null ? "未計測" : `${number(n)} ms`;
const duration = (n: number | undefined) =>
  `${((n ?? 0) / 3600000).toFixed(2)} 時間`;
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function DeepBookValidation({
  report,
  api,
  stale = false,
}: {
  report: ValidationReport;
  api?: SettingsApi;
  stale?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const begin = async () => {
    if (!api) return;
    setBusy(true);
    try {
      await api("validation/start", {});
      setNotice(
        "計測を開始しました。10秒以内に表示を更新します。PAPER運用は別途、手動で開始してください。",
      );
    } catch (e) {
      setNotice(
        "計測を開始できません。Botを停止し、Profit Guardを有効にしてください。既存の計測記録は上書きできません。コード：" +
          errorCode(e),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="DeepBook 24時間検証">
      <h2>DeepBook 24時間PAPER検証</h2>
      <p role="status">
        {report.status}
        {stale ? "（表示の更新に失敗しています）" : ""}
      </p>
      {!report.session ? (
        <>
          <p>専用環境の記録です。計測開始とPAPER運用開始は別の操作です。</p>
          <button
            disabled={!api || busy || stale || !!notice}
            onClick={() => void begin()}
          >
            24時間計測を開始
          </button>
        </>
      ) : (
        <>
          <p>
            検証開始：{dateTime(report.session.startedAt)} ／ 目標：
            {dateTime(report.session.targetAt)}
          </p>
          <p>
            経過：{duration(report.elapsedMs)} ／ PAPER実稼働：
            {duration(report.runningMs)} ／ 進捗：{rate(report.progress)}
          </p>
          <progress
            aria-label="24時間の進捗"
            value={report.progress ?? 0}
            max={1}
          />
          <p>
            24時間未満・記録不足の場合は合格にしません。停止後・再起動後は手動再開が必要です。
          </p>
          <p>
            DeepBook接続：{report.market?.healthy ? "正常" : "未取得・通信異常"}{" "}
            ／ 最終正常取得：{dateTime(report.market?.lastSuccessAt ?? null)} ／
            Indexer遅延：{ms(report.market?.diagnostics?.indexerLagMs)}
          </p>
          <p>
            計測記録：{number(report.sampleCount ?? 0)}件 ／ 最大記録空白：
            {ms(report.maxGapMs)}
          </p>
          <h3>API計測</h3>
          {(report.apis ?? []).map((a) => (
            <div className="card" key={a.api}>
              <h4>{a.api}</h4>
              <p>
                リクエスト：{a.requests} ／ 成功率：{rate(a.successRate)} ／
                再試行：{a.retries}
              </p>
              <p>
                平均応答：{ms(a.latency.averageMs)} ／ P95：
                {ms(a.latency.p95Ms)} ／ 最終正常取得：
                {dateTime(a.lastSuccessAt)}
              </p>
              <p>
                タイムアウト：{a.codes.UPSTREAM_TIMEOUT ?? 0} ／ HTTP 429：
                {a.codes.UPSTREAM_HTTP_429 ?? 0} ／ 502：
                {a.codes.UPSTREAM_HTTP_502 ?? 0} ／ 503：
                {a.codes.UPSTREAM_HTTP_503 ?? 0} ／ 504：
                {a.codes.UPSTREAM_HTTP_504 ?? 0}
              </p>
            </div>
          ))}
          <h3>ローソク足品質・注文板</h3>
          <p>
            取得5分足：{report.candles?.uniqueFiveMinuteBars ?? 0} ／ 元欠損：
            {report.candles?.originalMissing ?? 0} ／ 再構築：
            {report.candles?.reconstructed ?? 0} ／ 成功率：
            {rate(report.candles?.reconstructionSuccessRate)} ／ 未解決：
            {report.candles?.unresolved ?? 0}
          </p>
          <p>
            未解決を観測した取得周期：
            {report.candles?.reconstructionFailures ?? 0} ／ 再構築P95：
            {ms(report.candles?.reconstructionTime.p95Ms)} ／ 最新確定足：
            {dateTime(
              report.candles?.latestQuality?.[300]?.latestClosedAt ?? null,
            )}
          </p>
          <p>
            板の取得時刻：{dateTime(report.market?.bookAt ?? null)} ／
            スプレッド：{rate(report.market?.spread)} ／ 買い板流動性：
            {number(report.market?.diagnostics?.bidDepthUsdc ?? 0)} USDC ／
            売り板流動性：
            {number(report.market?.diagnostics?.askDepthUsdc ?? 0)} USDC
          </p>
          <details>
            <summary>再構築の理由・証拠</summary>
            <pre>{JSON.stringify(report.candles?.evidence ?? [], null, 2)}</pre>
          </details>
          <h3>AI判断・PAPER取引・安全停止</h3>
          <p>
            分析：{report.paper?.analyses ?? 0} ／ 買い：
            {report.paper?.actions.BUY ?? 0} ／ 売り：
            {report.paper?.actions.SELL ?? 0} ／ 見送り：
            {report.paper?.actions.WAIT ?? 0}
          </p>
          <p>
            PAPER注文記録：{report.paper?.orderRequests ?? 0} ／ PAPER約定：
            {report.paper?.orders ?? 0} ／ 評価損益：
            {report.paper?.pnlUsdc == null
              ? "未評価"
              : number(report.paper.pnlUsdc) + " USDC"}{" "}
            ／ 手動再開：{report.paper?.manualResumes ?? 0}
          </p>
          <p>
            安全停止：{report.paper?.safetyStops.length ?? 0}件 ／
            約定時安全経路：
            {report.paper?.fillChecksExercised ? "実行済み" : "未行使"} ／
            API異常時停止経路：
            {report.paper?.errorStopChecksExercised ? "実行済み" : "未行使"}
          </p>
          <ul>
            {report.paper?.safetyStops.map((s, i) => (
              <li key={i}>
                {dateTime(s.timestamp)}：<Reason code={s.code} />
              </li>
            ))}
          </ul>
          <details>
            <summary>合格条件と評価範囲</summary>
            <ul>
              {report.criteria?.map((c) => (
                <li key={c.name}>
                  {c.ok ? "確認済み" : "未達・未確認"}：{c.name}
                </li>
              ))}
            </ul>
            <ul>
              {report.limitations?.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </details>
          <button
            onClick={() =>
              download(
                "deepbook-24h.json",
                JSON.stringify(report, null, 2),
                "application/json",
              )
            }
          >
            検証JSONを保存
          </button>{" "}
          <button
            onClick={() =>
              download(
                "deepbook-24h.md",
                validationMarkdown(report),
                "text/markdown;charset=utf-8",
              )
            }
          >
            検証Markdownを保存
          </button>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
