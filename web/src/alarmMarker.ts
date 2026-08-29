/**
 * The bracket drawn around a file an agent touched that the user asked to be
 * told about.
 *
 * WHY A SHAPE AND NOT A COLOUR. A file dot's colour is spoken for four times
 * over — the size ramp or the extension palette underneath, the write flash
 * lerped over it, the read tint, then the idle fade — and the last thing to
 * paint over an alarmed node is the amber flash of the very write that raised
 * the alarm. An alarm expressed as a colour would therefore be invisible for
 * exactly as long as it is interesting. Same doctrine that makes a read a ring
 * that pulses rather than another shade of flash: a different SHAPE, not a
 * different shade, so the two never blur together through the bloom.
 *
 * WHY NOT A RING. Two markers on this page are already rings around something:
 * {@link ./searchMarker} draws one thick continuous ring around what the user
 * asked for, {@link ./readMarker} two thin concentric ones around what an agent
 * is looking at. A third ring would read as the same signal as those two, and
 * it would inherit the risk recorded against the read marker — a thin stroke on
 * a texture rasterised with mipmaps off is sampled sparsely when drawn small,
 * and fades out. So this is a BRACKET: two facing corner brackets, four short
 * straight arms, unmistakably not a circle at four device pixels. The gap in
 * the middle is part of the shape rather than a saving: arms meeting across the
 * centre make a box, and a box around a dot at this size is a filled square.
 *
 * Like {@link ./readMarker} and {@link ./avatar}, the painting is expressed
 * against {@link AlarmMarkerContext} — the slice of `CanvasRenderingContext2D`
 * it actually uses — so the shape can be exercised without a DOM, a canvas or a
 * GL context. `createAlarmMarkerCanvas` is the only part that needs a browser.
 *
 * The tests pin RELATIONS between the geometry below, never its values: that
 * the arms grow inward from two opposite corners, that both brackets are the
 * same size, that the middle stays clear and that nothing is clipped by the
 * edge of the box. Nobody has seen this marker on a screen yet, so retuning any
 * of the three fractions has to stay free.
 */

import { cssHex } from "./avatar";

/** The marker is painted into a square of this many pixels, per side. */
export const ALARM_MARKER_SIZE = 64;

/**
 * The bracket, as fractions of the box.
 *
 * `CORNER_INSET` is how far each corner sits from its edge, `ARM_LENGTH` how
 * far each arm reaches inward from it, and `STROKE_WIDTH` how thick the arms
 * are. Three constraints hold them together, and all three are asserted rather
 * than assumed: `CORNER_INSET` above `STROKE_WIDTH / 2` keeps the stroke inside
 * the box; `ARM_LENGTH` below `0.5 - CORNER_INSET` leaves the middle hollow;
 * and `STROKE_WIDTH` below `ARM_LENGTH` keeps an arm reading as a line rather
 * than as a blob. The stroke is no thinner than the read marker's outer ring,
 * for the reason that ring's own comment gives: below that, sparse sampling at
 * small sizes eats the shape.
 */
const CORNER_INSET = 0.12;
const ARM_LENGTH = 0.22;
const STROKE_WIDTH = 0.06;

/** The subset of the 2D context this module needs. Keeps the drawing testable. */
export interface AlarmMarkerContext {
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

/**
 * Paint the two brackets filling the {@link ALARM_MARKER_SIZE} box, tinted
 * `color`.
 *
 * One bracket is drawn per call to {@link strokeBracket}, as a single path of
 * two arms meeting at the corner, so the join between them is a join and not
 * two independent strokes overlapping.
 */
export function paintAlarmMarker(ctx: AlarmMarkerContext, color: number): void {
  const s = ALARM_MARKER_SIZE;
  // Clear FIRST, before anything else touches the context: the marker is hollow
  // in the middle and open between the brackets, so whatever was left
  // underneath shows through exactly where the file dot has to stay visible.
  ctx.clearRect(0, 0, s, s);

  ctx.strokeStyle = cssHex(color);
  ctx.lineWidth = s * STROKE_WIDTH;
  ctx.lineCap = "round";

  const near = s * CORNER_INSET;
  const far = s * (1 - CORNER_INSET);
  const reach = s * ARM_LENGTH;

  // Top-left and bottom-right: diagonally opposite, so the two brackets face
  // each other across the dot instead of leaning the same way.
  strokeBracket(ctx, near, near, reach, reach);
  strokeBracket(ctx, far, far, -reach, -reach);
}

/** One corner bracket: an arm along x, the corner, an arm along y. */
function strokeBracket(
  ctx: AlarmMarkerContext,
  cornerX: number,
  cornerY: number,
  reachX: number,
  reachY: number,
): void {
  ctx.beginPath();
  ctx.moveTo(cornerX + reachX, cornerY);
  ctx.lineTo(cornerX, cornerY);
  ctx.lineTo(cornerX, cornerY + reachY);
  ctx.stroke();
}

/**
 * Build a canvas carrying the brackets, ready to become a texture.
 *
 * Browser-only, and called ONCE: every marker in the renderer's pool shares the
 * single texture built from it, because they all show the same shape in the
 * same colour and only their position and scale differ.
 */
export function createAlarmMarkerCanvas(color: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = ALARM_MARKER_SIZE;
  canvas.height = ALARM_MARKER_SIZE;
  const ctx = canvas.getContext("2d");
  if (ctx) paintAlarmMarker(ctx as unknown as AlarmMarkerContext, color);
  return canvas;
}
