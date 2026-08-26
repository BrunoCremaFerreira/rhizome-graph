/**
 * Contract tests (RED) for the file-size colour ramp (F7).
 *
 * The defect this module exists to prevent is already written in `colors.ts`.
 * The obvious way to paint "cold to warm" is a hue sweep, and `hslToInt` is
 * sitting right there: `hslToInt(240 - 240 * t, 0.7, 0.6)` is one line and runs
 * straight through green at t = 0.5. Green is ruled out twice over -- the user
 * asked for a ramp without it, and green is already spoken for by the `A` flash
 * that says "a file was created". A size ramp that turned files green at the
 * median would be saying "created" about every average-sized file on screen.
 *
 * So the ramp is an explicit stop table interpolated per channel, and the whole
 * of this file is the guard on that choice. It lives here rather than in
 * `colors.ts` because that module is "the colour of a thing by what it is" -- a
 * pure function of one path, called from the renderer's per-frame loop -- while
 * this one is a scale built from a whole distribution. Same split as
 * `statusList.ts` beside `statusHud.ts`.
 *
 * The central assertion is the user's own sentence, pinned as an inequality:
 * for every sampled `t`, `g < max(r, b)`. Note what it deliberately does NOT
 * say. The tightest margin over these stops is about 2/255, and that thinness
 * is INHERENT: any ramp running from a blue to a red through a light neutral
 * must pass a point where all three channels are nearly equal. A test demanding
 * a margin (`g <= max(r, b) - 8`) would reject every white-crossing ramp,
 * including the correct one. The near-tie is therefore checked a second way
 * instead -- wherever the margin is under 8/255 the colour must be NEUTRAL,
 * `max - min <= 24` -- which is what separates "passes through white" from
 * "passes through green" without constraining how thin the margin gets.
 *
 * The invariant is also transfer-independent: the sRGB transfer function is
 * monotone and applied per channel, so a channel ordering in sRGB is the same
 * ordering in linear light. three.js's colour-space handling cannot break it.
 *
 * `UNMEASURED_COLOR` is checked by RELATION only -- achromatic, and never equal
 * to a ramp sample -- never by value, so retuning the greys stays free.
 *
 * Expected to FAIL until src/sizeColor.ts exists.
 *
 * One failure reason per test.
 */

import { describe, it, expect } from "vitest";
import { RAMP_STOPS, rampColor, UNMEASURED_COLOR } from "../src/sizeColor";

/** The three 8-bit channels of a packed 0xRRGGBB integer. */
function channels(rgb: number): { r: number; g: number; b: number } {
  return { r: (rgb >> 16) & 0xff, g: (rgb >> 8) & 0xff, b: rgb & 0xff };
}

/**
 * The sample grid the invariant is asserted over: 10 001 points across [0, 1],
 * dense enough that the thinnest crossing (near t = 0.456) is actually visited.
 */
const SAMPLES = 10000;

function sampled(): number[] {
  const ts: number[] = [];
  for (let i = 0; i <= SAMPLES; i++) ts.push(i / SAMPLES);
  return ts;
}

describe("rampColor: there is no green star", () => {
  it("keeps green below the greater of red and blue at every point of the ramp", () => {
    // The user's constraint, as an inequality. Reported as the worst offender
    // rather than as a bare boolean, so a failure names the t that broke it.
    const offenders = sampled()
      .map((t) => ({ t, ...channels(rampColor(t)) }))
      .filter((s) => !(s.g < Math.max(s.r, s.b)));
    expect(offenders.slice(0, 5)).toEqual([]);
  });

  it("passes through white rather than through green wherever the margin is thin", () => {
    // The margin gets down to ~2/255, and that is inherent to a blue-to-red
    // ramp crossing a light neutral. What must NOT happen is the channels
    // converging because green is climbing: where they nearly tie, the colour
    // has to be a neutral.
    const notNeutral = sampled()
      .map((t) => ({ t, ...channels(rampColor(t)) }))
      .filter((s) => Math.max(s.r, s.b) - s.g < 8)
      .filter((s) => Math.max(s.r, s.g, s.b) - Math.min(s.r, s.g, s.b) > 24);
    expect(notNeutral.slice(0, 5)).toEqual([]);
  });
});

describe("rampColor: the ends and the clamp", () => {
  it("paints the coldest file the table's first stop", () => {
    expect(rampColor(0)).toBe(0x3b6dff);
  });

  it("paints the hottest file the table's last stop", () => {
    expect(rampColor(1)).toBe(0xff3b21);
  });

  it("clamps a position below zero to the cold end", () => {
    expect(rampColor(-0.5)).toBe(rampColor(0));
  });

  it("clamps a position above one to the hot end", () => {
    expect(rampColor(2.5)).toBe(rampColor(1));
  });

  it("degrades a NaN position to one end instead of producing NaN channels", () => {
    // A NaN reaches here from a scale built over a degenerate distribution.
    // Whichever end it lands on, it must be a real colour: NaN channels would
    // be written into a three.js buffer and paint nothing at all.
    expect([rampColor(0), rampColor(1)]).toContain(rampColor(Number.NaN));
  });
});

describe("RAMP_STOPS", () => {
  it("spans the whole of [0, 1] in ascending order", () => {
    const ts = RAMP_STOPS.map((stop) => stop.t);
    expect(ts[0]).toBe(0);
    expect(ts[ts.length - 1]).toBe(1);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it("returns each stop's own colour at that stop's position", () => {
    // Interpolation between the bracketing stops must be exact at the stops
    // themselves, or the table stops describing the ramp it names.
    const atStops = RAMP_STOPS.map((stop) => rampColor(stop.t));
    expect(atStops).toEqual(RAMP_STOPS.map((stop) => stop.rgb));
  });
});

describe("UNMEASURED_COLOR", () => {
  it("is a grey rather than a colour, so it reads as an absence of measurement", () => {
    // A relation, not a value: retuning the grey must stay free.
    const { r, g, b } = channels(UNMEASURED_COLOR);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(12);
  });

  it("never collides with a colour the ramp itself can produce", () => {
    // An unmeasured node that happened to wear a ramp colour would be a lie
    // about a size nobody measured.
    const collisions = sampled().filter((t) => rampColor(t) === UNMEASURED_COLOR);
    expect(collisions.slice(0, 5)).toEqual([]);
  });
});
