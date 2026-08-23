/**
 * Contract tests (RED) for the content search's matching rule.
 *
 * The defect this module exists to prevent is an off-by-N highlight. The
 * content search counts occurrences on the daemon and the panel RECOMPUTES
 * their ranges from the text it is later handed (decision 7), so the two sides
 * only agree if both fold case with a rule that cannot change the length of the
 * text. `String.prototype.toLowerCase` is not such a rule: `"İ"` (the
 * dotted capital I) lowercases to TWO characters in JavaScript -- and to two in
 * Python -- so every offset computed against a Unicode fold of a text
 * containing one is shifted, and the panel would underline the wrong columns of
 * the wrong line. Decision 6 therefore folds `A-Z` and nothing else.
 *
 * The stated price of that choice is pinned here too: `"CAFÉ"` does not
 * match a query of `"café"`, because an ASCII-only fold leaves the
 * accented letters alone. That is a deliberate, documented limitation, not a
 * bug to be fixed by reaching for `toLowerCase`.
 *
 * MATCH_FIXTURES below is the shared fixture table of decision 14. The same
 * (text, query, expected ranges) triples are asserted in
 * `tests/test_content_search.py`, in this order, with no code shared between
 * the two languages. Every character in it is in the Basic Multilingual Plane
 * on purpose: JavaScript offsets are UTF-16 code units and Python's are code
 * points, and outside the BMP the two would disagree about the same match.
 *
 * Expected to FAIL until src/matchRanges.ts exists.
 */

import { describe, expect, it } from "vitest";

import {
  countMatches,
  foldAscii,
  matchRanges,
  type MatchRange,
} from "../src/matchRanges";

/**
 * Shared with tests/test_content_search.py -- keep both in step, same order.
 * Each row: a name, the text, the query, and the expected [start, end) pairs.
 */
export const MATCH_FIXTURES: ReadonlyArray<{
  readonly name: string;
  readonly text: string;
  readonly query: string;
  readonly ranges: ReadonlyArray<readonly [number, number]>;
}> = [
  { name: "a plain word", text: "hello world", query: "world", ranges: [[6, 11]] },
  { name: "overlapping candidates count once", text: "aaa", query: "aa", ranges: [[0, 2]] },
  { name: "two disjoint runs", text: "aaaa", query: "aa", ranges: [[0, 2], [2, 4]] },
  { name: "the tail is not re-scanned", text: "abab", query: "aba", ranges: [[0, 3]] },
  { name: "case folds both ways", text: "Foo foo", query: "FOO", ranges: [[0, 3], [4, 7]] },
  { name: "an empty query matches nothing", text: "anything", query: "", ranges: [] },
  { name: "an empty text matches nothing", text: "", query: "a", ranges: [] },
  { name: "an empty query in an empty text", text: "", query: "", ranges: [] },
  { name: "no occurrence", text: "hello", query: "zz", ranges: [] },
  { name: "a query longer than the text", text: "ab", query: "abc", ranges: [] },
  { name: "the whole text", text: "abc", query: "abc", ranges: [[0, 3]] },
  { name: "across a newline", text: "line one\nline two", query: "line", ranges: [[0, 4], [9, 13]] },
  { name: "ascii folds", text: "CAFE", query: "cafe", ranges: [[0, 4]] },
  { name: "an accented capital does not fold", text: "CAFÉ", query: "café", ranges: [] },
  { name: "an accented letter still matches itself", text: "café", query: "café", ranges: [[0, 4]] },
  { name: "a dotted capital I costs one offset", text: "İstanbul", query: "stanbul", ranges: [[1, 8]] },
  { name: "a dotted capital I shifts nothing after it", text: "İ file", query: "file", ranges: [[2, 6]] },
  { name: "a dotted capital I is not an ascii i", text: "İ", query: "i", ranges: [] },
  { name: "an ascii i is not a dotted capital I", text: "i", query: "İ", ranges: [] },
  { name: "a sharp s is not ss", text: "STRASSE", query: "straße", ranges: [] },
  { name: "a sharp s matches itself", text: "Straße", query: "straße", ranges: [[0, 6]] },
];

