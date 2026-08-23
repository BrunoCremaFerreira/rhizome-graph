/**
 * The state machine behind the content search (ctrl+shift+F).
 *
 * The name search in {@link ./search} recomputes from the in-memory node list on
 * every event, so it has no notion of waiting. This one is a ROUND TRIP: the
 * browser cannot read the disk, so the page submits a query, waits, receives a
 * frame of `{path, count}` and then walks the occurrences one by one, across
 * files. Every one of those transitions is a decision, and a decision taken
 * inside `renderer.ts` or `main.ts` needs a GL context or a live socket and is
 * therefore untestable -- so the machine lives here, pure, the way
 * {@link ./view}, {@link ./labels} and {@link ./search} do, and the renderer is
 * left painting. Every transition returns a NEW state; nothing is mutated.
 *
 * Four traps this module exists to avoid:
 *
 *  - **A superseded answer must not land.** Submission is `Enter`, so there is
 *    no debounce anywhere in this feature -- and two submissions can still
 *    overlap. {@link applyContentResults} refuses three ways and returns the
 *    SAME REFERENCE when it does, the idiom `applyView` established in
 *    {@link ./fileView}, where `if (next !== state)` is the caller's whole
 *    adoption test.
 *  - **Typing must not erase the answer.** {@link setContentQuery} touches
 *    `query` alone: the user reads the results while typing the next question,
 *    and clearing per keystroke would flicker the counter to nothing and drop
 *    the highlights still being read. That is also what gives {@link isDirty}
 *    something to mean, and what makes submit-on-Enter livable.
 *  - **A step inside one file must not re-request it.** `F3` walks occurrences,
 *    not files, and seven of them can live in one document.
 *    {@link requiresLoad} is that rule as a pure function, so `main.ts` holds a
 *    call and not a comparison.
 *  - **The walk wraps and never crashes.** An empty result set is the normal
 *    answer to a typo, so {@link nextOccurrence} is a no-op on it rather than an
 *    exception or a slide into an ambiguous 0.
 *
 * Note the direction of the {@link DocMarking} import: the type is declared by
 * the PANEL and consumed HERE. That is deliberate. The panel is opened by graph
 * clicks and git-status rows that have nothing to do with searching, so it must
 * never import a search state to mark a row; the marks travel as an argument to
 * `buildDoc`, and this module is the one half that knows both.
 */

import type { SearchResult } from "./protocol";
import type { SearchFrame } from "./search";
import type { DocMarking } from "./fileDoc";

/** One matched file and the daemon's count of occurrences in it. */
export interface FileMatchCount {
  /** Path relative to the observed root, as the graph and the click speak it. */
  readonly path: string;
  /** How many occurrences the daemon counted; the walk indexes into this. */
  readonly count: number;
}

export interface ContentSearchState {
  /** True while the bar is showing and taking keystrokes. */
  readonly open: boolean;
  /** What is in the field right now. */
  readonly query: string;
  /** The query the results describe, `""` when none has been answered. */
  readonly submitted: string;
  /** True between `Enter` and the daemon's frame. */
  readonly pending: boolean;
  /** The matched files, in the order the daemon walked them. */
  readonly files: readonly FileMatchCount[];
  /** Whether the daemon cut the walk short. */
  readonly truncated: boolean;
  /** Why there is no answer, or `""`. */
  readonly error: string;
  /** Global 0-based index of the occurrence being walked; `-1` before the first step. */
  readonly occurrence: number;
}

/** The state a session starts from, and the one every reset returns to. */
export function createContentSearch(): ContentSearchState {
  return {
    open: false,
    query: "",
    submitted: "",
    pending: false,
    files: [],
    truncated: false,
    error: "",
    occurrence: -1,
  };
}

/**
 * Show the bar, with nothing typed, nothing submitted and nothing in flight.
 *
 * The previous search is discarded rather than resumed: ctrl+shift+F is also
 * the refocus chord, and a user who reaches for it again is asking a new
 * question -- resurrecting the old highlights would light up nodes for a query
 * that is no longer in the field.
 */
export function openContentSearch(_state: ContentSearchState): ContentSearchState {
  return { ...createContentSearch(), open: true };
}

/**
 * Record what is in the field, and do nothing else.
 *
 * It does NOT search (decision 5: submission is `Enter`, so there is no
 * debounce to get right) and it does NOT clear the results: `submitted`,
 * `files` and the walk all survive, which is what keeps the counter and the
 * highlights on screen while the next query is being typed.
 */
export function setContentQuery(state: ContentSearchState, query: string): ContentSearchState {
  return { ...state, query };
}

/**
 * Ask the daemon for what is in the field.
 *
 * `submitted` is copied from `query` here and nowhere else -- it is the string a
 * later frame is matched against, and the only thing that can tell an answer to
 * this submission from an answer to the one before it.
 *
 * The previous answer goes now, having survived every keystroke up to this
 * point: past this transition `submitted` names the new query, and painting the
 * old query's files under it would mark text that never matched. The previous
 * refusal goes too, because a new attempt is not the old failure.
 */
export function submitContentSearch(state: ContentSearchState): ContentSearchState {
  return {
    ...state,
    submitted: state.query,
    pending: true,
    files: [],
    truncated: false,
    error: "",
    occurrence: -1,
  };
}

