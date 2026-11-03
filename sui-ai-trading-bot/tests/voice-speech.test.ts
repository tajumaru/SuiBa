import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  createAgentSpeaker,
  loadAgentVoice,
  saveAgentVoice,
  speakableText,
  type UtteranceLike,
} from "../apps/dashboard/src/voiceSpeech.ts";
import { AgentHeaderAvatar } from "../apps/dashboard/src/AgentNarration.tsx";

describe("voice speech", () => {
  it("rewrites acronyms and symbols for reading aloud", () => {
    expect(speakableText("RSI（あと28）")).toBe("アールエスアイ（あと28）");
    expect(speakableText("SUI / USDC、MACDとEMA")).toBe(
      "スイ / ユーエスディーシー、マックディーとイーエムエー",
    );
    expect(speakableText("約定率は45%")).toBe("約定率は45パーセント");
    expect(speakableText("価格は$0.88")).toBe("価格はドル0.88");
    expect(speakableText("様子見です")).toBe("様子見です");
  });

  it("persists the opt-in flag", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    expect(loadAgentVoice(storage)).toBe(false);
    saveAgentVoice(true, storage);
    expect(loadAgentVoice(storage)).toBe(true);
    saveAgentVoice(false, storage);
    expect(loadAgentVoice(storage)).toBe(false);
    expect(loadAgentVoice(null)).toBe(false);
  });

  it("speaks through the injected synth with a Japanese voice", () => {
    const spoken: UtteranceLike[] = [];
    const changes: boolean[] = [];
    const synth = {
      speak: (u: UtteranceLike) => {
        spoken.push(u);
        u.onstart?.();
      },
      cancel: vi.fn(),
      getVoices: () => [
        { name: "Kyoko", lang: "ja-JP" },
        { name: "Samantha", lang: "en-US" },
      ],
    };
    const speaker = createAgentSpeaker({
      synth,
      makeUtterance: (text) =>
        ({
          lang: "",
          rate: 1,
          pitch: 1,
          voice: null,
          onstart: null,
          onend: null,
          onerror: null,
          text,
        }) as unknown as UtteranceLike & { text: string },
      onSpeakingChange: (s) => changes.push(s),
    });
    expect(speaker.supported).toBe(true);
    expect(speaker.speak("RSIはまだ")).toBe(true);
    const u = spoken[0] as UtteranceLike & { text: string };
    expect(u.text).toBe("アールエスアイはまだ");
    expect(u.lang).toBe("ja-JP");
    expect(u.voice?.name).toBe("Kyoko");
    expect(changes).toEqual([true]);
    u.onend?.();
    expect(changes).toEqual([true, false]);
    expect(speaker.speak("  ")).toBe(false);
  });

  it("is unsupported without a synth", () => {
    const speaker = createAgentSpeaker({ synth: null });
    expect(speaker.supported).toBe(false);
    expect(speaker.speak("こんにちは")).toBe(false);
  });

  it("the header avatar shows the speaking state", () => {
    const speaking = renderToStaticMarkup(
      React.createElement(AgentHeaderAvatar, {
        pose: "normal",
        speaking: true,
      }),
    );
    expect(speaking).toContain("喋ってる…");
    expect(speaking).toContain('data-pose="normal"'); // frame pose unchanged
    const listening = renderToStaticMarkup(
      React.createElement(AgentHeaderAvatar, {
        pose: "normal",
        speaking: true,
        listening: true,
      }),
    );
    expect(listening).toContain("聞いてる…"); // listening outranks speaking
    expect(listening).toContain("agent-avatar-listen");
  });
});
