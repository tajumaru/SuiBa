import React, { useEffect, useState } from "react";
import type { OperationMonitor } from "../../worker/src/operations.ts";
type OperationsSnapshot = ReturnType<OperationMonitor["snapshot"]>;
import { recoveryStatus } from "./recoveryState.ts";
import { BotVitalSigns } from "./BotVitalSigns.tsx";
import { botVital } from "./botVital.ts";
export function operationSummary(d: OperationsSnapshot, stale = false) {
  const v = recoveryStatus(
    {
      mode: d.mode,
      runtime: {
        running: ["RUNNING", "DATA_DELAYED"].includes(d.status),
        emergency: d.safety?.botState === "EMERGENCY_STOP",
        error:
          d.status === "ABNORMAL_STOP"
            ? (d.stopReason ?? d.safety?.lastStopReason ?? "UNKNOWN")
            : null,
      },
      safety: {
        ...d.safety,
        ordersAllowed:
          d.safety?.ordersAllowed &&
          d.status === "RUNNING" &&
          d.timing?.transportRecent &&
          ["FRESH", "UPDATING"].includes(d.timing?.dataStatus),
      },
    },
    stale,
  );
  return {
    title: v.title,
    tone: stale
      ? "warning"
      : v.title === "停止中"
        ? v.tone === "alert"
          ? "error"
          : "stopped"
        : v.tone === "ok"
          ? "healthy"
          : "warning",
    message: v.title === "正常稼働" ? v.safety : v.reason,
  };
}
export function OperationSummary({
  data,
  stale,
}: {
  data: OperationsSnapshot;
  stale: boolean;
}) {
  // Tick every second so ages and the next-fetch countdown stay live, and
  // remember when this snapshot arrived. If the worker's heartbeat record
  // or the snapshot itself ages past the freshness bounds, botVital
  // downgrades the beating states and the summary follows it into
  // 状態不明 — the hero can never keep claiming 正常稼働 on old evidence.
  const [now, setNow] = useState(() => Date.now());
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  useEffect(() => {
    const update = () => setNow(Date.now());
    const id = setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("pageshow", update);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pageshow", update);
    };
  }, []);
  useEffect(() => {
    const at = Date.now();
    setReceivedAt(at);
    setNow(at);
  }, [data]);
  const vital = botVital(data, stale, now, receivedAt);
  const v = operationSummary(
    vital.state === "unknown"
      ? { ...data, safety: { ...data.safety, ordersAllowed: false } }
      : data,
    stale || vital.evidenceStale,
  );
  return (
    <section className={`operation-hero ${v.tone}`} aria-label="運用状態">
      <small className="operation-mode">
        {data.mode} ·{" "}
        {data.mode === "PAPER"
          ? "仮想売買・実資金は使用しません"
          : "実資金の売買"}
      </small>
      <p>{v.message}</p>
      <BotVitalSigns vital={vital} />
    </section>
  );
}
export function noTradeReasons(
  d: OperationsSnapshot,
  hours: number,
  stale = false,
) {
  const r = d.reports.find((r) => r.hours === hours);
  if (!r || r.tradeCount > 0) return [];
  const reasons: string[] = [];
  if (stale) return ["原因未確定：最新のAPI応答を取得できません"];
  if (["STOPPED", "ABNORMAL_STOP"].includes(d.status))
    reasons.push("Botが停止している（現在のAPI状態）");
  if (
    !d.timing?.transportRecent ||
    ["UNKNOWN", "STALE"].includes(d.timing?.dataStatus)
  )
    reasons.push("データ取得に問題がある（現在の通信・鮮度）");
  if (r.profitGuardSkipped > 0)
    reasons.push(`利益保護で見送り：期間内 ${r.profitGuardSkipped}件`);
  if (r.riskSkipped > 0)
    reasons.push(`リスク制限で見送り：期間内 ${r.riskSkipped}件`);
  if (
    d.events.some(
      (e) =>
        e.kind === "WAIT" &&
        e.code === "STRATEGY_WAIT" &&
        e.timestamp >= r.from &&
        e.timestamp <= r.until,
    )
  )
    reasons.push("売買条件が成立していない（期間内の戦略見送り記録あり）");
  const pending = d.candidates.filter(
    (c) =>
      c.createdAt >= r.from &&
      c.createdAt <= r.until &&
      c.finalAction === "PENDING",
  );
  if (pending.length)
    reasons.push(
      `注文候補はあるが約定していない：直近記録 ${pending.length}件`,
    );
  if (!reasons.length)
    reasons.push("原因未確定：候補0件だけでは売買条件の不成立を断定できません");
  return reasons;
}
export function OperationGuidance({
  data,
  hours,
  stale,
}: {
  data: OperationsSnapshot;
  hours: number;
  stale: boolean;
}) {
  const reasons = noTradeReasons(data, hours, stale);
  const v = operationSummary(data, stale);
  const checks: string[] = [];
  if (stale) checks.push("画面とAPIの接続を確認し、最新状態を取得");
  if (
    !stale &&
    (data.safety?.connectivity !== "HEALTHY" ||
      data.apis?.some((a) => a.failed || a.backoff || a.exhausted))
  )
    checks.push("DeepBook・市場データAPIの通信を詳細診断で確認");
  if (
    !stale &&
    (!data.timing?.transportRecent ||
      ["STALE", "UNKNOWN"].includes(data.timing?.dataStatus))
  )
    checks.push("市場データの鮮度とローソク足品質を確認");
  if (!stale && v.title !== "正常稼働")
    checks.push("停止理由とPAPER再開条件を確認");
  if (!data.accounting.ledger.ok || data.accounting.latest?.ok === false)
    checks.unshift("残高・損益照合の不一致を確認");
  return (
    <>
      {reasons.length > 0 && (
        <section aria-label="なぜ売買されない？">
          <h2>なぜ売買されない？</h2>
          <ul>
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <small>
            現在の状態と選択期間の記録を区別しています。現在の停止だけで期間全体の原因は確定しません。
          </small>
        </section>
      )}
      {checks.length > 0 && (
        <section className="operation-next">
          <h2>次に確認すること</h2>
          <ol>
            {checks.slice(0, 3).map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
          <a href="#operation-diagnostics">詳細診断へ</a>
        </section>
      )}
    </>
  );
}