/**
 * Shared with tests/test_content_search.py -- keep both in step, same order.
 * Each row: a name, the input, and the expected fold.
 */
export const FOLD_FIXTURES: ReadonlyArray<{
  readonly name: string;
  readonly text: string;
  readonly folded: string;
}> = [
  { name: "plain ascii letters", text: "ABC", folded: "abc" },
  { name: "punctuation and digits are untouched", text: "Hello, World! 123", folded: "hello, world! 123" },
  { name: "already folded", text: "abc", folded: "abc" },
  { name: "an empty string", text: "", folded: "" },
  { name: "a dotted capital I survives an ascii fold", text: "İ", folded: "İ" },
  { name: "a dotted capital I among ascii", text: "İstanbul", folded: "İstanbul" },
  { name: "a sharp s survives an ascii fold", text: "Straße", folded: "straße" },
  { name: "an accented capital survives an ascii fold", text: "CAFÉ", folded: "cafÉ" },
  { name: "the ascii boundary at [ and `", text: "[A`a", folded: "[a`a" },
];

const asRanges = (
  pairs: ReadonlyArray<readonly [number, number]>,
): MatchRange[] => pairs.map(([start, end]) => ({ start, end }));

describe("foldAscii", () => {
  it("lowercases A-Z and leaves every other character alone", () => {
    for (const row of FOLD_FIXTURES) {
      expect(foldAscii(row.text), row.name).toBe(row.folded);
    }
  });

  it("never changes the length of the text it folds", () => {
    for (const row of FOLD_FIXTURES) {
      expect(foldAscii(row.text).length, row.name).toBe(row.text.length);
    }
  });

  it("preserves the length of a dotted capital I, which toLowerCase does not", () => {
    expect("İ".toLowerCase().length).toBe(2);
    expect(foldAscii("İ").length).toBe(1);
  });

  it("preserves the length of every text and query in the shared table", () => {
    for (const row of MATCH_FIXTURES) {
      expect(foldAscii(row.text).length, row.name).toBe(row.text.length);
      expect(foldAscii(row.query).length, row.name).toBe(row.query.length);
    }
  });

  it("is idempotent", () => {
    for (const row of FOLD_FIXTURES) {
      expect(foldAscii(foldAscii(row.text)), row.name).toBe(foldAscii(row.text));
    }
  });
});

describe("matchRanges", () => {
  it("counts overlapping candidates once, advancing by the query length", () => {
    expect(matchRanges("aaa", "aa")).toEqual([{ start: 0, end: 2 }]);
  });

  it("finds an occurrence whatever the case on either side", () => {
    expect(matchRanges("Foo foo", "FOO")).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
  });

  it("answers nothing for an empty query", () => {
    expect(matchRanges("anything", "")).toEqual([]);
  });

  it("does not match an accented capital against an accented query", () => {
    expect(matchRanges("CAFÉ", "café")).toEqual([]);
    expect(matchRanges("CAFE", "cafe")).toEqual([{ start: 0, end: 4 }]);
  });

  it("keeps offsets exact around a dotted capital I", () => {
    expect(matchRanges("İ file", "file")).toEqual([{ start: 2, end: 6 }]);
  });

  it("agrees with the shared fixture table", () => {
    for (const row of MATCH_FIXTURES) {
      expect(matchRanges(row.text, row.query), row.name).toEqual(asRanges(row.ranges));
    }
  });
});

describe("countMatches", () => {
  it("equals the number of ranges for every row of the shared table", () => {
    for (const row of MATCH_FIXTURES) {
      expect(countMatches(row.text, row.query), row.name).toBe(
        matchRanges(row.text, row.query).length,
      );
    }
  });

  it("equals the expected range count for every row of the shared table", () => {
    for (const row of MATCH_FIXTURES) {
      expect(countMatches(row.text, row.query), row.name).toBe(row.ranges.length);
    }
  });
});
