import { useCallback, useEffect, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { useReducedMotion } from "framer-motion";
import { Play } from "lucide-react";
import { publicUrl } from "../lib/backend";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import {
  CHAPTERS,
  DURATION,
  FPS,
  HEIGHT,
  QueueExplainer,
  V_HEIGHT,
  V_WIDTH,
  WIDTH,
} from "../explainer/QueueExplainer";

type ChapterId = (typeof CHAPTERS)[number]["id"];

function chapterAt(frame: number): ChapterId {
  let current: ChapterId = CHAPTERS[0].id;
  for (const chapter of CHAPTERS) {
    if (frame >= chapter.at) current = chapter.id;
  }
  return current;
}

const SECONDS = Math.floor(DURATION / FPS);
/** A frame with the airport line on screen; frame 0 is intentionally blank. */
const POSTER_FRAME = 100;
const PHONE = "(max-width: 720px)";

/** Phones get the portrait cut so the captions stay readable. */
function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia(PHONE).matches);
  useEffect(() => {
    const query = window.matchMedia(PHONE);
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

export function Explainer() {
  const playerRef = useRef<PlayerRef>(null);
  const [chapter, setChapter] = useState<ChapterId>(CHAPTERS[0].id);
  const [started, setStarted] = useState(false);
  const reducedMotion = useReducedMotion();
  const phone = usePhone();
  const w = phone ? V_WIDTH : WIDTH;
  const h = phone ? V_HEIGHT : HEIGHT;

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame = (event: { detail: { frame: number } }) => {
      setChapter((prev) => {
        const next = chapterAt(event.detail.frame);
        return prev === next ? prev : next;
      });
    };
    player.addEventListener("frameupdate", onFrame);
    return () => player.removeEventListener("frameupdate", onFrame);
  }, [phone]);

  // Keep the active chapter visible in the scrollable strip on phones.
  useEffect(() => {
    const item = document.querySelector<HTMLElement>(`.chapter-item[data-value="${chapter}"]`);
    const strip = item?.parentElement;
    if (!item || !strip || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollTo({
      left: item.offsetLeft - (strip.clientWidth - item.offsetWidth) / 2,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [chapter, reducedMotion]);

  const jump = useCallback(
    (id: ChapterId) => {
      const target = CHAPTERS.find((entry) => entry.id === id);
      const player = playerRef.current;
      if (!target || !player) return;
      player.seekTo(target.at);
      player.play();
      setStarted(true);
      setChapter(id);
    },
    [],
  );

  const start = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    player.seekTo(0);
    player.play();
    setStarted(true);
  }, []);

  return (
    <section className="explainer-section" id="idea" aria-labelledby="idea-heading">
      <div className="container">
        <header className="section-heading explainer-heading">
          <div>
            <p className="section-kicker">
              <span>01</span> The idea in {SECONDS} seconds
            </p>
            <h2 id="idea-heading">
              Watch it <em>first.</em>
            </h2>
          </div>
          <p className="section-lede">
            The whole mechanism as a short cartoon: animals in an airport line, the
            same five as AI agents, the NEAR contract and the live season. Then scroll down and run the real thing yourself.
          </p>
        </header>

        <div className="explainer-frame">
          <Player
            key={phone ? "portrait" : "landscape"}
            ref={playerRef}
            component={QueueExplainer}
            inputProps={{ variant: "site" as const, audioSrc: publicUrl("voiceover.mp3") }}
            durationInFrames={DURATION}
            fps={FPS}
            initialFrame={POSTER_FRAME}
            compositionWidth={w}
            compositionHeight={h}
            style={{ width: "100%", aspectRatio: `${w} / ${h}` }}
            controls={started}
            autoPlay={false}
            loop={false}
            clickToPlay={started}
            spaceKeyToPlayOrPause={false}
            showVolumeControls
            acknowledgeRemotionLicense
          />
          {!started ? (
            <div className="explainer-poster">
              <p className="explainer-poster-line">
                From an airport line to a refused jump to a contract that keeps
                every deadline.
              </p>
              <button
                type="button"
                className="explainer-play"
                onClick={start}
                aria-label={`Play the ${SECONDS}-second film`}
              >
                <span className="explainer-play-mark" aria-hidden="true">
                  <Play size={22} fill="currentColor" />
                </span>
                <span>
                  Play the film
                  <small>{SECONDS} seconds · with narration</small>
                </span>
              </button>
              <p className="explainer-poster-note">
                {reducedMotion
                  ? "Reduced motion is on. Nothing plays until you press play."
                  : "Paused until you press play."}
              </p>
            </div>
          ) : null}
        </div>

        <SegmentedControl
          className="chapter-control"
          aria-label="Jump to a chapter"
          value={chapter}
          onValueChange={(next) => {
            if (next) jump(next as ChapterId);
          }}
        >
          <SegmentedControlIndicator className="chapter-indicator" />
          {CHAPTERS.map((entry, index) => (
            <SegmentedControlItem key={entry.id} value={entry.id} className="chapter-item" data-value={entry.id}>
              <span className="chapter-num">{String(index + 1).padStart(2, "0")}</span>
              {entry.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>
    </section>
  );
}
