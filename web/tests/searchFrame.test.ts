/**
 * Contract tests (RED) for the camera target a search result asks for.
 *
 * Finding a node is only half the feature: the camera has to go there. One match
 * means approaching it close enough that its name is drawn; several mean pulling
 * back until all of them are on screen at once, which depends on the viewport's
 * ASPECT -- the visible world is `halfHeight * aspect` wide, so a row of matches
 * spread horizontally needs a much wider frame than its height alone suggests.
 * Framing on height only is exactly how a wide match set ends up half off screen.
 *
 * This is arithmetic over a bounding box, so it belongs beside {@link ../src/view}
 * rather than inside renderer.ts, which needs a GL context and cannot be tested.
 * The tests below assert the PROPERTY the renderer depends on -- every match
 * lands inside the visible rectangle, with room to spare -- not the formula that
 * produces it, so the fit can be retuned without rewriting the specification.
 *
 * Two floors guard the degenerate cases the graph really produces: matches
 * sitting almost on top of each other (a directory and its single file) must not
 * zoom the camera into the bloom, and matches flung apart by a force layout that
 * has not settled must not push the camera past MAX_HALF_HEIGHT.
 *
 * Expected to FAIL until src/search.ts exports frameMatches.
 *
 * A later defect, and the reason for the `occludedRight` block at the bottom of
 * this file: the content-search panel docks over the right-hand 40% of the
 * canvas, so the node an F3 step just approached is centred on a viewport whose
 * right half is a wall of text -- the camera moves, the match lands behind the
 * panel, and the step reads as a broken camera. The fix is a third, DEFAULTED
 * parameter, which is why the "unchanged without a third argument" block below
 * comes first: it is the jaw that keeps every two-argument caller (and the whole
 * describe above) honest while the occlusion arithmetic is added.
 */

import { describe, it, expect } from "vitest";
import { frameMatches, SEARCH_FOCUS_HALF_HEIGHT } from "../src/search";
import { MIN_HALF_HEIGHT, MAX_HALF_HEIGHT, type ViewTarget } from "../src/view";
import { FILE_LABEL_ZOOM_THRESHOLD } from "../src/labels";

const ASPECT = 16 / 9;

interface Point {
  x: number;
  y: number;
}

/** Whether every point falls inside the rectangle `target` puts on screen. */
function allVisible(points: readonly Point[], target: ViewTarget, aspect: number): boolean {
  const halfH = target.halfHeight;
  const halfW = target.halfHeight * aspect;
  return points.every(
    (p) => Math.abs(p.x - target.centerX) <= halfW && Math.abs(p.y - target.centerY) <= halfH,
  );
}

/** The largest fraction of the visible half-extent any point reaches. */
function fillFraction(points: readonly Point[], target: ViewTarget, aspect: number): number {
  const halfW = target.halfHeight * aspect;
  return Math.max(
    ...points.map((p) =>
      Math.max(
        Math.abs(p.x - target.centerX) / halfW,
        Math.abs(p.y - target.centerY) / target.halfHeight,
      ),
    ),
  );
}

/** Matches spread mostly vertically: the height is what binds the frame. */
const TALL: Point[] = [
  { x: -8, y: -120 },
  { x: 12, y: 0 },
  { x: 4, y: 140 },
];

/** Matches spread mostly horizontally: only the aspect can fit these. */
const WIDE: Point[] = [
  { x: -400, y: -2 },
  { x: 0, y: 1 },
  { x: 400, y: 2 },
];

