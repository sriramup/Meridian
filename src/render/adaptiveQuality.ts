// Keeps the camera fluid on GPUs that can't draw the lit 3D city at full pixel density.
//
// It only ever acts on evidence: frame times sampled while the camera is actually moving, judged by
// their median over a couple of seconds (so a one-off hitch, chunk loading or a background tab
// never counts). If moving frames run consistently slower than ~36 fps, the 3D layer's pixel
// density steps down one notch (2 → 1.5 → 1.25 on a high-density screen); a machine that keeps up
// is never touched. The basemap and the interface stay at full resolution. `?quality=full` turns it
// off.

/** frames per verdict: a couple of seconds of motion */
const WINDOW = 120;
/** median moving-frame time (ms) above which the scene is too slow: ~36 fps */
const SLOW_MS = 28;
/** frame gaps longer than this are a paused or hidden tab, not slowness */
const MAX_GAP_MS = 250;
/** after a step, motion settles before the next verdict */
const COOLDOWN_MS = 3000;

export interface QualityGovernor {
  /** a frame was drawn while the camera moved, `dt` ms after the previous one */
  sample(dt: number, now: number): void;
  /** the current pixel density for the 3D layer */
  readonly level: number;
}

export function qualityGovernor(native: number, apply: (pixelRatio: number) => void, enabled = true): QualityGovernor {
  const top = Math.min(2, native);
  // never below 1.25 on a high-density screen (softer than that reads as blurry); nothing to do at 1x
  const steps = [top, 1.5, 1.25].filter((v, i, a) => v <= top && a.indexOf(v) === i);
  let at = 0;
  let cooldown = 0;
  const win: number[] = [];
  return {
    get level() {
      return steps[at];
    },
    sample(dt, now) {
      if (!enabled || at >= steps.length - 1 || dt <= 0 || dt > MAX_GAP_MS || now < cooldown) return;
      win.push(dt);
      if (win.length < WINDOW) return;
      const sorted = win.splice(0).sort((a, b) => a - b);
      if (sorted[sorted.length >> 1] <= SLOW_MS) return;
      at++;
      cooldown = now + COOLDOWN_MS;
      apply(steps[at]);
    },
  };
}
