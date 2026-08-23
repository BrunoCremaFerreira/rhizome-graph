/**
 * Contract tests (RED) for the content search's state machine.
 *
 * The defect: the name search (`search.ts`) recomputes from an in-memory node
 * list, so it has no notion of waiting. A content search is a ROUND TRIP -- the
 * browser cannot read the disk, so the page submits a query, waits, receives a
 * frame of `{path, count}` and then walks the occurrences one by one across
 * files. None of those transitions exist anywhere, and every one of them is a
 * decision that would otherwise be taken inside `renderer.ts` or `main.ts`,
 * where a GL context and a live socket make it untestable. So the machine lives
 * in a pure module, the way `view.ts`, `labels.ts` and `search.ts` do, and the
 * renderer is left painting.
 *
 * Four traps this module exists to avoid, each pinned below:
 *
 *  - **A superseded answer must not land.** With no debounce (submit is `Enter`,
 *    by decision 5) two submissions can still overlap, and the second answer is
 *    about a query the first one is not. `applyContentResults` refuses three
 *    ways and returns the SAME REFERENCE when it does -- the idiom `applyView`
 *    established in `fileView.ts`, where `if (next !== state)` is the caller's
 *    whole adoption test.
 *  - **Typing must not erase the answer.** The user reads the results while
 *    typing the next query; clearing on every keystroke would make the counter
 *    flicker to nothing and drop the highlights the user is still looking at.
 *    So `setContentQuery` touches `query` alone, which is exactly what gives
 *    `isDirty` something to mean and what makes submit-on-Enter livable.
 *  - **A step inside one file must not re-request it.** `F3` walks occurrences,
 *    not files: seven of them can live in one document. `requiresLoad` is that
 *    rule as a pure function, so `main.ts` holds a call and not a comparison.
 *  - **The walk wraps and never crashes.** An empty result set is the normal
 *    answer to a typo, and `F3` on it must be a no-op rather than an exception
 *    or a slide into an ambiguous 0.
 *
 * Note the direction of the `DocMarking` import below: the TYPE is declared by
 * `fileDoc.ts` and imported HERE. That is load-bearing. The panel must never
 * import a search state to mark a row -- it would make the modal file view,
 * which has nothing to do with searching, depend on the search machine. The
 * marks travel as an ARGUMENT to `buildDoc`, so this module is the one that
 * knows both halves.
 *
 * Expected to FAIL until src/contentSearch.ts exists.
 *
 * One failure reason per test.
 */

import { describe, it, expect } from "vitest";
import {
  createContentSearch,
  openContentSearch,
  setContentQuery,
  submitContentSearch,
  applyContentResults,
  failContentSearch,
  nextOccurrence,
  closeContentSearch,
  matchedPaths,
  totalMatches,
  activeOccurrence,
  isDirty,
  requiresLoad,
  docMarkingFor,
  searchFrameOf,
  type ContentSearchState,
} from "../src/contentSearch";
import type { SearchResult } from "../src/protocol";
// Declared by the PANEL, consumed by the SEARCH -- never the other way round.
import type { DocMarking } from "../src/fileDoc";

/** A daemon answer, with the fields that degrade defaulted the way it sends them. */
function frame(
  query: string,
  files: readonly { path: string; count: number }[],
  extra: { truncated?: boolean; error?: string } = {},
): SearchResult {
  return {
    query,
    files: files.map((f) => ({ ...f })),
    truncated: extra.truncated ?? false,
    error: extra.error ?? "",
  };
}

/**
 * Nine occurrences over three files: a.ts holds globals 0-2, b.ts 3-4 and
 * c.ts 5-8. Chosen so that no file's count equals its offset and the mapping
 * cannot pass by coincidence.
 */
const FILES = [
  { path: "a.ts", count: 3 },
  { path: "b.ts", count: 2 },
  { path: "c.ts", count: 4 },
];

/** Open, submitted and answered: a finished search, before any walk. */
function answered(query = "todo", files: readonly { path: string; count: number }[] = FILES) {
  const submitted = submitContentSearch(setContentQuery(openContentSearch(createContentSearch()), query));
  return applyContentResults(submitted, frame(query, files));
}

/** The same, walked forward `steps` times. */
function walked(steps: number, query = "todo"): ContentSearchState {
  let state = answered(query);
  for (let i = 0; i < steps; i += 1) state = nextOccurrence(state);
  return state;
}

// ---------------------------------------------------------------- 6.5

