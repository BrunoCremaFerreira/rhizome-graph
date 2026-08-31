/**
 * Contract tests (RED) for the one bound that stands between a string somebody
 * else wrote and a canvas this page allocates.
 *
 * The defect is real, pre-existing, and today unreachable. `makeLabelTexture`
 * (src/renderer.ts) sizes its canvas straight off the text it was handed:
 *
 *     const metrics = ctx.measureText(text);
 *     const pad = Math.max(2, Math.round(font * 0.25));
 *     canvas.width = Math.ceil(metrics.width) + pad * 2;
 *
 * There is no `Math.min` anywhere on that line, and it is the sink every piece
 * of text on the graph passes through -- file names, directory names, the
 * agent's own name. Nothing can reach it badly today only by accident of the
 * inputs: file names come from paths, and the actor caption is cut to
 * `MAX_ACTOR_LABEL_CHARS` by `actorDisplayName`. The TodoWrite caption is the
 * first caller that would hand it a sentence a language model wrote, and a
 * 4 000-character one asks for a 52 012 px wide canvas at 2x DPR -- past every
 * engine's maximum canvas dimension, past a typical WebGL `MAX_TEXTURE_SIZE`,
 * and 7.5 MiB allocated per repaint on the way to being rejected.
 *
 * The bound belongs in `makeLabelTexture` and not in the caption path, because
 * a bound only the caption honours is a bound the next caller will not honour.
 * But `renderer.ts` needs a GL context and carries no unit test by doctrine, so
 * what is specified here is the pure sibling the arithmetic must be extracted
 * into: `labelCanvasWidth(measuredWidth, pad)` in `src/labels.ts`, beside every
 * other decision that would silently lose its coverage inside the renderer.
 * The canvas cannot be tested; the arithmetic can, and the arithmetic is where
 * the defect is.
 *
 * The bound test leads this file deliberately. It is the only assertable part
 * of the step, and -- unlike everything else the caption feature needs -- it is
 * worth taking on its own merits even if that feature is never built.
 *
 * The last group is the coupling: the character cap the caption is folded to
 * and the pixel bound the canvas is clipped at are two different limits on one
 * path, and neither may be retuned alone. A cap in code points does not bound a
 * rasterised width -- 60 full-width CJK glyphs are roughly twice the pixels of
 * 60 Latin ones -- so the two constants are pinned against each other rather
 * than against a screen. The arithmetic works out at the widest glyph and the
 * largest raster font: 60 chars x 64 px x 1.0 em + 2 x 16 px of padding is
 * 3 872 px, under the 4 096 px floor below. The security audit's proposed cap
 * of 64 characters is 4 128 px and would break this very row, which is why the
 * plan's 60 stands.
 *
 * Expected to FAIL until `labelCanvasWidth`, `MAX_LABEL_TEXTURE_PX` and the
 * today-private `MAX_FONT_PIXELS` are exported from `src/labels.ts`, and until
 * `src/agentCaption.ts` exists to declare `MAX_CAPTION_CHARS`.
 */

import { describe, it, expect } from "vitest";
import { labelCanvasWidth, MAX_FONT_PIXELS, MAX_LABEL_TEXTURE_PX } from "../src/labels";
import { MAX_CAPTION_CHARS } from "../src/agentCaption";

/**
 * The smallest `MAX_TEXTURE_SIZE` a WebGL2 implementation is permitted to
 * report, from the specification's minimum required value. A texture wider than
 * this is not "large", it is a texture some conforming browser will refuse.
 */
const MIN_GUARANTEED_WEBGL2_TEXTURE_SIZE = 4096;

/**
 * The advance of the widest glyph a caption plausibly holds, in em.
 *
 * A judgement written down as a constant rather than left as a number inside an
 * expression: 1.0 em is a full-width CJK ideograph. The estimate this
 * assumption replaces -- half an em, a fair mean for Latin in a sans face -- is
 * wrong for CJK by roughly a factor of two in the dangerous direction, so the
 * coupling below is computed on the safe side of exactly that error.
 */
const WIDEST_GLYPH_EM = 1.0;

/**
 * The padding `makeLabelTexture` puts on each side, at a given font size.
 *
 * Spelled here exactly as the renderer computes it (src/renderer.ts): a quarter
 * of the em box, never below two pixels. The coupling has to include it rather
 * than ignore it, because it is part of the width the canvas is actually asked
 * for.
 */
function padFor(font: number): number {
  return Math.max(2, Math.round(font * 0.25));
}

/**
 * Measurements no `measureText` should ever return, and every one of them a
 * value that reaches this function unchecked today.
 *
 * `Infinity` and `NaN` are what a canvas hands back when a font failed to load
 * or a context was lost; a negative or zero width is what a degenerate string
 * measures at. None of them may become a canvas dimension.
 */
const HOSTILE_MEASUREMENTS: readonly number[] = [
  Number.POSITIVE_INFINITY,
  Number.NaN,
  Number.MAX_SAFE_INTEGER,
  1e9,
  52012,
  -1,
  -1e9,
  Number.NEGATIVE_INFINITY,
  0,
  0.4,
];

