import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  trimNarrationEntries,
  type NarrationEntry,
  type NarrationState,
} from "./agentNarration.ts";
import { agentReply, type AgentChatContext, type ChatTopic } from "./agentChat.ts";
import { isCommandText, runChatCommand } from "./chatCommands.ts";
import {
  startListening,
  voiceRecognitionCtor,
  type VoiceSession,
} from "./voiceInput.ts";
import {
  createAgentSpeaker,
  isSpeechSupported,
  loadAgentVoice,
  saveAgentVoice,
  type AgentSpeaker,
} from "./voiceSpeech.ts";

/**
 * The feed's chat cluster, extracted from AgentNarrationFeed:
 * the composer state, the submit path (user line in, a thinking
 * beat, the reply composed from the freshest context and
 * appended), voice input feeding the same submit path, and the
 * spoken replies. The narration state itself stays with the
 * feed — this hook appends through the feed's ref, persist and
 * setter — and the reply context's data half is written by the
 * feed after every render through the returned chatCtxRef.
 */
export function useAgentChat({
  narrationRef,
  persist,
  setNarration,
  pairLabel,
  forceStick,
  setChatReplyAt,
  onListeningChange,
  onSpeakingChange,
}: {
  /** The state the next append builds on (the feed's mirror). */
  narrationRef: RefObject<NarrationState>;
  /** Persist a new narration state (the feed's per-pair save). */
  persist: (state: NarrationState) => void;
  /** The feed's narration state setter. */
  setNarration: Dispatch<SetStateAction<NarrationState>>;
  /** The base symbol of the pair on screen, for chat replies. */
  pairLabel: string;
  /** The reader's own sends land at the page bottom (scroll). */
  forceStick: () => void;
  /** Marks a landed reply so the feed can borrow the smile pose. */
  setChatReplyAt: Dispatch<SetStateAction<number | null>>;
  /** Reports voice-recognition activity to the app shell. */
  onListeningChange?: (listening: boolean) => void;
  /** Reports speech-synthesis activity to the app shell. */
  onSpeakingChange?: (speaking: boolean) => void;
}) {
  const [chatInput, setChatInput] = useState("");
  // The chat box starts folded to a single "キャラに聞く" line so
  // the feed leads; it expands on tap (or when a milestone
  // prompt chip submits through it).
  const [chatOpen, setChatOpen] = useState(false);
  const [chatTopic, setChatTopic] = useState<ChatTopic | null>(null);
  const [chatThinking, setChatThinking] = useState(false);
  const chatTimer = useRef<number | null>(null);
  // Japanese IME: the Enter that confirms a conversion must not
  // submit the comment.
  const composingRef = useRef(false);
  useEffect(
    () => () => {
      if (chatTimer.current != null) window.clearTimeout(chatTimer.current);
    },
    [],
  );
  // The data-derived half of the chat context, refreshed after
  // every render: the reply is composed when it LANDS, from the
  // freshest snapshot, not from the moment the user hit send.
  const chatCtxRef = useRef<Pick<
    AgentChatContext,
    "dec" | "score" | "running" | "stoppedKind" | "pairLabel" | "chain"
  > | null>(null);
  const [chatReplyText, setChatReplyText] = useState("");
  const submitChat = (raw: string) => {
    const text = raw.trim().slice(0, 120);
    if (!text || chatThinking) return;
    setChatOpen(true);
    forceStick();
    const state = narrationRef.current;
    const at = Date.now();
    const withUser: NarrationState = {
      ...state,
      entries: trimNarrationEntries([
        ...state.entries,
        {
          id: `narration:${state.nextEntryId}`,
          at,
          kind: "chatUser",
          text,
        } satisfies NarrationEntry,
      ]),
      nextEntryId: state.nextEntryId + 1,
    };
    narrationRef.current = withUser;
    persist(withUser);
    setNarration(withUser);
    setChatInput("");
    setChatThinking(true);
    // A short thinking beat before the reply lands, so the
    // exchange reads as a conversation rather than a lookup. The
    // reply itself is composed inside the timer, from the
    // freshest records available at that moment.
    chatTimer.current = window.setTimeout(() => {
      chatTimer.current = null;
      const prev = narrationRef.current;
      const history = prev.priceHistory;
      const lastReply = [...prev.entries]
        .reverse()
        .find((e) => e.kind === "chatReply");
      const base = chatCtxRef.current;
      const ctx: AgentChatContext = {
        dec: base?.dec ?? null,
        score: base?.score ?? null,
        running: base?.running ?? false,
        stoppedKind: base?.stoppedKind ?? null,
        pairLabel: base?.pairLabel ?? pairLabel,
        chain: base?.chain ?? null,
        linePrice: prev.priceLine?.price ?? null,
        tradeCount: prev.entries.filter((e) => e.kind === "trade").length,
        recentMovePct:
          history.length >= 2 && history[0] > 0
            ? (history[history.length - 1] / history[0] - 1) * 100
            : null,
        lastTopic: (lastReply?.topic as ChatTopic | undefined) ?? null,
        exchangeCount: prev.entries.filter((e) => e.kind === "chatReply")
          .length,
      };
      const command = isCommandText(text);
      const reply = command
        ? { text: runChatCommand(text, ctx), topic: null, mono: true }
        : { ...agentReply(text, ctx), mono: false };
      const landedAt = Date.now();
      const next: NarrationState = {
        ...prev,
        entries: trimNarrationEntries([
          ...prev.entries,
          {
            id: `narration:${prev.nextEntryId}`,
            at: landedAt,
            kind: "chatReply",
            text: reply.text,
            topic: reply.topic ?? undefined,
            mono: reply.mono || undefined,
          } satisfies NarrationEntry,
        ]),
        nextEntryId: prev.nextEntryId + 1,
      };
      narrationRef.current = next;
      persist(next);
      setNarration(next);
      setChatTopic(reply.topic);
      setChatReplyAt(landedAt);
      setChatReplyText(reply.text);
      // A command readout is for the eyes, not the voice.
      if (!command) speakReply(reply.text);
      setChatThinking(false);
    }, 650);
  };
  // Voice input: one recognition session at a time, feeding the
  // same submitChat path as typing. The mic renders only where
  // the platform offers recognition at all.
  const voiceSupported = voiceRecognitionCtor() !== null;
  const [voiceListening, setVoiceListening] = useState(false);
  const voiceRef = useRef<VoiceSession | null>(null);
  useEffect(() => {
    onListeningChange?.(voiceListening);
  }, [voiceListening, onListeningChange]);
  useEffect(
    () => () => {
      voiceRef.current?.stop();
      voiceRef.current = null;
    },
    [],
  );
  const stopListening = () => {
    voiceRef.current?.stop();
    voiceRef.current = null;
    setVoiceListening(false);
  };
  /** Append a character line directly (no thinking beat): used
   * when recognition itself failed and there is no question to
   * answer, only something to say about it. */
  const sayChatLine = (text: string) => {
    forceStick();
    const prev = narrationRef.current;
    const next: NarrationState = {
      ...prev,
      entries: trimNarrationEntries([
        ...prev.entries,
        {
          id: `narration:${prev.nextEntryId}`,
          at: Date.now(),
          kind: "chatReply",
          text,
        } satisfies NarrationEntry,
      ]),
      nextEntryId: prev.nextEntryId + 1,
    };
    narrationRef.current = next;
    persist(next);
    setNarration(next);
    setChatReplyText(text);
    speakReply(text);
  };
  const toggleVoice = () => {
    if (voiceListening) {
      stopListening();
      return;
    }
    if (chatThinking) return;
    const session = startListening({
      onInterim: (text) => setChatInput(text.slice(0, 120)),
      onFinal: (text) => {
        setChatInput(text.slice(0, 120));
        stopListening();
        submitChat(text);
      },
      onError: (kind) => {
        stopListening();
        sayChatLine(
          kind === "denied"
            ? "マイクが使えなかった…許可を確認してみて"
            : "聞き取れなかった…もう一回お願いできる？",
        );
      },
      onEnd: () => {
        voiceRef.current = null;
        setVoiceListening(false);
      },
    });
    if (session) {
      voiceRef.current = session;
      setChatOpen(true);
      setVoiceListening(true);
    }
  };
  // The character's voice (spoken replies): opt-in and
  // device-local. Only chat replies are spoken.
  const speechSupported = isSpeechSupported();
  const [voiceOn, setVoiceOn] = useState<boolean>(() => loadAgentVoice());
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  const speakerRef = useRef<AgentSpeaker | null>(null);
  const speaker = (): AgentSpeaker => {
    if (!speakerRef.current) {
      speakerRef.current = createAgentSpeaker({
        onSpeakingChange: (speaking) => onSpeakingChange?.(speaking),
      });
    }
    return speakerRef.current;
  };
  useEffect(
    () => () => {
      speakerRef.current?.cancel();
    },
    [],
  );
  const speakReply = (text: string) => {
    if (voiceOnRef.current) speaker().speak(text);
  };
  const toggleVoiceOut = () => {
    const next = !voiceOn;
    setVoiceOn(next);
    saveAgentVoice(next);
    if (next) {
      // This tap is the gesture that unlocks audio; the short
      // confirmation both proves it and performs the unlock.
      speaker().speak("声、オンになったよ");
    } else {
      speaker().cancel();
    }
  };
  return {
    chatInput,
    setChatInput,
    chatOpen,
    setChatOpen,
    chatTopic,
    setChatTopic,
    chatThinking,
    composingRef,
    chatReplyText,
    submitChat,
    voiceSupported,
    voiceListening,
    toggleVoice,
    speechSupported,
    voiceOn,
    toggleVoiceOut,
    chatCtxRef,
  };
}
