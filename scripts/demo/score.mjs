// A quiet ambient score for the demo, synthesized with ffmpeg (no samples, nothing licensed):
// slow-attack chords of soft sine partials, a low root, light echo for space and a gentle low-pass.
//
//   node scripts/demo/score.mjs <seconds> <out.m4a>

import { execFileSync } from "node:child_process";

const total = Number(process.argv[2] ?? 120);
const out = process.argv[3] ?? "score.m4a";
const hz = (m) => 440 * 2 ** ((m - 69) / 12);
// D major-ish, unhurried: Dmaj9 → Bm7 → Gmaj7 → A6sus, each held CHORD seconds
const CHORDS = [
  [50, 62, 66, 69, 73, 76],
  [47, 59, 62, 66, 69, 74],
  [43, 59, 62, 66, 71, 74],
  [45, 57, 61, 64, 66, 71],
];
const CHORD = 8;
const n = Math.ceil(total / CHORD);
// each chord fades in over 2.6 s and out over 3 s, overlapping its neighbours
const env = (i) => {
  const a = i * CHORD,
    b = a + CHORD + 2.5;
  return `(between(t,${a},${b})*min(1,(t-${a})/2.6)*min(1,(${b}-t)/3))`;
};
const voices = [];
for (let i = 0; i < n; i++) {
  const ch = CHORDS[i % CHORDS.length];
  ch.forEach((m, k) => {
    const f = hz(m);
    const amp = k === 0 ? 0.16 : 0.085 / (1 + k * 0.12);
    // a slow, slightly detuned pair per note: a soft chorus
    voices.push(`${amp}*${env(i)}*(sin(2*PI*${f.toFixed(3)}*t)+0.5*sin(2*PI*${(f * 1.003).toFixed(3)}*t+${k}))`);
  });
}
const expr = voices.join("+");
const fadeOut = Math.max(0, total - 4);
execFileSync("ffmpeg", [
  "-y",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  `aevalsrc='${expr}':s=48000:d=${total}`,
  "-af",
  `lowpass=f=2400,aecho=0.8:0.7:420|780:0.32|0.22,volume=0.85,afade=t=in:d=2.5,afade=t=out:st=${fadeOut}:d=4,alimiter=limit=0.7`,
  "-ac",
  "2",
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  out,
]);
console.log(`wrote ${out}`);