describe("frameMatches", () => {
  it("has no camera target when nothing matched", () => {
    expect(frameMatches([], ASPECT)).toBeNull();
  });

  it("centres the camera exactly on a lone match", () => {
    const target = frameMatches([{ x: 37, y: -11 }], ASPECT);

    expect(target?.centerX).toBe(37);
    expect(target?.centerY).toBe(-11);
  });

  it("approaches a lone match at the focus zoom", () => {
    expect(frameMatches([{ x: 37, y: -11 }], ASPECT)?.halfHeight).toBe(SEARCH_FOCUS_HALF_HEIGHT);
  });

  it("focuses close enough for the found file to be named", () => {
    // Past FILE_LABEL_ZOOM_THRESHOLD idle files show no name at all, so a match
    // framed from further out is an unlabelled dot the user cannot identify.
    expect(SEARCH_FOCUS_HALF_HEIGHT).toBeLessThan(FILE_LABEL_ZOOM_THRESHOLD);
  });

  it("stops short of the zoom where the bloom swallows everything", () => {
    expect(SEARCH_FOCUS_HALF_HEIGHT).toBeGreaterThan(MIN_HALF_HEIGHT);
  });

  it("centres the camera on the middle of the matches' bounding box", () => {
    const target = frameMatches(
      [
        { x: -10, y: -4 },
        { x: 30, y: 16 },
      ],
      ASPECT,
    );

    expect(target?.centerX).toBeCloseTo(10);
    expect(target?.centerY).toBeCloseTo(6);
  });

  it("frames every match that is spread out vertically", () => {
    const target = frameMatches(TALL, ASPECT)!;

    expect(allVisible(TALL, target, ASPECT)).toBe(true);
  });

  it("frames every match that is spread out horizontally", () => {
    // The defect this catches: fitting on height alone leaves a wide row of
    // matches running off both sides of the screen.
    const target = frameMatches(WIDE, ASPECT)!;

    expect(allVisible(WIDE, target, ASPECT)).toBe(true);
  });

  it("frames every match on a tall narrow viewport too", () => {
    const narrow = 0.5;
    const target = frameMatches(WIDE, narrow)!;

    expect(allVisible(WIDE, target, narrow)).toBe(true);
  });

  it("leaves margin around the matches instead of touching the edges", () => {
    for (const points of [TALL, WIDE]) {
      const target = frameMatches(points, ASPECT)!;

      expect(fillFraction(points, target, ASPECT)).toBeLessThanOrEqual(0.9);
    }
  });

  it("does not dive into the bloom when the matches sit on top of each other", () => {
    // A directory and its only file land microns apart; fitting their bounding
    // box would put the camera inside them.
    const clustered: Point[] = [
      { x: 100, y: 50 },
      { x: 100.01, y: 50.02 },
    ];

    expect(frameMatches(clustered, ASPECT)!.halfHeight).toBeGreaterThanOrEqual(
      SEARCH_FOCUS_HALF_HEIGHT,
    );
  });

  it("never pulls back further than the camera is allowed to go", () => {
    const scattered: Point[] = [
      { x: -1e9, y: -1e9 },
      { x: 1e9, y: 1e9 },
    ];

    expect(frameMatches(scattered, ASPECT)!.halfHeight).toBeLessThanOrEqual(MAX_HALF_HEIGHT);
  });

  it("returns a usable target on the first layout pass, before the canvas measures", () => {
    // A zero-height canvas makes the aspect 0, Infinity or NaN depending on how
    // it is derived; any of them must not hand the camera a NaN half-height.
    for (const bad of [0, Infinity, NaN]) {
      const target = frameMatches(WIDE, bad)!;

      expect(Number.isFinite(target.halfHeight)).toBe(true);
      expect(target.halfHeight).toBeGreaterThanOrEqual(MIN_HALF_HEIGHT);
      expect(target.halfHeight).toBeLessThanOrEqual(MAX_HALF_HEIGHT);
    }
  });
});

/**
 * The jaw (9.1). Every fixture the two-argument call is specified over, with the
 * exact target it produces TODAY, captured before `occludedRight` existed. These
 * are literals rather than a recomputation of the formula on purpose: a test that
 * derives its expectation the same way the code does cannot notice the code
 * changing. If one of these moves, a caller that never asked about a panel had
 * its camera moved by a panel.
 */
