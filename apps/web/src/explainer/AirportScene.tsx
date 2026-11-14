import type { ReactNode } from "react";
import { AbsoluteFill, Easing, useCurrentFrame, useVideoConfig } from "remotion";
import { AGENTS, C, Caption, Coin, F, Kicker, mix, ramp } from "./kit";
import { Critter, Suitcase, type Mood, type Species } from "./critters";

const LAND = { FLOOR: 900, GAP: 262, FRONT_X: 1400, SCALE: 1.42, GATE_X: 1610, LATE_START: 352 };
const PORT = { FLOOR: 1060, GAP: 176, FRONT_X: 790, SCALE: 0.98, GATE_X: 900, LATE_START: 150 };
// Front of the line is next to the gate (right). Index 0 = first in line.
const LINE = [
  // Security is shared by every flight: each traveller has its own departure time.
  { who: AGENTS.mira, flight: "15:40", city: "Rome" },
  { who: AGENTS.atlas, flight: "16:05", city: "Tokyo" },
  { who: AGENTS.vale, flight: "16:20", city: "Lima" },
  { who: AGENTS.juno, flight: "16:45", city: "Oslo" },
];

export const AIRPORT = { twist: 180, rule: 275, end: 360 } as const;

function Tag({ text, tone, lift = 0 }: { text: string; tone: "plain" | "late" | "ok"; lift?: number }) {
  const colors =
    tone === "late" ? { bg: C.urgent, fg: "#fff" } : tone === "ok" ? { bg: C.successSoft, fg: C.ink } : { bg: C.surface, fg: C.ink };
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: -292 - lift,
        transform: "translateX(-50%)",
        background: colors.bg,
        color: colors.fg,
        border: `4px solid ${C.ink}`,
        borderRadius: 999,
        fontFamily: F.sans,
        fontWeight: 900,
        fontSize: 21,
        padding: "3px 13px",
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </div>
  );
}

/** A traveller standing at (x, y): a critter, its suitcase and whatever floats above it. */
function Traveller({
  x,
  y,
  scale,
  species,
  color,
  mood,
  look,
  blink,
  step = 0,
  sweat = 0,
  bob = 0,
  children,
}: {
  x: number;
  y: number;
  scale: number;
  species: Species;
  color: string;
  mood: Mood;
  look: number;
  blink: number;
  step?: number;
  sweat?: number;
  bob?: number;
  children?: ReactNode;
}) {
  return (
    <div style={{ position: "absolute", left: x, top: y + bob, width: 0, height: 0, transform: `scale(${scale})` }}>
      {/* soft ground shadow */}
      <div style={{ position: "absolute", left: -78, top: -12, width: 156, height: 24, borderRadius: "50%", background: "rgba(36,27,47,0.22)" }} />
      <Suitcase color={color} />
      <Critter species={species} color={color} mood={mood} look={look} blink={blink} step={step} sweat={sweat} />
      {children}
    </div>
  );
}

