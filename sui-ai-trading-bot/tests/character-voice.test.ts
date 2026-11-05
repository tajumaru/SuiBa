import { describe, expect, it } from "vitest";
import { greetingText, voiceText } from "../apps/dashboard/src/narration/voice.ts";

describe("voiceText", () => {
  it("leaves the white character's lines exactly as written", () => {
    const text = "PAPERで買いを記録したよ：SUI 5.0";
    expect(voiceText("trade", text, "white")).toBe(text);
  });

  it("gives ぺんちゃん one ぺん ending per entry", () => {
    expect(
      voiceText("trade", "PAPERで買いを記録したよ：SUI 5.0", "pen"),
    ).toBe("PAPERで買いを記録したぺん：SUI 5.0");
    expect(voiceText("status", "稼働中だよ。待ってるね", "pen")).toBe(
      "稼働中だぺん。待ってるね",
    );
    expect(voiceText("status", "開始操作を待ってるね", "pen")).toBe(
      "開始操作を待ってるぺん",
    );
  });

  it("gives King Fizh a kingly ending, numbers untouched", () => {
    expect(
      voiceText("priceLine", "宣言するよ。0.5123まで下がったら届く", "fizh"),
    ).toBe("宣言するぞ。0.5123まで下がったら届く");
    expect(voiceText("status", "停止中だよ。理由：手動", "fizh")).toBe(
      "停止中であるぞ。理由：手動",
    );
    expect(voiceText("status", "開始操作を待ってるね", "fizh")).toBe(
      "開始操作を待ってるね",
    );
  });

  it("rewrites only the first spoken ending", () => {
    expect(voiceText("cycle", "見送ったよ。次を待つよ", "pen")).toBe(
      "見送ったぺん。次を待つよ",
    );
  });

  it("never touches the designed voices or the user's own words", () => {
    const kansai = "あと少しやったのに、離れてしもた";
    expect(voiceText("nearMiss", kansai, "pen")).toBe(kansai);
    expect(voiceText("watchHit", "ほらな、言うてたやろ", "fizh")).toBe(
      "ほらな、言うてたやろ",
    );
    expect(voiceText("chatUser", "調子はどうだよ", "pen")).toBe(
      "調子はどうだよ",
    );
    expect(voiceText("monthlyReport", "今月は勝率50%だよ", "fizh")).toBe(
      "今月は勝率50%だよ",
    );
  });

  it("passes texts without a spoken ending through unchanged", () => {
    const text = "1時間で+2.4%（0.5123）";
    expect(voiceText("alert", text, "pen")).toBe(text);
    expect(voiceText("alert", text, "fizh")).toBe(text);
  });
});

describe("greetingText", () => {
  it("hands over by name, in the incoming character's voice", () => {
    expect(greetingText("white", "pen", "")).toBe(
      "キャラ、おつかれさまだぺん。交代だぺん！ここからはぺんちゃんが実況するぺん",
    );
    expect(greetingText("pen", "fizh", "")).toBe(
      "ぺんちゃん、ご苦労であった。交代であるぞ。ここからは余、King Fizhが実況するぞ",
    );
    expect(greetingText("fizh", "white", "")).toBe(
      "King Fizh、おつかれさま。交代だよ。ここからはキャラが実況するよ",
    );
  });

  it("drops the address when a custom name reads the same on both sides", () => {
    expect(greetingText("white", "pen", "ボブ")).toBe(
      "交代だぺん！ここからはボブが実況するぺん",
    );
  });
});
