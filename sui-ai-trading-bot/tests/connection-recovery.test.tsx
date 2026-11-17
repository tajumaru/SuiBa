import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectionRecovery,
  isConnectionFailure,
} from "../apps/dashboard/src/connectionRecovery.ts";
import { ConnectionNotice } from "../apps/dashboard/src/ConnectionNotice.tsx";

describe("browser to worker reconnection", () => {
  it("backs off one shared probe, bounds jitter and staggers auxiliary recovery", () => {
    let now = 100000;
    const changed = vi.fn();
    const connection = new ConnectionRecovery(
      changed,
      () => now,
      () => 0.5,
    );
    expect(connection.canReadAuxiliary).toBe(true);
    for (const delay of [5500, 10500, 20500, 30500, 30500]) {
      connection.fail();
      expect(connection.offline).toBe(true);
      expect(connection.canReadAuxiliary).toBe(false);
      expect(connection.pollDelay).toBe(delay);
      connection.fail(); // Another in-flight channel fails in the same window.
      expect(connection.pollDelay).toBe(delay);
      now += delay - 1;
      expect(connection.canPoll).toBe(false);
      now++;
      expect(connection.canPoll).toBe(true);
    }
    connection.recovered();
    expect(changed).toHaveBeenLastCalledWith(false);
    expect(connection.offline).toBe(false);
    expect(connection.pollDelay).toBe(10000);
    expect(connection.canReadAuxiliary).toBe(false);
    now += 2500;
    expect(connection.canReadAuxiliary).toBe(true);
    connection.fail();
    expect(connection.pollDelay).toBe(5500);
  });

  it("distinguishes network/timeouts from application and Bot errors", () => {
    expect(isConnectionFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(
      isConnectionFailure(new DOMException("timeout", "TimeoutError")),
    ).toBe(true);
    expect(
      isConnectionFailure(new DOMException("body aborted", "AbortError")),
    ).toBe(true);
    for (const code of [
      "CANDLE_STALE",
      "HTTP_401",
      "HTTP_500",
      "DASHBOARD_DELTA_CHECKSUM",
    ])
      expect(isConnectionFailure(new Error(code))).toBe(false);
    expect(isConnectionFailure(new SyntaxError("bad JSON"))).toBe(false);
  });

  it("labels retained values and their fixed receipt time, including no initial snapshot", () => {
    const receivedAt = Date.UTC(2026, 10, 13, 1, 2, 3);
    const html = renderToStaticMarkup(
      <ConnectionNotice receivedAt={receivedAt} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("再起動中の可能性");
    expect(html).toContain("接続断前の情報");
    expect(html).toContain('dateTime="2026-11-13T01:02:03.000Z"');
    expect(
      renderToStaticMarkup(<ConnectionNotice receivedAt={null} />),
    ).toContain("まだデータを取得できていません");
  });
});
