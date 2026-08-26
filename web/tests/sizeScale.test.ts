/**
 * Contract tests (RED) for the median-hinged size scale (F7).
 *
 * The defect is one of distribution, and it is measured rather than imagined.
 * The obvious scale -- one symmetric spread, `max(p90 - median, median - p10)`
 * -- empties its own coldest fifth over a real home directory: the file median
 * there is 41 bytes while the p90 is hundreds of kilobytes, so the upper spread
 * is roughly three times the lower one, and taking the larger of the two
 * compresses the entire lower HALF of the data into two fifths of the ramp.
 * Measured, the five bins came out [0, 35, 23, 12, 30]: a third of the files
 * are small, and not one of them was painted cold. A spectrum whose cold end is
 * unreachable is not a spectrum.
 *
 * So the two halves are hinged independently around the median, in log space:
 *
 *     lb  = log1p(bytes)
 *     med = p50(lb),  lo = med - p10(lb),  hi = p90(lb) - med   # each > 0
 *     t   = 0.5 + (lb - med) / (2 * hi)   when lb >= med
 *     t   = 0.5 - (med - lb) / (2 * lo)   when lb <  med
 *     t   = clamp(t, 0, 1)
 *
 * The stated price is that the ramp is no longer a ratio scale: below the
 * median a factor of ten moves the colour a different distance than a factor of
 * ten above it, so "twice as red" means "further up this project's own
 * distribution", not "twice as big". That is why the legend has to print the
 * byte value at BOTH ends and at the median -- which is why `formatBytes` is
 * specified here, in the pure module, rather than left to the painter, and why
 * the scale carries `coldBytes` / `midBytes` / `hotBytes` at all.
 *
 * Two degenerate inputs are behaviour, not crashes: a distribution more than
 * half of which is one size gives a zero spread and must guard to 1.0 rather
 * than divide by zero, and an empty file set produces NO scale at all -- `null`
 * -- because there is nothing to be the middle of, and every node is then
 * unmeasured.
 *
 * Expected to FAIL until src/sizeColor.ts exists.
 *
 * One failure reason per test.
 */

import { describe, it, expect } from "vitest";
import { buildScale, scalePosition, formatBytes } from "../src/sizeColor";

/**
 * Eleven byte counts, so that every reasonable percentile convention -- linear
 * interpolation, nearest rank, or a plain floor of `p * (n - 1)` -- picks the
 * SAME three elements: 2, 32 and 512. The fixture pins the hinge, not a
 * particular way of indexing a sorted array.
 */
const KNOWN = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];

/**
 * A home directory's real shape, reduced to 101 sorted values: a heavy mass of
 * near-empty files (p10 = 0), a median of 41 bytes, and a p90 of 256 KiB. This
 * is the distribution on which the symmetric spread failed, and the asymmetry
 * is the point -- the lower spread is log1p(41), the upper one nearly two and a
 * half times larger.
 */
function homeShaped(): number[] {
  const values: number[] = [];
  for (let i = 0; i < 30; i++) values.push(0);
  for (let i = 0; i < 20; i++) values.push(1 + Math.round((i * 39) / 19));
  values.push(41);
  for (let i = 1; i <= 39; i++) {
    const f = i / 40;
    values.push(Math.round(Math.exp(Math.log(42) + f * (Math.log(262143) - Math.log(42)))));
  }
  for (let i = 0; i < 11; i++) values.push(Math.round(262144 * Math.pow(1.7, i)));
  return values;
}

/** `buildScale` is allowed to answer null; a test that reached one has failed. */
function scaleOf(sizes: readonly number[]) {
  const scale = buildScale(sizes);
  if (scale === null) throw new Error("expected a scale over a non-empty set");
  return scale;
}

describe("buildScale: the three anchors", () => {
  it("reports the p10, p50 and p90 byte values the legend has to print", () => {
    const scale = scaleOf(KNOWN);
    expect([scale.coldBytes, scale.midBytes, scale.hotBytes]).toEqual([2, 32, 512]);
  });
});

