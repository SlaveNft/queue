import type { CSSProperties } from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { AGENTS, C, Caption, Coin, F, Kicker, Pill, clamp, mix, ramp, useSpring } from "./kit";
import { Critter, CritterBadge } from "./critters";

type Id = "kestrel" | "mira" | "atlas" | "vale" | "juno";

const JOBS: Record<Id, { sec: number; ask: string; paid: string }> = {
  mira: { sec: 11, ask: "0.00042", paid: "+0.00504" },
  atlas: { sec: 9, ask: "0.00058", paid: "+0.00696" },
  vale: { sec: 10, ask: "0.00036", paid: "+0.00432" },
  juno: { sec: 12, ask: "0.00031", paid: "+0.00372" },
  kestrel: { sec: 12, ask: "", paid: "" },
};

/** Start second of each job before and after Kestrel's purchase. */
const BEFORE: Record<Id, number> = { mira: 0, atlas: 11, vale: 20, juno: 30, kestrel: 42 };
const AFTER: Record<Id, number> = { kestrel: 0, mira: 12, atlas: 23, vale: 32, juno: 42 };
const KESTREL_DUE = 34;
const JUNO_DUE = 58;
const ORION_SEC = 8;

// Local timeline (frames at 30 fps).
export const LANE = {
  intro: 0,
  arrive: 120,
  asks: 220,
  jump: 300,
  jumpEnd: 380,
  refuse: 430,
  run: 580,
  end: 750,
} as const;

/**
 * The lane runs left → right in landscape and top → bottom in portrait.
 * "main" is the time axis, "cross" the other one.
 */
function useGeometry() {
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const g = portrait
    ? { portrait, S: 13, M0: 340, cross0: 250, crossLen: 730, gap: 6, worker: { x: 56, y: 340, w: 124, h: 120 } }
    : { portrait, S: 24, M0: 330, cross0: 600 - 85, crossLen: 170, gap: 8, worker: { x: 96, y: 600 - 95, w: 200, h: 190 } };
  const main = (sec: number) => g.M0 + sec * g.S;
  /** Box for a job that starts at `sec` and lasts `len` seconds, nudged by `crossShift` px. */
  const box = (sec: number, len: number, crossShift = 0): CSSProperties & { left: number; top: number; width: number; height: number } => {
    const a = main(sec) + g.gap / 2;
    const l = len * g.S - g.gap;
    return portrait
      ? { left: g.cross0 + crossShift, top: a, width: g.crossLen, height: l }
      : { left: a, top: g.cross0 - crossShift, width: l, height: g.crossLen };
  };
  /** A point at time `sec`, at fraction `t` across the lane (0 = start edge, 1 = far edge). */
  const point = (sec: number, t: number) =>
    portrait ? { x: g.cross0 + g.crossLen * t, y: main(sec) } : { x: main(sec), y: g.cross0 + g.crossLen * (1 - t) };
  return { g, main, box, point, portrait };
}

function Card({
  id,
  rect,
  appear,
  portrait,
  outline,
  fill = 0,
  done = false,
  late = false,
  z = 1,
}: {
  id: Id | "orion";
  rect: { left: number; top: number; width: number; height: number };
  appear: number;
  portrait: boolean;
  outline?: string;
  fill?: number;
  done?: boolean;
  late?: boolean;
  z?: number;
}) {
  const meta = id === "orion" ? { name: "Orion", color: "#B6AFC2", species: "cat" as const } : AGENTS[id];
  const sec = id === "orion" ? ORION_SEC : JOBS[id].sec;
  const f = Math.min(1, fill);
  return (
    <div
      style={{
        position: "absolute",
        ...rect,
        transform: `translateY(${(1 - appear) * 40}px)`,
        opacity: appear,
        zIndex: z,
        background: C.surface,
        border: `5px solid ${outline ?? C.ink}`,
        borderRadius: 18,
        boxShadow: late ? "0 0 0 8px rgba(242,84,61,0.28)" : "0 8px 0 rgba(36,27,47,0.16)",
        overflow: "hidden",
      }}
    >
      <div
        style={
          portrait
            ? { position: "absolute", left: 0, top: 0, right: 0, height: 8, background: meta.color }
            : { position: "absolute", left: 0, top: 0, bottom: 0, width: 8, background: meta.color }
        }
      />
      <div
        style={
          portrait
            ? { position: "absolute", left: 0, right: 0, top: 8, height: `calc(${f * 100}% - 8px)`, background: done ? C.successSoft : "rgba(255,200,61,0.5)" }
            : { position: "absolute", left: 8, top: 0, bottom: 0, width: `calc(${f * 100}% - 8px)`, background: done ? C.successSoft : "rgba(255,200,61,0.5)" }
        }
      />
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: portrait ? "row" : "column",
          alignItems: portrait ? "center" : "flex-start",
          justifyContent: portrait ? "space-between" : "flex-start",
          height: portrait ? "100%" : undefined,
          padding: portrait ? "8px 20px 0" : "16px 12px 0 20px",
          gap: portrait ? 12 : 12,
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <CritterBadge species={meta.species} color={meta.color} size={portrait ? 78 : 70} mood={done ? "happy" : late ? "worried" : "calm"} />
          <span style={{ fontFamily: F.sans, fontWeight: 900, fontSize: portrait ? 30 : 26, letterSpacing: "-0.02em", color: C.ink }}>
            {meta.name}
          </span>
        </div>
        <span style={{ fontFamily: F.sans, fontSize: portrait ? 22 : 22, color: done ? C.success : C.muted, fontWeight: 800 }}>
          {done ? "✓ on time" : `${sec}s of work`}
        </span>
      </div>
    </div>
  );
}

