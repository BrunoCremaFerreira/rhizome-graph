/**
 * The render model behind the file viewer: what the panel paints, decided here.
 *
 * {@link ./fileViewHud} used to decide it in the DOM — one `textContent` for
 * text and hex, a class per line prefix for a diff. Those are decisions (how
 * wide is the gutter? is this file big enough that colouring it would stall the
 * graph's animation loop? which fragments does the grammar get to see?) living
 * in the one module doctrine says is never tested, because it needs a DOM the
 * `node` test environment does not have. So the panel gets a MODEL, one for all
 * three modes, and the painter becomes a loop over {@link FileDoc.rows}.
 *
 * `buildDoc` is the only entry point, and it is a pure READ of the state: it
 * dispatches by mode, parses, budgets, sizes the gutter, lists the tokenization
 * requests AND stitches the tokens in once `state.highlight` has arrived. A
 * second exported "attach" step would let a caller paint a doc it forgot to
 * attach tokens to — a bug that just looks uncoloured.
 *
 * Five decisions carry the weight:
 *
 *  - **One request per (hunk × side).** Concatenating "the whole old file" out
 *    of its hunks is wrong: hunks are not contiguous, and a hunk ending inside
 *    an unterminated string would poison the grammar for every hunk after it.
 *  - **`-1` is what makes that close.** A context line must EXIST in the old
 *    side's code for the grammar to see a coherent fragment, but its tokens
 *    come from the NEW side — same text, and the new side is the numbering the
 *    reader follows. Hence the invariant that holds the design up:
 *    `code.split("\n").length === rows.length`.
 *  - **The budget is the graph's frame rate**, and it degrades in two steps:
 *    past the highlight budget a diff keeps its rows, stripes and gutter and
 *    only loses colour; past {@link MAX_ROWS} it falls back to the single text
 *    node the panel used to use, because there the cost is ELEMENTS.
 *  - **Hex is untouched.** A dump is already column-aligned and has no
 *    language: a gutter would double its offsets.
 *  - **A `highlight` whose shape disagrees paints NOTHING.** A chunk count or a
 *    line count that does not match means every row goes plain. The wrong
 *    tokens on the right rows are worse than none: silently, plausibly wrong.
 *  - **The search's marks are an ARGUMENT, never state.** The query and the
 *    active occurrence belong to the content search; copied onto
 *    {@link FileViewState} they would have two owners and a synchronisation bug
 *    the first time an answer landed late. {@link DocMarking} is declared HERE
 *    so the search imports it from the panel and never the reverse, and
 *    `buildDoc(state)` with one argument is byte for byte what it always was.
 */

import { parseDiff, type DiffRow, type RowKind } from "./diffModel";
import { languageForPath, type LanguageId } from "./language";
import { matchRanges, type MatchRange } from "./matchRanges";
import type { CodeToken, FileViewState } from "./fileView";

export type { CodeToken } from "./fileView";

/** Above this many rows the panel would be built out of that many elements. */
export const MAX_ROWS = 20000;

/** Lines the tokenizer is allowed: ~28 000 spans, ~60–100 ms of building. */
export const MAX_HIGHLIGHT_LINES = 4000;

/** Bytes the tokenizer is allowed: half the daemon's own 256 KiB cap. */
export const MAX_HIGHLIGHT_BYTES = 131072;

/**
 * Marks the panel is allowed before it shows only the active one.
 *
 * A one-letter query over a 4 000-line file is ~40 000 extra spans in a panel
 * rebuilt on every paint, sharing a frame budget with a force layout that never
 * settles. The counter already says how many there are; the panel is read, not
 * counted.
 */
export const MAX_MARKS_PER_DOC = 2000;

/** Why the content is on screen without colour. */
const TOO_LARGE = "too large to highlight";

/** What the search asks the panel to mark, and which occurrence is current. */
export interface DocMarking {
  /** The query, under {@link matchRanges}' rule. Empty marks nothing. */
  readonly query: string;
  /** The occurrence to single out, counted over the whole document. */
  readonly activeMatch: number | null;
}

