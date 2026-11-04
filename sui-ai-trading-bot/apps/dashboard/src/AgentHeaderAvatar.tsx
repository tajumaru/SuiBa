import imgNormal from "./assets/agent-white-normal.jpg";
import imgPoint from "./assets/agent-white-point.jpg";
import imgPointSmile from "./assets/agent-white-point-smile.jpg";
import imgSleep from "./assets/agent-white-sleep.jpg";
import imgLaptop from "./assets/agent-white-laptop.jpg";
import imgBlueLine from "./assets/agent-blue-line.jpg";
import imgHard from "./assets/agent-hard.jpg";
import imgHardPoint from "./assets/agent-hard-point.jpg";
import imgHardPointSmile from "./assets/agent-hard-point-smile.jpg";
import imgHardGuitar from "./assets/agent-hard-guitar.jpg";
import imgHardGuitar2 from "./assets/agent-hard-guitar-2.jpg";
import imgLaptopTyping from "./assets/agent-white-laptop-typing.jpg";
import imgScream from "./assets/agent-white-scream.jpg";
import imgListen from "./assets/agent-white-listen.jpg";
import imgPenNormal from "./assets/agent-pen-normal.jpg";
import imgPenPoint from "./assets/agent-pen-point.jpg";
import imgPenPointSmile from "./assets/agent-pen-point-smile.jpg";
import imgPenSleep from "./assets/agent-pen-sleep.jpg";
import imgPenLaptop from "./assets/agent-pen-laptop.jpg";
import imgPenLaptopTyping from "./assets/agent-pen-laptop-typing.jpg";
import imgPenBlueLine from "./assets/agent-pen-blue-line.jpg";
import imgPenScream from "./assets/agent-pen-scream.jpg";
import imgPenListen from "./assets/agent-pen-listen.jpg";
import imgFizhNormal from "./assets/agent-fizh-normal.jpg";
import imgFizhPoint from "./assets/agent-fizh-point.jpg";
import imgFizhPointSmile from "./assets/agent-fizh-point-smile.jpg";
import imgFizhSleep from "./assets/agent-fizh-sleep.jpg";
import imgFizhLaptop from "./assets/agent-fizh-laptop.jpg";
import imgFizhLaptopTyping from "./assets/agent-fizh-laptop-typing.jpg";
import imgFizhBlueLine from "./assets/agent-fizh-blue-line.jpg";
import imgFizhScream from "./assets/agent-fizh-scream.jpg";
import imgFizhListen from "./assets/agent-fizh-listen.jpg";
import {
  saveAgentCharacter,
  useAgentCharacter,
  type AgentCharacter,
} from "./agentCharacter.ts";
import type { AgentPose } from "./agentNarration.ts";
import type { ErrorShout } from "./errorShout.ts";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion.ts";
import { useEffect, useState } from "react";
import { agentDisplayName } from "./agentName.ts";

export const POSE_IMAGE: Record<AgentPose, string> = {
  normal: imgNormal,
  point: imgPoint,
  pointSmile: imgPointSmile,
  sleep: imgSleep,
  laptop: imgLaptop,
  buyLine: imgBlueLine,
};

/** ぺんちゃん's artwork, pose for pose with the white set: the
 * pink penguin (pink hood, white face, orange beak) in the same
 * flat style and the same scenes — the blue-line crowd included. */
export const PEN_POSE_IMAGE: Record<AgentPose, string> = {
  normal: imgPenNormal,
  point: imgPenPoint,
  pointSmile: imgPenPointSmile,
  sleep: imgPenSleep,
  laptop: imgPenLaptop,
  buyLine: imgPenBlueLine,
};

/** Sui King Fizh's artwork, pose for pose with the other sets:
 * the blue fish king in his own painterly style — gold crown,
 * monocle, white fur collar, red royal robe and the Sui-drop
 * medallion — with a crowd of smaller blue fish for the
 * blue-line celebration. */
export const FIZH_POSE_IMAGE: Record<AgentPose, string> = {
  normal: imgFizhNormal,
  point: imgFizhPoint,
  pointSmile: imgFizhPointSmile,
  sleep: imgFizhSleep,
  laptop: imgFizhLaptop,
  buyLine: imgFizhBlueLine,
};

/** The shout and listen overlays per character (they are not
 * poses in the map above; the avatar swaps them in directly). */
