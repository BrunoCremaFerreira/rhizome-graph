/**
 * The colour of a file BY HOW BIG IT IS: the ramp, the scale it is read
 * against, and the byte formatter the legend prints its anchors with.
 *
 * It is not in `colors.ts` because that module answers "the colour of a thing
 * by what it is" -- a pure function of one path, called from the renderer's
 * per-frame loop -- while this one is a scale built from a WHOLE distribution,
 * evaluated once when an answer arrives. Same split as `statusList.ts` beside
 * `statusHud.ts`.
 *
 * Two decisions are load-bearing, and each exists because the obvious
 * alternative is wrong in a measured way.
 *
 * THE RAMP IS A STOP TABLE, NOT A HUE SWEEP. `hslToInt` is one import away and
 * `hslToInt(240 - 240 * t, ...)` runs straight through green at the median.
 * Green is ruled out twice: the user asked for a ramp without it, and green is
 * already the `A` flash that says "a file was created". So the stops are
 * written down and interpolated per channel, and the invariant they exist to
 * satisfy is `g < max(r, b)` everywhere. The margin is thin near the middle
 * (~2/255) and that thinness is inherent -- any blue-to-red ramp through a
 * light neutral has to pass a near-tie -- so what distinguishes this from a
 * green is that the near-tie is NEUTRAL, not that the margin is wide.
 *
 * THE SCALE IS HINGED AT THE MEDIAN, NOT SYMMETRIC. A single spread of
 * `max(hi, lo)` empties its own coldest fifth over a home directory, where the
 * file median is 41 bytes and the p90 is hundreds of kilobytes: the larger
 * spread compresses the whole lower half of the data into two fifths of the
 * ramp. Hinging the halves independently costs nothing elsewhere and gives the
 * small files the cold end they belong at. The stated price is that the ramp is
 * no longer a ratio scale -- "further up this project's own distribution", not
 * "twice as big" -- which is why the scale carries its three byte anchors for a
 * legend to print.
 */

import { NEUTRAL_NODE_COLOR } from "./colors";

/** The five stops of the ramp, cold to hot, interpolated per channel in sRGB. */
export const RAMP_STOPS: readonly { readonly t: number; readonly rgb: number }[] = [
  { t: 0.0, rgb: 0x3b6dff },
  { t: 0.25, rgb: 0x8fb8ff },
  { t: 0.5, rgb: 0xfff4e8 },
  { t: 0.75, rgb: 0xffb64d },
  { t: 1.0, rgb: 0xff3b21 },
];

/**
 * The grey of a node nobody measured -- a file created since the answer, or one
 * beyond the daemon's cap. It is the grey ALREADY on screen, imported rather
 * than respelled: a second near-grey beside the directory grey would be the
 * least legible pair this page could contain.
 */
export const UNMEASURED_COLOR = NEUTRAL_NODE_COLOR;

/** Where a distribution sits: its middle, its two half-widths, its anchors. */
export interface SizeScale {
  readonly medianLog: number;
  /** `medianLog - p10Log`, guarded above zero. */
  readonly lowSpread: number;
  /** `p90Log - medianLog`, guarded above zero. */
  readonly highSpread: number;
  /** The p10 byte value, for the legend. */
  readonly coldBytes: number;
  /** The p50 byte value. */
  readonly midBytes: number;
  /** The p90 byte value. */
  readonly hotBytes: number;
}

/**
 * A position in [0, 1], where anything that is not a number lands on the cold
 * end rather than travelling on as a NaN into a vertex buffer.
 */
function clamp01(t: number): number {
  if (!(t > 0)) return 0;
  return t > 1 ? 1 : t;
}

/** The value at `p` of a sorted list, by plain rank -- no interpolation. */
function percentile(sorted: readonly number[], p: number): number {
  const index = Math.floor(p * (sorted.length - 1));
  return sorted[index];
}

/** One channel of a packed 0xRRGGBB integer. */
function channel(rgb: number, shift: number): number {
  return (rgb >> shift) & 0xff;
}

/**
 * The scale a set of file sizes is read against, or null when there is nothing
 * to be the middle of -- an empty set leaves every node unmeasured.
 */
export function buildScale(sizes: readonly number[]): SizeScale | null {
  if (sizes.length === 0) return null;
  const sorted = [...sizes].sort((a, b) => a - b);
  const coldBytes = percentile(sorted, 0.1);
  const midBytes = percentile(sorted, 0.5);
  const hotBytes = percentile(sorted, 0.9);
  const medianLog = Math.log1p(midBytes);
  // Each half is guarded on its own: a tree more than half of which is empty
  // files has no lower width, and the upper half must keep the width it has.
  const low = medianLog - Math.log1p(coldBytes);
  const high = Math.log1p(hotBytes) - medianLog;
  return {
    medianLog,
    lowSpread: low > 0 ? low : 1,
    highSpread: high > 0 ? high : 1,
    coldBytes,
    midBytes,
    hotBytes,
  };
}

/** Where a file of `bytes` sits on the ramp: 0 at the p10, 0.5 at the median, 1 at the p90. */
export function scalePosition(scale: SizeScale, bytes: number): number {
  const lb = Math.log1p(bytes > 0 ? bytes : 0);
  const t =
    lb >= scale.medianLog
      ? 0.5 + (lb - scale.medianLog) / (2 * scale.highSpread)
      : 0.5 - (scale.medianLog - lb) / (2 * scale.lowSpread);
  return clamp01(t);
}

/** The ramp's colour at `t`, clamped into [0, 1]. */
export function rampColor(t: number): number {
  const p = clamp01(t);
  for (let i = 1; i < RAMP_STOPS.length; i += 1) {
    const hi = RAMP_STOPS[i];
    if (p > hi.t) continue;
    const lo = RAMP_STOPS[i - 1];
    const span = hi.t - lo.t;
    const f = span > 0 ? (p - lo.t) / span : 0;
    let rgb = 0;
    for (const shift of [16, 8, 0]) {
      const a = channel(lo.rgb, shift);
      const b = channel(hi.rgb, shift);
      rgb |= Math.round(a + (b - a) * f) << shift;
    }
    return rgb;
  }
  return RAMP_STOPS[RAMP_STOPS.length - 1].rgb;
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

/**
 * A byte count as the legend prints it: binary units, one decimal above bytes,
 * and never a negative -- a minus sign there would be a measurement bug showing
 * through as a caption.
 */
export function formatBytes(bytes: number): string {
  const value = bytes > 0 ? bytes : 0;
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(scaled)) : scaled.toFixed(1);
  return `${text} ${BYTE_UNITS[unit]}`;
}
