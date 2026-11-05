import type { NarrationEntry } from "./agentNarration.ts";
import { followUpChips, orderedChips } from "./agentChat.ts";
import { commandSuggestions, isCommandText } from "./chatCommands.ts";
import type { useAgentChat } from "./useAgentChat.ts";

type AgentChat = ReturnType<typeof useAgentChat>;

/**
 * The chat composer, extracted from AgentNarrationFeed: the
 * fixed bar at the screen bottom that starts folded to a
 * single "…に聞く" line and expands to the suggestion chips,
 * the voice toggles and the input form. All state and
 * behaviour live in useAgentChat (owned by the feed, which
 * also needs submit for the entries' prompt chips); this
 * component is the bar's markup only.
 */
export function AgentChatComposer({
  chat,
  displayName,
  entries,
}: {
  /** The feed's chat cluster (see useAgentChat). */
  chat: AgentChat;
  /** The character's display name, for the labels. */
  displayName: string;
  /** The feed's entries; the opening chips avoid the topics
   * the reader already asked about. */
  entries: readonly NarrationEntry[];
}) {
  const {
    chatReplyText,
    chatOpen,
    setChatOpen,
    chatInput,
    setChatInput,
    chatThinking,
    chatTopic,
    setChatTopic,
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
        <div
          className="agent-chat-chips"
          role="group"
          aria-label={`${displayName}への質問候補`}
        >
          {isCommandText(chatInput) ? (
            commandSuggestions(chatInput).map((cmd) => (
              <button
                key={cmd.name}
                type="button"
                disabled={chatThinking}
                onClick={() => submitChat(cmd.name)}
              >
                {cmd.name}（{cmd.hint}）
              </button>
            ))
          ) : (
            <>
              {(chatTopic == null
                ? orderedChips(
                    entries
                      .filter((e) => e.kind === "chatUser")
                      .map((e) => e.text),
                  )
                : followUpChips(chatTopic)
              ).map((chip) => (
                <button
                  key={chip}
                  type="button"
                  disabled={chatThinking}
                  onClick={() => submitChat(chip)}
                >
                  {chip}
                </button>
              ))}
              {chatTopic != null && (
                <button
                  type="button"
                  disabled={chatThinking}
                  onClick={() => setChatTopic(null)}
                >
                  ほかの質問
                </button>
              )}
            </>
          )}
          {speechSupported && (
            <button
              type="button"
              className={`agent-voice-toggle${voiceOn ? " on" : ""}`}
              aria-pressed={voiceOn}
              onClick={toggleVoiceOut}
            >
              {voiceOn ? "🔊 声あり" : "🔇 声なし"}
            </button>
          )}
        </div>
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
          <button type="submit" disabled={chatThinking}>
            送信
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
