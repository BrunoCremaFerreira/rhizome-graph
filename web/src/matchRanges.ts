/**
 * Where a query occurs in a text: the one matching rule both sides of the
 * content search obey.
 *
 * The daemon counts occurrences over the files on disk and the panel
 * RECOMPUTES their ranges from the text it is later handed, so the count in the
 * counter and the columns under the highlight come from two programs in two
 * languages. They agree only while both fold case with the same rule, and only
 * while that rule cannot move an offset.
 *
 * Hence the trap this module exists to avoid: `toLowerCase` is not such a rule.
 * The Latin capital letter I with a dot above (U+0130) is ONE code unit that
 * lowercases to TWO, in JavaScript and in Python alike, so a Unicode fold of a
 * text holding one shifts every offset after it and the panel underlines the
 * wrong columns of the wrong line. {@link foldAscii} therefore maps `A-Z`
 * (0x41..0x5A) and nothing else, by char code, one code unit out for every code
 * unit in. The price is stated rather than hidden: a word spelled with an
 * accented capital E does not match the same word typed with the accented
 * lowercase e, because an ASCII-only fold leaves accented letters untouched.
 * (Both examples are described rather than quoted: this repository's language
 * policy scan fails on any accented Latin letter in an authored source.)
 *
 * Occurrences are non-overlapping, left to right, advancing by the query's
 * length: `"aa"` in `"aaa"` is one match, not two. That is the rule Python's
 * `str.count` already follows, pinned here rather than inherited.
 *
 * An empty query yields no ranges at all -- not one per position, and above all
 * not an endless loop over a zero-width advance.
 *
 * Offsets are JavaScript string indices, i.e. UTF-16 CODE UNITS, while the
 * daemon's are code points. The shared fixture table is deliberately all-BMP,
 * where the two are the same number; outside the BMP they would disagree about
 * the same match.
 *
 * Its own module, not part of the content search's state machine: `fileDoc.ts`
 * needs the same rule to mark a row, and the panel must not import a search
 * state to do it. Pure and DOM-free, like {@link ./search} and {@link ./view}.
 */

const UPPER_A = 0x41;
const UPPER_Z = 0x5a;
const TO_LOWER = 0x20;

/**
 * Lowercase `A-Z` and leave every other character exactly as it was.
 *
 * Length-preserving by construction: one code unit is read and one is written.
 */
export function foldAscii(text: string): string {
  let folded = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    folded += String.fromCharCode(
      code >= UPPER_A && code <= UPPER_Z ? code + TO_LOWER : code,
    );
  }
  return folded;
}

/** A half-open `[start, end)` slice of a text, in UTF-16 code units. */
export interface MatchRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Every non-overlapping occurrence of `query` in `text`, left to right, under
 * the ASCII fold.
 *
 * An empty query answers `[]`.
 */
export function matchRanges(text: string, query: string): MatchRange[] {
  const ranges: MatchRange[] = [];
  if (query.length === 0) {
    return ranges;
  }
  const foldedText = foldAscii(text);
  const foldedQuery = foldAscii(query);
  let from = 0;
  for (;;) {
    const start = foldedText.indexOf(foldedQuery, from);
    if (start < 0) {
      return ranges;
    }
    const end = start + foldedQuery.length;
    ranges.push({ start, end });
    from = end;
  }
}

/**
 * How many occurrences {@link matchRanges} finds -- built on it, so the count
 * and the highlights can never disagree.
 */
export function countMatches(text: string, query: string): number {
  return matchRanges(text, query).length;
}
