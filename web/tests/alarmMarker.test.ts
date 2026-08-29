/**
 * RED specification for the alarm marker: the shape drawn around a file an
 * agent touched that the user asked to be told about.
 *
 * The defect it is written against is a collision, not a missing feature. The
 * colour channel on a file dot is spoken for four times over -- the size ramp
 * or the extension palette underneath, the write flash lerped over it, the read
 * tint, then the idle fade -- and the LAST thing to paint over an alarmed node
 * is the amber flash of the very write that raised the alarm. An alarm
 * expressed as a colour is therefore invisible for exactly as long as it is
 * interesting. So it is a SHAPE, on the same doctrine that makes a read a ring
 * that pulses rather than another shade of flash.
 *
 * But it may not be a ring. Two markers on this page are already rings around
 * something: the search draws one thick continuous ring around what the user
 * asked for, the read draws two thin concentric ones around what an agent is
 * looking at. The bloom washes hue out of small bright shapes, so a third ring
 * in a sixth colour reads as the same signal as those two, and it inherits the
 * risk `CLAUDE.md` already records against the read marker -- a thin stroke on
 * a 64 px texture with mipmaps off is sampled sparsely when drawn small, and
 * fades. A BRACKET is the answer: two facing corner brackets around the dot,
 * four short straight arms, unmistakably not a circle at four device pixels.
 *
 * HOW THIS IS ASSERTED, and why it is not what the plan asked for. The plan's
 * row 6.4 wanted an assertion over the parsed source of `alarmMarker.ts` --
 * that the geometry "names no world units". There is no TypeScript parser in
 * this suite and no token means "world unit", so that row is not writable as
 * specified. It is replaced by the technique `readMarker.test.ts` already uses:
 * a recording context object that captures every 2D call instead of
 * rasterizing, so the shape is verified with no DOM, no canvas and no GL
 * context. That pins more than the scan would have.
 *
 * Radii, arm lengths and stroke widths are deliberately NOT pinned to their
 * constants. They are tuning, and nobody on this host has seen this marker on a
 * screen; a test that fails when somebody nudges an arm by a pixel is noise.
 * Only the RELATIONS are specified: the box is cleared first, nothing is
 * painted outside the box, the arms grow inward from two opposite corners, both
 * brackets are the same size, and the middle stays clear so the dot the marker
 * points at is still visible.
 */

import { describe, it, expect } from "vitest";
import {
  ALARM_MARKER_SIZE,
  createAlarmMarkerCanvas,
  paintAlarmMarker,
  type AlarmMarkerContext,
} from "../src/alarmMarker";
import { paintReadRings, type ReadMarkerContext } from "../src/readMarker";

/** Any colour would do; this is the one an alarm is likely to be painted in. */
const ALARM_COLOR = 0xff3333;

const CENTRE = ALARM_MARKER_SIZE / 2;
const EPSILON = 1e-6;

interface Call {
  op: string;
  args: readonly unknown[];
}

interface Point {
  x: number;
  y: number;
}

interface Segment {
  a: Point;
  b: Point;
  width: number;
}

