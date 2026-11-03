/**
 * The character's voice: spoken chat replies via the platform's
 * speech synthesis (iOS Safari's Japanese voices). Opt-in and
 * device-local — the toggle lives in the chat sheet, defaults
 * off, and the tap that turns it on is also the user gesture
 * that unlocks audio. Only chat replies are spoken, never the
 * narration feed. Synthesis runs on the device; nothing is
 * sent anywhere by the app.
 */

export const AGENT_VOICE_KEY = "suiba.agentVoice";

interface VoiceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): VoiceStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadAgentVoice(
  storage: VoiceStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(AGENT_VOICE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveAgentVoice(
  on: boolean,
  storage: VoiceStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(AGENT_VOICE_KEY, on ? "1" : "0");
  } catch {
    // Blocked storage must never break the chat.
  }
}

/**
 * Read-aloud form of a reply: trading acronyms become their
 * spoken Japanese names and symbols become words, so the
 * synthesis does not stumble over "RSI" or "%".
 */
const SPEAKABLE: [string, string][] = [
  ["USDC", "ユーエスディーシー"],
  ["RSI", "アールエスアイ"],
  ["MACD", "マックディー"],
  ["EMA", "イーエムエー"],
  ["DeepBook", "ディープブック"],
  ["SUI", "スイ"],
  ["WAL", "ウォル"],
  ["PAPER", "ペーパー"],
  ["%", "パーセント"],
  ["$", "ドル"],
];

export function speakableText(text: string): string {
  let out = text;
  for (const [from, to] of SPEAKABLE) out = out.split(from).join(to);
  return out;
}

export interface UtteranceLike {
  lang: string;
  rate: number;
  pitch: number;
  voice: { name: string; lang: string } | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

export interface SynthLike {
  speak(utterance: UtteranceLike): void;
  cancel(): void;
  getVoices(): { name: string; lang: string }[];
}

export interface AgentSpeaker {
  supported: boolean;
  speak(text: string): boolean;
  cancel(): void;
}

export function isSpeechSupported(
  scope: Record<string, unknown> = globalThis as Record<string, unknown>,
): boolean {
  return (
    typeof scope.speechSynthesis === "object" &&
    scope.speechSynthesis !== null &&
    typeof scope.SpeechSynthesisUtterance === "function"
  );
}

export function createAgentSpeaker(options?: {
  synth?: SynthLike | null;
  makeUtterance?: (text: string) => UtteranceLike;
  onSpeakingChange?: (speaking: boolean) => void;
}): AgentSpeaker {
  const scope = globalThis as Record<string, unknown>;
  const synth =
    options?.synth ??
    (isSpeechSupported()
      ? (scope.speechSynthesis as SynthLike)
      : null);
  const makeUtterance =
    options?.makeUtterance ??
    ((text: string) => {
      const UtteranceCtor = scope.SpeechSynthesisUtterance as new (
        text: string,
      ) => UtteranceLike;
      return new UtteranceCtor(text);
    });
  const supported = synth !== null;
  const notify = options?.onSpeakingChange ?? (() => {});
  return {
    supported,
    speak(text: string): boolean {
      if (!synth || !text.trim()) return false;
      try {
        synth.cancel();
        const utterance = makeUtterance(speakableText(text));
        utterance.lang = "ja-JP";
        utterance.rate = 1.0;
        utterance.pitch = 1.15;
        const voices = synth.getVoices().filter((v) =>
          v.lang?.toLowerCase().startsWith("ja"),
        );
        utterance.voice =
          voices.find((v) => v.name.includes("Kyoko")) ?? voices[0] ?? null;
        utterance.onstart = () => notify(true);
        utterance.onend = () => notify(false);
        utterance.onerror = () => notify(false);
        synth.speak(utterance);
        return true;
      } catch {
        notify(false);
        return false;
      }
    },
    cancel() {
      if (!synth) return;
      try {
        synth.cancel();
      } catch {
        // Nothing playing: fine.
      }
      notify(false);
    },
  };
}
