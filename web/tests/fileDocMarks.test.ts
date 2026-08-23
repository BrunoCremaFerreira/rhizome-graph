/**
 * Contract tests (RED) for marking the search matches inside the panel's text.
 *
 * The defect (R7 of `docs/features/todo/content-search.md`): the content search
 * can tell the user a file holds nine occurrences and then open it with none of
 * them visible. A row is painted either as one text node or as a run of spans,
 * one per `CodeToken`, and a match crosses those tokens arbitrarily — half a
 * keyword, one whole string, the space between two of them. So highlighting a
 * match means SPLITTING the token run at the match boundaries, and if that
 * split happens in `fileViewHud.ts` it happens in the one module doctrine says
 * is never tested.
 *
 * Splitting by index is exactly the arithmetic `fileDoc`'s own docstring calls
 * "silently, plausibly wrong": untested, the failure is one character of
 * highlight offset on a row holding a tab or an accented letter, which nobody
 * notices and everybody distrusts. Hence the invariant asserted here over and
 * over, on plain rows, on coloured rows, on diff rows, on a tab and on a
 * surrogate pair:
 *
 *     spans.map((span) => span.text).join("") === row.text
 *
 * The splitter may not lose, duplicate or reorder a character. It is
 * `fileDoc`'s existing `code.split("\n").length === rows.length` for the new
 * axis, and it is what catches every off-by-one.
 *
 * Three more decisions are pinned:
 *
 *  - **The marking is an ARGUMENT, not state.** The query and the active
 *    occurrence belong to the search; copied onto `FileViewState` they would
 *    have two owners and a synchronisation bug the first time an answer landed
 *    late. `buildDoc(state)` with one argument must therefore stay byte for
 *    byte what it is today — `spans === null` on every row, `activeRow ===
 *    null` — which is the jaw the rest of this file hangs from. `DocMarking`
 *    is declared in `fileDoc.ts` so the later `contentSearch.ts` imports it
 *    from here and never the reverse: the panel must not depend on the search.
 *  - **A row with `tokens === null` is still split.** Colour is the optional
 *    layer; the match is not. An uncoloured file — a diff over the highlight
 *    budget, an unknown extension — is highlighted all the same.
 *  - **`MAX_MARKS_PER_DOC`.** A one-letter query over a 4 000-line file would
 *    otherwise add tens of thousands of spans to a panel rebuilt on every
 *    paint, sharing a frame budget with a force layout that never settles.
 *    Past the cap only the active occurrence's row is marked; the counter
 *    already says how many there are, and the panel is read, not counted.
 *
 * Expected to FAIL until `fileDoc.ts` grows `DocMarking`, `MarkKind`,
 * `MarkedSpan`, `MAX_MARKS_PER_DOC`, `Row.spans` and `FileDoc.activeRow`.
 */

import { describe, it, expect } from "vitest";
import {
  buildDoc,
  MAX_MARKS_PER_DOC,
  type DocMarking,
  type FileDoc,
  type MarkKind,
  type MarkedSpan,
  type Row,
} from "../src/fileDoc";
import {
  createFileView,
  requestView,
  applyView,
  type FileViewState,
} from "../src/fileView";
import type { FileViewMode } from "../src/protocol";

/** A Python file, so a known grammar is in play unless a test says otherwise. */
const PY = "rhizome_graph/normalize.py";

/** A panel showing the daemon's answer. */
function shown(mode: FileViewMode, content: string, path = PY): FileViewState {
  const pending = requestView(createFileView(), path);
  return applyView(pending, { path, mode, content, truncated: false, error: "" });
}

/** One syntax token, in the shape `highlight.ts` converts shiki's into. */
function tok(text: string, color: string, italic = false, bold = false) {
  return { text, color, italic, bold };
}

/** A state whose tokens have already arrived, as `applyTokens` leaves it. */
function highlighted(
  state: FileViewState,
  chunks: ReturnType<typeof tok>[][][],
): FileViewState {
  return { ...state, highlight: chunks };
}

/** What the search asks the panel to mark. */
function marking(query: string, activeMatch: number | null = null): DocMarking {
  return { query, activeMatch };
}

/** The rows of a document that must have some. */
function rowsOf(doc: FileDoc): readonly Row[] {
  const rows = doc.rows;
  expect(rows, "expected a row-based document, not the plain fast path").not.toBe(null);
  return rows as readonly Row[];
}