describe("openContentSearch", () => {
  it("shows the bar with nothing typed, nothing submitted and nothing in flight", () => {
    const state = openContentSearch(createContentSearch());
    expect(state).toEqual({
      open: true,
      query: "",
      submitted: "",
      pending: false,
      files: [],
      truncated: false,
      error: "",
      occurrence: -1,
    });
  });

  it("discards the previous search, so reopening does not resurrect old highlights", () => {
    // ctrl+shift+F is also the refocus chord, and a user who reaches for it
    // twice is asking a new question, not resuming the last one.
    expect(openContentSearch(walked(2))).toEqual(openContentSearch(createContentSearch()));
  });
});

describe("setContentQuery", () => {
  it("records what is in the field", () => {
    expect(setContentQuery(openContentSearch(createContentSearch()), "todo").query).toBe("todo");
  });

  it("leaves the submitted query alone, since nothing has been asked yet", () => {
    // This is what gives isDirty something to compare.
    expect(setContentQuery(answered("todo"), "todos").submitted).toBe("todo");
  });

  it("keeps the results of the finished search on screen while the next one is typed", () => {
    // Clearing per keystroke would flicker the counter to nothing and drop the
    // highlights the user is still reading.
    expect(setContentQuery(answered("todo"), "todos").files).toEqual(FILES);
  });

  it("keeps the walk where it was, so the counter does not jump while typing", () => {
    expect(setContentQuery(walked(3), "todos").occurrence).toBe(2);
  });

  it("reports the state as dirty once the field and the submission disagree", () => {
    expect(isDirty(setContentQuery(answered("todo"), "todos"))).toBe(true);
  });

  it("reports a freshly answered search as clean, so Enter means walk and not resubmit", () => {
    expect(isDirty(answered("todo"))).toBe(false);
  });

  it("reports typing back to the submitted text as clean again", () => {
    const state = setContentQuery(setContentQuery(answered("todo"), "tod"), "todo");
    expect(isDirty(state)).toBe(false);
  });
});

describe("submitContentSearch", () => {
  it("marks a request in flight", () => {
    expect(submitContentSearch(setContentQuery(openContentSearch(createContentSearch()), "todo")).pending).toBe(true);
  });

  it("copies the field into submitted, which is what a later answer is matched against", () => {
    expect(submitContentSearch(setContentQuery(openContentSearch(createContentSearch()), "todo")).submitted).toBe("todo");
  });

  it("drops the previous answer, so no file is marked with a query it was not matched by", () => {
    // The highlights survive TYPING and end at Enter: past this transition
    // `submitted` names the new query, and painting it over the old query's
    // files would underline text that never matched.
    const resubmitted = submitContentSearch(setContentQuery(walked(4), "todos"));
    expect({ files: resubmitted.files, occurrence: resubmitted.occurrence, truncated: resubmitted.truncated }).toEqual({
      files: [],
      occurrence: -1,
      truncated: false,
    });
  });

  it("clears the previous refusal, because a new attempt is not the old failure", () => {
    const failed = failContentSearch(submitContentSearch(setContentQuery(openContentSearch(createContentSearch()), "todo")), "refused");
    expect(submitContentSearch(failed).error).toBe("");
  });
});

// ---------------------------------------------------------------- 6.6

describe("applyContentResults", () => {
  it("returns the same reference when the bar has been closed, so a late answer cannot reopen it", () => {
    const closed = closeContentSearch(submitContentSearch(setContentQuery(openContentSearch(createContentSearch()), "todo")));
    expect(applyContentResults(closed, frame("todo", FILES))).toBe(closed);
  });

  it("returns the same reference when nothing is pending, so a second copy of an answer changes nothing", () => {
    const done = answered("todo");
    expect(applyContentResults(done, frame("todo", FILES))).toBe(done);
  });

  it("returns the same reference when the answer names a query that has already been superseded", () => {
    // Two submissions in flight: the first answer must not replace the second
    // submission's state. This is the guard that has no debounce behind it.
    const second = submitContentSearch(setContentQuery(answered("todo"), "todos"));
    expect(applyContentResults(second, frame("todo", FILES))).toBe(second);
  });

  it("adopts the files of an answer to the submission actually outstanding", () => {
    expect(answered("todo").files).toEqual(FILES);
  });

  it("clears pending once the answer has landed", () => {
    expect(answered("todo").pending).toBe(false);
  });

  it("adopts the truncation flag, since a cut list is a different claim from a complete one", () => {
    const submitted = submitContentSearch(setContentQuery(openContentSearch(createContentSearch()), "todo"));
    expect(applyContentResults(submitted, frame("todo", FILES, { truncated: true })).truncated).toBe(true);
  });

  it("adopts an error the daemon reports instead of leaving the bar waiting forever", () => {
    const submitted = submitContentSearch(setContentQuery(openContentSearch(createContentSearch()), "todo"));
    const failed = applyContentResults(submitted, frame("todo", [], { error: "query too short" }));
    expect({ error: failed.error, pending: failed.pending }).toEqual({ error: "query too short", pending: false });
  });

  it("starts the new answer before the first occurrence, so the camera frames all of them", () => {
    // A global index carried over from the previous result set would point
    // into a different list of files entirely.
    expect(answered("todo").occurrence).toBe(-1);
  });

  it("adopts an empty answer as a real result, not as a failure", () => {
    const empty = answered("nothinghere", []);
    expect({ files: empty.files, pending: empty.pending, error: empty.error }).toEqual({
      files: [],
      pending: false,
      error: "",
    });
  });
});