/** The departure hall: dotted wall, big windows, a wooden floor and the security gate. */
function Hall({ floor, gateX, portrait }: { floor: number; gateX: number; portrait: boolean }) {
  const f = useCurrentFrame();
  const windows = portrait ? [70, 400] : [110, 560, 1010];
  const ww = portrait ? 270 : 360;
  const wh = portrait ? 290 : 226;
  const wy = portrait ? floor - 640 : 216;
  return (
    <>
      <AbsoluteFill
        style={{
          background: C.wall,
          backgroundImage: `radial-gradient(${C.wallDot} 5px, transparent 6px)`,
          backgroundSize: "64px 64px",
        }}
      />
      {windows.map((x, i) => (
        <div key={x} style={{ position: "absolute", left: x, top: wy, width: ww, height: wh, borderRadius: 26, background: "#BDE9F5", border: `7px solid ${C.ink}`, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: 30 + ((f * 0.5 + i * 120) % (ww + 160)) - 140, top: 40 + i * 34, width: 120, height: 38, borderRadius: 30, background: "#fff" }} />
          <div style={{ position: "absolute", left: -20, right: -20, bottom: -30, height: 90, borderRadius: "50%", background: "#8FD694" }} />
          {i === 1 ? (
            <svg viewBox="0 0 120 60" style={{ position: "absolute", left: 60 + ((f * 1.6) % 420) - 160, top: 120 - ((f * 0.5) % 130), width: 120, maxWidth: "none" }}>
              <path d="M 6 36 L 78 30 Q 110 28 112 36 Q 110 44 78 42 L 52 42 L 30 58 L 20 58 L 34 42 L 12 42 Z M 52 30 L 34 8 L 44 8 L 70 30 Z" fill="#fff" stroke={C.ink} strokeWidth="5" strokeLinejoin="round" />
            </svg>
          ) : null}
          <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 7, marginLeft: -3.5, background: C.ink }} />
        </div>
      ))}
      {/* floor */}
      <div style={{ position: "absolute", left: 0, right: 0, top: floor - 26, bottom: 0, background: C.floor, borderTop: `7px solid ${C.ink}`, backgroundImage: `repeating-linear-gradient(90deg, transparent 0 236px, ${C.floorLine} 236px 242px)` }} />
      {/* security gate */}
      <div style={{ position: "absolute", left: gateX, top: floor - (portrait ? 470 : 600), width: portrait ? 150 : 230, height: portrait ? 452 : 582, border: `7px solid ${C.ink}`, borderBottom: "none", borderRadius: "22px 22px 0 0", background: "#DCE6EE" }}>
        <div style={{ position: "absolute", left: 22, right: 22, top: 96, bottom: 0, background: C.wall, border: `7px solid ${C.ink}`, borderBottom: "none", borderRadius: "14px 14px 0 0" }} />
        <div style={{ margin: "16px 14px 0", background: C.block, color: C.lime, borderRadius: 10, fontFamily: F.sans, fontSize: portrait ? 17 : 21, fontWeight: 900, textAlign: "center", padding: "7px 0", letterSpacing: "0.08em" }}>SECURITY</div>
        <div style={{ position: "absolute", left: "50%", top: 66, width: 22, height: 22, marginLeft: -11, borderRadius: 11, background: f % 40 < 20 ? "#5EE08A" : "#2FA36B", border: `4px solid ${C.ink}` }} />
      </div>
    </>
  );
}

