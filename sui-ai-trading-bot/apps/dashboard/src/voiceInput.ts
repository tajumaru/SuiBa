/**
 * Voice input for the character chat, over the Web Speech API
 * (Safari's webkitSpeechRecognition). Deliberately thin: it
 * detects the constructor, runs one recognition session in
 * Japanese, streams interim transcripts into the chat input,
 * and hands the final transcript to the normal submit path —
 * so a spoken question is indistinguishable from a typed one
 * downstream. Recognition itself happens on the platform's
 * servers (Apple's, on iOS Safari); nothing is recorded or
 * stored by the app. Where the API is absent the mic button
 * simply never renders (keyboard dictation still works).
 */

export type VoiceErrorKind = "denied" | "no-speech" | "other";

export interface VoiceCallbacks {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onError(kind: VoiceErrorKind): void;
  onEnd(): void;
}

interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
  length: number;
}

interface RecognitionEventLike {
  results: ArrayLike<RecognitionResultLike>;
}

export interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export type RecognitionCtor = new () => RecognitionLike;

export function voiceRecognitionCtor(
  scope: Record<string, unknown> = globalThis as Record<string, unknown>,
): RecognitionCtor | null {
  const ctor =
    (scope.SpeechRecognition as RecognitionCtor | undefined) ??
    (scope.webkitSpeechRecognition as RecognitionCtor | undefined);
  return typeof ctor === "function" ? ctor : null;
}

export interface VoiceSession {
  stop(): void;
}

export function startListening(
  callbacks: VoiceCallbacks,
  ctor: RecognitionCtor | null = voiceRecognitionCtor(),
): VoiceSession | null {
  if (!ctor) return null;
  const recognition = new ctor();
  recognition.lang = "ja-JP";
  recognition.interimResults = true;
  recognition.continuous = false;
  let finalSent = false;
  recognition.onresult = (event) => {
    let interim = "";
    let final = "";
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) final += result[0].transcript;
      else interim += result[0].transcript;
    }
    if (final) {
      if (!finalSent) {
        finalSent = true;
        callbacks.onFinal(final);
      }
    } else if (interim) {
      callbacks.onInterim(interim);
    }
  };
  recognition.onerror = (event) => {
    const kind: VoiceErrorKind =
      event.error === "not-allowed" || event.error === "service-not-allowed"
        ? "denied"
        : event.error === "no-speech"
          ? "no-speech"
          : "other";
    callbacks.onError(kind);
  };
  recognition.onend = () => callbacks.onEnd();
  try {
    recognition.start();
  } catch {
    callbacks.onError("other");
    return null;
  }
  return {
    stop() {
      try {
        recognition.stop();
      } catch {
        // Already stopped: nothing to do.
      }
    },
  };
}
