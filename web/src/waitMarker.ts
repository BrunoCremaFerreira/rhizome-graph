/**
 * The broken ring drawn around an agent that is WAITING.
 *
 * A blocked agent looks exactly like a thinking one: both are one motionless
 * figure. The `Notification` hook is the fact that tells them apart, and this
 * is the only thing on screen that carries it — so what it must not do is blur
 * into a signal the page already spends. Two markers are already rings around
 * something: {@link ./searchMarker} draws ONE thick continuous ring in cyan
 * around what the user asked for, {@link ./readMarker} draws TWO thin
 * continuous ones in violet around what an agent is reading. The bloom washes
 * hue out of small bright shapes, so a third continuous ring in a sixth colour
 * would read as the same signal as those two — on a screenshot, at real zoom,
 * and to a colour-blind eye.
 *
 * Hence a BROKEN ring: arcs with gaps between them, painted in the colour it is
 * HANDED. The colour is an argument and never a choice, so the actor's own
 * `hashColor("actor:" + agent)` reaches the ring unchanged: with three agents on
 * screen the ring says WHICH one is blocked without anybody reading a caption.
 * A different shape, not a different shade — the rule this repository already
 * follows for the read marker.
 *
 * The stroke floor is inherited risk, not caution. `CLAUDE.md` records that the
 * read marker's inner stroke is 2.24 px on a 64 px texture rasterised with
 * `generateMipmaps = false` and `LinearFilter`, so drawn much smaller than 64 px
 * it is sampled sparsely and can fade out. A broken ring is MORE exposed to that
 * than a continuous one, because a gap and a thin stroke are the same artefact
 * at low sampling — a marker that fades into the very shapes it exists to be
 * told apart from. So the arcs are never thinner than the read marker's outer
 * ring, imported from that module rather than respelled, and retuning one moves
 * the floor with it.
 *
 * Like {@link ./readMarker} and {@link ./avatar}, the painting is expressed
 * against {@link WaitMarkerContext} — the slice of `CanvasRenderingContext2D` it
 * actually uses — so the shape is verified with no DOM, no canvas and no GL
 * context. `createWaitMarkerCanvas` is the only part that needs a browser.
 */

import { cssHex } from "./avatar";
import { OUTER_WIDTH } from "./readMarker";

/** The marker is painted into a square of this many pixels, per side. */
export const WAIT_MARKER_SIZE = 64;

/**
 * How many arcs the ring is broken into.
 *
 * Three reads as deliberate at a glance. Two reads as a ring with a bite out of
 * it, and many read as a dotted circle, which at the sizes a figure is drawn is
 * indistinguishable from a continuous one.
 */
const ARC_COUNT = 3;

/**
 * How much of its own segment each arc fills; the rest is the gap.
 *
 * Below about half the arcs stop reading as a ring at all; at 1 there are no
 * gaps and the whole distinction is gone.
 */
const ARC_FILL = 0.62;

/** Radius of the arcs, as a fraction of the box. */
const ARC_RADIUS = 0.42;

/**
 * Stroke width of the arcs, as a fraction of the box.
 *
 * Never below {@link OUTER_WIDTH} — see the sampling note in this module's
 * header. Both are fractions of their own box, so they are comparable directly.
 * `ARC_RADIUS + WAIT_ARC_WIDTH / 2` stays under 0.5, or the outer half of every
 * stroke is clipped by the quad and the clipping adds gaps this shape never
 * drew — in a marker whose entire meaning is where its gaps are.
 */
export const WAIT_ARC_WIDTH = 0.06;

/** The subset of the 2D context this module needs. Keeps the drawing testable. */
export interface WaitMarkerContext {
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(cx: number, cy: number, r: number, start: number, end: number): void;
  stroke(): void;
}

/** Paint the broken ring filling the {@link WAIT_MARKER_SIZE} box, in `color`. */
export function paintWaitRing(ctx: WaitMarkerContext, color: number): void {
  const s = WAIT_MARKER_SIZE;
  // Clear first: the ring is hollow and the figure it surrounds has to stay
  // visible through the middle, so anything left underneath shows through.
  ctx.clearRect(0, 0, s, s);

  // Set before the first stroke: a stroke issued with no style in force
  // inherits the context's default black, which through the bloom is simply an
  // invisible arc.
  ctx.strokeStyle = cssHex(color);
  ctx.lineCap = "round";
  ctx.lineWidth = s * WAIT_ARC_WIDTH;

  const segment = (Math.PI * 2) / ARC_COUNT;
  const sweep = segment * ARC_FILL;
  for (let i = 0; i < ARC_COUNT; i += 1) {
    const start = segment * i;
    ctx.beginPath();
    // No `closePath`: on a partial arc it would draw a chord straight back to
    // the start, filling in the gap that IS the marker.
    ctx.arc(s * 0.5, s * 0.5, s * ARC_RADIUS, start, start + sweep);
    ctx.stroke();
  }
}

/**
 * Build a canvas carrying the broken ring, ready to become a texture.
 *
 * Browser-only. Unlike the read marker's single shared texture, this one is
 * built per COLOUR: the ring carries the actor's own colour, which is the whole
 * point of it, so two waiting agents cannot share one. Callers cache it against
 * the actor and dispose it with the figure.
 */
export function createWaitMarkerCanvas(color: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = WAIT_MARKER_SIZE;
  canvas.height = WAIT_MARKER_SIZE;
  const ctx = canvas.getContext("2d");
  if (ctx) paintWaitRing(ctx as unknown as WaitMarkerContext, color);
  return canvas;
}
