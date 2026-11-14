#!/usr/bin/env node
// Fit the narration to the explainer film.
//
//   node scripts/build-voiceover.mjs [--tempo 1.28]
//
// Input:  docs/media/voiceover.mp3        the raw take from the script in docs/VOICEOVER.md
//         docs/media/voiceover-tests.mp3  optional: the "Then we tried to break it…" line as its own take;
//                                         without it the tests scene plays silently
// Output: apps/web/public/voiceover.mp3            the narration: long pauses trimmed, tempo raised (pitch kept)
//         apps/web/src/explainer/voiceTiming.ts    how long each scene of the film lasts, so picture follows voice
//
// The film itself is not re-encoded here: QueueExplainer reads voiceTiming.ts and plays each scene faster or
// slower to match its line. Re-render the videos afterwards with `npm -w @queue/web run render:explainer`.
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./lib.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const TEMPO = arg("tempo", 1.28);
const FPS = 30;
const LEAD = 0.3; // seconds of quiet before the first word (after tempo)
const GAP_IN = 0.2; // pause between two phrases of one scene (before tempo)
const GAP_SCENE = 0.34; // pause between two scenes (before tempo)
const END_CARD = 1.8; // seconds for the logo card, which has no narration

const SRC = path.join(ROOT, "docs/media/voiceover.mp3");
if (!existsSync(SRC)) {
  console.error("build-voiceover: docs/media/voiceover.mp3 not found");
  process.exit(1);
}

// The phrases of this take, in seconds of the raw file (from ffmpeg silencedetect), grouped by film scene.
// `orig` is the scene's frame range in the film's own timeline (30 fps).
const SCENES = [
  { name: "airport: the latecomer asks", orig: [0, 180], phrases: [[0.0, 3.18], [3.68, 5.59], [6.05, 6.92]] },
  { name: "airport: pay everyone you pass", orig: [180, 275], phrases: [[7.48, 9.9]] },
  { name: "airport: unless someone would be late", orig: [275, 360], phrases: [[10.19, 12.93]] },
  { name: "agents share one worker", orig: [360, 480], phrases: [[13.47, 17.13]] },
  { name: "Kestrel is urgent", orig: [480, 580], phrases: [[17.79, 19.4], [19.74, 21.73]] },
  { name: "posted prices", orig: [580, 660], phrases: [[22.19, 25.32]] },
  { name: "the purchase", orig: [660, 790], phrases: [[25.79, 30.29]] },
  { name: "the refusal", orig: [790, 940], phrases: [[30.76, 34.65]] },
  { name: "everyone lands on time", orig: [940, 1110], phrases: [[35.09, 36.35], [36.84, 38.08], [38.47, 39.94]] },
  { name: "a contract decides", orig: [1110, 1190], phrases: [[40.34, 42.3], [42.61, 44.36]] },
  { name: "the live season", orig: [1190, 1355], phrases: [[44.8, 47.12], [47.5, 48.85], [49.3, 51.07]] },
];
// The tests scene has its own take (one sentence), so the main take does not have to be recorded again.
const TESTS = { name: "tested like a protocol", orig: [1355, 1475], take: path.join(ROOT, "docs/media/voiceover-tests.mp3"), silentSecs: 3.6 };
const END = { name: "end card", orig: [1475, 1560] };
const PAD_IN = 0.04;
const PAD_OUT = 0.07;

// Build the audio: phrase, short pause, phrase, …, then one tempo change over the whole track.
const parts = [];
const labels = [];
let n = 0;
const silence = (d) => {
  parts.push(`aevalsrc=0:d=${d.toFixed(3)}:s=44100[s${n}]`);
  labels.push(`[s${n}]`);
  n += 1;
};
const sceneSecs = [];
silence(LEAD * TEMPO);
SCENES.forEach((scene, si) => {
  let secs = si === 0 ? LEAD * TEMPO : 0;
  scene.phrases.forEach(([a, b], pi) => {
    const start = Math.max(0, a - PAD_IN);
    const end = b + PAD_OUT;
    parts.push(`[0:a]atrim=${start.toFixed(3)}:${end.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.012,afade=t=out:st=${(end - start - 0.03).toFixed(3)}:d=0.03[p${n}]`);
    labels.push(`[p${n}]`);
    n += 1;
    secs += end - start;
    const gap = pi < scene.phrases.length - 1 ? GAP_IN : GAP_SCENE;
    silence(gap);
    secs += gap;
  });
  sceneSecs.push(secs / TEMPO);
});
// The extra take: strip the silence at both ends, then treat it as one more phrase.
let testsSecs = TESTS.silentSecs;
const inputs = ["-i", SRC];
if (existsSync(TESTS.take)) {
  const trimmed = path.join(mkdtempSync(path.join(os.tmpdir(), "queue-voice-")), "tests.wav");
  const strip = "silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.03";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", TESTS.take, "-af", `${strip},areverse,${strip},areverse`, "-ar", "44100", "-ac", "1", trimmed], { stdio: "inherit" });
  const d = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", trimmed]).toString().trim());
  inputs.push("-i", trimmed);
  parts.push(`[1:a]afade=t=in:d=0.012,afade=t=out:st=${(d - 0.03).toFixed(3)}:d=0.03[p${n}]`);
  labels.push(`[p${n}]`);
  n += 1;
  silence(GAP_SCENE);
  testsSecs = (d + GAP_SCENE) / TEMPO;
}
const filter = `${parts.join(";")};${labels.join("")}concat=n=${labels.length}:v=0:a=1,atempo=${TEMPO},loudnorm=I=-16:TP=-1.5:LRA=11[out]`;
const OUT = path.join(ROOT, "apps/web/public/voiceover.mp3");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[out]", "-ar", "44100", "-b:a", "160k", OUT], { stdio: "inherit" });

// Scene lengths in output frames, from cumulative times so rounding never drifts.
let t = 0;
let prev = 0;
const scenes = SCENES.map((scene, i) => {
  t += sceneSecs[i];
  const edge = Math.round(t * FPS);
  const out = edge - prev;
  prev = edge;
  return { name: scene.name, orig: scene.orig, out };
});
scenes.push({ name: TESTS.name, orig: TESTS.orig, out: Math.round(testsSecs * FPS) });
scenes.push({ name: END.name, orig: END.orig, out: Math.round(END_CARD * FPS) });
const total = scenes.reduce((s, x) => s + x.out, 0);

const ts = `// Generated by scripts/build-voiceover.mjs from docs/media/voiceover.mp3. Do not edit by hand.
// Each scene of the film (frames \`orig\` of its own timeline) is played over \`out\` frames, so the picture
// follows the narration in public/voiceover.mp3.
export const VOICE_TIMING = {
  tempo: ${TEMPO},
  audio: "voiceover.mp3",
  scenes: ${JSON.stringify(scenes, null, 2).replace(/\n/g, "\n  ")},
  totalFrames: ${total},
} as const;
`;
writeFileSync(path.join(ROOT, "apps/web/src/explainer/voiceTiming.ts"), ts);
const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", OUT]).toString().trim();
console.log(`build-voiceover: tempo ${TEMPO}, narration ${Number(dur).toFixed(2)} s, film ${(total / FPS).toFixed(2)} s (${total} frames)`);
for (const s of scenes) console.log(`  ${String(s.out).padStart(4)} frames (${(s.out / FPS).toFixed(2)} s, x${((s.orig[1] - s.orig[0]) / s.out).toFixed(2)})  ${s.name}`);
