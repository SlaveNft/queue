import type { ReactNode } from "react";
import { C } from "./kit";

/**
 * The cast of the explainer: small cartoon animals drawn in SVG. Thick dark outline, flat colours, big eyes.
 * Every critter is drawn in a 200×240 box with its feet on the bottom edge and is anchored at bottom-centre.
 */
export type Species = "bird" | "cat" | "frog" | "bunny" | "hamster" | "owl";
export type Mood = "calm" | "worried" | "happy" | "annoyed" | "ask";

const OUT = C.ink;
const SW = 7;

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function Eye({ cx, cy, r, look, blink, mood, ring }: { cx: number; cy: number; r: number; look: number; blink: number; mood: Mood; ring?: boolean }) {
  if (mood === "happy") {
    // Closed, smiling eyes.
    return <path d={`M ${cx - r * 0.8} ${cy + 2} Q ${cx} ${cy - r * 0.95} ${cx + r * 0.8} ${cy + 2}`} fill="none" stroke={OUT} strokeWidth={SW - 1} strokeLinecap="round" />;
  }
  const open = Math.max(0.12, 1 - blink);
  const pr = mood === "worried" ? r * 0.38 : r * 0.5;
  return (
    <g>
      {ring ? <circle cx={cx} cy={cy} r={r + 7} fill="#FFF6E3" stroke={OUT} strokeWidth={SW - 1} /> : null}
      <ellipse cx={cx} cy={cy} rx={r} ry={r * open} fill="#fff" stroke={OUT} strokeWidth={SW - 2} />
      {open > 0.4 ? (
        <>
          <circle cx={cx + look * r * 0.32} cy={cy + (mood === "worried" ? -1 : 2)} r={pr} fill={OUT} />
          <circle cx={cx + look * r * 0.32 - pr * 0.35} cy={cy - pr * 0.3} r={pr * 0.32} fill="#fff" />
        </>
      ) : null}
    </g>
  );
}

function Brows({ mood, y, dx }: { mood: Mood; y: number; dx: number }) {
  if (mood === "worried" || mood === "ask") {
    return (
      <g stroke={OUT} strokeWidth={SW - 2} strokeLinecap="round">
        <line x1={100 - dx - 14} y1={y + 4} x2={100 - dx + 12} y2={y - 6} />
        <line x1={100 + dx + 14} y1={y + 4} x2={100 + dx - 12} y2={y - 6} />
      </g>
    );
  }
  if (mood === "annoyed") {
    return (
      <g stroke={OUT} strokeWidth={SW - 2} strokeLinecap="round">
        <line x1={100 - dx - 14} y1={y - 5} x2={100 - dx + 13} y2={y + 4} />
        <line x1={100 + dx + 14} y1={y - 5} x2={100 + dx - 13} y2={y + 4} />
      </g>
    );
  }
  return null;
}

function Mouth({ mood, y }: { mood: Mood; y: number }) {
  if (mood === "happy") return <path d={`M 86 ${y - 2} Q 100 ${y + 16} 114 ${y - 2} Z`} fill="#E5484D" stroke={OUT} strokeWidth={SW - 3} strokeLinejoin="round" />;
  if (mood === "ask" || mood === "worried") return <ellipse cx={100} cy={y + 4} rx={mood === "ask" ? 9 : 6} ry={mood === "ask" ? 10 : 6} fill="#7A2E3A" stroke={OUT} strokeWidth={SW - 3} />;
  if (mood === "annoyed") return <line x1={90} y1={y + 4} x2={110} y2={y + 4} stroke={OUT} strokeWidth={SW - 2} strokeLinecap="round" />;
  return <path d={`M 90 ${y} Q 100 ${y + 9} 110 ${y}`} fill="none" stroke={OUT} strokeWidth={SW - 2} strokeLinecap="round" />;
}

/** A thick outlined curve: a tail or a whisker. */
function Rope({ d, color, w }: { d: string; color: string; w: number }) {
  return (
    <>
      <path d={d} fill="none" stroke={OUT} strokeWidth={w + SW * 2 - 2} strokeLinecap="round" />
      <path d={d} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" />
    </>
  );
}