function Tick({
  sec,
  label,
  color,
  opacity,
}: {
  sec: number;
  label: string;
  color: string;
  opacity: number;
}) {
  const { g, main, portrait } = useGeometry();
  if (opacity <= 0) return null;
  const m = main(sec);
  const labelStyle: CSSProperties = {
    position: "absolute",
    fontFamily: F.sans,
    fontSize: portrait ? 21 : 20,
    fontWeight: 900,
    color,
    whiteSpace: "nowrap",
    background: C.paper,
    padding: "2px 6px",
  };
  return portrait ? (
    <div style={{ position: "absolute", inset: 0, opacity, pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: g.cross0 - 20, top: m - 1.5, width: g.crossLen + 40, height: 3, background: color, zIndex: 3 }} />
      <div style={{ ...labelStyle, right: 1080 - (g.cross0 - 28), top: m - 16, textAlign: "right", padding: "2px 0", zIndex: 3 }}>{label.replace(" · ✓", " ✓")}</div>
    </div>
  ) : (
    <div style={{ position: "absolute", left: m, top: g.cross0 - 91, opacity }}>
      <div style={{ position: "absolute", left: -2.5, top: 34, width: 5, height: 268, borderRadius: 3, background: color }} />
      <div style={{ ...labelStyle, left: 0, top: 0, transform: "translateX(-50%)" }}>{label}</div>
    </div>
  );
}