/** Whether a fragment is outside the matches, inside one, or inside THE one. */
export type MarkKind = "none" | "match" | "active";

/** A fragment of a row: a token's style, plus what the search makes of it. */
export interface MarkedSpan extends CodeToken {
  readonly mark: MarkKind;
}

/** One line of the panel. */
export interface Row {
  readonly kind: RowKind;
  /** Line number in the old file, or `null`. */
  readonly oldNo: number | null;
  /** Line number in the new file, or `null`. */
  readonly newNo: number | null;
  /** The text to paint, diff marker already stripped. */
  readonly text: string;
  /** Its syntax tokens, or `null` for a plain line. */
  readonly tokens: readonly CodeToken[] | null;
  /**
   * The line cut at the match boundaries, or `null` when nothing marks it.
   *
   * `spans.map((span) => span.text).join("") === text` — the splitter may not
   * lose, duplicate or reorder a character. Colour is the optional layer here,
   * the match is not: an uncoloured row is split all the same, with `color`
   * empty on every span.
   */
  readonly spans: readonly MarkedSpan[] | null;
}

/** A fragment to tokenize, and where each of its lines lands. */
export interface HighlightRequest {
  /** The fragment's lines, joined by `"\n"`. */
  readonly code: string;
  /** Per line of {@link code}: the {@link Row} index, or `-1` to discard. */
  readonly rows: readonly number[];
}

/** Everything the painter needs, and nothing it has to decide. */
export interface FileDoc {
  /** The rows, or `null` for the single-text-node fast path. */
  readonly rows: readonly Row[] | null;
  /** Whether line numbers are drawn. */
  readonly gutter: boolean;
  /** How wide the gutter must be, in `ch`. */
  readonly gutterWidth: number;
  /** The grammar the path resolves to, or `null`. */
  readonly lang: LanguageId | null;
  /** The fragments to tokenize; empty when there is nothing to colour. */
  readonly requests: readonly HighlightRequest[];
  /** `""`, or why the content was not coloured. */
  readonly note: string;
  /** The whole body, for the fast path where {@link rows} is `null`. */
  readonly plain: string;
  /**
   * The row holding the active occurrence, for the painter to scroll to.
   *
   * `null` when nothing is active, and `null` on the plain fast path — a
   * 20 000-row file gets neither marks nor scroll, the degradation that path
   * already applies to colour.
   */
  readonly activeRow: number | null;
}

/** A mutable row under construction; frozen into a {@link Row} by returning it. */
interface MutableRow {
  kind: RowKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  tokens: readonly CodeToken[] | null;
  spans: readonly MarkedSpan[] | null;
}

/** The single-text-node answer: hex, an error, a wait, or too many rows. */
function plainDoc(plain: string, lang: LanguageId | null, note: string): FileDoc {
  return {
    rows: null,
    gutter: false,
    gutterWidth: 0,
    lang,
    requests: [],
    note,
    plain,
    activeRow: null,
  };
}

/** The lines of a file, without the phantom last one a trailing `\n` yields. */
function contentLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Widest line number, in characters — one column width for every row. */
function gutterWidthOf(rows: readonly MutableRow[]): number {
  let largest = 0;
  for (const row of rows) {
    if (row.oldNo !== null && row.oldNo > largest) largest = row.oldNo;
    if (row.newNo !== null && row.newNo > largest) largest = row.newNo;
  }
  return String(largest).length;
}

