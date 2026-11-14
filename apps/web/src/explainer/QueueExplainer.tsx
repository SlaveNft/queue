import type { ReactNode } from "react";
import { AbsoluteFill, Audio, Easing, Freeze, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { VOICE_TIMING } from "./voiceTiming";
import { AirportScene, AIRPORT } from "./AirportScene";
import { LaneScene, LANE } from "./LaneScene";
import { AGENTS, C, Caption, F, Kicker, ramp } from "./kit";
import { Critter, type Mood, type Species } from "./critters";

/** A critter in normal flow: a fixed box with the drawing anchored to its bottom-centre. */
function Stand({ species, color, scale, mood = "happy", bob = 0, wave = 0 }: { species: Species; color: string; scale: number; mood?: Mood; bob?: number; wave?: number }) {
  return (
    <span style={{ position: "relative", display: "block", width: 200 * scale, height: 240 * scale, flex: `0 0 ${200 * scale}px` }}>
      <span style={{ position: "absolute", left: 100 * scale, top: 240 * scale + bob, width: 0, height: 0, transform: `scale(${scale})`, display: "block" }}>
        <Critter species={species} color={color} mood={mood} wave={wave} />
      </span>
    </span>
  );
}
const CAST = [AGENTS.juno, AGENTS.vale, AGENTS.kestrel, AGENTS.atlas, AGENTS.mira];
const DOTS = { backgroundImage: `radial-gradient(${C.paperDeep} 5px, transparent 6px)`, backgroundSize: "64px 64px" };

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
/** Portrait cut for phones (4:5). */
export const V_WIDTH = 1080;
export const V_HEIGHT = 1350;

/** The contract pills, then the live-season numbers, then how it was tested, then the end card. */
const PILLS_LEN = 80;
const SEASON_LEN = 165;
const TESTS_LEN = 120;
const NEAR_LEN = PILLS_LEN + SEASON_LEN + TESTS_LEN + 85;
const XFADE = 12;

/** Chapter start frames in the film's own timeline. */
const FILM_CHAPTERS = [
  { id: "line", label: "The line", at: 0 },
  { id: "rule", label: "The twist", at: AIRPORT.twist },
  { id: "agents", label: "Agents", at: AIRPORT.end + LANE.intro },
  { id: "jump", label: "The jump", at: AIRPORT.end + LANE.arrive },
  { id: "refuse", label: "Refusal", at: AIRPORT.end + LANE.refuse },
  { id: "kept", label: "Promise kept", at: AIRPORT.end + LANE.run },
  { id: "near", label: "On NEAR", at: AIRPORT.end + LANE.end },
  { id: "season", label: "Live season", at: AIRPORT.end + LANE.end + PILLS_LEN },
  { id: "tests", label: "Tested", at: AIRPORT.end + LANE.end + PILLS_LEN + SEASON_LEN },
] as const;

/** Length of the film in its own timeline, before it is fitted to the narration. */
const FILM_LEN = AIRPORT.end + LANE.end + NEAR_LEN;

/**
 * The narration sets the pace: each scene of the film is played over as many frames as its line lasts
 * (see scripts/build-voiceover.mjs). `toFilm` maps a frame of the finished video to a frame of the film,
 * `toVideo` goes the other way.
 */
const TIMING = VOICE_TIMING.scenes;
export const DURATION = VOICE_TIMING.totalFrames;
function toFilm(frame: number): number {
  let start = 0;
  for (const scene of TIMING) {
    if (frame < start + scene.out) return scene.orig[0] + ((frame - start) / scene.out) * (scene.orig[1] - scene.orig[0]);
    start += scene.out;
  }
  return FILM_LEN - 1;
}
function toVideo(filmFrame: number): number {
  let start = 0;
  for (const scene of TIMING) {
    if (filmFrame < scene.orig[1]) return Math.round(start + ((filmFrame - scene.orig[0]) / (scene.orig[1] - scene.orig[0])) * scene.out);
    start += scene.out;
  }
  return DURATION - 1;
}

/** Chapter start frames in the finished video, shared with the site's chapter control. */
export const CHAPTERS = FILM_CHAPTERS.map((chapter) => ({ ...chapter, at: toVideo(chapter.at) }));

/** `audioSrc` lets the site point at its own base path; the render uses Remotion's public folder. */
export type ExplainerProps = { variant: "site" | "video"; audioSrc?: string };

type Stat = { big: string; label: string; note: string; accent?: boolean; peek: Array<{ species: Species; color: string }> };

/** Three big-number cards with the cast peeking over them. */
function Cards({ stats, from }: { stats: Stat[]; from: number }) {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  return (
    <div
      style={{
        position: "absolute",
        top: portrait ? 400 : 430,
        left: "50%",
        width: portrait ? 900 : 1560,
        transform: "translateX(-50%)",
        display: "flex",
        flexDirection: portrait ? "column" : "row",
        gap: portrait ? 26 : 28,
      }}
    >
      {stats.map((st, i) => {
        const t = ramp(f, from + 14 + i * 12, from + 32 + i * 12, Easing.out(Easing.cubic));
        return (
          <div
            key={st.label}
            style={{
              position: "relative",
              flex: 1,
              border: `6px solid ${C.ink}`,
              borderRadius: 26,
              boxShadow: "0 10px 0 rgba(36,27,47,0.16)",
              background: st.accent ? C.lime : C.surface,
              padding: portrait ? "22px 34px" : "34px 40px 38px",
              opacity: t,
              transform: `translateY(${(1 - t) * 26}px)`,
              display: "flex",
              flexDirection: portrait ? "row" : "column",
              alignItems: portrait ? "center" : "flex-start",
              gap: portrait ? 34 : 6,
            }}
          >
            {/* the cast peeks over the card */}
            {!portrait ? (
              <div style={{ position: "absolute", right: 26, top: -6, display: "flex", gap: 0, zIndex: -1, transform: `translateY(${-92 * t}%)` }}>
                {st.peek.map((who, k) => (
                  <Stand key={k} species={who.species} color={who.color} scale={0.62} bob={Math.sin(f / 7 + i + k) * 4} wave={k === 0 ? 0.5 + 0.5 * Math.sin(f / 5 + i) : 0} />
                ))}
              </div>
            ) : null}
            <div
              style={{
                fontFamily: F.sans,
                fontWeight: 900,
                fontSize: portrait ? 150 : 190,
                lineHeight: 0.95,
                letterSpacing: "-0.03em",
                color: C.ink,
                minWidth: portrait ? 270 : undefined,
              }}
            >
              {st.big}
            </div>
            <div>
              <div
                style={{
                  fontFamily: F.sans,
                  fontWeight: 900,
                  fontSize: portrait ? 28 : 27,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: C.ink,
                }}
              >
                {st.label}
              </div>
              <div
                style={{
                  marginTop: 10,
                  fontFamily: F.sans,
                  fontWeight: 700,
                  fontSize: portrait ? 30 : 28,
                  lineHeight: 1.25,
                  letterSpacing: "-0.01em",
                  color: C.inkSoft,
                }}
              >
                {st.note}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NearScene({ variant }: ExplainerProps) {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const pills = [
    "Rust contract · NEAR testnet",
    "Escrow holds every job's reward + bond",
    "Refuses any jump that breaks a deadline",
    "Displaced agents withdraw their pay",
  ];
  const seasonAt = PILLS_LEN;
  const testsAt = PILLS_LEN + SEASON_LEN;
  const endAt = testsAt + TESTS_LEN;
  const end = ramp(f, endAt, endAt + 20, Easing.out(Easing.cubic));
  // The live season on NEAR testnet (data/season/testnet-season-4/comparison.json).
  const stats: Stat[] = [
    { big: "8", label: "AI agents", note: "each a model on NEAR AI, signing with its own limited key", peek: [AGENTS.mira, AGENTS.juno] },
    { big: "5", label: "jobs moved back, paid", note: "0 of them ended late", accent: true, peek: [AGENTS.kestrel] },
    { big: "135", label: "of 138 answers", note: "model-signed and verified by the contract", peek: [{ species: "owl" as const, color: "#B98A5E" }] },
  ];
  // How the rule was tested (docs/TESTING.md).
  const tests: Stat[] = [
    { big: "300", label: "simulated seasons", note: "39,318 jobs: no job moved back by a purchase ended late", peek: [AGENTS.atlas] },
    { big: "600", label: "random histories", note: "money, deadlines and order checked after every step", accent: true, peek: [AGENTS.vale, AGENTS.juno] },
    { big: "92", label: "of 95 code mutations caught", note: "mutation testing: one small change at a time; the 3 left change nothing", peek: [{ species: "owl" as const, color: "#B98A5E" }] },
  ];
  return (
    <AbsoluteFill style={{ background: C.paper, ...DOTS }}>
      {f >= testsAt && end <= 0 ? (
        <>
          <Kicker from={testsAt} to={endAt}>
            Tested like a protocol
          </Kicker>
          <Caption from={testsAt} to={endAt + 2}>
            {"Then we tried to break it. *The rule held.*"}
          </Caption>
          <Cards stats={tests} from={testsAt} />
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: portrait ? 150 : 130,
              textAlign: "center",
              fontFamily: F.sans,
              fontWeight: 800,
              fontSize: portrait ? 26 : 28,
              color: C.inkSoft,
              padding: portrait ? "0 60px" : 0,
              opacity: ramp(f, testsAt + 50, testsAt + 64),
            }}
          >
            The code on chain is <span style={{ color: C.urgent }}>built from this repository</span>. Every method:{" "}
            <span style={{ background: C.block, color: C.lime, borderRadius: 10, padding: "3px 14px", whiteSpace: "nowrap" }}>docs/TESTING.md</span>
          </div>
        </>
      ) : f >= seasonAt && end <= 0 ? (
        <>
          <Kicker from={seasonAt} to={testsAt}>
            Live season · NEAR testnet
          </Kicker>
          <Caption from={seasonAt} to={testsAt + 2}>
            {"Then eight AI agents ran it for real. *Nobody they passed was late.*"}
          </Caption>
          <Cards stats={stats} from={seasonAt} />
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: portrait ? 150 : 130,
              textAlign: "center",
              fontFamily: F.sans,
              fontWeight: 800,
              fontSize: portrait ? 26 : 28,
              color: C.inkSoft,
              padding: portrait ? "0 60px" : 0,
              opacity: ramp(f, seasonAt + 60, seasonAt + 76),
            }}
          >
            A jump that would break a deadline was <span style={{ color: C.urgent }}>refused on chain</span>. Re-check it all:{" "}
            <span style={{ background: C.block, color: C.lime, borderRadius: 10, padding: "3px 14px", whiteSpace: "nowrap" }}>npm run verify:season</span>
          </div>
        </>
      ) : end <= 0 ? (
        <>
          <Kicker from={0} to={PILLS_LEN}>
            Settled on NEAR
          </Kicker>
          <Caption from={0} to={PILLS_LEN + 2}>
            {"No operator decides who jumps. *A contract does.*"}
          </Caption>
          <div
            style={{
              position: "absolute",
              top: portrait ? 400 : 300,
              left: "50%",
              width: portrait ? 900 : 1040,
              transform: "translateX(-50%)",
              borderTop: `5px solid ${C.ink}`,
            }}
          >
            {pills.map((text, i) => {
              const t = ramp(f, 12 + i * 8, 26 + i * 8, Easing.out(Easing.cubic));
              return (
                <div
                  key={text}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 24,
                    padding: portrait ? "30px 8px" : "24px 8px",
                    borderBottom: `1.5px solid ${C.line}`,
                    opacity: t,
                    transform: `translateX(${(1 - t) * -24}px)`,
                  }}
                >
                  <span
                    style={{
                      width: 46,
                      height: 46,
                      flex: "0 0 46px",
                      borderRadius: 23,
                      border: `5px solid ${C.ink}`,
                      background: C.successSoft,
                      color: C.ink,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontFamily: F.sans,
                      fontWeight: 800,
                      fontSize: 24,
                    }}
                  >
                    ✓
                  </span>
                  <span
                    style={{
                      fontFamily: F.sans,
                      fontWeight: 900,
                      fontSize: portrait ? 40 : 38,
                      letterSpacing: "-0.01em",
                      color: C.ink,
                      lineHeight: 1.15,
                    }}
                  >
                    {text}
                  </span>
                </div>
              );
            })}
            <div
              style={{
                marginTop: 28,
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontFamily: F.sans,
                fontWeight: 900,
                fontSize: portrait ? 22 : 20,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: C.muted,
                opacity: ramp(f, 50, 62),
              }}
            >
              <span style={{ width: 12, height: 12, borderRadius: 6, background: C.success }} />
              The same mechanism is live on NEAR testnet · proof in the repo
            </div>
          </div>
        </>
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 26,
            opacity: end,
            transform: `scale(${0.96 + 0.04 * end})`,
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
            {[44, 66, 88].map((h, i) => (
              <span key={h} style={{ width: 26, height: h, borderRadius: 8, background: i === 2 ? C.lime : C.ink, border: `5px solid ${C.ink}` }} />
            ))}
            <span
              style={{
                marginLeft: 18,
                fontFamily: F.sans,
                fontWeight: 900,
                fontSize: portrait ? 104 : 124,
                letterSpacing: "0.03em",
                color: C.ink,
                lineHeight: 0.8,
              }}
            >
              QUEUE
            </span>
          </div>
          <div style={{ fontFamily: F.serif, fontWeight: 900, letterSpacing: "-0.02em", fontSize: portrait ? 70 : 76, color: C.ink, textAlign: "center" }}>
            The queue is a market.
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: portrait ? 0 : 6, marginTop: 6 }}>
            {CAST.map((who, i) => (
              <Stand key={who.name} species={who.species} color={who.color} scale={portrait ? 0.8 : 0.92} bob={-Math.abs(Math.sin((f - i * 5) / 6)) * 14} wave={i === 2 ? 0.5 + 0.5 * Math.sin(f / 4) : 0} />
            ))}
          </div>
          <div
            style={{
              marginTop: 8,
              fontFamily: F.sans,
              fontWeight: 900,
              fontSize: 28,
              color: C.limeInk,
              background: C.lime,
              border: `5px solid ${C.ink}`,
              borderRadius: 999,
              padding: "10px 28px",
              maxWidth: portrait ? 900 : undefined,
              textAlign: "center",
              opacity: ramp(f, endAt + 16, endAt + 30),
            }}
          >
            {variant === "site" ? "Run it live below ↓" : "Built at NEAR HACKATHON · try it: repo in the thread"}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
}

/** Fades a scene in over the previous one. */
function Fade({ children, len }: { children: ReactNode; len: number }) {
  const f = useCurrentFrame();
  const opacity = ramp(f, 0, XFADE) * (1 - ramp(f, len - 2, len));
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
}

export function QueueExplainer({ variant, audioSrc }: ExplainerProps) {
  const frame = useCurrentFrame();
  const at = toFilm(frame);
  // Each scene reads its own clock. Freeze hands it the frame the narration has reached; a <Sequence> is not
  // used here because it would cut every scene at the (shorter) length of the fitted video.
  const scene =
    at < AIRPORT.end
      ? { start: 0, len: AIRPORT.end, node: <AirportScene /> }
      : at < AIRPORT.end + LANE.end
        ? { start: AIRPORT.end, len: LANE.end, node: <LaneScene /> }
        : { start: AIRPORT.end + LANE.end, len: NEAR_LEN, node: <NearScene variant={variant} /> };
  return (
    <AbsoluteFill style={{ background: C.paper, fontFamily: F.sans, ...DOTS }}>
      <Freeze frame={at - scene.start}>
        <Fade len={scene.len + 2}>{scene.node}</Fade>
      </Freeze>
      <Audio src={audioSrc ?? staticFile(VOICE_TIMING.audio)} />
      <ProgressBar />
    </AbsoluteFill>
  );
}

function ProgressBar() {
  const f = useCurrentFrame();
  return (
    <div style={{ position: "absolute", left: 0, bottom: 0, height: 6, width: `${(f / DURATION) * 100}%`, background: C.lime }} />
  );
}
