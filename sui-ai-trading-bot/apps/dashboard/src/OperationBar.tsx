import React, { useEffect, useState } from "react";
import type { BotEngine } from "../../worker/src/engine.ts";
import { OperationIcon } from "./operationIcons.tsx";
import { startRejectionReason } from "./operationLabels.ts";

type State = ReturnType<BotEngine["snapshot"]>;

/**
 * The tab-independent PAPER operation bar: one slim line at the
 * top of the content on every tab while connected. Since the
 * controls were unified here, this bar is the single home of the
 * operation state and its everyday actions — the strategy tab's
 * old full-size panel is gone.
 *
 * - 運用中: 「PAPER運用停止」 stops in place. Stopping is a safety
 *   action with no client-side gate.
 * - 停止中: 「PAPER運用開始」 starts in place — the same command
 *   the old panel issued, with the same server-side gate; a
 *   refusal comes back as a code and is spelled out under the bar.
 *   The client-side gate is not bypassed either: while the
 *   strategy tab's settings editor reports a block (unsaved
 *   edits, a conflict, a pending preset switch, a save in flight)
 *   the button is disabled and every reason is listed under the
 *   bar. The editor only exists while the strategy tab is open,
 *   which is exactly when those blocks can occur.
 * - 緊急停止中 / 安全停止中: 「解除の手順へ」 jumps to the
 *   strategy tab, whose top carries the release section. A
 *   stopped state is never started or released from the bar.
 *
 * Buttons are icon-only; their names live in aria-label/title,
 * using the same names the old panel used so there is exactly one
 * start and one stop in the app.
 */
export function OperationBar({
  runtime,
  control,
  onOpenStrategy,
  startBlocked,
}: {
  runtime: State["runtime"];
  control: (c: string) => Promise<string | null>;
  onOpenStrategy: () => void;
  startBlocked: string[];
}) {
  const { running, emergency, error } = runtime;
  const stoppedState = !!(emergency || error);
  const state = emergency
    ? "緊急停止中"
    : error
      ? "安全停止中"
      : running
        ? "運用中"
        : "停止中";
  const tone = stoppedState
    ? "tone-alert"
    : running
      ? "tone-ok"
      : "tone-caution";
  // A server-refused start (a long market fetch, an API backoff, a
  // ledger check...) is reported where the operator pressed the
  // button, and cleared whenever the operation state moves on.
  const [startFailure, setStartFailure] = useState<string | null>(null);
  useEffect(() => {
    setStartFailure(null);
  }, [running, emergency, error]);
  async function start() {
    setStartFailure(await control("start"));
  }
  return (
    <>
      <div className={`operation-bar ${tone}`}>
        <span className="operation-bar-state">
          <span className="operation-bar-dot" aria-hidden="true" />
          PAPER運用：{state}
        </span>
        {running ? (
          <button
            type="button"
            className="operation-icon-button stop"
            aria-label="PAPER運用停止"
            title="PAPER運用停止"
            onClick={() => void control("stop")}
          >
            <OperationIcon kind="stop" />
          </button>
        ) : stoppedState ? (
          <button
            type="button"
            className="operation-icon-button release"
            aria-label="解除の手順へ"
            title="解除の手順へ"
            onClick={onOpenStrategy}
          >
            <OperationIcon kind="release" />
          </button>
        ) : (
          <button
            type="button"
            className="operation-icon-button start"
            aria-label="PAPER運用開始"
            title="PAPER運用開始"
            disabled={startBlocked.length > 0}
            onClick={() => void start()}
          >
            <OperationIcon kind="start" />
          </button>
        )}
      </div>
      {!running && !stoppedState && startBlocked.length > 0 && (
        <div className="operation-bar-notice">
          <p>今は開始できません：</p>
          <ul>
            {startBlocked.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </div>
      )}
      {startFailure && (
        <p className="error operation-bar-failure" role="alert">
          開始できませんでした。{startRejectionReason(startFailure)}
        </p>
      )}
    </>
  );
}