/** Records every 2D-context call instead of rasterizing anything. */
function recordingContext(): { ctx: AlarmMarkerContext; calls: Call[] } {
  const calls: Call[] = [];
  const record =
    (op: string) =>
    (...args: unknown[]): void => {
      calls.push({ op, args });
    };
  const ctx = {
    beginPath: record("beginPath"),
    closePath: record("closePath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    arc: record("arc"),
    rect: record("rect"),
    fill: record("fill"),
    fillRect: record("fillRect"),
    stroke: record("stroke"),
    clearRect: record("clearRect"),
    set fillStyle(value: string) {
      calls.push({ op: "fillStyle", args: [value] });
    },
    set strokeStyle(value: string) {
      calls.push({ op: "strokeStyle", args: [value] });
    },
    set lineWidth(value: number) {
      calls.push({ op: "lineWidth", args: [value] });
    },
    set lineCap(value: string) {
      calls.push({ op: "lineCap", args: [value] });
    },
  } as unknown as AlarmMarkerContext;
  return { ctx, calls };
}

function record(color: number = ALARM_COLOR): Call[] {
  const { ctx, calls } = recordingContext();
  paintAlarmMarker(ctx, color);
  return calls;
}

function opsOf(calls: Call[]): string[] {
  return calls.map((call) => call.op);
}

/** The value of a settable property in force when `index` was recorded. */
function propertyAt(calls: Call[], op: string, index: number): unknown {
  let value: unknown;
  for (let i = 0; i < index; i += 1) {
    if (calls[i].op === op) value = calls[i].args[0];
  }
  return value;
}

const keyOf = (p: Point): string => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;

/**
 * Every straight stroke the painter issued, with the width in force when it was
 * stroked. Works whether the arms are four separate strokes, two L-shaped
 * paths, or one path of four subpaths; a subpath stroked twice counts once.
 */
function segmentsOf(calls: Call[]): Segment[] {
  const segments: Segment[] = [];
  const seen = new Set<string>();
  let width = 0;
  let subpaths: Point[][] = [];

  const emit = (): void => {
    for (const points of subpaths) {
      for (let i = 1; i < points.length; i += 1) {
        const segment = { a: points[i - 1], b: points[i], width };
        const key = `${keyOf(segment.a)}|${keyOf(segment.b)}|${width.toFixed(4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        segments.push(segment);
      }
    }
  };

  for (const call of calls) {
    const [x, y] = call.args as [number, number];
    if (call.op === "lineWidth") width = Number(call.args[0]);
    else if (call.op === "beginPath") subpaths = [];
    else if (call.op === "moveTo") subpaths.push([{ x: Number(x), y: Number(y) }]);
    else if (call.op === "lineTo") {
      if (subpaths.length === 0) subpaths.push([]);
      subpaths[subpaths.length - 1].push({ x: Number(x), y: Number(y) });
    } else if (call.op === "stroke") emit();
  }
  return segments;
}

/** The points two or more segments meet at: the corners of the brackets. */
function cornersOf(segments: Segment[]): Point[] {
  const seen = new Map<string, { point: Point; count: number }>();
  for (const segment of segments) {
    for (const point of [segment.a, segment.b]) {
      const key = keyOf(point);
      const entry = seen.get(key) ?? { point, count: 0 };
      entry.count += 1;
      seen.set(key, entry);
    }
  }
  return [...seen.values()].filter((entry) => entry.count >= 2).map((entry) => entry.point);
}

function lengthOf(segment: Segment): number {
  return Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
}

/** Which corner a segment belongs to, and which end of it reaches inward. */
function armsOf(segments: Segment[], corner: Point): Segment[] {
  return segments.filter(
    (segment) => keyOf(segment.a) === keyOf(corner) || keyOf(segment.b) === keyOf(corner),
  );
}

function farEnd(segment: Segment, corner: Point): Point {
  return keyOf(segment.a) === keyOf(corner) ? segment.b : segment.a;
}

/** Distance from a point to a segment, for "is the middle still clear?". */
function distanceToSegment(point: Point, segment: Segment): number {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - segment.a.x, point.y - segment.a.y);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (segment.a.x + t * dx), point.y - (segment.a.y + t * dy));
}

describe("paintAlarmMarker: it is a bracket, not a third ring", () => {
  it("draws no arc at all, so the bloom cannot merge it with the read or search rings", () => {
    // Decision 8, and the plan's own section 4: a third ring inherits the read
    // marker's sparse-sampling risk AND adds a discrimination problem to it.
    // The marker has to be a shape that is not a circle at four device pixels.
    expect(opsOf(record())).not.toContain("arc");
  });

  it("draws a different number of arcs from the read marker, which is the point of the shape", () => {
    const { ctx, calls } = recordingContext();
    paintReadRings(ctx as unknown as ReadMarkerContext, 0xaa66ff);
    const readArcs = opsOf(calls).filter((op) => op === "arc").length;

    expect(opsOf(record()).filter((op) => op === "arc").length).not.toBe(readArcs);
  });

  it("draws four arms, which is two corner brackets", () => {
    expect(segmentsOf(record())).toHaveLength(4);
  });

  it("draws every arm straight along an axis, the way a corner bracket is drawn", () => {
    for (const segment of segmentsOf(record())) {
      const dx = Math.abs(segment.b.x - segment.a.x);
      const dy = Math.abs(segment.b.y - segment.a.y);
      expect(dx < EPSILON || dy < EPSILON).toBe(true);
      expect(Math.max(dx, dy)).toBeGreaterThan(0);
    }
  });

  it("meets its arms at exactly two corners", () => {
    expect(cornersOf(segmentsOf(record()))).toHaveLength(2);
  });

  it("hangs two arms off each corner", () => {
    const segments = segmentsOf(record());
    for (const corner of cornersOf(segments)) {
      expect(armsOf(segments, corner)).toHaveLength(2);
    }
  });

  it("puts the two corners in opposite quadrants, so the brackets face each other", () => {
    const [first, second] = cornersOf(segmentsOf(record()));

    expect((first.x - CENTRE) * (second.x - CENTRE)).toBeLessThan(0);
    expect((first.y - CENTRE) * (second.y - CENTRE)).toBeLessThan(0);
  });

  it("leaves the middle hollow, so the file dot it points at stays visible", () => {
    expect(opsOf(record())).not.toContain("fill");
    expect(opsOf(record())).not.toContain("fillRect");
  });
});

describe("paintAlarmMarker: where the arms go", () => {
  it("grows each arm inward from its corner, never outward past it", () => {
    // A bracket whose arms run away from the corner is a cross, and a cross
    // through the dot hides the thing it is pointing at.
    const segments = segmentsOf(record());
    for (const corner of cornersOf(segments)) {
      for (const arm of armsOf(segments, corner)) {
        const end = farEnd(arm, corner);
        const movingX = Math.abs(end.x - corner.x) > EPSILON;
        const from = movingX ? corner.x : corner.y;
        const to = movingX ? end.x : end.y;

        expect(Math.abs(to - CENTRE)).toBeLessThan(Math.abs(from - CENTRE));
      }
    }
  });

  it("stops every arm short of the middle, so the two brackets never join up", () => {
    // The gap IS the shape. Arms that cross the centre make a box, and a box
    // around a dot at this size is a filled square.
    const segments = segmentsOf(record());
    for (const corner of cornersOf(segments)) {
      for (const arm of armsOf(segments, corner)) {
        const end = farEnd(arm, corner);
        const movingX = Math.abs(end.x - corner.x) > EPSILON;
        const from = movingX ? corner.x : corner.y;
        const to = movingX ? end.x : end.y;

        expect((to - CENTRE) * (from - CENTRE)).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the centre of the box unpainted, stroke width included", () => {
    for (const segment of segmentsOf(record())) {
      expect(distanceToSegment({ x: CENTRE, y: CENTRE }, segment)).toBeGreaterThan(
        segment.width / 2,
      );
    }
  });

  it("makes both brackets the same size, so neither reads as the important one", () => {
    const segments = segmentsOf(record());
    const [first, second] = cornersOf(segments).map((corner) =>
      armsOf(segments, corner)
        .map(lengthOf)
        .reduce((a, b) => a + b, 0),
    );

    expect(first).toBeCloseTo(second, 5);
  });

  it("draws arms long enough to read as a bracket and short enough to leave a gap", () => {
    for (const segment of segmentsOf(record())) {
      expect(lengthOf(segment)).toBeGreaterThan(0);
      expect(lengthOf(segment)).toBeLessThan(ALARM_MARKER_SIZE / 2);
      expect(segment.width).toBeGreaterThan(0);
      expect(segment.width).toBeLessThan(lengthOf(segment));
    }
  });
});

describe("paintAlarmMarker: the box", () => {
  it("clears the whole box before it paints anything", () => {
    // The marker is hollow in the middle and between the brackets, so anything
    // left underneath shows through exactly where the dot has to be.
    const calls = record();

    expect(calls[0].op).toBe("clearRect");
    expect(calls[0].args).toEqual([0, 0, ALARM_MARKER_SIZE, ALARM_MARKER_SIZE]);
  });

  it("clears before the first stroke, however the painting is ordered", () => {
    const ops = opsOf(record());
    const cleared = ops.indexOf("clearRect");
    const painted = ops.findIndex((op) => op === "stroke" || op === "moveTo" || op === "lineTo");

    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(cleared).toBeLessThan(painted);
  });

  it("keeps every stroke inside the box, clipping nothing away", () => {
    // The sprite is mapped 1:1 onto a quad: an arm drawn to the very edge loses
    // the outer half of its stroke and the bracket reads as broken -- which is
    // the read marker's own stated invariant, radius plus half the width under
    // half the box.
    const segments = segmentsOf(record());
    expect(segments.length).toBeGreaterThanOrEqual(1);
    for (const segment of segments) {
      for (const point of [segment.a, segment.b]) {
        expect(point.x - segment.width / 2).toBeGreaterThanOrEqual(0);
        expect(point.y - segment.width / 2).toBeGreaterThanOrEqual(0);
        expect(point.x + segment.width / 2).toBeLessThanOrEqual(ALARM_MARKER_SIZE);
        expect(point.y + segment.width / 2).toBeLessThanOrEqual(ALARM_MARKER_SIZE);
      }
    }
  });

  it("declares a square box to paint into", () => {
    expect(ALARM_MARKER_SIZE).toBeGreaterThan(0);
    expect(Number.isFinite(ALARM_MARKER_SIZE)).toBe(true);
  });

  it("offers a canvas builder for the one part that needs a browser", () => {
    expect(typeof createAlarmMarkerCanvas).toBe("function");
  });
});

describe("paintAlarmMarker: the colour", () => {
  it("strokes in the colour it is handed, not one of its own", () => {
    const styles = record(0xff3333)
      .filter((call) => call.op === "strokeStyle")
      .map((call) => String(call.args[0]).toLowerCase());

    expect(styles.some((style) => style.includes("ff3333"))).toBe(true);
  });

  it("tints whatever colour it is given", () => {
    const styles = record(0x33ff33)
      .filter((call) => call.op === "strokeStyle")
      .map((call) => String(call.args[0]).toLowerCase());

    expect(styles.some((style) => style.includes("33ff33"))).toBe(true);
  });

  it("has a colour in force before each of its strokes", () => {
    // A stroke issued before any strokeStyle inherits the context's default
    // black, which through the bloom is an invisible marker.
    const calls = record();
    const strokes = calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.op === "stroke");

    expect(strokes.length).toBeGreaterThan(0);
    for (const { index } of strokes) {
      expect(String(propertyAt(calls, "strokeStyle", index) ?? "")).toContain("ff3333");
    }
  });

  it("pads a short hex so the colour is never a broken CSS string", () => {
    const styles = record(0x0000ff)
      .filter((call) => call.op === "strokeStyle")
      .map((call) => String(call.args[0]).toLowerCase());

    expect(styles.some((style) => style.includes("#0000ff"))).toBe(true);
  });
});
