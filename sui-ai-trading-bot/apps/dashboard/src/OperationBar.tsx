import React from "react";
import type { BotEngine } from "../../worker/src/engine.ts";
import { OperationIcon } from "./operationIcons.tsx";

type State = ReturnType<BotEngine["snapshot"]>;

/**
 * The tab-independent PAPER operation bar: one slim line at the
 * top of the content on every tab while connected, so the
 * operation state is visible — and the next action reachable —
 * without hunting for the operation panel (which lives at the
 * top of the strategy tab). It stays deliberately minimal —
 * state dot, state label, one contextual button — because the
 * full controls (start reasons, stop-state release steps) and
 * the global notices already live nearby.
 *
 * The button's behaviour depends on the state:
 * - 運用中: 「停止」 stops in place. Stopping is a safety action
 *   with no client-side gate, exactly as in the full controls.
 * - 停止中: 「開始へ」 jumps to the strategy tab instead of
 *   starting from here. A start must honour the unsaved-edits
 *   gate and show its reasons where the operator acts; the bar
 *   never bypasses that context.
 * - 緊急停止中 / 安全停止中: 「解除の手順へ」 jumps to the
 *   strategy tab, where the always-visible release section now
 *   sits at the top of the page.
 *
 * The button shows its line icon only; its wording above is the
 * aria-label (and title), kept distinct from the full controls'
 * button names so role+name lookups stay unambiguous.
 */
export function OperationBar({
  runtime,
  control,
  onOpenStrategy,
}: {
  runtime: State["runtime"];
  control: (c: string) => Promise<string | null>;
  onOpenStrategy: () => void;
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
  return (
    <div className={`operation-bar ${tone}`}>
      <span className="operation-bar-state">
        <span className="operation-bar-dot" aria-hidden="true" />
        PAPER運用：{state}
      </span>
      {running ? (
        <button
          type="button"
          className="operation-icon-button stop"
          aria-label="停止"
          title="停止"
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
          className="operation-icon-button go"
          aria-label="開始へ"
          title="開始へ"
          onClick={onOpenStrategy}
        >
          <OperationIcon kind="go" />
        </button>
      )}
    </div>
  );
}