/** The spans of one row, failing loudly when the row was not split at all. */
function spansOf(doc: FileDoc, index: number): readonly MarkedSpan[] {
  const spans = rowsOf(doc)[index].spans;
  expect(Array.isArray(spans), `row ${index} must carry spans, got ${String(spans)}`).toBe(
    true,
  );
  return spans as readonly MarkedSpan[];
}

/** The texts of one row's spans, in order — the invariant's left-hand side. */
function textsOf(doc: FileDoc, index: number): string[] {
  return spansOf(doc, index).map((span) => span.text);
}

/** The marks of one row's spans, in order. */
function marksOf(doc: FileDoc, index: number): MarkKind[] {
  return spansOf(doc, index).map((span) => span.mark);
}

/** Every span in the document carrying `kind`, as text, in document order. */
function markedTexts(doc: FileDoc, kind: MarkKind): string[] {
  const found: string[] = [];
  for (const row of rowsOf(doc)) {
    for (const span of row.spans ?? []) if (span.mark === kind) found.push(span.text);
  }
  return found;
}

/** How many rows were split at all. */
function rowsWithSpans(doc: FileDoc): number {
  return rowsOf(doc).filter((row) => row.spans !== null).length;
}

/** Two lines of a Python file. */
const TEXT = "import os\nx = 1\n";

/** A diff with one removal, one addition and one context line. */
const SMALL_DIFF = ["@@ -1,2 +1,2 @@", "-x = 1", "+x = 2", " y = 3", ""].join("\n");

/** Four occurrences of one query, spread one-two-one over three rows. */
const FOUR_MATCHES = "aa here\nbb here here\ncc here\n";

/** The row indices into a document built from {@link FOUR_MATCHES}. */
const FIRST = 0;
const MIDDLE = 1;
const LAST = 2;

/** A document of `count` rows, each holding exactly one `z`. */
function manyMatches(count: number): FileViewState {
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) lines.push(`z${index}`);
  return shown("text", `${lines.join("\n")}\n`);
}

describe("7.1 buildDoc without a marking: today's document, unchanged", () => {
  it("leaves every row of a text file unsplit when no marking is passed", () => {
    const doc = buildDoc(shown("text", TEXT));
    expect(rowsOf(doc).map((row) => row.spans)).toEqual([null, null]);
  });

  it("leaves every row of a diff unsplit when no marking is passed", () => {
    const doc = buildDoc(shown("diff", SMALL_DIFF));
    expect(rowsOf(doc).map((row) => row.spans)).toEqual([null, null, null, null]);
  });

  it("names no active row when no marking is passed", () => {
    expect(buildDoc(shown("text", TEXT)).activeRow).toBe(null);
  });

  it("names no active row for a diff built without a marking", () => {
    expect(buildDoc(shown("diff", SMALL_DIFF)).activeRow).toBe(null);
  });
});

