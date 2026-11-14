import type { CSSProperties, ReactNode } from "react";
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const C = {
  /* A cartoon world: warm paper, thick dark outlines, flat colours. */
  paper: "#FFF1CF",
  paperDeep: "#F7DDA6",
  surface: "#FFFBEF",
  ink: "#241B2F",
  inkSoft: "#4A3F57",
  muted: "#75697F",
  line: "#D9BF8C",
  /** The accent: sunny yellow. */
  lime: "#FFC83D",
  /** Text on the accent. */
  limeInk: "#241B2F",
  urgent: "#F2543D",
  success: "#1F9D61",
  successSoft: "#D5F3E1",
  /** A dark panel and the text on it. */
  block: "#241B2F",
  onBlock: "#FFF6E3",
  /** Scenery. */
  wall: "#2E8279",
  wallDot: "#3C9389",
  floor: "#B9773F",
  floorLine: "#9A5F30",
} as const;

export const F = {
  sans: '"Nunito Variable", "Nunito", -apple-system, "Segoe UI", sans-serif',
  serif: '"Nunito Variable", "Nunito", -apple-system, "Segoe UI", sans-serif',
  mono: '"Nunito Variable", "Nunito", -apple-system, "Segoe UI", sans-serif',
} as const;

export const AGENTS = {
  kestrel: { name: "Kestrel", color: "#FF8A5C", species: "bird" },
  mira: { name: "Mira", color: "#7FB2FF", species: "cat" },
  atlas: { name: "Atlas", color: "#6FD08C", species: "frog" },
  vale: { name: "Vale", color: "#C3A1FF", species: "bunny" },
  juno: { name: "Juno", color: "#F6B24A", species: "hamster" },
} as const;

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0 → 1 between two frames, eased. */
export function ramp(frame: number, from: number, to: number, ease = Easing.inOut(Easing.cubic)): number {
  return interpolate(frame, [from, to], [0, 1], { ...clamp, easing: ease });
}

export function useSpring(delay: number, damping = 16): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping, mass: 0.7 } });
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** A headline caption that slides in and out. Words wrapped in *stars* become serif italic. */
export function Caption({
  children,
  from,
  to,
  y = 96,
  size = 58,
  outlined = false,
}: {
  children: string;
  from: number;
  to: number;
  y?: number;
  size?: number;
  /** White lettering with a dark outline, for coloured backdrops. Default: dark lettering on paper. */
  outlined?: boolean;
}) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const enter = ramp(frame, from, from + 14, Easing.out(Easing.cubic));
  const exit = ramp(frame, to - 10, to, Easing.in(Easing.cubic));
  const opacity = enter * (1 - exit);
  if (opacity <= 0) return null;
  const parts = children.split(/(\*[^*]+\*)/g);
  return (
    <div
      style={{
        position: "absolute",
        top: portrait ? y + 10 : y,
        left: 0,
        right: 0,
        textAlign: "center",
        opacity,
        transform: `translateY(${(1 - enter) * 18 - exit * 10}px)`,
        fontFamily: F.sans,
        fontSize: portrait ? Math.round(size * 1.12) : Math.round(size * 1.06),
        fontWeight: 900,
        letterSpacing: "-0.02em",
        lineHeight: 1.14,
        color: outlined ? "#FFFFFF" : C.ink,
        ...(outlined ? { WebkitTextStroke: `10px ${C.ink}`, paintOrder: "stroke fill" } : {}),
        padding: portrait ? "0 64px" : "0 140px",
      }}
    >
      {parts.map((part, index) =>
        part.startsWith("*") ? (
          <span
            key={index}
            style={{ color: outlined ? C.lime : C.urgent }}
          >
            {part.slice(1, -1)}
          </span>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </div>
  );
}

/** Small mono label above the caption: the chapter of the story. */
export function Kicker({ children, from, to }: { children: string; from: number; to: number }) {
  const frame = useCurrentFrame();
  const opacity = ramp(frame, from, from + 10) * (1 - ramp(frame, to - 8, to));
  if (opacity <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 50,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        opacity,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          fontFamily: F.sans,
          fontSize: 20,
          fontWeight: 900,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: C.ink,
          background: C.lime,
          border: `3px solid ${C.ink}`,
          borderRadius: 999,
          padding: "5px 18px",
        }}
      >
        {children}
      </span>
    </div>
  );
}

/** A traveller in the airport line. */
export function Person({
  x,
  y,
  color,
  scale = 1,
  bob = 0,
  children,
}: {
  x: number;
  y: number;
  color: string;
  scale?: number;
  bob?: number;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y + bob,
        width: 0,
        height: 0,
        transform: `scale(${scale})`,
      }}
    >
      <svg
        width={90}
        height={190}
        viewBox="0 0 90 190"
        // The host page may cap svg width (max-width: 100%) inside this 0×0 anchor.
        style={{ position: "absolute", left: -45, top: -190, maxWidth: "none", display: "block" }}
      >
        <circle cx="45" cy="30" r="24" fill={color} />
        <rect x="14" y="62" width="62" height="96" rx="31" fill={color} />
        <rect x="24" y="150" width="14" height="40" rx="7" fill={color} />
        <rect x="52" y="150" width="14" height="40" rx="7" fill={color} />
      </svg>
      {children}
    </div>
  );
}

/** A coin that flies from (x1,y1) to (x2,y2) on an arc between two frames. */
export function Coin({
  from,
  to,
  x1,
  y1,
  x2,
  y2,
  label,
}: {
  from: number;
  to: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string;
}) {
  const frame = useCurrentFrame();
  const t = ramp(frame, from, to, Easing.inOut(Easing.quad));
  if (frame < from) return null;
  const landed = frame >= to;
  const x = mix(x1, x2, t);
  const y = mix(y1, y2, t) - Math.sin(t * Math.PI) * 140;
  const pop = landed ? ramp(frame, to, to + 10, Easing.out(Easing.back(2))) : 0;
  const fade = 1 - ramp(frame, to + 40, to + 60);
  return (
    <>
      {!landed ? (
        <div
          style={{
            position: "absolute",
            left: x - 30,
            top: y - 30,
            width: 60,
            height: 60,
            borderRadius: 30,
            background: C.lime,
            border: `4px solid ${C.ink}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: F.sans,
            fontWeight: 900,
            fontSize: 30,
            color: C.limeInk,
          }}
        >
          N
        </div>
      ) : null}
      {landed && label && fade > 0 ? (
        <div
          style={{
            position: "absolute",
            left: x2,
            top: y2 - 34 - pop * 12,
            transform: `translateX(-50%) scale(${0.6 + pop * 0.4})`,
            opacity: fade,
            fontFamily: F.sans,
            fontSize: 24,
            fontWeight: 900,
            color: C.ink,
            background: C.successSoft,
            border: `3px solid ${C.ink}`,
            borderRadius: 999,
            padding: "3px 14px",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
      ) : null}
    </>
  );
}

export function Pill({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        fontFamily: F.sans,
        fontSize: 19,
        fontWeight: 800,
        padding: "5px 14px",
        border: `3px solid ${C.ink}`,
        borderRadius: 999,
        background: C.surface,
        color: C.ink,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </span>
  );
}
