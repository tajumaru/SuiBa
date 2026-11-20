import type { useAgentChat } from "./useAgentChat.ts";

type AgentChat = ReturnType<typeof useAgentChat>;

/**
 * The chat composer, extracted from AgentNarrationFeed: the
 * fixed bar at the screen bottom that starts folded to a
 * single "…に聞く" line and expands to the input form (the
 * owner removed the suggestion chips on 2026-11-20 — typing
 * only). All state and behaviour live in useAgentChat (owned
 * by the feed, which also needs submit for the entries'
 * prompt chips); this component is the bar's markup only.
 */
export function AgentChatComposer({
  chat,
  displayName,
}: {
  /** The feed's chat cluster (see useAgentChat). */
  chat: AgentChat;
  /** The character's display name, for the labels. */
  displayName: string;
}) {
  const {
    chatReplyText,
    chatOpen,
    setChatOpen,
    chatInput,
    setChatInput,
    chatThinking,
    submitChat,
    composingRef,
    speechSupported,
    voiceOn,
    toggleVoiceOut,
    voiceSupported,
    voiceListening,
    toggleVoice,
  } = chat;
  return (
      <div className="agent-chat">
        <p className="sr-only" role="status">
          {chatReplyText}
        </p>
        {!chatOpen ? (
          <button
            type="button"
            className="agent-chat-open"
            aria-expanded={false}
            onClick={() => setChatOpen(true)}
          >
            {displayName}に聞く
          </button>
        ) : (
          <>
        <form
          className="agent-chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (composingRef.current) return;
            submitChat(chatInput);
          }}
        >
          <input
            type="text"
            value={chatInput}
            maxLength={120}
            disabled={chatThinking}
            onChange={(e) => setChatInput(e.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            placeholder={
              voiceListening
                ? "聞いてる…話してね"
                : `${displayName}へのコメント`
            }
            aria-label={`${displayName}へのコメント`}
          />
          {speechSupported && (
            <button
              type="button"
              className={`agent-voice-toggle${voiceOn ? " on" : ""}`}
              aria-label={voiceOn ? "声あり" : "声なし"}
              aria-pressed={voiceOn}
              disabled={chatThinking}
              onClick={toggleVoiceOut}
            >
              {voiceOn ? "🔊" : "🔇"}
            </button>
          )}
          {voiceSupported && (
            <button
              type="button"
              className={`agent-chat-mic${voiceListening ? " listening" : ""}`}
              aria-label={voiceListening ? "聞き取りをやめる" : "音声で聞く"}
              aria-pressed={voiceListening}
              disabled={chatThinking}
              onClick={toggleVoice}
            >
              🎤
            </button>
          )}
          <button
            type="submit"
            className="agent-chat-send"
            aria-label="送信"
            disabled={chatThinking}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </button>
        </form>
        <button
          type="button"
          className="agent-chat-close"
          aria-expanded={true}
          onClick={() => setChatOpen(false)}
        >
          畳む
        </button>
          </>
        )}
      </div>
  );
}