const SCREAM_IMAGE: Record<AgentCharacter, string> = {
  white: imgScream,
  pen: imgPenScream,
  fizh: imgFizhScream,
};
const LISTEN_IMAGE: Record<AgentCharacter, string> = {
  white: imgListen,
  pen: imgPenListen,
  fizh: imgFizhListen,
};

/**
 * The artwork for one pose: the still frame, plus — for the
 * laptop pose only — the second typing frame stacked over it.
 * ぺんちゃん wears its own artwork for every pose and has no
 * hard-mode set (the hard portraits belong to the white
 * character's persona); the white character's hard set covers
 * only the working poses, exactly as before, and its sleep and
 * blue-line artwork stay its own in every mode.
 */
export function artworkFor(
  character: AgentCharacter,
  pose: AgentPose,
  hardMode: boolean,
): { main: string; typing: string | null } {
  if (character === "pen")
    return {
      main: PEN_POSE_IMAGE[pose],
      typing: pose === "laptop" ? imgPenLaptopTyping : null,
    };
  if (character === "fizh")
    return {
      main: FIZH_POSE_IMAGE[pose],
      typing: pose === "laptop" ? imgFizhLaptopTyping : null,
    };
  if (hardMode) {
    if (pose === "normal") return { main: imgHard, typing: null };
    if (pose === "point") return { main: imgHardPoint, typing: null };
    if (pose === "pointSmile")
      return { main: imgHardPointSmile, typing: null };
    if (pose === "laptop")
      return { main: imgHardGuitar, typing: imgHardGuitar2 };
  }
  return {
    main: POSE_IMAGE[pose],
    typing: pose === "laptop" ? imgLaptopTyping : null,
  };
}
export const POSE_LABEL: Record<AgentPose, string> = {
  normal: "様子を見ています",
  point: "条件が近づいています",
  pointSmile: "売買を記録しました",
  sleep: "止まっています",
  laptop: "様子を見ています",
  buyLine: "ラインに接近中",
};

/**
 * The avatar artwork for the current pose. Only the laptop pose has
 * a second frame — the same scene with the near hand's index finger
 * raised — stacked on top of the base frame; style.css flips the
 * two in a two-frame typing loop (about 0.26s per frame) purely with
 * CSS keyframes, and only when reduced motion is not requested.
 * Under prefers-reduced-motion the second frame rests invisible,
 * so the laptop pose is the still base frame, like every other
 * pose's single image.
 *
 * While the saved settings are the hard-mode preset, the working
 * poses wear the hard artwork instead: the normal pose becomes the
 * sunglasses-and-mohawk portrait, the laptop pose becomes the
 * Sui-blue guitar pair (playing / strumming arm raised), flipped
 * by the same typing loop, and the two pointing poses get their
 * own hard portraits (running time is mostly spent pointing, so
 * leaving them white hid the mode entirely). Sleep, the blue line
 * crowd and the scream keep their own artwork — those are
 * separate states, not the working look.
 */
export function AgentAvatarArtwork({
  pose,
  hardMode = false,
}: {
  pose: AgentPose;
  hardMode?: boolean;
}) {
  const character = useAgentCharacter();
  const art = artworkFor(character, pose, hardMode);
  return (
    <>
      <img src={art.main} alt="" />
      {art.typing && (
        <img className="agent-avatar-typing" src={art.typing} alt="" />
      )}
    </>
  );
}

/**
 * Pill dot tone per pose, in the dashboard's usual state colours:
 * the laptop pose (awake at the desk, watching) burns green, the
 * pointing poses (a condition just clicked, or the hunt closing in)
 * burn gold, and the sleeping / unconfirmed poses stay grey.
 */
export const AVATAR_DOT_TONE: Record<AgentPose, "run" | "near" | "stop" | "line"> = {
  normal: "stop",
  point: "near",
  pointSmile: "near",
  sleep: "stop",
  laptop: "run",
  buyLine: "line",
};