describe("7.2 an uncoloured row is split all the same", () => {
  const PLAIN = "alpha beta alpha\n";

  it("splits a plain row into spans whose text concatenates back to the row", () => {
    const doc = buildDoc(shown("text", PLAIN), marking("beta"));
    expect(textsOf(doc, 0).join("")).toBe(rowsOf(doc)[0].text);
  });

  it("splits a plain row exactly at the match boundaries", () => {
    const doc = buildDoc(shown("text", PLAIN), marking("beta"));
    expect(textsOf(doc, 0)).toEqual(["alpha ", "beta", " alpha"]);
  });

  it("marks the matched fragment of a plain row and nothing around it", () => {
    const doc = buildDoc(shown("text", PLAIN), marking("beta"));
    expect(marksOf(doc, 0)).toEqual(["none", "match", "none"]);
  });

  it("gives an uncoloured row's spans the empty colour, colour being optional", () => {
    const doc = buildDoc(shown("text", PLAIN), marking("beta"));
    expect(spansOf(doc, 0).map((span) => span.color)).toEqual(["", "", ""]);
  });

  it("leaves an uncoloured row's tokens null while splitting it into spans", () => {
    const doc = buildDoc(shown("text", PLAIN), marking("beta"));
    expect(rowsOf(doc)[0].tokens).toBe(null);
  });

  it("keeps a tab one character wide when it splits the row before a match", () => {
    const doc = buildDoc(shown("text", "\tif value:\n"), marking("if"));
    expect(textsOf(doc, 0)).toEqual(["\t", "if", " value:"]);
  });

  it("concatenates a tabbed row's spans back to the row exactly", () => {
    const doc = buildDoc(shown("text", "\tif value:\n"), marking("if"));
    expect(textsOf(doc, 0).join("")).toBe(rowsOf(doc)[0].text);
  });

  it("counts an accented letter as one character when splitting", () => {
    const doc = buildDoc(shown("text", "café résumé\n"), marking("sum"));
    expect(textsOf(doc, 0)).toEqual(["café ré", "sum", "é"]);
  });

  it("concatenates an accented row's spans back to the row exactly", () => {
    const doc = buildDoc(shown("text", "café résumé\n"), marking("sum"));
    expect(textsOf(doc, 0).join("")).toBe(rowsOf(doc)[0].text);
  });

  it("never cuts a surrogate pair in half around a match", () => {
    const doc = buildDoc(shown("text", "\u{1f642}ok\u{1f642}\n"), marking("ok"));
    expect(textsOf(doc, 0)).toEqual(["\u{1f642}", "ok", "\u{1f642}"]);
  });

  it("concatenates a row holding a surrogate pair back to the row exactly", () => {
    const doc = buildDoc(shown("text", "\u{1f642}ok\u{1f642}\n"), marking("ok"));
    expect(textsOf(doc, 0).join("")).toBe(rowsOf(doc)[0].text);
  });
});