describe("failContentSearch", () => {
  it("stops waiting, so the bar does not sit pending on a request that will never answer", () => {
    const submitted = submitContentSearch(setContentQuery(openContentSearch(createContentSearch()), "todo"));
    expect(failContentSearch(submitted, "socket closed").pending).toBe(false);
  });

  it("records why, because a bar that just stops is indistinguishable from one still working", () => {
    const submitted = submitContentSearch(setContentQuery(openContentSearch(createContentSearch()), "todo"));
    expect(failContentSearch(submitted, "socket closed").error).toBe("socket closed");
  });

  it("leaves no results behind, since the submission they would be attributed to failed", () => {
    const resubmitted = submitContentSearch(setContentQuery(walked(4), "todos"));
    const failed = failContentSearch(resubmitted, "socket closed");
    expect({ files: failed.files, occurrence: failed.occurrence }).toEqual({ files: [], occurrence: -1 });
  });
});

// ---------------------------------------------------------------- 6.7

describe("totalMatches", () => {
  it("sums the counts the daemon reported, which is the right-hand side of the counter", () => {
    expect(totalMatches(answered("todo"))).toBe(9);
  });

  it("is zero for a search that matched nothing", () => {
    expect(totalMatches(answered("nothinghere", []))).toBe(0);
  });

  it("is zero before anything has been submitted", () => {
    expect(totalMatches(openContentSearch(createContentSearch()))).toBe(0);
  });
});