/**
 * The narration character as a round avatar at the top centre of
 * the app (main.tsx renders it on every tab): the pose artwork
 * clipped to a circle and gently bobbing, with the
 * pose's status label — the same POSE_LABEL the feed stage used to
 * show — in a pill underneath. The detailed expression overlay of
 * the old in-feed stage (a Zzz stream, a snot bubble, fingertip
 * stars positioned on the artwork) does not fit a 76px circle, so
 * the avatar keeps only two coarse marks: a floating "Zzz" while
 * asleep and a twinkling star while pointing, drawn as plain spans
 * keyed to the pose-* class in style.css. The artwork itself is
 * decorative (the pill carries the status text), so the circle is
 * aria-hidden. The dock is sticky (see .agent-avatar-dock in
 * style.css): it rests half over the header's bottom edge and
 * then stays at the top of the viewport while the page scrolls.
 * Motion is defined only under prefers-reduced-motion:
 * no-preference in style.css; under reduce everything rests
 * still and the marks stay as faint marks.
 */
/**
 * The burst marks of a buy celebration, in the approved flashy
 * arrangement: gold stars and pale-blue notes scattered around the
 * circle. They exist only while celebrating and only when motion
 * is allowed — under reduced motion the celebration is the still
 * smile and the gold pill alone, so the marks are never rendered.
 */
export const AVATAR_BURST_MARKS = [
  { className: "s1", mark: "✦" },
  { className: "s2", mark: "✦" },
  { className: "s3", mark: "✦" },
  { className: "n1", mark: "♪" },
  { className: "n2", mark: "♪" },
  { className: "s4", mark: "✦" },
  { className: "s5", mark: "✦" },
  { className: "n3", mark: "♪" },
] as const;

/**
 * While `celebrating`, the avatar borrows the smile artwork
 * whatever the derived pose is, hops once and throws the burst
 * marks (motion permitting), and the pill turns gold with
 * 「買えた！」. The override is render-local: the feed keeps
 * reporting the pose derived from the records, so when the
 * celebration ends the avatar falls back to exactly that pose.
 *
 * An error shout (see errorShout.ts) outranks even the
 * celebration: the avatar swaps to the dedicated scream artwork
 * — the same character in a Munch-style pose, both hands with
 * fingers pressed to its cheeks, wide hollow eyes and an open
 * oval mouth — shakes once, and calls out the short fixed line
 * in a speech bubble while the pill carries the state label in
 * alert colours. The scream and bubble stay for as long as the
 * error state does; the shake replays when the kind of error
 * changes (the avatar remounts on the kind key). Under reduced
 * motion there is no shake or pop: the face, the bubble and the
 * pill still change.
 */