/** One fragment per side of one hunk, in the order old-then-new. */
function hunkRequests(rows: readonly MutableRow[]): HighlightRequest[] {
  const requests: HighlightRequest[] = [];
  let oldCode: string[] = [];
  let oldRows: number[] = [];
  let newCode: string[] = [];
  let newRows: number[] = [];

  function flush(): void {
    // An empty side is dropped: `"".split("\n")` is one line against zero row
    // entries, which is exactly the invariant this design rests on.
    if (oldCode.length > 0) requests.push({ code: oldCode.join("\n"), rows: oldRows });
    if (newCode.length > 0) requests.push({ code: newCode.join("\n"), rows: newRows });
    oldCode = [];
    oldRows = [];
    newCode = [];
    newRows = [];
  }

  rows.forEach((row, index) => {
    if (row.kind === "hunk") {
      flush();
      return;
    }
    if (row.kind === "del") {
      oldCode.push(row.text);
      oldRows.push(index);
    } else if (row.kind === "add") {
      newCode.push(row.text);
      newRows.push(index);
    } else if (row.kind === "context") {
      // In the old side's code so the grammar sees a coherent fragment, and
      // mapped to -1 so its tokens are thrown away in favour of the new side's.
      oldCode.push(row.text);
      oldRows.push(-1);
      newCode.push(row.text);
      newRows.push(index);
    }
  });
  flush();

  return requests;
}

/**
 * Paint the tokens onto the rows they were asked for, or paint none at all.
 *
 * The tokenizer is a third-party wasm grammar over content the daemon may have
 * cut mid-UTF-8. A chunk count or a line count that disagrees with what was
 * requested means the answer describes something else, and every row stays
 * plain rather than taking colours chosen by index.
 */
function stitch(
  rows: MutableRow[],
  requests: readonly HighlightRequest[],
  chunks: readonly (readonly (readonly CodeToken[])[])[],
): void {
  if (chunks.length !== requests.length) return;
  for (let i = 0; i < requests.length; i += 1) {
    if (chunks[i].length !== requests[i].rows.length) return;
  }
  // Only once every fragment checks out: a later request overrides an earlier
  // one, which is how a context line ends up wearing the new side's colours.
  for (let i = 0; i < requests.length; i += 1) {
    const map = requests[i].rows;
    for (let line = 0; line < map.length; line += 1) {
      const target = map[line];
      if (target >= 0 && target < rows.length) rows[target].tokens = chunks[i][line];
    }
  }
}

/** The style a plain, uncoloured fragment wears: none at all. */
const NO_STYLE: Omit<CodeToken, "text"> = { color: "", italic: false, bold: false };

/**
 * Cut one row at BOTH the token boundaries and the match boundaries.
 *
 * Every fragment keeps the style of the token it came out of, so a match
 * straddling the seam between a keyword and a string is two spans, one in each
 * colour, and the row still reads as the grammar coloured it. `activeWithin` is
 * the index, among this row's ranges, of the document's active occurrence, or
 * `-1` when it lives on another row.
 */
function splitRow(
  row: MutableRow,
  ranges: readonly MatchRange[],
  activeWithin: number,
): MarkedSpan[] {
  const length = row.text.length;
  const cuts = new Set<number>([0, length]);
  for (const range of ranges) {
    cuts.add(range.start);
    cuts.add(range.end);
  }
  if (row.tokens !== null) {
    let at = 0;
    for (const token of row.tokens) {
      at += token.text.length;
      if (at < length) cuts.add(at);
    }
  }
  const bounds = [...cuts].filter((at) => at >= 0 && at <= length).sort((a, b) => a - b);

  const spans: MarkedSpan[] = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const start = bounds[i];
    const end = bounds[i + 1];
    // Sliced out of the ROW, never out of the tokens: a grammar whose fragments
    // do not add up to the line must not be able to lose a character here.
    const text = row.text.slice(start, end);
    const found = ranges.findIndex((range) => range.start <= start && end <= range.end);
    const mark: MarkKind = found < 0 ? "none" : found === activeWithin ? "active" : "match";
    spans.push({ ...styleAt(row.tokens, start), text, mark });
  }
  return spans;
}

