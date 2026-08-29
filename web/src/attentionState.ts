/**
 * What the page holds when an agent has touched something the user asked to be
 * told about.
 *
 * It is a module of its own, beside `search.ts`, `contentSearch.ts` and
 * `sizeMode.ts`, for the reason all three give: a decision taken in `main.ts`
 * carries no test by doctrine, and one taken in `renderer.ts` needs a GL
 * context and cannot be tested at all. It is not on `SimNode` either — that
 * record has four channels and the tick decays three of them, and an alarm has
 * no decay. It lasts until a human dismisses it, because the file stays
 * modified.
 *
 * THE DIVERGENCE FROM `eventLog.ts`, which is the one thing to read before
 * changing anything here. That module folds a repeat into the TOP entry only,
 * because folding into an older entry further down would reorder the list under
 * the reader's eye. This one folds against the MATCHING entry wherever it sits.
 * An alarm list is a SET, not a stream: forty touches of one lockfile are ONE
 * alarm with a count of forty, whether or not something else alarmed in
 * between, because the reader is being asked "what needs looking at", not "what
 * happened last". The ordering is by `firstTs`, so a folded entry stays exactly
 * where its first sighting put it and nothing shuffles under the reader. Do not
 * "fix" this into `eventLog.ts`'s rule — an implementation copied from there
 * passes every other test in `attentionState.test.ts` and fails that one.
 *
 * WHO THE ALARM NAMES. `agent` is identity and `label` is text, as everywhere
 * else, and a fold keeps the LATEST of both: two subagents that both touch one
 * watched path leave one alarm, and "which of them did it" is not a question a
 * single row can answer. The row names the most recent one and the activity
 * list below it still holds the sequence.
 *
 * Every function returns the SAME REFERENCE when nothing changed — the
 * `applyView` idiom — so `if (next !== state)` is the whole of the caller's
 * adoption test, and an ordinary edit (which is nearly every event) costs the
 * page no repaint at all.
 */

import type { AgentEvent, EventType } from "./protocol";

/**
 * How many alarms are kept at once.
 *
 * A rule file matching a whole subtree during a refactor is the ordinary case
 * rather than the hostile one, so the list is bounded; past the cap the OLDEST
 * alarm is dropped, because the newest is the one the reader has not seen yet.
 */
export const MAX_ALARMS = 100;

/** One watched path that has been touched, and everything the row needs. */
export interface Alarm {
  /** Path relative to the observed root, exactly as the event named it. */
  readonly path: string;
  /** When it first fired. The ordering key, so a fold never moves a row. */
  readonly firstTs: number;
  /** When it last fired, for the "last seen" line. */
  readonly lastTs: number;
  /** How many events folded into it. */
  readonly count: number;
  /** The LATEST actor id; `""` when nobody was on camera. Identity. */
  readonly agent: string;
  /** The latest readable agent type. Display text only, never identity. */
  readonly label: string;
  /** Which kinds of event hit it, so a painter can tell a read from a write. */
  readonly types: readonly EventType[];
}

/** The alarms currently open, newest first, and the cap they are held under. */
export interface AttentionState {
  /** Newest first by {@link Alarm.firstTs}. A snapshot; never mutated. */
  readonly alarms: readonly Alarm[];
  /** The resolved cap this state was created with. */
  readonly max: number;
}

/** A degenerate cap (0, negative, NaN, Infinity) falls back to the default. */
function resolveMax(max: number | undefined): number {
  if (max === undefined || !Number.isFinite(max)) return MAX_ALARMS;
  const limit = Math.floor(max);
  return limit >= 1 ? limit : MAX_ALARMS;
}

/**
 * An empty set of alarms.
 *
 * @param max Alarms kept at once; defaults to {@link MAX_ALARMS}.
 */
export function createAttention(max?: number): AttentionState {
  return { alarms: [], max: resolveMax(max) };
}

/** The alarms, newest first. A snapshot the caller may hold across updates. */
export function alarms(state: AttentionState): readonly Alarm[] {
  return state.alarms;
}

/** Whether this exact path has an alarm open right now. */
export function isAlarmed(state: AttentionState, path: string): boolean {
  return state.alarms.some((alarm) => alarm.path === path);
}

/**
 * Fold one event in, if it alarmed at all.
 *
 * Two events are refused and each for its own reason. One that did not match
 * the rules is not this module's business and returns the state untouched. One
 * from the SEED never alarms however the daemon flagged it: the boot snapshot
 * is the whole project tree — twelve thousand paths on a home directory — and
 * nobody touched any of it, so a panel that opened full of backdrop is a panel
 * the reader learns to close. That guard is stated here as well as upstream,
 * which is this repository's own form of depth: two conditions on one path.
 */
export function observe(state: AttentionState, event: AgentEvent): AttentionState {
  if (event === null || typeof event !== "object") return state;
  if (event.attention !== true) return state;
  if (event.origin === "seed") return state;
  if (typeof event.path !== "string") return state;

  const index = state.alarms.findIndex((alarm) => alarm.path === event.path);
  if (index >= 0) {
    const held = state.alarms[index];
    // A NEW object, never a mutation: the caller may still be holding the array
    // it read last frame, and a count that changed underneath it is a panel
    // that disagrees with itself.
    const folded: Alarm = {
      path: held.path,
      firstTs: held.firstTs,
      lastTs: event.ts,
      count: held.count + 1,
      agent: event.agent,
      label: event.label,
      types: held.types.includes(event.type) ? held.types : [...held.types, event.type],
    };
    const next = state.alarms.slice();
    // Replaced in place: `firstTs` did not move, so neither does the row.
    next[index] = folded;
    return { alarms: next, max: state.max };
  }

  const opened: Alarm = {
    path: event.path,
    firstTs: event.ts,
    lastTs: event.ts,
    count: 1,
    agent: event.agent,
    label: event.label,
    types: [event.type],
  };
  // Sorted rather than unshifted: the daemon's clock is what `firstTs` means,
  // and an event that arrives late must not claim the top of a set. The sort is
  // stable, so the new alarm still wins a tie against one already held.
  const next = [opened, ...state.alarms].sort((a, b) => b.firstTs - a.firstTs);
  if (next.length > state.max) next.length = state.max;
  return { alarms: next, max: state.max };
}

/**
 * Dismiss one alarm, because a human has looked at it.
 *
 * It does NOT suppress the path. A later event on it opens a FRESH alarm
 * counting one: an agent going back to a file after somebody said they had seen
 * it is the exact case worth watching, and an alarm that keeps re-arming must
 * not look like one that was handled.
 */
export function acknowledge(state: AttentionState, path: string): AttentionState {
  const next = state.alarms.filter((alarm) => alarm.path !== path);
  if (next.length === state.alarms.length) return state;
  return { alarms: next, max: state.max };
}

/** Dismiss everything at once, because the reader has been through the list. */
export function acknowledgeAll(state: AttentionState): AttentionState {
  if (state.alarms.length === 0) return state;
  return { alarms: [], max: state.max };
}

/**
 * Empty the list because the observed root changed.
 *
 * Separate from {@link acknowledgeAll} although the answer is the same shape:
 * one is a human saying "seen", the other is the page discovering that every
 * path it holds belongs to a project nobody is watching any more. The same
 * sentence `closeSizeMode` and `eventHud.clear()` are in the reset handler for.
 */
export function resetAttention(state: AttentionState): AttentionState {
  if (state.alarms.length === 0) return state;
  return { alarms: [], max: state.max };
}
