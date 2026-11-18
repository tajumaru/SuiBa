import { describe, expect, it } from "vitest";
import { isMainModule } from "../scripts/is-main-module.ts";

describe("REAL CLI entry-point detection", () => {
  it.each([
    [
      "Windows",
      "file:///D:/SuiBa/sui-ai-trading-bot/scripts/real-resume.ts",
      "D:\\SuiBa\\sui-ai-trading-bot\\scripts\\real-resume.ts",
    ],
    [
      "POSIX",
      "file:///home/user/SuiBa/sui-ai-trading-bot/scripts/real-resume.ts",
      "/home/user/SuiBa/sui-ai-trading-bot/scripts/real-resume.ts",
    ],
  ])(
    "matches the %s argv path to its module URL",
    (_shape, moduleUrl, argvPath) => {
      expect(isMainModule(moduleUrl, argvPath)).toBe(true);
    },
  );
});