/**
 * Adopt the daemon's answer -- or refuse it, returning the SAME reference.
 *
 * Three refusals, and the third is the one with no debounce behind it:
 *
 *  - the bar has been closed, so a late answer must not reopen it;
 *  - nothing is pending, so a second copy of an answer changes nothing;
 *  - the frame names a query that has already been typed over and resubmitted.
 *
 * Returning `state` itself rather than an equal copy is the caller's whole
 * adoption test, exactly as in `applyView`: `if (next !== state)`.
 *
 * On adoption the walk restarts at `-1`. A global index carried over from the
 * previous result set would point into a different list of files entirely, and
 * the camera should frame the new answer whole before approaching any part of
 * it. An `error` the daemon reports is adopted as the answer, not as a refusal:
 * a bar left pending forever is worse than one that says why.
 */
export function applyContentResults(
  state: ContentSearchState,
  frame: SearchResult,
): ContentSearchState {
  if (!state.open) return state;
  if (!state.pending) return state;
  if (frame.query !== state.submitted) return state;

  return {
    ...state,
    pending: false,
    files: frame.files.map((file) => ({ path: file.path, count: file.count })),
    truncated: frame.truncated,
    error: frame.error,
    occurrence: -1,
  };
}

/**
 * Report that the request itself failed, and stop waiting.
 *
 * A bar that merely stops is indistinguishable from one still working, so the
 * reason is kept. The results go with it: they were about a submission that has
 * no answer, and leaving them would light nodes for a search that never ran.
 * As in `failView`, a failure landing after the bar was closed must not paint
 * anything -- so a closed state is returned untouched.
 */
export function failContentSearch(state: ContentSearchState, reason: string): ContentSearchState {
  if (!state.open) return state;
  return {
    ...state,
    pending: false,
    error: reason,
    files: [],
    truncated: false,
    occurrence: -1,
  };
}

/**
 * Step to the next occurrence, wrapping past the last one.
 *
 * A no-op on an empty result set, and a no-op by REFERENCE: a typo is the normal
 * way to get here, and the caller's own `!==` test is how it learns that nothing
 * moved and no file needs loading.
 */
export function nextOccurrence(state: ContentSearchState): ContentSearchState {
  const total = totalMatches(state);
  if (total === 0) return state;
  return { ...state, occurrence: (state.occurrence + 1) % total };
}

/**
 * Dismiss the bar, leaving no trace.
 *
 * Equal to a fresh state, so the highlights go out with it and a request still
 * in flight can no longer land (see {@link applyContentResults}).
 */
export function closeContentSearch(_state: ContentSearchState): ContentSearchState {
  return createContentSearch();
}

/** The matched files, which is what `renderer.setSearch` lights. */
export function matchedPaths(state: ContentSearchState): readonly string[] {
  return state.files.map((file) => file.path);
}

/** The right-hand side of the `7 / 213` counter: the daemon's numbers, summed. */
export function totalMatches(state: ContentSearchState): number {
  let total = 0;
  for (const file of state.files) total += file.count;
  return total;
}

/**
 * Where the walk is resting: the file, and the index of the occurrence WITHIN it.
 *
 * The global index is mapped through the cumulative counts, because the counter
 * counts occurrences across the whole answer while the panel counts them inside
 * one document. `null` before the first step and on an empty result set -- an
 * answer arrives without seizing the camera.
 */
export function activeOccurrence(
  state: ContentSearchState,
): { path: string; indexInFile: number } | null {
  if (state.occurrence < 0) return null;
  let remaining = state.occurrence;
  for (const file of state.files) {
    if (remaining < file.count) return { path: file.path, indexInFile: remaining };
    remaining -= file.count;
  }
  return null;
}

/** Whether the field disagrees with the query the results describe. */
export function isDirty(state: ContentSearchState): boolean {
  return state.query !== state.submitted;
}

/**
 * The file the panel must fetch, or `null` when the one on screen already holds
 * the active occurrence.
 *
 * This is the rule that keeps seven steps inside one document to ONE round trip
 * (decision 2). Re-requesting per step would rebuild the panel, lose the scroll
 * and re-run the highlighter on every `F3`. It is a function rather than a
 * comparison in `main.ts` so that the comparison is pinned by a test.
 */
export function requiresLoad(state: ContentSearchState, loadedPath: string): string | null {
  const active = activeOccurrence(state);
  if (active === null) return null;
  return active.path === loadedPath ? null : active.path;
}

/**
 * What the panel should mark in `path`, or `null` when there is nothing to mark.
 *
 * The query is the SUBMITTED one, never the half-typed field: the results
 * describe the former, and marking the latter would stripe text against a query
 * nothing was matched by. A file the search did not match is `null` outright --
 * the panel is opened by clicks and git-status rows too.
 *
 * `activeMatch` is the index within THIS document, since `buildDoc` counts its
 * marks per document; a global index would single out the wrong occurrence in
 * every file but the first. It is `null` in a matched file the walk is not
 * currently resting in: those matches are still worth striping, none of them is
 * the current one.
 */
export function docMarkingFor(state: ContentSearchState, path: string): DocMarking | null {
  if (state.submitted === "") return null;
  if (!state.files.some((file) => file.path === path)) return null;
  const active = activeOccurrence(state);
  return {
    query: state.submitted,
    activeMatch: active !== null && active.path === path ? active.indexInFile : null,
  };
}

/**
 * How the camera should treat the matches: frame them all, or approach one.
 *
 * Exactly the two behaviours `renderer.setSearch` already implements -- the
 * content search adds no third. `"all"` until the first step, so an answer is
 * visible as a whole before the walk starts moving the camera.
 */
export function searchFrameOf(state: ContentSearchState): SearchFrame {
  return state.occurrence < 0 ? "all" : "active";
}