export function AirportScene() {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const { FLOOR, GAP, FRONT_X, SCALE, GATE_X, LATE_START } = portrait ? PORT : LAND;

  // The late traveller runs in, asks, then is let through to the front.
  const run = ramp(f, 18, 78, Easing.out(Easing.cubic));
  const pass = ramp(f, AIRPORT.twist + 10, AIRPORT.twist + 95, Easing.inOut(Easing.cubic));
  const lateStart = LATE_START;
  const lateX = pass > 0 ? mix(lateStart, FRONT_X, pass) : mix(-120, lateStart, run);
  const lateY = FLOOR - Math.sin(pass * Math.PI) * 60;
  const runBob = f < 80 ? Math.abs(Math.sin(f / 3)) * -10 : 0;

  // Everyone it passes steps back one place.
  const shift = pass * GAP;
  const bubble = ramp(f, 82, 92) * (1 - ramp(f, AIRPORT.twist, AIRPORT.twist + 8));
  const allOk = ramp(f, AIRPORT.rule, AIRPORT.rule + 12);

  const blinkOf = (i: number) => ((f + i * 23) % 96 < 5 ? 1 : 0);
  const idle = (i: number) => Math.sin(f / 9 + i * 1.7) * 2.5;
  // The line notices the latecomer, frowns at the question, and cheers up once it is paid.
  const paidAt = (i: number) => AIRPORT.twist + 18 + (LINE.length - 1 - i) * 17 + 26;
  const moodOf = (i: number): Mood => (f >= paidAt(i) ? "happy" : f >= 84 && f < AIRPORT.twist + 10 ? "annoyed" : "calm");

  return (
    <AbsoluteFill style={{ background: C.wall }}>
      <Hall floor={FLOOR} gateX={GATE_X} portrait={portrait} />
      <Kicker from={0} to={AIRPORT.end}>
        Airport security, 15:12
      </Kicker>
      <Caption from={0} to={AIRPORT.twist} outlined>
        {"Someone late for a flight asks to *cut ahead of you.*"}
      </Caption>
      <Caption from={AIRPORT.twist} to={AIRPORT.rule} outlined>
        {"What if they had to *pay everyone they pass…*"}
      </Caption>
      <Caption from={AIRPORT.rule} to={AIRPORT.end} outlined>
        {"…and couldn't, if it made *anyone miss their flight?*"}
      </Caption>

      {/* The line */}
      {LINE.map((p, i) => {
        const baseX = FRONT_X - i * GAP;
        const appear = ramp(f, i * 5, i * 5 + 16, Easing.out(Easing.back(1.6)));
        const x = baseX - shift;
        const stepping = pass > 0.02 && pass < 0.98 ? f / 2.4 + i : 0;
        return (
          <Traveller
            key={p.flight}
            x={x}
            y={FLOOR + (1 - appear) * 30}
            scale={appear * SCALE}
            species={p.who.species}
            color={p.who.color}
            mood={moodOf(i)}
            look={f > 30 && f < AIRPORT.rule ? -1 : 0.4}
            blink={blinkOf(i)}
            step={stepping}
            bob={idle(i)}
          >
            <Tag text={allOk > 0.5 ? `✓ ${p.city} ${p.flight}` : `✈ ${p.city} ${p.flight}`} tone={allOk > 0.5 ? "ok" : "plain"} />
          </Traveller>
        );
      })}

      {/* Coins as the late traveller passes each one */}
      {LINE.map((p, i) => {
        const at = AIRPORT.twist + 18 + (LINE.length - 1 - i) * 17;
        return (
          <Coin
            key={p.flight}
            from={at}
            to={at + 26}
            x1={mix(lateStart, FRONT_X, ramp(at, AIRPORT.twist + 10, AIRPORT.twist + 95))}
            y1={FLOOR - 330 * SCALE}
            x2={FRONT_X - i * GAP - GAP}
            y2={FLOOR - 150 * SCALE}
            label="+ paid"
          />
        );
      })}

      {/* The latecomer */}
      {f >= 18 ? (
        <Traveller
          x={lateX}
          y={lateY}
          scale={SCALE}
          species={AGENTS.kestrel.species}
          color={AGENTS.kestrel.color}
          mood={pass > 0.95 ? "happy" : bubble > 0.2 ? "ask" : "worried"}
          look={1}
          blink={pass > 0.95 ? 0 : blinkOf(7)}
          step={f < 80 || (pass > 0.02 && pass < 0.98) ? f / 1.6 : 0}
          sweat={pass > 0.9 ? 0 : 1}
          bob={runBob}
        >
          <Tag text={pass > 0.95 ? "✓ made it" : "✈ Cairo · boards in 8 min"} tone={pass > 0.95 ? "ok" : "late"} lift={portrait && pass < 0.95 ? 52 : 0} />
          {bubble > 0 ? (
            <div
              style={{
                position: "absolute",
                left: 70,
                top: -404,
                opacity: bubble,
                transform: `scale(${0.7 + 0.3 * bubble})`,
                transformOrigin: "left bottom",
                background: "#fff",
                color: C.ink,
                border: `5px solid ${C.ink}`,
                borderRadius: "26px 26px 26px 6px",
                fontFamily: F.sans,
                fontWeight: 900,
                fontSize: 34,
                padding: "10px 24px",
                whiteSpace: "nowrap",
              }}
            >
              Can I go first?
            </div>
          ) : null}
        </Traveller>
      ) : null}
    </AbsoluteFill>
  );
}