export function Critter({
  species,
  color,
  mood = "calm",
  look = 0,
  blink = 0,
  step = 0,
  sweat = 0,
  wave = 0,
}: {
  species: Species;
  color: string;
  mood?: Mood;
  /** -1 looks left, 1 looks right. */
  look?: number;
  /** 0 open … 1 closed. */
  blink?: number;
  /** Walk cycle phase in radians; 0 stands still. */
  step?: number;
  /** 0…1 sweat drops (in a hurry). */
  sweat?: number;
  /** 0…1 raises one arm. */
  wave?: number;
}) {
  const light = shade(color, 0.62);
  const dark = shade(color, -0.22);
  const pink = "#FF9FB2";
  const footL = Math.sin(step) * 7;
  const footR = Math.sin(step + Math.PI) * 7;
  const stroke = { stroke: OUT, strokeWidth: SW, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };

  let behind: ReactNode = null;
  let ears: ReactNode = null;
  let face: ReactNode = null;
  let eyeY = 92;
  let eyeDx = 25;
  let eyeR = 17;
  let mouthY = 118;
  let ring = false;
  let headRy = 56;

  if (species === "cat") {
    behind = <Rope d="M 146 196 Q 196 190 182 140 Q 176 122 190 112" color={color} w={13} />;
    ears = (
      <>
        <path d="M 46 62 L 50 12 L 88 42 Z" fill={color} {...stroke} />
        <path d="M 154 62 L 150 12 L 112 42 Z" fill={color} {...stroke} />
        <path d="M 58 46 L 58 28 L 74 42 Z" fill={pink} />
        <path d="M 142 46 L 142 28 L 126 42 Z" fill={pink} />
      </>
    );
    face = (
      <>
        <ellipse cx="100" cy="114" rx="30" ry="20" fill={light} />
        <path d="M 94 106 L 106 106 L 100 113 Z" fill={pink} stroke={OUT} strokeWidth={4} strokeLinejoin="round" />
        <g stroke={OUT} strokeWidth={4} strokeLinecap="round">
          <line x1="52" y1="108" x2="26" y2="102" />
          <line x1="52" y1="118" x2="26" y2="122" />
          <line x1="148" y1="108" x2="174" y2="102" />
          <line x1="148" y1="118" x2="174" y2="122" />
        </g>
      </>
    );
  } else if (species === "bunny") {
    behind = <circle cx="150" cy="200" r="15" fill="#fff" {...stroke} />;
    ears = (
      <>
        <ellipse cx="74" cy="20" rx="17" ry="44" fill={color} {...stroke} transform="rotate(-8 74 44)" />
        <ellipse cx="126" cy="20" rx="17" ry="44" fill={color} {...stroke} transform="rotate(8 126 44)" />
        <ellipse cx="74" cy="22" rx="7" ry="28" fill={pink} transform="rotate(-8 74 44)" />
        <ellipse cx="126" cy="22" rx="7" ry="28" fill={pink} transform="rotate(8 126 44)" />
      </>
    );
    face = (
      <>
        <ellipse cx="100" cy="116" rx="28" ry="19" fill={light} />
        <ellipse cx="100" cy="106" rx="7" ry="5" fill={pink} stroke={OUT} strokeWidth={4} />
        {mood === "calm" || mood === "annoyed" ? <rect x="94" y="121" width="12" height="11" rx="2" fill="#fff" stroke={OUT} strokeWidth={4} /> : null}
      </>
    );
  } else if (species === "frog") {
    headRy = 50;
    eyeY = 56;
    eyeDx = 30;
    eyeR = 16;
    mouthY = 112;
    ears = (
      <>
        <circle cx="70" cy="56" r="27" fill={color} {...stroke} />
        <circle cx="130" cy="56" r="27" fill={color} {...stroke} />
      </>
    );
    face = (
      <>
        <ellipse cx="100" cy="112" rx="40" ry="20" fill={light} />
        <circle cx="90" cy="94" r="2.6" fill={OUT} />
        <circle cx="110" cy="94" r="2.6" fill={OUT} />
      </>
    );
  } else if (species === "hamster") {
    ears = (
      <>
        <circle cx="52" cy="48" r="18" fill={color} {...stroke} />
        <circle cx="148" cy="48" r="18" fill={color} {...stroke} />
        <circle cx="52" cy="48" r="8" fill={pink} />
        <circle cx="148" cy="48" r="8" fill={pink} />
      </>
    );
    face = (
      <>
        <ellipse cx="60" cy="122" rx="26" ry="18" fill="#FFF3DC" stroke={OUT} strokeWidth={5} />
        <ellipse cx="140" cy="122" rx="26" ry="18" fill="#FFF3DC" stroke={OUT} strokeWidth={5} />
        <ellipse cx="100" cy="108" rx="7" ry="5" fill={pink} stroke={OUT} strokeWidth={4} />
      </>
    );
    mouthY = 120;
  } else if (species === "bird") {
    behind = (
      <g fill={dark} {...stroke}>
        <path d="M 138 196 L 184 214 L 150 220 Z" />
        <path d="M 140 186 L 190 190 L 152 206 Z" />
      </g>
    );
    ears = (
      <g fill={color} {...stroke}>
        <path d="M 88 42 Q 84 10 100 22 Q 104 2 114 22 Q 128 12 116 44 Z" />
      </g>
    );
    face = (
      <>
        <ellipse cx="100" cy="104" rx="46" ry="34" fill="#FFF3DC" />
        <path d="M 86 108 L 114 108 L 100 130 Z" fill="#FFC83D" stroke={OUT} strokeWidth={5} strokeLinejoin="round" />
      </>
    );
    mouthY = -100;
  } else {
    // owl
    ring = true;
    eyeR = 15;
    eyeDx = 27;
    ears = (
      <>
        <path d="M 48 60 L 44 14 L 84 40 Z" fill={color} {...stroke} />
        <path d="M 152 60 L 156 14 L 116 40 Z" fill={color} {...stroke} />
      </>
    );
    face = (
      <>
        <ellipse cx="100" cy="100" rx="50" ry="38" fill={light} />
        <path d="M 90 104 L 110 104 L 100 124 Z" fill="#FFC83D" stroke={OUT} strokeWidth={5} strokeLinejoin="round" />
      </>
    );
    mouthY = -100;
  }

  const armL = species === "bird" || species === "owl"
    ? <path d="M 52 156 Q 22 176 40 214 Q 56 200 62 170 Z" fill={dark} {...stroke} />
    : <ellipse cx="50" cy="176" rx="13" ry="23" fill={color} {...stroke} transform="rotate(14 50 176)" />;
  const armR = species === "bird" || species === "owl"
    ? <path d="M 148 156 Q 178 176 160 214 Q 144 200 138 170 Z" fill={dark} {...stroke} transform={`rotate(${-wave * 110} 146 160)`} />
    : <ellipse cx="150" cy="176" rx="13" ry="23" fill={color} {...stroke} transform={`rotate(${-14 - wave * 130} 146 158)`} />;

  return (
    <svg width={200} height={240} viewBox="0 0 200 240" style={{ position: "absolute", left: -100, top: -240, maxWidth: "none", display: "block", overflow: "visible" }}>
      {behind}
      <ellipse cx={74} cy={228 - Math.max(0, footL)} rx="21" ry="11" fill={species === "bird" || species === "owl" ? "#FFC83D" : dark} {...stroke} />
      <ellipse cx={126} cy={228 - Math.max(0, footR)} rx="21" ry="11" fill={species === "bird" || species === "owl" ? "#FFC83D" : dark} {...stroke} />
      {armL}
      <ellipse cx="100" cy="176" rx="52" ry="54" fill={color} {...stroke} />
      <ellipse cx="100" cy="188" rx="31" ry="34" fill={light} />
      {armR}
      {ears}
      <ellipse cx="100" cy="92" rx="62" ry={headRy} fill={color} {...stroke} />
      {face}
      {species !== "bird" && species !== "owl" ? (
        <>
          <ellipse cx="50" cy={eyeY + 26} rx="11" ry="7" fill={pink} opacity={species === "hamster" ? 0 : 0.75} />
          <ellipse cx="150" cy={eyeY + 26} rx="11" ry="7" fill={pink} opacity={species === "hamster" ? 0 : 0.75} />
        </>
      ) : null}
      <Eye cx={100 - eyeDx} cy={eyeY} r={eyeR} look={look} blink={blink} mood={mood} ring={ring} />
      <Eye cx={100 + eyeDx} cy={eyeY} r={eyeR} look={look} blink={blink} mood={mood} ring={ring} />
      <Brows mood={mood} y={eyeY - eyeR - 9} dx={eyeDx} />
      {mouthY > 0 ? <Mouth mood={mood} y={mouthY} /> : null}
      {sweat > 0 ? (
        <g opacity={sweat} fill="#8FD3FF" stroke={OUT} strokeWidth={4} strokeLinejoin="round">
          <path d="M 22 52 q -9 14 0 20 q 9 -6 0 -20 Z" />
          <path d="M 180 70 q -7 11 0 16 q 7 -5 0 -16 Z" />
        </g>
      ) : null}
    </svg>
  );
}