/** Paddings a caller could reach this function with, sane and otherwise. */
const HOSTILE_PADS: readonly number[] = [0, 2, 16, Number.NaN, Number.POSITIVE_INFINITY, -8, 1e9];

describe("labelCanvasWidth: no string can ask for a texture larger than the bound", () => {
  it("never answers wider than the bound, whatever the measurement and the padding", () => {
    // The whole of the defect in one property. A width that is merely large is
    // a slow frame; a width past the engine's limit is a texture that is
    // rejected or silently clamped after the allocation has already been paid
    // for, and nothing on screen says which happened.
    for (const measured of HOSTILE_MEASUREMENTS) {
      for (const pad of HOSTILE_PADS) {
        expect(labelCanvasWidth(measured, pad)).toBeLessThanOrEqual(MAX_LABEL_TEXTURE_PX);
      }
    }
  });

  it("never answers below one pixel, because a zero-width canvas is not a texture", () => {
    // The other end of the same clamp. A canvas of width 0 raises on some
    // engines and rasterises nothing on the rest, so a label that measured at
    // nothing must still come back as a texture the sprite can carry.
    for (const measured of HOSTILE_MEASUREMENTS) {
      for (const pad of HOSTILE_PADS) {
        expect(labelCanvasWidth(measured, pad)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("answers a whole, finite number of pixels for a measurement that is neither", () => {
    // `Math.ceil(NaN) + pad * 2` is `NaN`, and `NaN` assigned to `canvas.width`
    // is coerced to 0 by the DOM -- a blank label, with no error anywhere. The
    // clamp has to answer the question rather than pass the arithmetic through.
    for (const measured of HOSTILE_MEASUREMENTS) {
      for (const pad of HOSTILE_PADS) {
        const width = labelCanvasWidth(measured, pad);
        expect(Number.isFinite(width)).toBe(true);
        expect(Number.isInteger(width)).toBe(true);
      }
    }
  });

  it("is exact below the bound, so an ordinary label is rasterised at the width it measured", () => {
    // The bound is a clamp and not a policy: every label on this page today is
    // far below it, and each must come out at precisely the width the existing
    // inline arithmetic gives it. A rounding change here would resample every
    // name on the graph.
    expect(labelCanvasWidth(100, 16)).toBe(132);
    expect(labelCanvasWidth(100.2, 16)).toBe(133);
    expect(labelCanvasWidth(0.1, 2)).toBe(5);
  });

  it("never throws, because one bad measurement must not cost the frame", () => {
    // The rule `actorDisplayName` already states for text off the network,
    // applied to the number a canvas hands back: this runs inside a per-frame
    // repaint, and an exception here takes the graph with it.
    for (const measured of HOSTILE_MEASUREMENTS) {
      for (const pad of HOSTILE_PADS) {
        expect(() => labelCanvasWidth(measured, pad)).not.toThrow();
      }
    }
  });
});

describe("MAX_LABEL_TEXTURE_PX: a bound every engine can actually hold", () => {
  it("sits at or below the smallest MAX_TEXTURE_SIZE a WebGL2 implementation may report", () => {
    // Asserted against a named floor rather than as an equality to a magic
    // number: the bound is free to be tuned downward for memory or for
    // legibility, and only the ceiling is a fact about the platform.
    expect(MAX_LABEL_TEXTURE_PX).toBeLessThanOrEqual(MIN_GUARANTEED_WEBGL2_TEXTURE_SIZE);
  });

  it("is a positive whole number of pixels, since it is assigned to a canvas dimension", () => {
    expect(Number.isInteger(MAX_LABEL_TEXTURE_PX)).toBe(true);
    expect(MAX_LABEL_TEXTURE_PX).toBeGreaterThan(0);
  });
});

describe("the character cap and the pixel bound, asserted against each other", () => {
  it("leaves room for the longest in-policy caption at the largest raster font", () => {
    // Two limits on one path, and neither may be retuned alone. A cap in code
    // points says nothing about rasterised width, so without this assertion a
    // caption that passed every fold and every cap could still be clipped by
    // the pixel bound -- a silent failure at the far end of a path whose whole
    // purpose is to be safe by construction.
    const widest = MAX_CAPTION_CHARS * MAX_FONT_PIXELS * WIDEST_GLYPH_EM;

    expect(widest + padFor(MAX_FONT_PIXELS) * 2).toBeLessThanOrEqual(MAX_LABEL_TEXTURE_PX);
  });

  it("hands that caption back unclipped, so the coupling is a fact about the function", () => {
    // The same relation, put through the code rather than through the
    // constants. The one above can be satisfied by two numbers that agree; this
    // one also requires the clamp to be the only thing standing between them.
    const widest = MAX_CAPTION_CHARS * MAX_FONT_PIXELS * WIDEST_GLYPH_EM;
    const pad = padFor(MAX_FONT_PIXELS);

    expect(labelCanvasWidth(widest, pad)).toBe(Math.ceil(widest) + pad * 2);
  });
});
