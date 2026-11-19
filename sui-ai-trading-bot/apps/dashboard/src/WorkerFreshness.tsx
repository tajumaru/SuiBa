import { useEffect, useRef, useState } from "react";
import { botVital } from "./botVital.ts";
import type { OperationsSnapshot } from "./operationsTypes.ts";
import { dateTime } from "./presentation.ts";

/** The official Sui mark (same geometry as /sui-logo.svg),
 * inlined so the outline can be stroked and drawn by CSS. */
const SUI_MARK_PATH =
  "M626.027 417.029C666.817 468.244 691.209 533.014 691.209 603.469C691.209 673.925 666.076 740.673 624.214 792.176L620.588 796.626L619.641 790.981C618.817 786.201 617.869 781.34 616.757 776.478C595.785 684.349 527.471 605.365 415.03 541.378C339.095 498.28 295.626 446.448 284.213 387.487C276.838 349.375 282.318 311.098 292.907 278.301C303.496 245.545 319.235 218.063 332.626 201.541L376.383 148.06C384.046 138.666 398.426 138.666 406.09 148.06L626.068 417.029H626.027ZM695.206 363.59L402.01 5.12968C396.407 -1.70989 385.942 -1.70989 380.338 5.12968L87.184 363.59L86.2363 364.784C32.3026 431.738 0 516.821 0 609.444C0 825.138 175.151 1000 391.174 1000C607.198 1000 782.349 825.138 782.349 609.444C782.349 516.821 750.046 431.738 696.112 364.826L695.165 363.631L695.206 363.59ZM157.351 415.876L183.556 383.779L184.339 389.712C184.957 394.409 185.74 399.106 186.646 403.844C203.622 492.883 264.23 567.088 365.546 624.565C453.637 674.708 504.934 732.35 519.684 795.554C525.864 821.924 526.936 847.881 524.258 870.584L524.093 871.985L522.816 872.603C483.055 892.009 438.351 902.927 391.133 902.927C225.459 902.927 91.1394 768.855 91.1394 603.428C91.1394 532.396 115.902 467.172 157.269 415.793L157.351 415.876Z";

/** Text evidence from the shared operations feed, with the existing freshness rules. */
export function WorkerFreshness({
  data,
  stale = false,
}: {
  data: OperationsSnapshot | null;
  stale?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  const [receivedAt, setReceivedAt] = useState(Date.now);
  useEffect(() => {
    setReceivedAt(Date.now());
    setNow(Date.now());
  }, [data]);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 1000);
    window.addEventListener("pageshow", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pageshow", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  const vital = data ? botVital(data, stale, now, receivedAt) : null;
  const status = vital
    ? (
        {
          alive: "稼働中",
          weak: "通信・データを確認中",
          sleeping: "停止中",
          flatlined: "安全停止",
          unknown: "状態確認中",
        } as const
      )[vital.state]
    : "状態を確認中";
  // The background Sui mark re-draws itself on every fresh
  // heartbeat (owner's design, 2026-11-19: lines light up and
  // become the mark). Remounting the svg via key restarts the
  // CSS draw; when the vital is not alive the mark rests dimmed
  // and is never redrawn — the missing animation is the signal.
  const [beat, setBeat] = useState(0);
  const prevHeartbeat = useRef<number | null>(null);
  useEffect(() => {
    const hb = data?.lastHeartbeatAt ?? null;
    if (hb !== null && hb !== prevHeartbeat.current) {
      prevHeartbeat.current = hb;
      setBeat((b) => b + 1);
    }
  }, [data?.lastHeartbeatAt]);
  const markDim = !vital || vital.state !== "alive" || stale;
  return (
    <section aria-label="Workerの状態" className="worker-freshness">
      <svg
        key={beat}
        className={markDim ? "worker-heart-mark dim" : "worker-heart-mark"}
        viewBox="0 0 783 1000"
        aria-hidden="true"
      >
        <path
          className="worker-heart-fill"
          d={SUI_MARK_PATH}
          fill="#298DFF"
          fillRule="evenodd"
          clipRule="evenodd"
        />
        <path
          className="worker-heart-line"
          d={SUI_MARK_PATH}
          fill="none"
          stroke="#6fbcf0"
          strokeWidth={12}
          pathLength={100}
          strokeDasharray={100}
          strokeDashoffset={0}
        />
      </svg>
      <h3>Workerの状態</h3>
      <p role="status">
        {status}
        {stale ? "（最新情報を取得できません）" : ""}
      </p>
      {/* One line since 2026-11-19 (owner: the overview carried
          too much information): the heartbeat carries the full
          timestamp, the last successful analysis rides along as
          an age only — when analysis stalls its age grows while
          the heartbeat stays fresh, so the failure signal stays
          visible without a second near-identical timestamp. */}
      <dl>
        <dt>Workerの心拍</dt>
        <dd>
          {data ? dateTime(data.lastHeartbeatAt) : "未取得"}
          {vital?.heartbeatSecondsAgo != null && (
            <span className="worker-freshness-age">
              （{vital.heartbeatSecondsAgo}秒前）
            </span>
          )}
          {vital?.lastAnalysisSecondsAgo != null && (
            <span className="worker-freshness-age">
              ・最終分析 {vital.lastAnalysisSecondsAgo}秒前
            </span>
          )}
        </dd>
      </dl>
    </section>
  );
}