export function AgentHeaderAvatar({
  pose,
  celebrating = false,
  shout = null,
  hardMode = false,
  agentName = "",
  onRename,
  listening = false,
  speaking = false,
}: {
  pose: AgentPose;
  celebrating?: boolean;
  shout?: ErrorShout | null;
  /** Voice recognition is live in the chat: the DJ artwork
   * (Sui-blue headphones, one cup lifted) replaces the pose.
   * Shouts and the buy celebration outrank it. */
  listening?: boolean;
  /** A spoken reply is playing: the pointing smile shows with
   * a 喋ってる… pill. Listening, shouts and celebrations
   * outrank it. */
  speaking?: boolean;
  /** The character's user-chosen name ("" shows as キャラ). */
  agentName?: string;
  /** When set, tapping the avatar opens the rename editor and
   * saving calls this with the raw input (sanitised upstream). */
  onRename?: (name: string) => void;
  /** The saved settings are the hard-mode preset: the working
   * poses wear the hard artwork, and on the base poses (normal /
   * laptop) the pill says so too — the pointing poses keep their
   * factual state label. Shouts and celebrations outrank it. */
  hardMode?: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const character = useAgentCharacter();
  // While the page is scrolled, the sticky dock rides over the
  // operation bar and the ticker: shrink the avatar and fold
  // the status pill away so the character never covers the
  // state text or the price (the shout bubble stays). Hysteresis
  // keeps the boundary from flickering.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      setStuck((prev) => {
        const y = window.scrollY;
        return prev ? y > 80 : y > 140;
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const shouting = shout !== null;
  const shownPose: AgentPose = shouting
    ? "normal"
    : celebrating
      ? "pointSmile"
      : pose;
  const animated = celebrating && !reducedMotion && !shouting;
  const artworkHard = hardMode && !shouting && !celebrating;
  const hardShown =
    artworkHard && (shownPose === "normal" || shownPose === "laptop");
  const stateLabel = shouting
    ? shout.label
    : celebrating
      ? "買えた！"
      : listening
        ? "聞いてる…"
        : speaking
          ? "喋ってる…"
          : hardShown
            ? "ハードモード中"
            : POSE_LABEL[shownPose];
  return (
    <div className={`agent-avatar-dock${stuck ? " stuck" : ""}`}>
      <div
        key={shout ? shout.kind : "calm"}
        className={`agent-avatar pose-${shownPose}${animated ? " celebrating" : ""}${shouting ? " shouting" : ""}`}
        data-pose={shownPose}
        aria-hidden="true"
      >
        <div className="agent-avatar-bob">
          {shouting ? (
            <img
              className="agent-avatar-scream"
              src={SCREAM_IMAGE[character]}
              alt=""
            />
          ) : listening && !celebrating ? (
            <img
              className="agent-avatar-listen"
              src={LISTEN_IMAGE[character]}
              alt=""
            />
          ) : speaking && !celebrating ? (
            <AgentAvatarArtwork pose="pointSmile" hardMode={artworkHard} />
          ) : (
            <AgentAvatarArtwork pose={shownPose} hardMode={artworkHard} />
          )}
        </div>
        <span className="agent-avatar-zzz">Zzz</span>
        <span className="agent-avatar-star">✦</span>
        {shouting && (
          <span className="agent-avatar-bubble">{shout.message}</span>
        )}
        {animated && (
          <span className="agent-avatar-burst">
            {AVATAR_BURST_MARKS.map((m) => (
              <span key={m.className} className={m.className}>
                {m.mark}
              </span>
            ))}
          </span>
        )}
        {shownPose === "buyLine" && !reducedMotion && (
          <span className="agent-avatar-petals" aria-hidden="true">
            <span className="p1" />
            <span className="p2" />
            <span className="p3" />
            <span className="p4" />
          </span>
        )}
      </div>
      <p
        className={`agent-avatar-pill${celebrating && !shouting ? " celebrate" : ""}${shouting ? " shout" : ""}${shownPose === "buyLine" && !shouting && !celebrating ? " line" : ""}`}
        role="status"
      >
        <span
          className={
            shouting
              ? "agent-avatar-dot shout"
              : `agent-avatar-dot tone-${AVATAR_DOT_TONE[shownPose]}`
          }
          aria-hidden="true"
        />
        {(agentName !== "" || character !== "white") && (
          <span className="agent-avatar-name">
            {agentDisplayName(agentName, character)}：
          </span>
        )}
        {stateLabel}
      </p>
      {onRename && (
        <button
          type="button"
          className="agent-avatar-tap"
          aria-label={`${agentDisplayName(agentName, character)}の名前を変える`}
          aria-expanded={renameOpen}
          onClick={() => {
            setRenameDraft(agentName);
            setRenameOpen((v) => !v);
          }}
        >
          <span className="agent-avatar-edit-badge" aria-hidden="true">
            ✎
          </span>
        </button>
      )}
      {onRename && renameOpen && (
        <form
          className="agent-rename"
          onSubmit={(e) => {
            e.preventDefault();
            onRename(renameDraft);
            setRenameOpen(false);
          }}
        >
          <label>
            キャラの名前
            <input
              type="text"
              value={renameDraft}
              maxLength={20}
              placeholder="キャラ"
              aria-label="キャラの名前"
              onChange={(e) => setRenameDraft(e.target.value)}
            />
          </label>
          <div
            className="agent-character-picker"
            role="group"
            aria-label="キャラを選ぶ"
          >
            <button
              type="button"
              className={character === "white" ? "active" : ""}
              aria-pressed={character === "white"}
              onClick={() => saveAgentCharacter("white")}
            >
              <img src={imgNormal} alt="" />
              白キャラ
            </button>
            <button
              type="button"
              className={character === "pen" ? "active" : ""}
              aria-pressed={character === "pen"}
              onClick={() => saveAgentCharacter("pen")}
            >
              <img src={imgPenNormal} alt="" />
              ぺんちゃん
            </button>
            <button
              type="button"
              className={character === "fizh" ? "active" : ""}
              aria-pressed={character === "fizh"}
              onClick={() => saveAgentCharacter("fizh")}
            >
              <img src={imgFizhNormal} alt="" />
              King Fizh
            </button>
          </div>
          <div className="agent-rename-actions">
            <button type="submit">保存</button>
            <button
              type="button"
              onClick={() => {
                onRename("");
                setRenameOpen(false);
              }}
            >
              元に戻す
            </button>
            <button type="button" onClick={() => setRenameOpen(false)}>
              やめる
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
