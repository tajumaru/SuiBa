import React, { useState } from "react";
import type { ValidationReport } from "../../worker/src/validation.ts";
import { validationMarkdown } from "../../../packages/shared/src/validation-presentation.ts";
import type { OperationsSnapshot } from "./OperationsPanel.tsx";
import { validationView } from "./validationView.ts";
import type { SettingsApi } from "./settingsPresets.ts";
import { dateTime, number, errorCode } from "./presentation.ts";
import { Reason } from "./Reason.tsx";
const rate = (n: number | null | undefined) =>
  n == null ? "未計測" : `${(n * 100).toFixed(2)}%`;
const ms = (n: number | null | undefined) =>
  n == null ? "未計測" : `${number(n)} ms`;
const duration = (n: number | null | undefined) => n == null ? "未計測" : `${Math.floor(n / 3600000)}時間 ${Math.floor(n / 60000) % 60}分`;
const count = (n: number | null | undefined) => n == null ? "未計測" : number(n);
function Metric({ title, value, state, help }: { title: string; value: string; state: string; help: string }) {
  return <article className="validation-metric" aria-label={title}><h3>{title}</h3><strong className="validation-value">{value}</strong><p>{state}</p><small>{help}</small></article>;
}
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
  operations,
}: {
  report: ValidationReport;
  api?: SettingsApi;
  stale?: boolean;
  operations: OperationsSnapshot;
}) {
  const view = validationView(report, operations, stale);
  const requests = report.apis?.reduce((n, a) => n + a.requests, 0) ?? 0;
  const successes = report.apis?.reduce((n, a) => n + a.successes, 0) ?? 0;
  const quality = report.candles?.latestQuality?.[300];
  const elapsed = report.session ? Math.max(0, Math.min(report.session.targetAt, report.generatedAt) - report.session.startedAt) : null;
  const target = report.session ? Math.max(1, report.session.targetAt - report.session.startedAt) : 86400000;
  const progress = elapsed == null ? null : Math.min(1, elapsed / target);
  const freshness = stale ? "状態不明" : ({ FRESH: "鮮度確認済み", UPDATING: "確定足の更新待ち", STALE: "データが古い", UNKNOWN: "未計測" }[operations.timing.dataStatus] ?? "未計測");
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
    <section className="deepbook-validation" aria-label="DeepBook 24時間検証">
      <h2>DeepBook 24時間PAPER検証</h2>
      <div className={`validation-overview ${view.tone}`}>
        <p className="validation-session" role="status">{view.icon} 24時間検証：{view.sessionLabel}</p>
        <p>PAPER Bot：<strong>{view.botLabel}</strong></p>
        <p>DeepBook接続：{view.connectionLabel}</p>
      </div>
      <div className="validation-action" aria-label="次に行う操作" role={view.tone === "danger" ? "alert" : undefined}>
        <h3>次に行う操作</h3>
        <p>{view.action}</p>
        {operations.stopReason && <p>停止理由：<Reason code={operations.stopReason} /></p>}
        {stale && <p>表示の更新に失敗しています。接続を確認するまで、表示済みの状態は最新とは限りません。</p>}
      </div>
      <p className="validation-help">PAPER：実際のお金を使わない仮想取引。計測開始とPAPER運用開始は別の操作です。</p>
      <div className="validation-metrics" aria-label="重要な4つの指標">
        <Metric title="API成功率" value={requests ? rate(successes / requests) : "未計測"} state={requests ? `通信${number(requests)}件中${number(successes)}件成功${successes < requests ? "・失敗あり" : ""}` : "計測記録を待っています"} help="データ取得リクエストが成功した割合。全APIの実試行を集計。" />
        <Metric title="未解決の5分足欠損" value={quality ? `${count(report.candles?.unresolved)}本` : "未計測"} state={quality ? `${count(report.candles?.reconstructed)}本を安全に再構築${report.candles?.unresolved ? "・未解決あり" : "・未解決なし"}` : "ローソク足の品質記録がありません"} help="未解決欠損：安全に補完できていない価格データ。再構築：欠けた価格データを根拠に基づいて補う処理。" />
        <Metric title="DeepBook接続・データ鮮度" value={freshness} state={view.connectionLabel} help="通信成功と価格データの鮮度は別々に確認します。鮮度は現在の安全監視の判定です。" />
        <Metric title="PAPER実稼働時間" value={duration(report.runningMs)} state={`Bot${view.botLabel}`} help="検証期間中にBotが実際に稼働した時間。計測経過時間とは異なります。" />
      </div>
      {report.session && <div className="validation-warnings" aria-label="重要な警告">
        {requests > successes && <p role="alert">! API取得失敗を記録しています。通信の詳細で原因と発生件数を確認してください。</p>}
        {!!report.candles?.unresolved && <p role="alert">! 未解決の5分足欠損が{count(report.candles.unresolved)}本あります。安全に利用できるデータが揃うまで新規取引できません。</p>}
        {operations.timing.dataStatus === "STALE" && <p role="alert">! 市場データが古くなっています。鮮度の回復を確認してください。</p>}
        {!!report.integrityFault && <p role="alert">! 計測記録の整合性に問題があります。合格条件と評価範囲を確認してください。</p>}
        {view.complete && <div><h3>{view.passed ? "確認できた合格条件" : "合格条件の未達・未確認項目"}</h3><ul>{report.criteria?.filter(c => view.passed ? c.ok : !c.ok).map(c => <li key={c.name}>{view.passed ? "✓" : "!"} {c.name}</li>)}</ul></div>}
      </div>}
      {!report.session ? (
        <>
          <p>専用環境の記録です。計測開始とPAPER運用開始は別の操作です。</p>
          <button
            disabled={!api || busy || stale || !!report.session || ["RUNNING", "DATA_DELAYED"].includes(operations.status)}
            onClick={() => void begin()}
          >
            24時間計測を開始
          </button>
        </>
      ) : (
        <>
          <div className="validation-progress" aria-label="検証進捗">
            <h3>検証進捗</h3>
            <div className="validation-progress-heading"><strong>{rate(progress)}</strong><span>目標 24時間</span></div>
            <progress aria-label="24時間の進捗" value={progress ?? 0} max={1} />
            <div className="validation-time-grid"><p>経過時間<strong>{duration(elapsed)}</strong></p><p>残り時間<strong>{duration(elapsed == null ? null : target - elapsed)}</strong></p></div>
            <dl><dt>検証開始日時</dt><dd>{dateTime(report.session.startedAt)}</dd><dt>終了予定日時</dt><dd>{dateTime(report.session.targetAt)}</dd></dl>
            <small>サーバーが保存したセッション時刻に基づく進捗です。再起動しても継続します。{stale ? "表示の更新が止まっています。" : ""}</small>
          </div>
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
                タイムアウト：
                {[
                  "UPSTREAM_TIMEOUT",
                  "UPSTREAM_CONNECT_TIMEOUT",
                  "UPSTREAM_HEADERS_TIMEOUT",
                  "UPSTREAM_BODY_TIMEOUT",
                ].reduce((n, code) => n + (a.codes[code] ?? 0), 0)}{" "}
                ／ HTTP 429：
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