export function LaneScene() {
  const f = useCurrentFrame();
  const { g, main, box, point, portrait } = useGeometry();
  const order: Id[] = ["mira", "atlas", "vale", "juno"];
  const laneEnd = g.cross0 + g.crossLen;

  // Purchase move.
  const jt = ramp(f, LANE.jump + 10, LANE.jumpEnd - 10, Easing.inOut(Easing.cubic));
  const startOf = (id: Id) => mix(BEFORE[id], AFTER[id], jt);

  // Kestrel arrives from the far end of the lane.
  const kArrive = ramp(f, LANE.arrive, LANE.arrive + 30, Easing.out(Easing.cubic));
  const kSec = mix(portrait ? 110 : 70, startOf("kestrel"), kArrive);
  const kLift = Math.sin(jt * Math.PI) * (portrait ? 70 : 170);

  // Refusal demo: Orion tries to cut in ahead of Juno.
  const oArrive = ramp(f, LANE.refuse + 10, LANE.refuse + 35, Easing.out(Easing.cubic));
  const oTry = ramp(f, LANE.refuse + 50, LANE.refuse + 80, Easing.inOut(Easing.cubic));
  const oBack = ramp(f, LANE.refuse + 115, LANE.refuse + 135, Easing.inOut(Easing.cubic));
  const oFade = 1 - ramp(f, LANE.refuse + 135, LANE.refuse + 150);
  const oProgress = oTry * (1 - oBack);
  const oSec = mix(portrait ? 110 : 70, 54, oArrive) + (42 - 54) * oProgress;
  const oLift = Math.sin(Math.min(1, oProgress) * Math.PI * 0.5) * (portrait ? 70 : 150);
  const junoPreviewSec = oProgress * ORION_SEC;
  const refusedStamp = ramp(f, LANE.refuse + 80, LANE.refuse + 90, Easing.out(Easing.back(2.2))) * oFade;
  const shake = f > LANE.refuse + 80 && f < LANE.refuse + 100 ? Math.sin(f * 2.2) * 6 : 0;

  // Execution time-lapse.
  const runT = ramp(f, LANE.run + 10, LANE.end - 30, Easing.linear);
  const cursorSec = runT * 54;
  const fillOf = (id: Id) => Math.max(0, Math.min(1, (cursorSec - AFTER[id]) / JOBS[id].sec));
  const doneCount = (["kestrel", ...order] as Id[]).filter((id) => fillOf(id) >= 1).length;
  const running = f >= LANE.run;

  const appearOf = (i: number) => ramp(f, 10 + i * 9, 30 + i * 9, Easing.out(Easing.cubic));
  const lateBracket = ramp(f, LANE.arrive + 45, LANE.arrive + 60) * (1 - ramp(f, LANE.jump, LANE.jump + 20));
  const kestrelOk = ramp(f, LANE.jumpEnd - 5, LANE.jumpEnd + 10);
  const workerPulse = useSpring(4);

  const below = portrait ? main(56) + 40 : g.cross0 + g.crossLen + 92;
  const textBox: CSSProperties = portrait
    ? { position: "absolute", left: 60, right: 60, top: below, textAlign: "center" }
    : { position: "absolute", left: g.M0, top: below };

  return (
    <AbsoluteFill style={{ background: C.paper, backgroundImage: `radial-gradient(${C.paperDeep} 5px, transparent 6px)`, backgroundSize: "64px 64px" }}>
      <Kicker from={0} to={LANE.refuse}>
        One worker · agents in line
      </Kicker>
      <Kicker from={LANE.refuse} to={LANE.run}>
        The rule the contract enforces
      </Kicker>
      <Kicker from={LANE.run} to={LANE.end}>
        Time-lapse · 54 seconds of work
      </Kicker>

      <Caption from={0} to={LANE.arrive}>
        {"QUEUE does this for *AI agents* that share one worker."}
      </Caption>
      <Caption from={LANE.arrive} to={LANE.asks}>
        {"Kestrel's job can't wait: *12 seconds of work, due in 34.*"}
      </Caption>
      <Caption from={LANE.asks} to={LANE.jump}>
        {"Every agent ahead has *posted its price* for waiting."}
      </Caption>
      <Caption from={LANE.jump} to={LANE.refuse}>
        {"Kestrel buys the earlier slots. *Each agent it passes is paid.*"}
      </Caption>
      <Caption from={LANE.refuse} to={LANE.run}>
        {"If any agent would miss its deadline, *the contract refuses.*"}
      </Caption>
      <Caption from={LANE.run} to={LANE.end}>
        {"Kestrel lands on time. *So does everyone it passed.*"}
      </Caption>

      {/* The worker: one owl, one desk */}
      <div
        style={{
          position: "absolute",
          left: g.worker.x,
          top: g.worker.y,
          width: g.worker.w,
          height: g.worker.h,
          background: C.lime,
          border: `5px solid ${C.ink}`,
          borderRadius: 20,
          boxShadow: "0 8px 0 rgba(36,27,47,0.16)",
          overflow: "hidden",
          transform: `scale(${0.9 + workerPulse * 0.1})`,
          opacity: workerPulse,
        }}
      >
        <div style={{ position: "absolute", left: g.worker.w / 2, top: g.worker.h + (portrait ? 26 : 36), width: 0, height: 0, transform: `scale(${portrait ? 0.5 : 0.78}) translateY(${running ? Math.abs(Math.sin(f / 5)) * -8 : 0}px)` }}>
          <Critter species="owl" color="#B98A5E" mood={running ? "happy" : "calm"} blink={f % 80 < 5 ? 1 : 0} />
        </div>
        <span style={{ position: "absolute", left: 0, right: 0, top: 6, textAlign: "center", fontFamily: F.sans, fontWeight: 900, fontSize: portrait ? 17 : 20, letterSpacing: "0.12em", color: C.ink }}>WORKER</span>
      </div>

      {/* Time axis */}
      {portrait ? (
        <div style={{ position: "absolute", left: g.cross0 - 22, top: main(0), width: 2, height: main(56) - main(0), background: C.line, opacity: appearOf(0) }} />
      ) : (
        <div style={{ position: "absolute", left: g.M0, top: laneEnd + 26, width: main(56) - g.M0, height: 2, background: C.line, opacity: appearOf(0) }} />
      )}
      {[0, 10, 20, 30, 40, 50].map((sec) => (
        <div
          key={sec}
          style={{
            position: "absolute",
            ...(portrait
              ? { right: 1080 - (g.cross0 - 32), top: main(sec) - 12, textAlign: "right" as const }
              : { left: main(sec), top: laneEnd + 34, transform: "translateX(-50%)" }),
            fontFamily: F.mono,
            fontSize: portrait ? 18 : 16,
            color: C.muted,
            opacity: appearOf(0) * (portrait && sec === 0 ? 0 : 1),
          }}
        >
          {sec === 0 ? "now" : `${sec}s`}
        </div>
      ))}

      {/* Deadline ticks */}
      <Tick
        sec={KESTREL_DUE}
        label={kestrelOk > 0.5 ? "Kestrel due 34s · ✓" : "Kestrel due 34s"}
        color={kestrelOk > 0.5 ? C.success : C.urgent}
        opacity={ramp(f, LANE.arrive + 30, LANE.arrive + 45)}
      />
      <Tick
        sec={JUNO_DUE}
        label="Juno due 58s"
        color={AGENTS.juno.color}
        opacity={ramp(f, LANE.refuse, LANE.refuse + 15) * (1 - ramp(f, LANE.run - 10, LANE.run))}
      />

      {/* In plain FIFO Kestrel would be late */}
      {lateBracket > 0 ? (
        portrait ? (
          <div style={{ position: "absolute", left: laneEnd + 14, top: main(KESTREL_DUE), height: main(54) - main(KESTREL_DUE), width: 14, opacity: lateBracket, borderTop: `3px solid ${C.urgent}`, borderBottom: `3px solid ${C.urgent}`, borderRight: `3px solid ${C.urgent}` }} />
        ) : (
          <div style={{ position: "absolute", left: main(KESTREL_DUE), top: laneEnd + 74, width: main(54) - main(KESTREL_DUE), opacity: lateBracket }}>
            <div style={{ height: 14, borderLeft: `3px solid ${C.urgent}`, borderRight: `3px solid ${C.urgent}`, borderBottom: `3px solid ${C.urgent}` }} />
          </div>
        )
      ) : null}
      {lateBracket > 0 ? (
        <div
          style={{
            ...textBox,
            ...(portrait ? {} : { left: main(KESTREL_DUE), width: main(54) - main(KESTREL_DUE), top: laneEnd + 100, textAlign: "center" as const }),
            opacity: lateBracket,
            fontFamily: F.mono,
            fontWeight: 700,
            fontSize: portrait ? 26 : 22,
            color: C.urgent,
          }}
        >
          in plain FIFO: 20s late
        </div>
      ) : null}

      {/* Agents ahead */}
      {order.map((id, i) => {
        const sec = startOf(id) + (id === "juno" ? junoPreviewSec : 0);
        const late = id === "juno" && oProgress > 0.6;
        const r = box(sec, JOBS[id].sec);
        if (id === "juno") r.left += shake;
        return (
          <Card
            key={id}
            id={id}
            rect={r}
            portrait={portrait}
            appear={appearOf(i)}
            fill={running ? fillOf(id) : 0}
            done={running && fillOf(id) >= 1}
            outline={late ? C.urgent : undefined}
            late={late}
          />
        );
      })}

      {/* Posted asks */}
      {order.map((id, i) => {
        const pop = ramp(f, LANE.asks + 10 + i * 8, LANE.asks + 22 + i * 8, Easing.out(Easing.back(2)));
        // The posted ask is superseded the moment the purchase starts. Fade it
        // before the paid badges land so the two numbers never sit on top of
        // each other (the film's 0:24 overlap).
        const fade = 1 - ramp(f, LANE.jump - 8, LANE.jump + 10);
        if (pop * fade <= 0) return null;
        const r = box(startOf(id), JOBS[id].sec);
        const at: CSSProperties = portrait
          ? { right: 1080 - (r.left + r.width) + 170, top: r.top + r.height / 2 - 18, transformOrigin: "right center" }
          : { left: r.left + 6, top: r.top - 52, transformOrigin: "left bottom" };
        return (
          <div key={id} style={{ position: "absolute", zIndex: 4, ...at, opacity: pop * fade, transform: `scale(${0.7 + 0.3 * pop})` }}>
            <Pill style={{ fontSize: portrait ? 18 : 16, padding: "4px 9px" }}>{JOBS[id].ask} N/s</Pill>
          </div>
        );
      })}

      {/* Kestrel */}
      {f >= LANE.arrive ? (
        <Card
          id="kestrel"
          rect={box(kSec, JOBS.kestrel.sec, kLift)}
          portrait={portrait}
          appear={kArrive}
          fill={running ? fillOf("kestrel") : 0}
          done={running && fillOf("kestrel") >= 1}
          outline={C.urgent}
          z={5}
        />
      ) : null}

      {/* Coins to each agent it passes */}
      {order.map((id, i) => {
        const fromPt = point(startOf("kestrel") + 6, portrait ? 0.85 : 1.6);
        const target = point(AFTER[id] + JOBS[id].sec / 2, portrait ? 0.8 : 1.05);
        return (
          <Coin
            key={id}
            from={LANE.jump + 18 + i * 9}
            to={LANE.jump + 46 + i * 9}
            x1={fromPt.x}
            y1={fromPt.y}
            x2={target.x}
            y2={target.y}
            label={`${JOBS[id].paid} N`}
          />
        );
      })}

      {/* Orion's refused attempt */}
      {f >= LANE.refuse && oFade > 0 ? (
        <Card id="orion" rect={box(oSec, ORION_SEC, oLift)} portrait={portrait} appear={oArrive * oFade} outline={C.muted} z={5} />
      ) : null}
      {refusedStamp > 0 ? (
        <div
          style={{
            position: "absolute",
            zIndex: 6,
            ...(portrait ? { left: 540, top: main(64) + 10 } : { left: main(46), top: laneEnd + 60 }),
            transform: `translateX(-50%) rotate(-4deg) scale(${refusedStamp})`,
            opacity: Math.min(1, refusedStamp),
            border: `6px solid ${C.urgent}`,
            borderRadius: 16,
            color: C.urgent,
            background: C.surface,
            padding: "10px 24px",
            fontFamily: F.sans,
            fontWeight: 900,
            fontSize: 38,
            letterSpacing: "0.08em",
            whiteSpace: "nowrap",
            textAlign: "center",
          }}
        >
          REFUSED
          <div style={{ fontSize: 20, letterSpacing: "0", marginTop: 2, color: C.ink, fontWeight: 800 }}>
            Juno would finish 4s late · nothing moves, nobody pays
          </div>
        </div>
      ) : null}

      {/* Execution cursor and on-time counter */}
      {running ? (
        <>
          <div
            style={{
              position: "absolute",
              zIndex: 6,
              ...(portrait
                ? { left: g.cross0 - 30, top: main(cursorSec) - 1.5, width: g.crossLen + 60, height: 3 }
                : { left: main(cursorSec) - 1.5, top: g.cross0 - 30, width: 3, height: g.crossLen + 60 }),
              background: C.ink,
              opacity: runT < 1 ? 1 : 0,
            }}
          />
          <div
            style={{
              position: "absolute",
              ...(portrait ? { right: 70, top: main(56) + 20 } : { right: 110, top: laneEnd + 90 }),
              display: "flex",
              alignItems: "baseline",
              gap: 16,
              opacity: ramp(f, LANE.run, LANE.run + 12),
            }}
          >
            <span style={{ fontFamily: F.sans, fontWeight: 900, fontSize: 22, color: C.muted, letterSpacing: "0.1em" }}>ON TIME</span>
            <span style={{ fontFamily: F.sans, fontWeight: 900, fontSize: 92, letterSpacing: "-0.03em", color: doneCount === 5 ? C.success : C.ink }}>
              {doneCount}/5
            </span>
          </div>
        </>
      ) : null}

      {/* Summary under the lane after the purchase */}
      <div
        style={{
          ...textBox,
          fontFamily: F.sans,
          fontWeight: 800,
          fontSize: portrait ? 25 : 22,
          lineHeight: 1.45,
          color: C.inkSoft,
          opacity: interpolate(f, [LANE.jumpEnd, LANE.jumpEnd + 15], [0, 1], clamp) * (1 - ramp(f, LANE.refuse - 10, LANE.refuse)),
        }}
      >
        Kestrel paid 0.0202404 NEAR · four agents moved back 12s · every deadline re-checked ✓
      </div>
    </AbsoluteFill>
  );
}
