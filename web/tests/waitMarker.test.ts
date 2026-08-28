/**
 * Contract tests (RED) for the marker drawn around an agent that is WAITING.
 *
 * The defect: a blocked agent looks exactly like a thinking one. The
 * `Notification` hook is the fact that tells them apart, and this is the only
 * thing on screen that will carry it -- so what the marker must not do is blur
 * into a signal the page already spends. Two are already rings around something:
 * `searchMarker.ts` draws ONE thick continuous ring in cyan around what the user
 * asked for, `readMarker.ts` draws TWO thin continuous ones in violet around
 * what an agent is reading. The bloom washes hue out of small bright shapes, so
 * a third continuous ring in a sixth colour would be the same signal as those
 * two on a screenshot, at real zoom, and to a colour-blind eye. Hence a BROKEN
 * ring -- arcs with gaps -- in the actor's own colour: a different shape, not a
 * different shade, which is the rule this repository already follows for the
 * read marker.
 *
 * That is why the gaps lead this file. They are the whole identity of the
 * marker, and they are what an implementer would lose by drawing one convenient
 * `arc(0, 2 * PI)` and calling the difference a colour.
 *
 * The gaps are asserted on what is PAINTED, never on what is declared. A
 * `lineCap` of `round` or `square` extends every stroke by half its own width
 * past each end of its arc, so a gap declared narrower than a stroke width is
 * drawn shut: the recorded calls still say three arcs while the screen shows
 * one continuous ring. Reading `Math.abs(end - start)` alone accepts exactly
 * that -- an arc fill of 0.99 satisfies every sweep assertion here and paints
 * the shape this module exists not to be. So the cut below subtracts the cap
 * extension the recording context actually captured and asserts what is left:
 * after stroking, there is still a hole.
 *
 * A broken ring is more exposed than a continuous one to the sampling problem
 * already recorded against the read marker: a stroke rasterised at 64 px and
 * drawn much smaller is sampled sparsely, and a thin stroke and a gap are the
 * same artefact at that point -- a marker that fades into the continuous shapes
 * it exists to be told apart from. Hence the width floor, asserted against
 * `readMarker`'s own outer ring rather than against a number, so that retuning
 * one moves the other.
 *
 * Everything is asserted on the CALLS, never on pixels: the painting is
 * expressed against the slice of `CanvasRenderingContext2D` it uses, so it is
 * verified with no DOM, no canvas and no GL context, exactly as
 * `readMarker.test.ts` does. Radii and widths are pinned only in RELATION to
 * each other and to the box; their values are tuning for a screen nobody here
 * can see.
 *
 * Expected to FAIL until `src/waitMarker.ts` exists AND `readMarker.ts` exports
 * its `OUTER_WIDTH` (today `const OUTER_WIDTH = 0.05;` at src/readMarker.ts:31,
 * module-private). Respelling `0.05` here would pin nothing: the point of the
 * floor is that the two constants move together.
 */

import { describe, it, expect } from "vitest";
import { paintWaitRing, WAIT_ARC_WIDTH, type WaitMarkerContext } from "../src/waitMarker";
import { OUTER_WIDTH, paintReadRings } from "../src/readMarker";
import { cssHex } from "../src/avatar";

/** An actor colour, as `hashColor("actor:" + agent)` would produce one. */
const ACTOR_COLOR = 0x4fa3ff;

interface Call {
  op: string;
  args: readonly unknown[];
}

/** Records every 2D-context call instead of rasterizing anything. */
function recordingContext(): { ctx: WaitMarkerContext; calls: Call[] } {
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
    fill: record("fill"),
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
  } as unknown as WaitMarkerContext;
  return { ctx, calls };
}

/** Paint the wait marker through the recorder and hand back what it did. */
function paint(color = ACTOR_COLOR): Call[] {
  const { ctx, calls } = recordingContext();
  paintWaitRing(ctx, color);
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

/**
 * The side of the box the marker painted into.
 *
 * Read off the `clearRect` rather than imported, so the module is free to
 * choose its own texture size without this file having an opinion about it.
 */
function boxOf(calls: Call[]): number {
  const cleared = calls.find((call) => call.op === "clearRect");
  if (!cleared) throw new Error("the marker cleared nothing");
  return Number(cleared.args[2]);
}

interface Arc {
  cx: number;
  cy: number;
  r: number;
  start: number;
  end: number;
  width: number;
  cap: string;
}

/** Every arc, with the stroke width and cap in force when it was declared. */
function arcsOf(calls: Call[]): Arc[] {
  return calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => call.op === "arc")
    .map(({ call, index }) => {
      const [cx, cy, r, start, end] = call.args as [number, number, number, number, number];
      return {
        cx,
        cy,
        r,
        start,
        end,
        width: Number(propertyAt(calls, "lineWidth", index) ?? 0),
        // `butt` is the 2D context's own default, so a module that declares no
        // cap is read as stopping each stroke exactly where its arc ends.
        cap: String(propertyAt(calls, "lineCap", index) ?? "butt"),
      };
    });
}

