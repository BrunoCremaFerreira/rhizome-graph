/**
 * The model behind the session-stats panel: what each agent actually did.
 *
 * Pure — no DOM, no three.js — for the same reason as `statusList.ts`,
 * `attentionList.ts` and `eventLog.ts`: `statsHud.ts` must stay a dumb painter,
 * and the test environment is `node`. Nothing here recomputes a number the
 * daemon sent, and it could not: the browser's history is the last 200 events
 * plus the seed, and nothing in the replay says how much was lost. This
 * module's whole job is to ORDER, SPLIT, COLOUR and CAP.
 *
 * Four decisions carry the weight.
 *
 *  - **`visible` derives from the row count AND the toggle**, never from a flag
 *    on the frame — `statusList.ts`'s rule. Closed, and open with nothing to
 *    show, are the same absence: a box in the corner reporting nothing occupies
 *    the place the reader looks.
 *  - **The order is the PANEL's, and the frame's own is not trusted.** The
 *    daemon sorts by writes descending, ties by agent ascending, and
 *    {@link parseStats} preserves exactly that — but the unattributed row sorts
 *    LAST here whatever its counts, because a row nobody is behind is not a
 *    competitor for the top of a table about who did what. Ties break on the
 *    agent id compared as a plain string, NOT `localeCompare`: its answer
 *    depends on the runtime's locale data, so the same session would list
 *    differently on two machines and rows would swap under the reader's eye
 *    every time the poll republished.
 *  - **The unattributed row is SHOWN and carries no swatch.** `CLAUDE.md` says
 *    an event with `agent: ""` must never create an ACTOR — a figure, a beam, a
 *    colour — and it also says an unattributed change is real work. A stats row
 *    is not an actor, so hiding it would make the totals not add up; a coloured
 *    dot beside it would invent an author for it. `swatch` is
 *    {@link actorColor}, imported and never respelled, so the dot in the corner
 *    and the figure in the graph cannot disagree about who an agent is.
 *  - **The cut belongs to the panel, not to the daemon**, so a daemon that ever
 *    raises its own agent cap cannot make the panel taller than the corner it
 *    lives in — and the cut is applied to the SORTED order, so what survives a
 *    crowded session is the top of the table rather than three arbitrary rows.
 *    What it left out is reported, never silently dropped.
 *
 * Reads are kept apart from writes and neither is dropped. `eventLog.ts` drops
 * `R` outright because that list is a list of CHANGES; this panel inverts that
 * deliberately — "it read 340 files and wrote 12" is the single most informative
 * line it can produce, and an agent filtered out for having written nothing is
 * an agent that spent the session reading and vanished from the report of it.
 * Do not "fix" this back into `eventLog`'s rule.
 *
 * Nothing received is mutated: the agents array is the parsed frame, which the
 * caller keeps, and a sort in place would leak this panel's order into anything
 * else reading the same object.
 */

import { actorColor } from "./colors";
import { splitPath } from "./eventLog";
import type { AgentStatsEntry, SessionStatsFrame } from "./protocol";

/** Deep enough for a real session, short enough to stay a corner panel. */
export const DEFAULT_MAX_ROWS = 20;

/** One line of the panel: an agent, its counts, and everything needed to paint them. */
export interface StatsRow {
  /** The actor key. `""` is the unattributed row. */
  agent: string;
  /** The readable agent type; display text only, and legitimately `""`. */
  label: string;
  /** The colour of the figure standing in the graph, or `null` when nobody is. */
  swatch: number | null;
  /** The daemon's counts, carried through and never recomputed here. */
  writes: number;
  reads: number;
  files: number;
  dirs: number;
  /** The path this agent returned to most; `""` when nothing was touched twice. */
  topPath: string;
  /** The directory half of it, ending in its slash; `""` at the top level. */
  topDir: string;
  /** The file-name half. Never contains a slash. */
  topName: string;
  /** How often that path was touched; `0` alongside an empty `topPath`. */
  topCount: number;
  /** When this agent was first and last seen. A SPAN, never "time active". */
  firstTs: number;
  lastTs: number;
  /** Whether this row's counts are floors rather than counts. */
  truncated: boolean;
}

export interface StatsPanelModel {
  /** Whether the panel belongs on screen at all. */
  visible: boolean;
  /** The rows to paint, ordered and cut. */
  rows: StatsRow[];
  /** How many rows the frame carried, cut or not. */
  total: number;
  /** How many the cap left out. */
  hidden: number;
  /**
   * Whether any row on screen is reporting floors.
   *
   * The header is where a reader who is not scanning rows will see it: "files
   * touched: 2000" with the flag missed is a wrong number, not a caveat.
   */
  truncated: boolean;
}

/** A degenerate cap (0, negative, NaN, Infinity) falls back to the default. */
function resolveMax(max: number | undefined): number {
  if (max === undefined || !Number.isFinite(max)) return DEFAULT_MAX_ROWS;
  const limit = Math.floor(max);
  return limit >= 1 ? limit : DEFAULT_MAX_ROWS;
}

/** Build one row from one frame entry. */
function toRow(entry: AgentStatsEntry): StatsRow {
  const { dir, name } = splitPath(entry.topPath);
  return {
    agent: entry.agent,
    label: entry.label,
    // No swatch at all for the unattributed row: the swatch is an actor's
    // identity, and there is no actor.
    swatch: entry.agent === "" ? null : actorColor(entry.agent),
    writes: entry.writes,
    reads: entry.reads,
    files: entry.files,
    dirs: entry.dirs,
    topPath: entry.topPath,
    topDir: dir,
    topName: name,
    topCount: entry.topCount,
    firstTs: entry.firstTs,
    lastTs: entry.lastTs,
    truncated: entry.truncated,
  };
}

/**
 * Decide what the session-stats panel shows for `frame`.
 *
 * @param frame The last stats frame, or `null` before one has arrived — which
 *   is "nothing heard", not "an empty session".
 * @param open Whether the reader has the panel toggled on (F8).
 * @param max Row cap; defaults to {@link DEFAULT_MAX_ROWS}.
 */
export function buildStatsPanel(
  frame: SessionStatsFrame | null,
  open: boolean,
  max?: number,
): StatsPanelModel {
  const entries = frame && Array.isArray(frame.agents) ? frame.agents : [];
  const total = entries.length;
  if (!open || total === 0) {
    return { visible: false, rows: [], total, hidden: total, truncated: false };
  }

  // A copy: the caller still holds the parsed frame's array.
  const sorted = entries.slice().sort((a, b) => {
    // The unattributed row is last whatever it did, so it is compared before
    // anything else is.
    const unattributed = Number(a.agent === "") - Number(b.agent === "");
    if (unattributed !== 0) return unattributed;
    if (a.writes !== b.writes) return b.writes - a.writes;
    if (a.agent < b.agent) return -1;
    if (a.agent > b.agent) return 1;
    return 0;
  });

  const rows = sorted.slice(0, resolveMax(max)).map(toRow);

  return {
    visible: true,
    rows,
    total,
    hidden: total - rows.length,
    // Over the rows on screen: what the cap left out is reported by `hidden`,
    // and a caveat about numbers nobody can see is a caveat nobody can use.
    truncated: rows.some((row) => row.truncated),
  };
}