const UNOCCLUDED_BASELINE: ReadonlyArray<{
  readonly name: string;
  readonly points: readonly Point[];
  readonly aspect: number;
  readonly target: ViewTarget;
}> = [
  {
    name: "a lone match",
    points: [{ x: 37, y: -11 }],
    aspect: ASPECT,
    target: { centerX: 37, centerY: -11, halfHeight: 25 },
  },
  {
    name: "a two-match bounding box",
    points: [
      { x: -10, y: -4 },
      { x: 30, y: 16 },
    ],
    aspect: ASPECT,
    target: { centerX: 10, centerY: 6, halfHeight: 25 },
  },
  {
    name: "matches spread vertically",
    points: TALL,
    aspect: ASPECT,
    target: { centerX: 2, centerY: 10, halfHeight: 152.94117647058823 },
  },
  {
    name: "matches spread horizontally",
    points: WIDE,
    aspect: ASPECT,
    target: { centerX: 0, centerY: 0, halfHeight: 264.70588235294116 },
  },
  {
    name: "matches spread horizontally on a narrow viewport",
    points: WIDE,
    aspect: 0.5,
    target: { centerX: 0, centerY: 0, halfHeight: 941.1764705882354 },
  },
  {
    name: "matches sitting on top of each other",
    points: [
      { x: 100, y: 50 },
      { x: 100.01, y: 50.02 },
    ],
    aspect: ASPECT,
    target: { centerX: 100.005, centerY: 50.010000000000005, halfHeight: 25 },
  },
  {
    name: "matches flung apart by an unsettled layout",
    points: [
      { x: -1e9, y: -1e9 },
      { x: 1e9, y: 1e9 },
    ],
    aspect: ASPECT,
    target: { centerX: 0, centerY: 0, halfHeight: 4000 },
  },
  {
    name: "a zero-height canvas on the first layout pass",
    points: WIDE,
    aspect: 0,
    target: { centerX: 0, centerY: 0, halfHeight: 470.5882352941177 },
  },
  {
    name: "an infinite aspect on the first layout pass",
    points: WIDE,
    aspect: Infinity,
    target: { centerX: 0, centerY: 0, halfHeight: 470.5882352941177 },
  },
  {
    name: "a NaN aspect on the first layout pass",
    points: WIDE,
    aspect: NaN,
    target: { centerX: 0, centerY: 0, halfHeight: 470.5882352941177 },
  },
];

describe("frameMatches with no occlusion asked about", () => {
  it.each(UNOCCLUDED_BASELINE)(
    "frames $name exactly as it did before the docked panel existed",
    ({ points, aspect, target }) => {
      expect(frameMatches(points, aspect)).toEqual(target);
    },
  );

  it("still has no camera target when nothing matched", () => {
    expect(frameMatches([], ASPECT, 0.4)).toBeNull();
  });

  it.each(UNOCCLUDED_BASELINE)(
    "treats an explicit zero occlusion for $name as no occlusion at all",
    ({ points, aspect, target }) => {
      expect(frameMatches(points, aspect, 0)).toEqual(target);
    },
  );
});

/** The world-space half-width the camera shows at this target. */
function halfWidthOf(target: ViewTarget, aspect: number): number {
  return target.halfHeight * aspect;
}

/**
 * Whether every point falls inside the band the panel leaves UNCOVERED: the
 * viewport runs from `centerX - halfW` to `centerX + halfW`, but a panel eating
 * the right-hand fraction `f` moves the usable right edge in by `2 * halfW * f`.
 */
function allUnoccluded(
  points: readonly Point[],
  target: ViewTarget,
  aspect: number,
  occludedRight: number,
): boolean {
  const halfW = halfWidthOf(target, aspect);
  const left = target.centerX - halfW;
  const right = target.centerX + halfW * (1 - 2 * occludedRight);
  return points.every(
    (p) =>
      p.x >= left &&
      p.x <= right &&
      Math.abs(p.y - target.centerY) <= target.halfHeight,
  );
}