/** How much of a full turn an arc covers, whichever way round it was declared. */
function sweepOf(arc: Arc): number {
  return Math.abs(arc.end - arc.start);
}

const TURN = Math.PI * 2;

/** The same angle, expressed inside one turn. */
function wrap(angle: number): number {
  return ((angle % TURN) + TURN) % TURN;
}

/**
 * How far past each end of its arc a stroke is actually painted, in box units.
 *
 * `round` and `square` both extend by half the stroke width at EACH end, and
 * `butt` stops on the endpoint. Read off what the context recorded rather than
 * assumed, so choosing another cap changes what this file demands of the gaps
 * instead of quietly invalidating it.
 */
function capExtensionOf(arc: Arc): number {
  return arc.cap === "round" || arc.cap === "square" ? arc.width / 2 : 0;
}

/** The arcs grouped by the circle they were declared on: a ring is one radius. */
function ringsOf(arcs: readonly Arc[]): Arc[][] {
  const byRadius = new Map<number, Arc[]>();
  for (const arc of arcs) {
    const key = Math.round(arc.r * 1e6);
    const ring = byRadius.get(key) ?? [];
    ring.push(arc);
    byRadius.set(key, ring);
  }
  return [...byRadius.values()];
}

interface Hole {
  /** What is left of the gap once both bordering caps have grown, in radians. */
  radians: number;
  /** The same hole measured along its circle, in the box's own units. */
  width: number;
  /** The wider of the two strokes bordering it, in the same units. */
  stroke: number;
}

/** Every hole a ring still shows once its arcs have been stroked. */
function holesOf(ring: readonly Arc[]): Hole[] {
  const ordered = [...ring].sort((a, b) => wrap(a.start) - wrap(b.start));
  return ordered.map((arc, index) => {
    // A ring of one arc borders its single gap with itself, which is what a
    // ring with one opening in it actually is.
    const next = ordered[(index + 1) % ordered.length];
    const declared = wrap(wrap(next.start) - (wrap(arc.start) + sweepOf(arc)));
    const eaten = capExtensionOf(arc) / arc.r + capExtensionOf(next) / next.r;
    const radians = declared - eaten;
    return {
      radians,
      width: radians * arc.r,
      stroke: Math.max(arc.width, next.width),
    };
  });
}

describe("paintWaitRing: the ring is broken, which is what makes it a different shape", () => {
  it("sweeps strictly less than a full turn in total, so the gaps are real", () => {
    const arcs = arcsOf(paint());
    const swept = arcs.reduce((total, arc) => total + sweepOf(arc), 0);

    expect(swept).toBeGreaterThan(0);
    expect(swept).toBeLessThan(2 * Math.PI);
  });

  it("still shows a hole once the caps have grown every arc it strokes", () => {
    // The declared sweeps are not the painted shape. A `lineCap` of `round`
    // extends each stroke by half its width past BOTH ends of its arc, so a gap
    // declared narrower than one stroke width is painted shut -- three arcs on
    // the calls, one continuous ring on the screen, which is the shape this
    // module exists not to be. Everything below is read off what the recording
    // context captured (the cap, the width, the radius, the sweeps), never off
    // a constant respelled here.
    const rings = ringsOf(arcsOf(paint()));

    expect(rings.length).toBeGreaterThan(0);
    for (const ring of rings) {
      for (const hole of holesOf(ring)) {
        expect(hole.radians).toBeGreaterThan(0);
      }
    }
  });

  it("leaves every hole wider than the strokes bordering it, so it survives sparse sampling", () => {
    // The margin, as a relation rather than a number: a hole narrower than the
    // line drawing it is the same artefact as a thin stroke at the sampling
    // this marker is drawn at -- the failure the module header records against
    // the read marker, and the one a broken ring is more exposed to than a
    // continuous one. Below this the shape stops distinguishing itself from the
    // two continuous rings the page already spends.
    for (const ring of ringsOf(arcsOf(paint()))) {
      for (const hole of holesOf(ring)) {
        expect(hole.width).toBeGreaterThan(hole.stroke);
      }
    }
  });

  it("draws more than one arc, so the ring reads as broken rather than as one opening", () => {
    expect(opsOf(paint()).filter((op) => op === "arc").length).toBeGreaterThanOrEqual(2);
  });

  it("strokes every arc it declares, leaving none of them invisible", () => {
    const ops = opsOf(paint());

    expect(ops.filter((op) => op === "stroke")).toHaveLength(
      ops.filter((op) => op === "arc").length,
    );
  });

  it("closes no single arc into a full circle of its own", () => {
    for (const arc of arcsOf(paint())) {
      expect(sweepOf(arc)).toBeGreaterThan(0);
      expect(sweepOf(arc)).toBeLessThan(2 * Math.PI);
    }
  });

  it("sweeps less than the read marker's rings, which are continuous by contract", () => {
    // The cross-module property, asserted as a relation so either marker can be
    // retuned freely: what may not change is that one is broken and one is not.
    const { ctx, calls } = recordingContext();
    paintReadRings(ctx as never, 0xaa66ff);
    const readSweeps = arcsOf(calls).map(sweepOf);

    for (const arc of arcsOf(paint())) {
      expect(sweepOf(arc)).toBeLessThan(Math.min(...readSweeps));
    }
  });
});

