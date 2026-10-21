import React from "react";
import type { MarketStatus } from "../../../packages/market-data/src/provider.ts";
import { dateTime, number, percent } from "./presentation.ts";
import { Reason } from "./Reason.tsx";
export function MarketDataPanel({
  value: v,
  unavailable = false,
}: {
  value: MarketStatus;
  unavailable?: boolean;
}) {
  const delayed = !v.lastSuccessAt || Date.now() - v.lastSuccessAt > 180000;
  return (
    <section aria-label="市場データ接続">
      <h3>市場データ接続</h3>
      <p>
        現在の取得元：{v.source ?? "未取得"} ／ 接続状態：
        {unavailable
          ? "状態不明"
          : v.healthy && !delayed
            ? "取得正常"
            : "取得停止・データ遅延"}
      </p>
      <p>
        DeepBook：
        {v.configured === "geckoterminal"
          ? "未使用"
          : v.fallback
            ? "代替取得中"
            : v.healthy
              ? "取得正常"
              : "未取得・要確認"}{" "}
        ／ 代替取得：{v.fallback ? "GeckoTerminalを使用中" : "なし"}
      </p>
      <p>
        最終正常取得：{dateTime(v.lastSuccessAt)} ／ 一式の取得時間：
        {v.latencyMs == null ? "不明" : number(v.latencyMs, 0) + " ms"}
      </p>
      {v.bookAt != null && (
        <p>
          注文板更新：{dateTime(v.bookAt)} ／ 最良買気配：{number(v.bid, 6)} ／
          最良売気配：{number(v.ask, 6)} ／ スプレッド：{percent(v.spread)}
        </p>
      )}
      {v.quality?.[300] && (
        <div aria-label="DeepBook 5分足の品質">
          <p>
            DeepBook 5分足の品質：元データ {v.quality[300].origins.ORIGINAL}本
            ／ 再構築 {v.quality[300].reconstructed}本 ／ 未解決{" "}
            {v.quality[300].unresolved}本
          </p>
          <p>
            観測時刻：{dateTime(v.quality[300].fetchedAt)} ／ 最新確定足：
            {dateTime(v.quality[300].latestClosedAt)}
          </p>
          <small>
            再構築の根拠は各足に保存します。約定ゼロの確認範囲は公式Indexerです。
          </small>
        </div>
      )}
      {v.reason && (
        <p>
          <Reason code={v.reason} />
        </p>
      )}
      <small>
        取得元の変更後や異常停止後は、正常取得に戻っても自動再開しません。
      </small>
    </section>
  );
}