describe("matchedPaths", () => {
  it("names the files the daemon matched, in the order it walked them", () => {
    expect(matchedPaths(answered("todo"))).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("is empty before anything has been submitted, so no node is lit", () => {
    expect(matchedPaths(openContentSearch(createContentSearch()))).toEqual([]);
  });
});

describe("activeOccurrence", () => {
  it("is null before the first step, so the answer arrives without seizing the camera", () => {
    expect(activeOccurrence(answered("todo"))).toBe(null);
  });

  it("is null on an empty result set", () => {
    expect(activeOccurrence(nextOccurrence(answered("nothinghere", [])))).toBe(null);
  });

  it("puts the first step on the first occurrence of the first file", () => {
    expect(activeOccurrence(walked(1))).toEqual({ path: "a.ts", indexInFile: 0 });
  });

  it("stays inside the first file for as long as its own count lasts", () => {
    expect(activeOccurrence(walked(3))).toEqual({ path: "a.ts", indexInFile: 2 });
  });

  it("crosses into the next file once the first one is exhausted", () => {
    expect(activeOccurrence(walked(4))).toEqual({ path: "b.ts", indexInFile: 0 });
  });

  it("maps global index 6 through the cumulative counts into the third file", () => {
    // a.ts holds 0-2, b.ts 3-4, c.ts 5-8: index 6 is c.ts's second occurrence.
    expect(activeOccurrence(walked(7))).toEqual({ path: "c.ts", indexInFile: 1 });
  });

  it("reaches the last occurrence of the last file", () => {
    expect(activeOccurrence(walked(9))).toEqual({ path: "c.ts", indexInFile: 3 });
  });
});

describe("nextOccurrence", () => {
  it("wraps to the first occurrence after the last, so the walk never dead-ends", () => {
    expect(activeOccurrence(walked(10))).toEqual({ path: "a.ts", indexInFile: 0 });
  });

  it("counts from zero after the wrap rather than running past the end", () => {
    expect(walked(10).occurrence).toBe(0);
  });

  it("is a no-op on an empty result set", () => {
    // A typo is the normal way to get here. Neither an exception nor a slide
    // to an ambiguous 0 -- the same state, so the caller's own `!==` test
    // reports that nothing happened.
    const empty = answered("nothinghere", []);
    expect(nextOccurrence(empty)).toBe(empty);
  });
});

// ---------------------------------------------------------------- 6.8

describe("requiresLoad", () => {
  it("asks for the file the first step landed in, when nothing is loaded yet", () => {
    expect(requiresLoad(walked(1), "")).toBe("a.ts");
  });

  it("asks for nothing while the walk stays inside the file already on screen", () => {
    // The rule this function exists for: seven occurrences in one document are
    // seven steps and ONE round trip. Re-requesting per step would rebuild the
    // panel, lose the scroll and re-run the highlighter each time.
    expect(requiresLoad(walked(2), "a.ts")).toBe(null);
  });

  it("still asks for nothing on the last occurrence of the loaded file", () => {
    expect(requiresLoad(walked(3), "a.ts")).toBe(null);
  });

  it("asks for the next file the moment the walk crosses into it", () => {
    expect(requiresLoad(walked(4), "a.ts")).toBe("b.ts");
  });

  it("asks for the first file again when the walk wraps back to it", () => {
    expect(requiresLoad(walked(10), "c.ts")).toBe("a.ts");
  });

  it("asks for nothing before the first step, since the walk is not on a file yet", () => {
    expect(requiresLoad(answered("todo"), "")).toBe(null);
  });

  it("asks for nothing on an empty result set", () => {
    expect(requiresLoad(answered("nothinghere", []), "")).toBe(null);
  });
});

// ---------------------------------------------------------------- 6.9

describe("searchFrameOf", () => {
  it("frames every match before the first walk, so the answer is visible as a whole", () => {
    expect(searchFrameOf(answered("todo"))).toBe("all");
  });

  it("frames every match on a bar just opened", () => {
    expect(searchFrameOf(openContentSearch(createContentSearch()))).toBe("all");
  });

  it("approaches the active match once the walk has begun", () => {
    // Exactly the two behaviours renderer.setSearch already implements; the
    // content search adds no third one.
    expect(searchFrameOf(walked(1))).toBe("active");
  });

  it("keeps approaching the active match after the walk wraps", () => {
    expect(searchFrameOf(walked(10))).toBe("active");
  });
});

describe("closeContentSearch", () => {
  it("returns the state a fresh session starts from, so nothing survives the bar", () => {
    expect(closeContentSearch(walked(4))).toEqual(createContentSearch());
  });

  it("closes a bar that is still waiting for an answer", () => {
    const submitted = submitContentSearch(setContentQuery(openContentSearch(createContentSearch()), "todo"));
    expect(closeContentSearch(submitted)).toEqual(createContentSearch());
  });

  it("leaves nothing matched, so the renderer's highlights go out with the bar", () => {
    expect(matchedPaths(closeContentSearch(walked(4)))).toEqual([]);
  });
});

// ---------------------------------------------------------------- 6.11

describe("docMarkingFor", () => {
  it("marks nothing in a file the search did not match", () => {
    // The panel is opened by clicks and git-status rows too; an unrelated file
    // must not be striped with a query that never occurs in it.
    expect(docMarkingFor(walked(1), "elsewhere.ts")).toBe(null);
  });

  it("marks nothing while no query has been submitted", () => {
    expect(docMarkingFor(setContentQuery(openContentSearch(createContentSearch()), "todo"), "a.ts")).toBe(null);
  });

  it("marks the submitted query, not the half-typed one in the field", () => {
    const typing = setContentQuery(walked(1), "todos");
    const marking: DocMarking | null = docMarkingFor(typing, "a.ts");
    expect(marking?.query).toBe("todo");
  });

  it("singles out the active occurrence by its index WITHIN that file", () => {
    // buildDoc counts marks per document, so a global index would underline
    // the wrong one in every file but the first.
    const marking: DocMarking | null = docMarkingFor(walked(7), "c.ts");
    expect(marking).toEqual({ query: "todo", activeMatch: 1 });
  });

  it("marks a matched file with no active occurrence while the walk is in another file", () => {
    // b.ts still has matches worth striping; none of them is the current one.
    expect(docMarkingFor(walked(7), "b.ts")).toEqual({ query: "todo", activeMatch: null });
  });

  it("marks a matched file with no active occurrence before the first step", () => {
    expect(docMarkingFor(answered("todo"), "a.ts")).toEqual({ query: "todo", activeMatch: null });
  });
});