describe("paintWaitRing: the box", () => {
  it("clears the whole box first, so a repaint never stacks on what was there", () => {
    const calls = paint();
    const box = boxOf(calls);

    expect(calls[0].op).toBe("clearRect");
    expect(calls[0].args).toEqual([0, 0, box, box]);
    expect(box).toBeGreaterThan(0);
  });

  it("paints into a square, so the sprite maps 1:1 onto its quad without stretching", () => {
    const cleared = paint().find((call) => call.op === "clearRect");

    expect(cleared?.args[2]).toBe(cleared?.args[3]);
  });

  it("centres every arc in the box, so the marker sits on the figure it is about", () => {
    const calls = paint();
    const centre = boxOf(calls) / 2;

    for (const arc of arcsOf(calls)) {
      expect(arc.cx).toBeCloseTo(centre, 5);
      expect(arc.cy).toBeCloseTo(centre, 5);
    }
  });

  it("keeps every arc inside the box, so nothing is clipped into a gap that was never drawn", () => {
    // The invariant `readMarker.ts:26-28` states: the sprite is mapped 1:1 onto
    // a quad, so `radius + width / 2` has to stay under half the box. It counts
    // twice here -- a clipped stroke would add a false gap to a shape whose
    // whole meaning is where its gaps are.
    const calls = paint();
    const box = boxOf(calls);
    const arcs = arcsOf(calls);

    expect(arcs.length).toBeGreaterThanOrEqual(1);
    for (const arc of arcs) {
      expect(arc.r / box + arc.width / box / 2).toBeLessThan(0.5);
    }
  });

  it("leaves the middle hollow, so the figure it surrounds stays visible", () => {
    expect(opsOf(paint())).not.toContain("fill");
  });

  it("draws arcs big enough to read as a ring, not as a hairline", () => {
    const calls = paint();
    const box = boxOf(calls);

    for (const arc of arcsOf(calls)) {
      expect(arc.r).toBeGreaterThan(box * 0.1);
      expect(arc.width).toBeGreaterThan(0);
    }
  });
});

describe("paintWaitRing: the stroke floor", () => {
  it("declares an arc width no thinner than the read marker's outer ring", () => {
    // Both are fractions of their own box, and the floor exists because a
    // broken ring is more exposed than a continuous one to sparse sampling at
    // small sizes: below it the arcs fade and the shape stops distinguishing.
    // Imported from `readMarker`, never respelled, so retuning one moves both.
    expect(WAIT_ARC_WIDTH).toBeGreaterThanOrEqual(OUTER_WIDTH);
  });

  it("paints its arcs at exactly the width it declares", () => {
    // Otherwise the exported constant is decoration and the floor above pins
    // nothing about what is actually on screen.
    const calls = paint();
    const box = boxOf(calls);

    for (const arc of arcsOf(calls)) {
      expect(arc.width).toBeCloseTo(box * WAIT_ARC_WIDTH, 5);
    }
  });
});

describe("paintWaitRing: the colour is an argument, never a choice", () => {
  it("strokes verbatim in the colour it is handed, so the actor's own colour reaches the ring", () => {
    // Decision 12: the fact is about the agent, not about a file, so the marker
    // carries the agent's identity. With three agents on screen the ring says
    // WHICH one is blocked without anybody reading a caption.
    const styles = paint(ACTOR_COLOR)
      .filter((call) => call.op === "strokeStyle")
      .map((call) => String(call.args[0]));

    expect(styles.length).toBeGreaterThan(0);
    for (const style of styles) {
      expect(style).toBe(cssHex(ACTOR_COLOR));
    }
  });

  it("derives no signal colour of its own from a colour it might recognise", () => {
    // The pin against a sixth semantic hue being sneaked in later: hand it the
    // amber of a modification and the amber is what it must paint.
    const styles = paint(0xffaa00)
      .filter((call) => call.op === "strokeStyle")
      .map((call) => String(call.args[0]));

    expect(styles.length).toBeGreaterThan(0);
    for (const style of styles) {
      expect(style).toBe(cssHex(0xffaa00));
    }
  });

  it("has a colour in force before each of its strokes", () => {
    // A stroke issued before any strokeStyle inherits the context's default
    // black, which through the bloom is simply an invisible arc.
    const calls = paint();
    const strokes = calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.op === "stroke");

    expect(strokes.length).toBeGreaterThan(0);
    for (const { index } of strokes) {
      expect(propertyAt(calls, "strokeStyle", index)).toBe(cssHex(ACTOR_COLOR));
    }
  });

  it("pads a short hex so the colour is never a broken CSS string", () => {
    const styles = paint(0x0000ff)
      .filter((call) => call.op === "strokeStyle")
      .map((call) => String(call.args[0]).toLowerCase());

    expect(styles.some((style) => style === "#0000ff")).toBe(true);
  });
});