describe("scalePosition: the hinge", () => {
  it("puts the median file exactly at the middle of the ramp", () => {
    const scale = scaleOf(KNOWN);
    expect(scalePosition(scale, scale.midBytes)).toBeCloseTo(0.5, 12);
  });

  it("puts the p10 file at the cold end", () => {
    const scale = scaleOf(KNOWN);
    expect(scalePosition(scale, scale.coldBytes)).toBeCloseTo(0, 12);
  });

  it("puts the p90 file at the hot end", () => {
    const scale = scaleOf(KNOWN);
    expect(scalePosition(scale, scale.hotBytes)).toBeCloseTo(1, 12);
  });

  it("lands a file between the median and the p90 strictly between them on the ramp", () => {
    const scale = scaleOf(KNOWN);
    const t = scalePosition(scale, 128);
    expect(t).toBeGreaterThan(0.5);
    expect(t).toBeLessThan(1);
  });

  it("clamps a file larger than the p90 to the hot end instead of running off it", () => {
    const scale = scaleOf(KNOWN);
    expect(scalePosition(scale, 8 * 1024 * 1024)).toBe(1);
  });

  it("clamps a file smaller than the p10 to the cold end instead of running off it", () => {
    const scale = scaleOf(KNOWN);
    expect(scalePosition(scale, 0)).toBe(0);
  });

  it("keeps the coldest fifth populated over a real home directory's shape", () => {
    // THE regression test for the hinge. Over this distribution the symmetric
    // spread puts NOTHING below t = 0.2; hinging the halves independently puts
    // about a third of the files there, which is where they belong.
    const sizes = homeShaped();
    const scale = scaleOf(sizes);
    const cold = sizes.filter((bytes) => scalePosition(scale, bytes) < 0.2).length;
    expect(cold / sizes.length).toBeGreaterThan(0.2);
  });
});

describe("buildScale: the degenerate distributions", () => {
  it("guards a zero spread to 1.0 when more than half the files are one size", () => {
    const scale = scaleOf(new Array(20).fill(512));
    expect([scale.lowSpread, scale.highSpread]).toEqual([1, 1]);
  });

  it("puts every file at the middle when they are all the same size", () => {
    // Not NaN, not Infinity: a distribution with no width has no cold end and
    // no hot end, so every node sits on the hinge.
    const scale = scaleOf(new Array(20).fill(512));
    expect(scalePosition(scale, 512)).toBe(0.5);
  });

  it("guards only the collapsed half when the median equals the p10", () => {
    // More than half the tree is empty files, with a real tail above it. The
    // lower half has no width, the upper half does, and the upper half must
    // keep the width it has.
    const sizes = [...new Array(60).fill(0), ...new Array(40).fill(0).map((_, i) => (i + 1) * 1024)];
    const scale = scaleOf(sizes);
    expect(scale.lowSpread).toBe(1);
    expect(scale.highSpread).toBeGreaterThan(0);
  });

  it("produces no scale at all for an empty file set", () => {
    // There is nothing to be the middle of. Every node is unmeasured, which is
    // a colour of its own rather than a position on a ramp.
    expect(buildScale([])).toBe(null);
  });
});

describe("formatBytes", () => {
  it("prints binary units with one decimal above bytes", () => {
    // The legend's three anchors, and the reason this lives in the pure module
    // rather than in the painter.
    expect([
      formatBytes(0),
      formatBytes(41),
      formatBytes(1023),
      formatBytes(1024),
      formatBytes(7934),
      formatBytes(1048576),
      formatBytes(3833402552),
    ]).toEqual(["0 B", "41 B", "1023 B", "1.0 KiB", "7.7 KiB", "1.0 MiB", "3.6 GiB"]);
  });

  it("never prints a negative size", () => {
    // No file has one. A minus sign in the legend would be a measurement bug
    // showing through as a caption.
    expect(formatBytes(-5).startsWith("-")).toBe(false);
  });
});
