/**
 * RED specification for `nodeFade.ts`: how much of its own colour a node keeps
 * when nobody has touched it lately.
 *
 * The defect: an alarm that fades out is an alarm nobody sees. Every file dot
 * is multiplied by `0.35 + 0.65 * opacity` at the end of the per-frame colour
 * chain, and `opacity` decays with idleness -- so a file an agent touched a
 * minute ago is painted at roughly a third of its colour. That is right for the
 * ordinary case and exactly wrong for a supervision marker: the whole point of
 * an alarm is that it stays legible long after the event that raised it, until
 * a human dismisses it. A search match is already exempt from the same fade,
 * for the same reason stated the other way round -- the user asked for that
 * node by name, so it must be visible however cold it is.
 *
 * WHERE THE DECISION LIVES, and why this file exists at all. The plan asked for
 * an assertion over the parsed source of `renderer.ts` -- that the fade sits
 * behind a condition naming the alarm set. That is not writable: there is no
 * TypeScript parser in this suite, and a substring search cannot see nesting,
 * so the "test" would pass over an implementation that named the alarm set in a
 * comment. The plan itself calls that row the weakest in it. So the decision
 * moves OUT of the renderer, which needs a GL context and carries no test by
 * doctrine, into a pure sibling -- the same move `view.ts` and `labels.ts`
 * already are. `renderer.ts` then calls this function and holds no arithmetic.
 *
 * The unflagged expression is pinned to the exact one it replaces, because this
 * is an extraction: if the constant moves during the move, every dot on the
 * page changes brightness and no test would have said so.
 */

import { describe, it, expect } from "vitest";
import { nodeOpacityFactor } from "../src/nodeFade";

/** The expression at the end of the renderer's colour chain, spelled once. */
const fade = (opacity: number): number => 0.35 + 0.65 * opacity;

describe("nodeOpacityFactor: the idle fade it preserves", () => {
  it("keeps the exact expression the renderer applies today", () => {
    expect(nodeOpacityFactor(0.1, {})).toBe(fade(0.1));
  });

  it.each([0, 0.25, 0.5, 0.75, 1])("agrees with that expression at opacity %s", (opacity) => {
    expect(nodeOpacityFactor(opacity, {})).toBeCloseTo(fade(opacity), 12);
  });

  it("floors a fully idle node at a third of its colour rather than at nothing", () => {
    // A node faded to zero is a node that has left the graph, and the tree is
    // the backdrop: it has to stay readable.
    expect(nodeOpacityFactor(0, {})).toBeCloseTo(0.35, 12);
  });

  it("leaves a freshly touched node at full colour", () => {
    expect(nodeOpacityFactor(1, {})).toBeCloseTo(1, 12);
  });

  it("brightens as a node gets warmer", () => {
    expect(nodeOpacityFactor(0.6, {})).toBeGreaterThan(nodeOpacityFactor(0.2, {}));
  });

  it("reads flags spelled false as no flags at all", () => {
    expect(nodeOpacityFactor(0.1, { matched: false, alarmed: false })).toBe(fade(0.1));
  });
});

describe("nodeOpacityFactor: what is exempt from the fade", () => {
  it("paints an alarmed node at full colour however cold it is", () => {
    expect(nodeOpacityFactor(0.1, { alarmed: true })).toBe(1);
  });

  it("exempts an alarmed node that has gone completely idle", () => {
    // This is the case the exemption exists for: the alarm outlives the event
    // by design, because the file stays modified until a human looks at it.
    expect(nodeOpacityFactor(0, { alarmed: true })).toBe(1);
  });

  it("paints a search match at full colour, as the renderer already does", () => {
    expect(nodeOpacityFactor(0.1, { matched: true })).toBe(1);
  });

  it("paints a node that is both matched and alarmed at full colour", () => {
    expect(nodeOpacityFactor(0, { matched: true, alarmed: true })).toBe(1);
  });
});

describe("nodeOpacityFactor: a degenerate opacity is clamped, never propagated", () => {
  it("treats an opacity above one as one", () => {
    expect(nodeOpacityFactor(4, {})).toBe(1);
  });

  it("treats a negative opacity as zero", () => {
    expect(nodeOpacityFactor(-3, {})).toBeCloseTo(0.35, 12);
  });

  it("treats NaN as a fully idle node instead of poisoning the colour", () => {
    // A NaN reaching `multiplyScalar` blanks the dot outright, and a blank dot
    // in a graph of thousands is not a symptom anybody can trace back here.
    expect(nodeOpacityFactor(Number.NaN, {})).toBeCloseTo(0.35, 12);
  });

  it.each([
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative Infinity", Number.NEGATIVE_INFINITY],
    ["NaN", Number.NaN],
  ])("answers a finite factor inside the legal range for %s", (_label, opacity) => {
    const factor = nodeOpacityFactor(opacity, {});

    expect(Number.isFinite(factor)).toBe(true);
    expect(factor).toBeGreaterThanOrEqual(0.35);
    expect(factor).toBeLessThanOrEqual(1);
  });

  it("still exempts an alarmed node whose opacity is junk", () => {
    expect(nodeOpacityFactor(Number.NaN, { alarmed: true })).toBe(1);
  });
});
