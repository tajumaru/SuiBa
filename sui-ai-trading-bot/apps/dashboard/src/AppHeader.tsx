import type { BotEngine } from "../../worker/src/engine.ts";
import { AgentHeaderAvatar } from "./AgentNarration.tsx";
import { presetName } from "./settingsPresets.ts";
import type { AgentPose } from "./agentNarration.ts";
import type { ErrorShout } from "./errorShout.ts";

type State = ReturnType<BotEngine["snapshot"]>;

/**
 * The app header and the narration character's avatar dock,
 * extracted from App. The avatar is a sibling of the header,
 * not a child, so its sticky dock can travel the whole page;
 * it renders only once connected (the login screen has no bot
 * state to show).
 */
export function AppHeader({
  data,
  token,
  control,
  logout,
  agentPose,
  buyCelebration,
  shout,
  agentName,
  changeAgentName,
  voiceListening,
  agentSpeaking,
}: {
  data: State | null;
  token: string;
  control: (command: string) => Promise<string | null>;
  logout: () => void;
  agentPose: AgentPose;
  buyCelebration: boolean;
  shout: ErrorShout | null;
  agentName: string;
  changeAgentName: (raw: string) => void;
  voiceListening: boolean;
  agentSpeaking: boolean;
}) {
  return (
    <>
      <header>
        <div className="header-row header-row-main">
          <strong>◈ Sui Paper Lab</strong>
          <span className="badge">PAPER（仮想売買）専用</span>
        </div>
        <div className="header-row header-row-sub">
          <button
            className="danger"
            disabled={!data}
            onClick={() => void control("emergency")}
          >
            緊急停止
          </button>
          {token && (
            <button className="logout-link" onClick={logout}>
              ログアウト
            </button>
          )}
        </div>
      </header>
      {/* The narration character rides at the top centre of the app
          as a round avatar, on every tab — but only once connected:
          the login screen has no bot state to show, so no avatar
          (and no placeholder) is rendered. It is a sibling of the
          header, not a child, so its sticky dock (see
          .agent-avatar-dock in style.css) can travel the whole
          page: at rest it floats half over the header's bottom
          edge, and on scroll it sticks to the top of the viewport
          instead of scrolling away with the header. */}
      {token && (
        <AgentHeaderAvatar
          pose={agentPose}
          celebrating={buyCelebration}
          shout={shout}
          hardMode={data != null && presetName(data.settings) === "hard"}
          agentName={agentName}
          onRename={changeAgentName}
          listening={voiceListening}
          speaking={agentSpeaking}
        />
      )}
    </>
  );
}
