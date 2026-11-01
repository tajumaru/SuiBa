import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  startListening,
  voiceRecognitionCtor,
  type RecognitionLike,
} from "../apps/dashboard/src/voiceInput.ts";
import { AgentHeaderAvatar } from "../apps/dashboard/src/AgentNarration.tsx";

class FakeRecognition implements RecognitionLike {
  lang = "";
  interimResults = false;
  continuous = false;
  onresult: RecognitionLike["onresult"] = null;
  onerror: RecognitionLike["onerror"] = null;
  onend: RecognitionLike["onend"] = null;
  started = false;
  stopped = false;
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  emitResult(results: { isFinal: boolean; transcript: string }[]) {
    this.onresult?.({
      results: results.map((r) => ({
        isFinal: r.isFinal,
        0: { transcript: r.transcript },
        length: 1,
      })),
    });
  }
  emitError(error: string) {
    this.onerror?.({ error });
  }
}

const callbacks = () => ({
  onInterim: vi.fn(),
  onFinal: vi.fn(),
  onError: vi.fn(),
  onEnd: vi.fn(),
});

describe("voice input", () => {
  it("detects the constructor (standard or webkit-prefixed)", () => {
    expect(voiceRecognitionCtor({})).toBeNull();
    expect(
      voiceRecognitionCtor({ webkitSpeechRecognition: FakeRecognition }),
    ).toBe(FakeRecognition);
    expect(voiceRecognitionCtor({ SpeechRecognition: FakeRecognition })).toBe(
      FakeRecognition,
    );
    expect(voiceRecognitionCtor()).toBeNull(); // absent in this env
  });

  it("returns no session without a constructor", () => {
    expect(startListening(callbacks(), null)).toBeNull();
  });

  it("streams interim text, then delivers the final once", () => {
    const cb = callbacks();
    let rec: FakeRecognition | null = null;
    class Ctor extends FakeRecognition {
      constructor() {
        super();
        rec = this;
      }
    }
    const session = startListening(cb, Ctor);
    expect(session).not.toBeNull();
    expect(rec!.started).toBe(true);
    expect(rec!.lang).toBe("ja-JP");
    expect(rec!.interimResults).toBe(true);
    rec!.emitResult([{ isFinal: false, transcript: "なんで" }]);
    expect(cb.onInterim).toHaveBeenCalledWith("なんで");
    rec!.emitResult([{ isFinal: true, transcript: "なんで買わないの" }]);
    expect(cb.onFinal).toHaveBeenCalledTimes(1);
    expect(cb.onFinal).toHaveBeenCalledWith("なんで買わないの");
    rec!.emitResult([{ isFinal: true, transcript: "なんで買わないの" }]);
    expect(cb.onFinal).toHaveBeenCalledTimes(1); // never twice
    session!.stop();
    expect(rec!.stopped).toBe(true);
  });

  it("maps platform errors to kinds", () => {
    const seen: string[] = [];
    const run = (error: string) => {
      let rec: FakeRecognition | null = null;
      class Ctor extends FakeRecognition {
        constructor() {
          super();
          rec = this;
        }
      }
      const cb = callbacks();
      startListening(cb, Ctor);
      rec!.emitError(error);
      seen.push(cb.onError.mock.calls[0][0] as string);
    };
    run("not-allowed");
    run("no-speech");
    run("network");
    expect(seen).toEqual(["denied", "no-speech", "other"]);
  });

  it("the header avatar switches to the listening artwork", () => {
    const listening = renderToStaticMarkup(
      React.createElement(AgentHeaderAvatar, {
        pose: "normal",
        listening: true,
      }),
    );
    expect(listening).toContain("agent-avatar-listen");
    expect(listening).toContain("聞いてる…");
    // A shout still outranks listening.
    const shouting = renderToStaticMarkup(
      React.createElement(AgentHeaderAvatar, {
        pose: "normal",
        listening: true,
        shout: {
          kind: "emergency",
          label: "緊急停止中",
          message: "止まってるよ！",
        },
      }),
    );
    expect(shouting).toContain("agent-avatar-scream");
    const plain = renderToStaticMarkup(
      React.createElement(AgentHeaderAvatar, { pose: "normal" }),
    );
    expect(plain).not.toContain("agent-avatar-listen");
  });
});
