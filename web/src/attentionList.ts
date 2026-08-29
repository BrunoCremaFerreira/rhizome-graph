/**
 * The model behind the alarm panel: which watched paths were touched, and what
 * the header says about the rules that decided so.
 *
 * Pure — no DOM, no three.js — for the same reason as `statusList.ts` and
 * `eventLog.ts`: `attentionHud.ts` must stay a dumb painter, and the test
 * environment is `node`. Two decisions carry the weight, and the second is the
 * sharper one.
 *
 * **`visible` derives from whether there is something to SAY, never from a
 * flag somebody set.** That is `statusList.ts`'s rule read properly, and the
 * failure it was written to avoid still holds: over a quiet session with rules
 * cleanly in force this panel has nothing to say, and an empty box in the
 * corner is worse than no box, because it occupies the place the reader looks.
 * But a refused pattern IS something to say, and so is a rule file cut short —
 * both mean a rule the user wrote is not in force, and the header is the only
 * place either is ever said. Keyed on the row count alone, that header reached
 * the screen only once something UNRELATED alarmed, so a user whose one rule
 * was dropped saw exactly what a clean session shows. Hence: at least one row,
 * OR a non-zero refusal count, OR a truncated rule file. Nothing else — a rule
 * file that loaded cleanly, an absent one, and a daemon that has not reported
 * yet all leave the panel off screen, and being on screen is never a claim that
 * something alarmed: the rows, the total and the hidden count stay honest.
 *
 * **"No rule file was found" and "a rule file was found and held nothing" are
 * TWO SENTENCES.** The matcher refuses a pattern it cannot translate correctly,
 * and where that refusal shows more files in the module it was borrowed from,
 * here it shows fewer: the user wrote a rule, it was dropped, and the panel then
 * reports the silence that means "nothing has happened". A supervision feature
 * whose failure mode is indistinguishable from success is not a supervision
 * feature. So the header states, always and not only on failure, which file the
 * rules came from and how many are in force, and quotes every refused pattern
 * verbatim when there are any — verbatim, so the user can find it in their own
 * file. It says nothing about refusals when there were none: a permanent
 * "0 refused" is one more thing to read in a corner that has to stay small, and
 * it trains the reader to skip the line that matters.
 *
 * `null` rules mean the daemon has not reported yet, and the header is then
 * EMPTY. Claiming "no rule file was found" in that window would be a statement
 * about a disk nobody has read.
 */

import { actorColor } from "./colors";
import { splitPath } from "./eventLog";
import type { Alarm } from "./attentionState";
import type { AttentionRulesFrame } from "./protocol";

/** Deep enough to scroll through, short enough to stay a corner panel. */
export const DEFAULT_MAX_ROWS = 50;

/** One line of the panel: a path, plus everything needed to paint it. */
export interface AttentionRow {
  /** Path relative to the observed root, exactly as received. */
  path: string;
  /** The directory half, ending in its slash; `""` at the top level. */
  dir: string;
  /** The file name half. Never contains a slash. */
  name: string;
  /** How many events folded into this alarm. */
  count: number;
  /** When it first fired, and when it last did. */
  firstTs: number;
  lastTs: number;
  /** The latest actor id; `""` when nobody was on camera. */
  agent: string;
  /** The latest readable agent type. Display text only. */
  label: string;
  /** Which kinds of event hit it: a read is not a write. */
  types: readonly string[];
  /**
   * The colour of the figure that did it, or `null` when nobody did.
   *
   * `actorColor`, the same function the renderer's avatar uses, so the swatch in
   * the corner and the figure in the graph cannot disagree about who this was.
   * An empty agent gets NO swatch: a watcher change with no attribution is a
   * real alarm, and a coloured dot beside it would invent an author for it.
   */
  swatch: number | null;
}

export interface AttentionListModel {
  /** Whether the list belongs on screen at all. */
  visible: boolean;
  /** What the header says about the rules; `""` before any have been reported. */
  header: string;
  /** The rows to paint, ordered and capped. */
  rows: AttentionRow[];
  /** How many alarms are open, cut or not. */
  total: number;
  /** How many the cap left out. */
  hidden: number;
}

/** A degenerate cap (0, negative, NaN, Infinity) falls back to the default. */
function resolveMax(max: number | undefined): number {
  if (max === undefined || !Number.isFinite(max)) return DEFAULT_MAX_ROWS;
  const limit = Math.floor(max);
  return limit >= 1 ? limit : DEFAULT_MAX_ROWS;
}

/**
 * What the header says about the rules in force.
 *
 * Three facts, and the third is the loud one: where the rules came from, how
 * many survived, and which patterns did not. Only the concept of each is fixed
 * by the tests, never the wording.
 */
function headerFor(rules: AttentionRulesFrame | null): string {
  if (rules === null) return "";

  // `source: ""` is the case that matters most — a typo in the rule path, or a
  // root switched into a project that has no rule file — and it must not read
  // as a file that was found and happened to be empty.
  const found =
    rules.source === ""
      ? "no rule file"
      : `${rules.source} · ${rules.count === 1 ? "1 rule" : `${rules.count} rules`}`;
  const cut = rules.truncated ? " · file cut short" : "";
  const refused =
    rules.refused.length > 0 ? ` · refused: ${rules.refused.join(", ")}` : "";

  return `${found}${cut}${refused}`;
}

/** Build one row out of one alarm. */
function buildRow(alarm: Alarm): AttentionRow {
  // `splitPath` from `eventLog.ts`, imported and never respelled: two
  // implementations of "where does the name start" would disagree about a
  // trailing slash or a doubled one, and the two panels would then paint the
  // same path two ways.
  const { dir, name } = splitPath(alarm.path);
  return {
    path: alarm.path,
    dir,
    name,
    count: alarm.count,
    firstTs: alarm.firstTs,
    lastTs: alarm.lastTs,
    agent: alarm.agent,
    label: alarm.label,
    types: alarm.types,
    swatch: alarm.agent === "" ? null : actorColor(alarm.agent),
  };
}

/**
 * Decide what the alarm panel shows.
 *
 * @param open The alarms currently open, in any order; not mutated.
 * @param rules The daemon's last rule report, or `null` before one arrived.
 * @param max Row cap; defaults to {@link DEFAULT_MAX_ROWS}.
 */
export function buildAttentionList(
  open: readonly Alarm[],
  rules: AttentionRulesFrame | null,
  max?: number,
): AttentionListModel {
  const header = headerFor(rules);
  const total = open.length;

  // A refused pattern, or a rule file the daemon stopped reading, both mean a
  // rule the user wrote is not watching anything — the one thing this panel
  // exists to make impossible to mistake for silence. So either holds the panel
  // open on its own, with the header carrying the whole of the message. `null`
  // rules say nothing at all yet, and a header that would be empty is not a
  // reason to draw a box.
  const rulesHaveSomethingToSay =
    rules !== null && (rules.refused.length > 0 || rules.truncated);
  if (total === 0) {
    return { visible: rulesHaveSomethingToSay, header, rows: [], total: 0, hidden: 0 };
  }

  // A copy: the caller still holds the array `attentionState.ts` handed it.
  // Sorted BEFORE the cut, so what survives is the newest and not whatever
  // order the alarms happened to arrive in.
  const ordered = open.slice().sort((a, b) => b.firstTs - a.firstTs);
  const rows = ordered.slice(0, resolveMax(max)).map(buildRow);

  return { visible: true, header, rows, total, hidden: total - rows.length };
}
