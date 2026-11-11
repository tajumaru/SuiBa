import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BOOT_SEEN_KEY,
  BootScreen,
  bootLines,
  isRepeatBootVisit,
  markBootSeen,
} from "../apps/dashboard/src/BootScreen.tsx";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

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

describe("boot repeat visit marker", () => {
  it("treats an unmarked session as a first visit and a marked one as a repeat", () => {
    const storage = fakeStorage();
    expect(isRepeatBootVisit(storage)).toBe(false);
    markBootSeen(storage);
    expect(isRepeatBootVisit(storage)).toBe(true);
  });

  it("recognizes a session marked by an earlier boot", () => {
    expect(isRepeatBootVisit(fakeStorage({ [BOOT_SEEN_KEY]: "1" }))).toBe(true);
  });

  it("fails open to the full sequence when storage throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(isRepeatBootVisit(throwing)).toBe(false);
    expect(() => markBootSeen(throwing)).not.toThrow();
  });

  it("fails open when storage is unavailable", () => {
    expect(isRepeatBootVisit(null)).toBe(false);
    expect(() => markBootSeen(null)).not.toThrow();
  });
});

describe("boot screen (static rendering)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("starts the first visit with every line still off", () => {
    vi.stubGlobal("window", { sessionStorage: fakeStorage() });
    const html = renderToStaticMarkup(
      <BootScreen pairLabel="SUI / USDC" api="ok" bot="stopped" onDone={() => {}} />,
    );
    expect(html).toContain("boot-screen");
    expect(html).not.toContain("boot-line on");
  });

  it("starts a repeat visit with every line already on (fast path)", () => {
    vi.stubGlobal("window", {
      sessionStorage: fakeStorage({ [BOOT_SEEN_KEY]: "1" }),
    });
    const html = renderToStaticMarkup(
      <BootScreen pairLabel="SUI / USDC" api="ok" bot="stopped" onDone={() => {}} />,
    );
    expect(html).toContain("boot-screen");
    expect(html.match(/boot-line on/g)).toHaveLength(6);
  });
});