/** Head-and-shoulders portrait for a job card: the critter cropped to a rounded tile. */
export function CritterBadge({ species, color, size = 46, mood = "calm" }: { species: Species; color: string; size?: number; mood?: Mood }) {
  return (
    <span
      style={{
        position: "relative",
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        borderRadius: size * 0.28,
        background: shade(color, 0.7),
        border: `3px solid ${OUT}`,
        overflow: "hidden",
        display: "block",
      }}
    >
      <span style={{ position: "absolute", left: size / 2, top: size * 1.72, transform: `scale(${size / 150})`, transformOrigin: "0 0", display: "block", width: 0, height: 0 }}>
        <Critter species={species} color={color} mood={mood} />
      </span>
    </span>
  );
}

/** A little wheeled suitcase standing next to a traveller. */
export function Suitcase({ color }: { color: string }) {
  return (
    <svg width={70} height={90} viewBox="0 0 70 90" style={{ position: "absolute", left: 54, top: -90, maxWidth: "none", display: "block", overflow: "visible" }}>
      <path d="M 22 26 L 22 8 L 48 8 L 48 26" fill="none" stroke={OUT} strokeWidth={6} strokeLinejoin="round" />
      <rect x="6" y="24" width="58" height="54" rx="10" fill={color} stroke={OUT} strokeWidth={6} />
      <line x1="6" y1="46" x2="64" y2="46" stroke={OUT} strokeWidth={5} />
      <circle cx="20" cy="84" r="6" fill={OUT} />
      <circle cx="50" cy="84" r="6" fill={OUT} />
    </svg>
  );
}
