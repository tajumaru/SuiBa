import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BootScreen, bootLines } from "../apps/dashboard/src/BootScreen.tsx";

describe("boot lines", () => {
  it("reports the verified token and the PAPER mode as constants", () => {
    const lines = bootLines({ pairLabel: "SUI / USDC", api: "pending", bot: "unknown" });
    expect(lines[0]).toMatchObject({ key: "token", value: "OK" });
    expect(lines[3]).toMatchObject({ key: "mode", value: "[ PAPER ]" });
    expect(lines[5]).toMatchObject({ key: "character", value: "ready" });
  });

  it("resolves the api line from the first snapshot's fate", () => {
    const at = (api: "pending" | "ok" | "error") =>
      bootLines({ pairLabel: "SUI / USDC", api, bot: "unknown" })[1];
    expect(at("ok")).toMatchObject({ value: "OK", tone: "ok" });
    expect(at("error")).toMatchObject({ value: "届かない", tone: "alert" });
    expect(at("pending")).toMatchObject({ value: "確認中", tone: "dim" });
  });

  it("names the pair on screen and the bot's recorded state", () => {
    const lines = bootLines({ pairLabel: "WAL / USDC", api: "ok", bot: "emergency" });
    expect(lines[2].value).toBe("WAL / USDC");
    expect(lines[4]).toMatchObject({ value: "緊急停止中", tone: "alert" });
    expect(
      bootLines({ pairLabel: "SUI / USDC", api: "ok", bot: "running" })[4].value,
    ).toBe("運用中");
    expect(
      bootLines({ pairLabel: "SUI / USDC", api: "ok", bot: "stopped" })[4].value,
    ).toBe("停止中");
  });
});

describe("boot screen (static rendering)", () => {
  it("renders the logo and every boot line", () => {
    const html = renderToStaticMarkup(
      <BootScreen pairLabel="SUI / USDC" api="ok" bot="stopped" onDone={() => {}} />,
    );
    expect(html).toContain("boot-screen");
    expect(html).toContain("PAPER TRADING TERMINAL");
    expect(html).toContain("api link");
    expect(html).toContain("[ PAPER ]");
    expect(html).toContain("TAP TO SKIP");
  });
});