/** The style covering one offset of a row, or none where there are no tokens. */
function styleAt(
  tokens: readonly CodeToken[] | null,
  offset: number,
): Omit<CodeToken, "text"> {
  if (tokens === null) return NO_STYLE;
  let at = 0;
  for (const token of tokens) {
    at += token.text.length;
    if (offset < at) return { color: token.color, italic: token.italic, bold: token.bold };
  }
  return NO_STYLE;
}

/**
 * Mark the rows the query occurs in, and answer the active occurrence's row.
 *
 * The occurrences are counted in document order across the rows, which is the
 * order the daemon's own counter uses, and an `activeMatch` past the end is
 * CLAMPED to the last one: the file may have changed between the grep and the
 * click, and a lost index must not lose the scroll as well.
 */
function markRows(rows: MutableRow[], marking: DocMarking): number | null {
  if (marking.query === "") return null;

  const perRow = rows.map((row) => matchRanges(row.text, marking.query));
  let total = 0;
  for (const ranges of perRow) total += ranges.length;
  if (total === 0) return null;

  let activeRow: number | null = null;
  let activeWithin = -1;
  if (marking.activeMatch !== null) {
    const wanted = Math.min(Math.max(marking.activeMatch, 0), total - 1);
    let seen = 0;
    for (let i = 0; i < rows.length; i += 1) {
      if (wanted < seen + perRow[i].length) {
        activeRow = i;
        activeWithin = wanted - seen;
        break;
      }
      seen += perRow[i].length;
    }
  }

  const overBudget = total > MAX_MARKS_PER_DOC;
  for (let i = 0; i < rows.length; i += 1) {
    if (perRow[i].length === 0) continue;
    if (overBudget && i !== activeRow) continue;
    rows[i].spans = splitRow(rows[i], perRow[i], i === activeRow ? activeWithin : -1);
  }
  return activeRow;
}

/** The whole model for one panel state — the painter decides nothing else. */
export function buildDoc(state: FileViewState, marking?: DocMarking): FileDoc {
  // The error wins over the content, so a stale body never sits under a failure.
  if (state.error !== "") return plainDoc(state.error, null, "");
  if (state.loading) return plainDoc("", null, "");
  // A dump has no language and its own first column is already an offset.
  if (state.mode === "hex") return plainDoc(state.content, null, "");

  const lang = languageForPath(state.path);
  const isDiff = state.mode === "diff";

  const rows: MutableRow[] = isDiff
    ? parseDiff(state.content).map((row: DiffRow) => ({
        kind: row.kind,
        oldNo: row.oldNo,
        newNo: row.newNo,
        text: row.text,
        tokens: null,
        spans: null,
      }))
    : contentLines(state.content).map((text, index) => ({
        kind: "plain" as RowKind,
        oldNo: null,
        // A file has only one side, and it is the one the reader is on.
        newNo: index + 1,
        text,
        tokens: null,
        spans: null,
      }));

  if (rows.length > MAX_ROWS) return plainDoc(state.content, lang, lang ? TOO_LARGE : "");

  const overBudget =
    rows.length > MAX_HIGHLIGHT_LINES || state.content.length > MAX_HIGHLIGHT_BYTES;

  let requests: readonly HighlightRequest[] = [];
  if (lang !== null && !overBudget) {
    if (isDiff) requests = hunkRequests(rows);
    else if (rows.length > 0) {
      requests = [{ code: rows.map((row) => row.text).join("\n"), rows: rows.map((_, i) => i) }];
    }
  }

  if (state.highlight !== null) stitch(rows, requests, state.highlight);

  // After the stitch, so a fragment can inherit the colour of the token it was
  // cut out of; before nothing, since the marks are the last word on a row.
  const activeRow = marking === undefined ? null : markRows(rows, marking);

  return {
    rows,
    gutter: true,
    gutterWidth: gutterWidthOf(rows),
    lang,
    requests,
    note: lang !== null && overBudget ? TOO_LARGE : "",
    plain: state.content,
    activeRow,
  };
}
