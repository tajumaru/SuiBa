import React from "react";

/**
 * Line icons for the PAPER operation actions (start / stop /
 * release / go), drawn in the same stroke style as the nav tab
 * icons (24x24 viewBox, round caps). Unlike the nav icons the
 * stroke colour is part of the meaning — green to start, red to
 * stop, amber to release — so each kind carries its own colour.
 * Decorative only: the button that hosts an icon always carries
 * the action's name as its aria-label.
 */
export type OperationIconKind = "start" | "stop" | "release" | "go";

const ICONS: Record<
  OperationIconKind,
  {
    stroke: string;
    strokeWidth: number;
    strokeLinecap?: "round";
    strokeLinejoin?: "round";
    body: React.ReactNode;
  }
> = {
  // 開始: play triangle.
  start: {
    stroke: "#43dfb2",
    strokeWidth: 1.9,
    strokeLinejoin: "round",
    body: <path d="M9 6.5v11l9-5.5z" />,
  },
  // 停止: square.
  stop: {
    stroke: "#ff7d9c",
    strokeWidth: 1.9,
    body: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
  },
  // 解除: padlock with its shackle open.
  release: {
    stroke: "#edc980",
    strokeWidth: 1.9,
    strokeLinecap: "round",
    body: (
      <>
        <rect
          x="5.5"
          y="10.5"
          width="13"
          height="9"
          rx="2"
          fill="rgba(237, 201, 128, 0.18)"
        />
        <path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2" />
      </>
    ),
  },
  // 開始へ: right arrow (a jump to the strategy tab, not a start).
  go: {
    stroke: "#dbe7f5",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    body: <path d="M5 12h13M13 6l6 6-6 6" />,
  },
};

export function OperationIcon({ kind }: { kind: OperationIconKind }) {
  const icon = ICONS[kind];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke={icon.stroke}
      strokeWidth={icon.strokeWidth}
      strokeLinecap={icon.strokeLinecap}
      strokeLinejoin={icon.strokeLinejoin}
      aria-hidden="true"
    >
      {icon.body}
    </svg>
  );
}