describe("7.3 a match crossing a token boundary", () => {
  const RED = "#CE9178";
  const BLUE = "#B5CEA8";

  /** One row, two tokens, and a query straddling the seam between them. */
  function crossing(): FileDoc {
    const state = highlighted(shown("text", "abcdef\n"), [
      [[tok("abc", RED), tok("def", BLUE, true)]],
    ]);
    return buildDoc(state, marking("cd"));
  }

  it("concatenates the split token run back to the row exactly", () => {
    const doc = crossing();
    expect(textsOf(doc, 0).join("")).toBe(rowsOf(doc)[0].text);
  });

  it("cuts both tokens at the match boundary instead of at their own", () => {
    expect(textsOf(crossing(), 0)).toEqual(["ab", "c", "d", "ef"]);
  });

  it("lets every fragment inherit the colour of the token it came from", () => {
    expect(crossing().rows?.[0].spans?.map((span) => span.color)).toEqual([
      RED,
      RED,
      BLUE,
      BLUE,
    ]);
  });

  it("lets every fragment inherit the style of the token it came from", () => {
    expect(crossing().rows?.[0].spans?.map((span) => span.italic)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it("marks exactly the two matched fragments and neither of their neighbours", () => {
    expect(marksOf(crossing(), 0)).toEqual(["none", "match", "match", "none"]);
  });

  it("keeps the row's own tokens as the grammar left them", () => {
    expect(crossing().rows?.[0].tokens).toEqual([tok("abc", RED), tok("def", BLUE, true)]);
  });
});

describe("7.4 the active occurrence, counted in document order", () => {
  it("marks the fourth range in document order active and the rest plain matches", () => {
    const doc = buildDoc(shown("text", FOUR_MATCHES), marking("here", 3));
    expect(marksOf(doc, FIRST)).toEqual(["none", "match"]);
    expect(marksOf(doc, MIDDLE)).toEqual(["none", "match", "none", "match"]);
    expect(marksOf(doc, LAST)).toEqual(["none", "active"]);
  });

  it("reports the row holding the active range as activeRow", () => {
    expect(buildDoc(shown("text", FOUR_MATCHES), marking("here", 3)).activeRow).toBe(LAST);
  });

  it("counts two ranges on one row as two steps of the document order", () => {
    const doc = buildDoc(shown("text", FOUR_MATCHES), marking("here", 2));
    expect(marksOf(doc, MIDDLE)).toEqual(["none", "match", "none", "active"]);
  });

  it("marks every range a plain match when no occurrence is active", () => {
    const doc = buildDoc(shown("text", FOUR_MATCHES), marking("here", null));
    expect(markedTexts(doc, "match")).toEqual(["here", "here", "here", "here"]);
  });

  it("makes no span active when no occurrence is active", () => {
    const doc = buildDoc(shown("text", FOUR_MATCHES), marking("here", null));
    expect(markedTexts(doc, "active")).toEqual([]);
  });

  it("names no active row when no occurrence is active", () => {
    expect(buildDoc(shown("text", FOUR_MATCHES), marking("here", null)).activeRow).toBe(null);
  });

  it("splits every marked row back into its own text, on all three rows", () => {
    const doc = buildDoc(shown("text", FOUR_MATCHES), marking("here", 3));
    for (const index of [FIRST, MIDDLE, LAST]) {
      expect(textsOf(doc, index).join("")).toBe(rowsOf(doc)[index].text);
    }
  });
});

describe("7.5 an active occurrence the file no longer holds", () => {
  it("clamps an out-of-range activeMatch to the last range's row", () => {
    expect(buildDoc(shown("text", FOUR_MATCHES), marking("here", 9)).activeRow).toBe(LAST);
  });

  it("clamps an out-of-range activeMatch onto the last range itself", () => {
    const doc = buildDoc(shown("text", FOUR_MATCHES), marking("here", 9));
    expect(marksOf(doc, LAST)).toEqual(["none", "active"]);
  });

  it("still leaves exactly one span active when the index was clamped", () => {
    const doc = buildDoc(shown("text", FOUR_MATCHES), marking("here", 9));
    expect(markedTexts(doc, "active")).toHaveLength(1);
  });
});

describe("7.6 the marking budget", () => {
  it("caps a document at 2000 marks, the panel being read and not counted", () => {
    expect(MAX_MARKS_PER_DOC).toBe(2000);
  });

  it("still marks every row at exactly the cap", () => {
    const doc = buildDoc(manyMatches(MAX_MARKS_PER_DOC), marking("z", 0));
    expect(rowsWithSpans(doc)).toBe(MAX_MARKS_PER_DOC);
  });

  it("splits only the active occurrence's row once past the cap", () => {
    const doc = buildDoc(manyMatches(MAX_MARKS_PER_DOC + 500), marking("z", 1200));
    expect(rowsWithSpans(doc)).toBe(1);
  });

  it("leaves a row that is not the active one unsplit past the cap", () => {
    const doc = buildDoc(manyMatches(MAX_MARKS_PER_DOC + 500), marking("z", 1200));
    expect(rowsOf(doc)[1199].spans).toBe(null);
  });

  it("marks the active occurrence's row past the cap", () => {
    const doc = buildDoc(manyMatches(MAX_MARKS_PER_DOC + 500), marking("z", 1200));
    expect(marksOf(doc, 1200)).toEqual(["active", "none"]);
  });

  it("still reports the active row past the cap, so the panel can scroll to it", () => {
    const doc = buildDoc(manyMatches(MAX_MARKS_PER_DOC + 500), marking("z", 1200));
    expect(doc.activeRow).toBe(1200);
  });

  it("splits no row at all past the cap when no occurrence is active", () => {
    const doc = buildDoc(manyMatches(MAX_MARKS_PER_DOC + 500), marking("z", null));
    expect(rowsWithSpans(doc)).toBe(0);
  });
});

describe("7.7 marking is orthogonal to the mode", () => {
  it("still parses a diff into its rows when a marking is passed", () => {
    const doc = buildDoc(shown("diff", SMALL_DIFF), marking("x = "));
    expect(rowsOf(doc).map((row) => row.kind)).toEqual(["hunk", "del", "add", "context"]);
  });

  it("marks the match inside a removal", () => {
    const doc = buildDoc(shown("diff", SMALL_DIFF), marking("x = "));
    expect(marksOf(doc, 1)).toEqual(["match", "none"]);
  });

  it("marks the match inside an addition", () => {
    const doc = buildDoc(shown("diff", SMALL_DIFF), marking("x = "));
    expect(marksOf(doc, 2)).toEqual(["match", "none"]);
  });

  it("concatenates a marked diff row back to its marker-stripped text", () => {
    const doc = buildDoc(shown("diff", SMALL_DIFF), marking("x = "));
    expect(textsOf(doc, 1).join("")).toBe("x = 1");
    expect(textsOf(doc, 2).join("")).toBe("x = 2");
  });

  it("counts a diff's ranges in row order, so the addition is the second", () => {
    const doc = buildDoc(shown("diff", SMALL_DIFF), marking("x = ", 1));
    expect(doc.activeRow).toBe(2);
  });
});
