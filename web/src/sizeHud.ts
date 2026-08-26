/**
 * The size legend in the top-right corner: what the ramp's colours are worth in
 * bytes, while F7 is armed.
 *
 * Presentation only. Whether there is a legend at all, which anchors it names
 * and whether a failure has replaced its rows is decided by the pure
 * {@link sizeLegend}; this module only paints what it returns, because the test
 * environment is `node` and a DOM-bound module cannot be unit-tested. Keep it
 * that thin, the way {@link ./statusHud} and {@link ./searchHud} are.
 *
 * Two details are load-bearing:
 *
 *  - **The gradient is built from {@link RAMP_STOPS}, never respelled in CSS.**
 *    The strip exists to say what the colours on the graph mean, so a second
 *    copy of the stop table would eventually mean a legend describing a ramp the
 *    renderer no longer draws.
 *  - **Each row prints its three anchors, not just a bar.** A gradient with no
 *    numbers under it is the very thing the legend was written to fix: the scale
 *    is root-relative and hinged at the median, so the bar alone states nothing.
 */

import { RAMP_STOPS } from "./sizeColor";
import type { SizeLegend, SizeLegendRow } from "./sizeMode";

/** The ramp as one CSS gradient, from the same stops the renderer paints with. */
const RAMP_GRADIENT = `linear-gradient(to right, ${RAMP_STOPS.map(
  (stop) => `#${stop.rgb.toString(16).padStart(6, "0")} ${Math.round(stop.t * 100)}%`,
).join(", ")})`;

/** Said when the daemon cut the walk short: the colours describe part of a tree. */
const TRUNCATED_NOTE = "partial walk — colours describe what was measured";

export interface SizeHud {
  /** Paint the legend, or hide the strip when the mode has nothing to explain. */
  render(legend: SizeLegend | null): void;
}

/** One scale: its name, the ramp, and the three byte values under it. */
function buildRow(row: SizeLegendRow): HTMLElement {
  const el = document.createElement("div");
  el.className = "row";

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = row.label;

  const ramp = document.createElement("div");
  ramp.className = "ramp";
  ramp.style.backgroundImage = RAMP_GRADIENT;

  const stops = document.createElement("div");
  stops.className = "stops";
  for (const [cssClass, text] of [
    ["cold", row.cold],
    ["mid", row.mid],
    ["hot", row.hot],
  ] as const) {
    const stop = document.createElement("span");
    stop.className = cssClass;
    stop.textContent = text;
    stops.append(stop);
  }

  el.append(label, ramp, stops);
  return el;
}

/** A line of prose under the rows: what the walk could not do. */
function buildNote(text: string, cssClass: string): HTMLElement {
  const el = document.createElement("div");
  el.className = cssClass;
  el.textContent = text;
  return el;
}

/** Bind the strip to `#size-legend`, which starts empty and hidden in the markup. */
export function createSizeHud(container: HTMLElement): SizeHud {
  return {
    render(legend: SizeLegend | null): void {
      if (legend === null) {
        // The mode is off: the strip leaves the screen with the colours it
        // explains, carrying none of its numbers into the next paint.
        container.replaceChildren();
        container.hidden = true;
        return;
      }

      const parts: HTMLElement[] = [];
      // Absent over a failed or empty walk, as the type now says.
      if (legend.files !== null) parts.push(buildRow(legend.files));
      if (legend.dirs !== null) parts.push(buildRow(legend.dirs));
      if (legend.truncated) parts.push(buildNote(TRUNCATED_NOTE, "note"));
      if (legend.error !== "") parts.push(buildNote(legend.error, "error"));

      container.replaceChildren(...parts);
      // An armed mode that measured nothing and failed at nothing has nothing to
      // print; an empty bordered box would read as a legend that broke.
      container.hidden = parts.length === 0;
    },
  };
}
