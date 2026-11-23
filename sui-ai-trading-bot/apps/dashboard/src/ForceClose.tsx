import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { BotSnapshot } from "../../worker/src/engine.ts";
import partyHero from "./assets/party-hero.webp";

type State = Pick<
  BotSnapshot,
  | "mode"
  | "pair"
  | "portfolio"
  | "price"
  | "runtime"
  | "settings"
  | "forceClose"
  | "latestManualFill"
  | "latestTradeAt"
  | "profitGuard"
>;
type Control = (command: string) => Promise<string | null>;

const signed = (value: number, digits = 2) =>
  `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;

export function ForceClose({
  data,
  control,
}: {
  data: State;
  control: Control;
}) {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<State["latestManualFill"]>(null);
  const tracking = useRef(false);
  const submitted = useRef(false);
  const {
    portfolio,
    price,
    runtime,
    forceClose,
    latestManualFill,
    latestTradeAt,
  } = data;
  const visible =
    data.mode === "PAPER" &&
    portfolio.sui > 0 &&
    runtime.running &&
    !runtime.emergency &&
    !runtime.error;

  useEffect(() => {
    if (forceClose) {
      tracking.current = true;
      setConfirming(false);
      setError(null);
    } else if (tracking.current) {
      if (
        portfolio.sui === 0 &&
        latestManualFill &&
        latestTradeAt === latestManualFill.timestamp
      ) {
        setResult(latestManualFill);
        tracking.current = false;
      } else if (!submitted.current) {
        tracking.current = false;
      }
    }
    if (portfolio.sui > 0) setResult(null);
    if (!visible) setConfirming(false);
  }, [forceClose, portfolio.sui, latestManualFill, latestTradeAt, visible]);

  async function submit() {
    if (submitted.current) return;
    submitted.current = true;
    tracking.current = true;
    setConfirming(false);
    setSending(true);
    setError(null);
    try {
      const refusal = await control("force-close");
      if (refusal) {
        tracking.current = false;
        setError(refusal);
      }
    } finally {
      submitted.current = false;
      setSending(false);
    }
  }

  if (!visible) {
    if (data.mode !== "PAPER" || portfolio.sui !== 0 || result?.pnl == null)
      return null;
    return (
      <div className="force-close-result" role="status" key={result.orderId}>
        <span className="force-close-slash" aria-hidden="true" />
        <strong className={result.pnl < 0 ? "pm-down" : "pm-up"}>
          {signed(result.pnl)} USDC
        </strong>
        <span>強制決済完了 · 最終約定の実現損益</span>
      </div>
    );
  }

  const base = data.pair === "WAL_USDC" ? "WAL" : "SUI";
  const entry = portfolio.costBasis / portfolio.sui;
  const change = price != null && entry > 0 ? price / entry - 1 : null;
  const gross =
    price == null ? null : price * portfolio.sui - portfolio.costBasis;
  const { stopLossPct, takeProfitPct } = data.settings;
  const domain = Math.max(stopLossPct, takeProfitPct) * 1.2;
  const position = (value: number) =>
    `${50 + 50 * Math.max(-1, Math.min(1, value / domain))}%`;
  const report = data.profitGuard;
  const quoteQty = Number(report?.quantityAtomic) / 1e9;
  const net =
    report?.scope === "SELL_QUOTE" &&
    report.netProfitUsdc != null &&
    report.asOf >= (latestTradeAt ?? 0) &&
    quoteQty > 0 &&
    quoteQty <= portfolio.sui &&
    Number.isFinite(Number(report.netProfitUsdc))
      ? Number(report.netProfitUsdc)
      : null;
  const amount = net ?? gross;
  const winning = amount != null && amount > 0;
  const command = winning ? "とどめの一撃" : "戦線離脱";
  const line =
    change != null && change >= takeProfitPct
      ? "利確ラインを越えた。今なら勝って終われる！"
      : change != null && change <= -stopLossPct
        ? "損切りラインも越えてる。傷が深くなる前に引こう。"
        : null;
  const progress = sending || !!forceClose;

  return (
    <section className="force-close" aria-label="ポジション">
      <div className="force-close-heading">
        <img src={partyHero} alt="" width="46" height="46" />
        <div>
          <h3>ポジション</h3>
          <span>
            {portfolio.sui.toFixed(4)} {base} ／ 取得 {entry.toFixed(4)}
          </span>
        </div>
        <span className="force-close-holding">保有中</span>
      </div>
      {change != null && gross != null && (
        <>
          <div className="force-close-scale">
            <span>損切りライン {signed(-stopLossPct * 100)}%</span>
            <span>取得価格</span>
            <span>利確ライン {signed(takeProfitPct * 100)}%</span>
          </div>
          <div
            className="force-close-gauge"
            aria-hidden="true"
            style={
              {
                "--stop": position(-stopLossPct),
                "--take": position(takeProfitPct),
                "--fill-left": position(Math.min(0, change)),
                "--fill-right": position(Math.max(0, change)),
              } as CSSProperties
            }
          >
            <span
              className={
                change < 0 ? "force-close-fill loss" : "force-close-fill"
              }
            />
            <i />
            <i />
            <i />
          </div>
          <p>
            現在 <b>{price?.toFixed(4)}</b> ／ 含み損益{" "}
            <b className={gross < 0 ? "pm-down" : "pm-up"}>
              {signed(gross)} USDC（{signed(change * 100, 1)}%）
            </b>
          </p>
        </>
      )}
      {line && (
        <p className="force-close-speech">
          <b>主人公</b> ／ {line}
        </p>
      )}
      <div className="force-close-commands">
        {progress ? (
          <p role="status">強制決済中</p>
        ) : (
          <>
            <button
              type="button"
              className="force-close-command"
              onClick={() => {
                if (confirming) void submit();
                else setConfirming(true);
              }}
            >
              <strong className={winning ? "force-close-win" : "pm-down"}>
                {confirming ? "確定する" : command}
              </strong>
              <span>
                {amount == null
                  ? "強制決済"
                  : winning
                    ? "強制利確"
                    : "強制損切"}
                {amount != null && (
                  <>
                    {" "}
                    ／{" "}
                    {net == null
                      ? "手数料控除前"
                      : quoteQty < portfolio.sui
                        ? "分割1回分・手数料後"
                        : "手数料後"}{" "}
                    {signed(amount)} USDC 見込み
                  </>
                )}
              </span>
            </button>
            <button
              type="button"
              className="force-close-back"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
            >
              {confirming ? "戻る" : "様子を見る"}
            </button>
          </>
        )}
      </div>
      {!progress && (
        <p className="force-close-note" aria-live="polite">
          {confirming
            ? `「${command}」で保有分をすべて売りますか？`
            : `選ぶともう一度確認が出て、2回目で実行。${
                winning
                  ? "ルールの利確条件は待たない。"
                  : "損切りの目安は待たない。"
              }`}
        </p>
      )}
      {error && (
        <p role="alert">強制決済を受け付けられませんでした（{error}）</p>
      )}
    </section>
  );
}
