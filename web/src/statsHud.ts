/**
 * The session-stats panel in the top-right column: what each agent did.
 *
 * Presentation only, exactly as `statusHud.ts` and `attentionHud.ts` are. Every
 * decision — whether the panel belongs on screen, the order of the rows, which
 * of them survive the cut, which colour a swatch wears — belongs to the pure
 * {@link buildStatsPanel}; this module only paints what it returns, because the
 * test environment is `node` and a DOM-bound module cannot be unit-tested. If
 * you find yourself choosing an order or a rule here, you are in the wrong file.
 *
 * Two details are load-bearing, and both are `attentionHud.ts`'s own:
 *
 *  - **A full repaint, with `scrollTop` restored.** The rows are rebuilt
 *    wholesale, which resets the scroll to the top; without restoring it the
 *    list jumps under the reader every time the daemon republishes the slot.
 *  - **Nothing here is clickable,** so the box keeps `pointer-events: none` and
 *    only the list takes hit-testing back, for the wheel.
 *
 * The two timestamps are printed as a SPAN and labelled as one, never as "time
 * active": an agent that worked ten seconds and idled an hour was not active
 * for an hour, and the honest answer needs a gap threshold that nothing here
 * has measured.
 */

import { buildStatsPanel, type StatsRow } from "./statsPanel";
import { cssHex } from "./avatar";
import type { SessionStatsFrame } from "./protocol";

/** Said when a row hit the daemon's per-agent cap: its numbers are floors. */
const TRUNCATED_NOTE = "some counts are floors — an agent hit the daemon's path cap";

/** The name of a row that nobody is behind. */
const UNATTRIBUTED = "unattributed";

export interface StatsHud {
  /** Paint the table, or hide the panel when it is closed or has nothing to say. */
  render(frame: SessionStatsFrame | null, open: boolean): void;
}

/** `1h 04m`, `3m 20s`, `12s` — enough to read at a glance, never more. */
function spanText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** One `<span>` of dimmed caption text. */
function span(cssClass: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = cssClass;
  el.textContent = text;
  return el;
}

/** Build the `<li>` for a row: the agent, its counts, and the file it kept opening. */
function buildRow(row: StatsRow): HTMLLIElement {
  const item = document.createElement("li");

  const head = document.createElement("div");
  head.className = "who";
  // No swatch at all for the unattributed row: an empty agent is nobody on
  // camera, and a coloured dot beside it would invent an author for it.
  if (row.swatch !== null) {
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = cssHex(row.swatch);
    head.append(swatch);
  }
  head.append(span("name", row.label || row.agent || UNATTRIBUTED));
  // Reads and writes stay two numbers: an agent that read 340 files and wrote
  // 12 is the single most informative line this panel can produce.
  head.append(span("counts", `${row.writes} written · ${row.reads} read`));
  if (row.truncated) head.append(span("floor", "+"));

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.append(span("scope", `${row.files} files · ${row.dirs} dirs`));
  meta.append(span("span", `span ${spanText(row.lastTs - row.firstTs)}`));

  item.append(head, meta);

  // Nothing at all rather than a file named with a count of 1: the daemon
  // answers `""` when this agent returned to nothing, and filling it in would
  // report a habit that does not exist.
  if (row.topPath !== "") {
    const top = document.createElement("div");
    top.className = "top";
    top.append(span("dir", row.topDir), span("file", row.topName));
    top.append(span("count", `×${row.topCount}`));
    item.append(top);
  }

  item.title = row.agent === "" ? UNATTRIBUTED : row.agent;
  return item;
}

/** `N agents`, plus what the cap left out. */
function countText(total: number, hidden: number): string {
  const base = total === 1 ? "1 agent" : `${total} agents`;
  return hidden > 0 ? `${base} · +${hidden} hidden` : base;
}

/**
 * Bind the panel to its container.
 *
 * @param rootEl The `<div id="session-stats">` wrapper; its `hidden` attribute
 *   is what keeps the panel off screen while it is closed or empty.
 * @param max Row cap, forwarded to the underlying model.
 */
export function createStatsHud(rootEl: HTMLElement, max?: number): StatsHud {
  const listEl = rootEl.querySelector("#session-stats-list");
  const countEl = rootEl.querySelector("#session-stats-count");
  const noteEl = rootEl.querySelector("#session-stats-note");

  return {
    render(frame: SessionStatsFrame | null, open: boolean): void {
      const model = buildStatsPanel(frame, open, max);
      rootEl.hidden = !model.visible;
      if (countEl) countEl.textContent = model.visible ? countText(model.total, model.hidden) : "";
      if (noteEl) noteEl.textContent = model.truncated ? TRUNCATED_NOTE : "";
      if (!listEl) return;

      const scroll = listEl.scrollTop;
      listEl.replaceChildren(...model.rows.map(buildRow));
      listEl.scrollTop = scroll;
    },
  };
}