describe("frameMatches with a panel docked over the right of the viewport", () => {
  const OCCLUDED = 0.4;

  it("shifts a lone match right by the half-width the panel covers", () => {
    // The defect: centred on the whole viewport, the node an F3 step approached
    // sits under the panel. Its centre must move to the middle of what is left.
    const target = frameMatches([{ x: 37, y: -11 }], ASPECT, OCCLUDED)!;

    expect(target.centerX).toBeCloseTo(37 + SEARCH_FOCUS_HALF_HEIGHT * ASPECT * OCCLUDED, 9);
  });

  it("leaves the vertical centring of a lone match alone", () => {
    const target = frameMatches([{ x: 37, y: -11 }], ASPECT, OCCLUDED)!;

    expect(target.centerY).toBe(-11);
  });

  it("still approaches a lone match at the focus zoom", () => {
    // Only the WIDTH is eaten; a single point drives no width, so the zoom the
    // walk arrives at must not change because a panel is open.
    expect(frameMatches([{ x: 37, y: -11 }], ASPECT, OCCLUDED)!.halfHeight).toBe(
      SEARCH_FOCUS_HALF_HEIGHT,
    );
  });

  it("keeps every match clear of the panel, not merely on screen", () => {
    for (const points of [TALL, WIDE]) {
      const target = frameMatches(points, ASPECT, OCCLUDED)!;

      expect(allUnoccluded(points, target, ASPECT, OCCLUDED)).toBe(true);
    }
  });

  it("pulls back by 1 / (1 - f) when the width is what binds the frame", () => {
    const open = frameMatches(WIDE, ASPECT, OCCLUDED)!;
    const closed = frameMatches(WIDE, ASPECT)!;

    expect(open.halfHeight).toBeCloseTo(closed.halfHeight / (1 - OCCLUDED), 9);
  });

  it("does not pull back at all when the height is what binds the frame", () => {
    // TALL is fit on its vertical spread; the panel takes width, and inflating a
    // height-bound frame would zoom out of a match that was already clear of it.
    const open = frameMatches(TALL, ASPECT, OCCLUDED)!;
    const closed = frameMatches(TALL, ASPECT)!;

    expect(open.halfHeight).toBeCloseTo(closed.halfHeight, 9);
  });

  it("still does not dive into the bloom when the matches sit on top of each other", () => {
    const clustered: Point[] = [
      { x: 100, y: 50 },
      { x: 100.01, y: 50.02 },
    ];

    const target = frameMatches(clustered, ASPECT, OCCLUDED)!;

    expect(target.halfHeight).toBeGreaterThanOrEqual(MIN_HALF_HEIGHT);
  });

  it("still never pulls back further than the camera is allowed to go", () => {
    // 1 / (1 - f) applied AFTER the clamp would hand the camera 6666 world units
    // of half-height, which the view then refuses, framing nothing.
    const scattered: Point[] = [
      { x: -1e9, y: -1e9 },
      { x: 1e9, y: 1e9 },
    ];

    expect(frameMatches(scattered, ASPECT, OCCLUDED)!.halfHeight).toBeLessThanOrEqual(
      MAX_HALF_HEIGHT,
    );
  });

  it.each([1, -1, NaN])(
    "ignores a nonsensical occluded fraction of %p and frames as if no panel were open",
    (bad) => {
      // A panel claiming the whole width divides by zero; a negative or NaN one
      // is a measurement of a canvas that has not laid out yet. Neither may reach
      // the camera, and the safe answer is the frame the closed panel gets.
      expect(frameMatches(WIDE, ASPECT, bad)).toEqual(frameMatches(WIDE, ASPECT));
    },
  );

  it.each([0.5, 0.89, 0.9, 0.95, 0.99, 1, -1, NaN, Infinity])(
    "hands the camera a finite, in-range half-height for an occlusion of %p",
    (fraction) => {
      const target = frameMatches(WIDE, ASPECT, fraction)!;

      expect(Number.isFinite(target.centerX)).toBe(true);
      expect(Number.isFinite(target.halfHeight)).toBe(true);
      expect(target.halfHeight).toBeGreaterThanOrEqual(MIN_HALF_HEIGHT);
      expect(target.halfHeight).toBeLessThanOrEqual(MAX_HALF_HEIGHT);
    },
  );
});
