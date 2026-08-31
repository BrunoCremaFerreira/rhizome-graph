/**
 * Contract tests (RED) for the caption a browser is willing to draw.
 *
 * The defect: this is the first thing on this page that rasterises a string a
 * language model wrote, and until now the browser's only protection was that
 * the daemon on the other end of the socket happened to be one this repository
 * wrote, at this version. It is not necessarily any of those things. A page is
 * pointed at a daemon by `ssh -L`, through a proxy, or from a different
 * release -- `CLAUDE.md` records that `vite.config.ts` "handed the whole LAN a
 * gate that says 127.0.0.1" for exactly this class of reason -- so a caption
 * arriving over the wire is text of unknown provenance heading for a canvas.
 *
 * Which is why this module is NOT redundant with `safe_caption` in
 * `rhizome_graph/agentstate.py`, and a reader who calls it that has read only
 * half the path. Decision 7: **two conditions on one path, never two paths.**
 * The daemon's cap bounds the wire and protects a browser of another version;
 * the browser's bounds the canvas and protects it from a DAEMON of another
 * version. Neither is a second route to the sink, and neither is dead code
 * standing in for the other.
 *
 * It is deliberately not in `protocol.ts`: that module answers "is this frame
 * well-formed", and a cap is a POLICY about drawing rather than a validation of
 * the wire -- the same split that keeps `truncateMiddle` a helper rather than
 * part of `parseStatus`. And it is not in `renderer.ts`, which needs a GL
 * context and carries no unit test by doctrine, so a rule taken there is a rule
 * that silently loses its coverage.
 *
 * CAPTION_FOLD_CASES below is the shared fixture table. The same pairs are
 * asserted in `tests/test_agent_caption.py`, in this order, with the same
 * expectations and with **no code shared between the two languages** -- there
 * is no code path between them, so a rule implemented twice has nothing but a
 * table to keep it honest. This is the device `content_search.py` and
 * `matchRanges.ts` already share, reused against the same trap: the two tables
 * are one fact written in two places and are edited together. A pair added here
 * and not there, or reordered in one of them alone, quietly stops pinning the
 * thing the table exists for.
 *
 * Every character in it is inside the BMP except where an astral one is the
 * point. Outside the BMP a Python cap counted in code points and a JavaScript
 * cap counted in `String.length` units disagree about the same string, and the
 * three boundary cases at the end of the table are what make that disagreement
 * loud instead of silent: one string of exactly `MAX_CAPTION_CHARS`, one of
 * `MAX_CAPTION_CHARS + 1`, and one whose astral tail sits at an odd offset so
 * that a `slice(0, 59)` on UTF-16 units lands INSIDE a surrogate pair.
 *
 * Every character that cannot be seen is spelled as an escape, as it is on the
 * Python side. A raw control or a raw bidirectional mark in a fixture is
 * invisible in a diff, in a terminal and in a review -- which is precisely why
 * those characters are dangerous -- and a fixture nobody can read is a fixture
 * somebody deletes.
 *
 * Expected to FAIL until `src/agentCaption.ts` exists.
 *
 * Style: Arrange-Act-Assert, one property per test.
 */

import { describe, expect, it } from "vitest";

import {
  captionFor,
  MAX_CAPTION_CHARS,
  safeCaption,
} from "../src/agentCaption";
import {
  applyAgentStates,
  createAgentStates,
  type AgentStateModel,
} from "../src/agentState";
import type { AgentStateEntry, AgentStates } from "../src/protocol";

/**
 * The ellipsis `labels.ts` already uses in `actorDisplayName`, and the same
 * rule with it: head plus ellipsis is exactly the cap long, never one under.
 */
const ELLIPSIS = "…";

/** U+1F680 ROCKET, the astral character the boundary case is built from. */
const ROCKET = "\u{1f680}";

// ---------------------------------------------------------------------------
// The three boundary strings of the shared fixture table.
//
// Named rather than inlined because the row that pins `MAX_CAPTION_CHARS` pins
// it THROUGH them: a shared table only pins a cap if it contains the boundary,
// and a table of short strings would let the two languages agree about every
// pair in it while disagreeing about the number.
// ---------------------------------------------------------------------------

/** Exactly `MAX_CAPTION_CHARS` characters. Comes back untouched. */
const AT_THE_CAP = "Reading the watcher and folding its events into the hub tree";

/** One character more, so the cut is by exactly one character. */
const ONE_PAST_THE_CAP =
  "Reading the watcher and folding its events into the hub trees";
const ONE_PAST_THE_CAP_CUT =
  "Reading the watcher and folding its events into the hub tre" + ELLIPSIS;

/**
 * The trap the shared table exists for. Fifty-six characters and then ten
 * astral ones: Python counts code points and JavaScript counts UTF-16 units, so
 * a cut on units lands inside a surrogate pair and hands back a lone surrogate,
 * while a cut on code points keeps three whole rockets.
 */
const ASTRAL_PAST_THE_CAP =
  "Rewriting the ingest loop so a held change is never lost" + ROCKET.repeat(10);
const ASTRAL_PAST_THE_CAP_CUT =
  "Rewriting the ingest loop so a held change is never lost" +
  ROCKET.repeat(3) +
  ELLIPSIS;

// ---------------------------------------------------------------------------
// THE SHARED FIXTURE TABLE.
//
// `tests/test_agent_caption.py` holds these same pairs, in this same order,
// with the same expectations. THE TWO FILES ARE EDITED TOGETHER.
//
// Deliberately NOT in the table: the "fold runs before the cap" case, which
// needs a run of two hundred controls. Written out as a literal it is
// unreadable in both languages and impossible to transcribe by eye, so it is a
// test of its own on the Python side.
// ---------------------------------------------------------------------------

const CAPTION_FOLD_CASES: ReadonlyArray<readonly [string, string]> = [
  // Nothing in, nothing out.
  ["", ""],
  // An ordinary caption is not touched at all.
  ["Rewriting the beam pool", "Rewriting the beam pool"],
  // Runs of whitespace collapse, and the ends are stripped.
  ["   Updating   the   plan   ", "Updating the plan"],
  // A control is a SEPARATOR, never a joiner: two words either side of a
  // newline come back as two words.
  ["Reading\nthe watcher", "Reading the watcher"],
  // The rest of the C0 set a model actually types.
  ["Writing\ttests\r\nfor\u0000the hub", "Writing tests for the hub"],
  // A C1 control: NEXT LINE, U+0085.
  ["Deleting\u0085stale nodes", "Deleting stale nodes"],
  // A right-to-left override, which would otherwise reverse the visual order of
  // everything after it -- directly under the one string on the page that says
  // WHO is acting. Spaces either side, so the table says nothing about whether
  // a bidi control leaves a separator behind.
  ["Renaming \u202e the parser", "Renaming the parser"],
  // Only controls and whitespace: the caption is empty and the sprite hides.
  ["  \n\t\u200e  ", ""],
  // The jaw. This is a fold of dangerous characters, not an ASCII filter: a
  // caption a model wrote about a file named in another language is ordinary
  // text and comes back exactly as written.
  ["Renaming café.txt and naïve.py", "Renaming café.txt and naïve.py"],
  ["設定ファイルを読んでいます", "設定ファイルを読んでいます"],
  ["Shipping the release " + ROCKET, "Shipping the release " + ROCKET],
  // The three boundary cases, without which the table pins no cap at all.
  [AT_THE_CAP, AT_THE_CAP],
  [ONE_PAST_THE_CAP, ONE_PAST_THE_CAP_CUT],
  [ASTRAL_PAST_THE_CAP, ASTRAL_PAST_THE_CAP_CUT],
];

/**
 * A surrogate with no partner: the artefact a UTF-16 cut leaves behind.
 *
 * A browser draws one as a replacement character, and the string either side of
 * it is identical to a correct one until it is rendered -- which is why the
 * absence of one is asserted rather than inferred from a string comparison.
 */
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Count code points, the unit both languages have to agree on. */
function codePoints(text: string): number {
  return Array.from(text).length;
}

/** One parsed entry, exactly as `parseAgentStates` hands it over. */
function entry(agent: string, caption: string): AgentStateEntry {
  return { agent, label: "", state: "working", caption, ts: 1754870400 } as AgentStateEntry;
}

/** The model after a single frame, for the tests that need no history. */
function modelOf(...agents: AgentStateEntry[]): AgentStateModel {
  return applyAgentStates(createAgentStates(), { agents } as AgentStates);
}

describe("safeCaption: the second condition costs the first one nothing", () => {
  // Row 6.5, and it leads the file deliberately. A fold that is not idempotent
  // turns "defence in depth" into "the caption is mangled once for every layer
  // it passes" -- a sentence losing a word, or growing an ellipsis it did not
  // need, at each hop -- and that would be discovered on a screen rather than
  // in a suite, because every layer of it is individually correct.

  it("hands every caption the daemon already folded back unchanged", () => {
    for (const [raw, folded] of CAPTION_FOLD_CASES) {
      expect(safeCaption(folded), `the folded output of ${JSON.stringify(raw)}`).toBe(
        folded,
      );
    }
  });

  it("answers the same thing whether it is applied once or twice", () => {
    for (const [raw] of CAPTION_FOLD_CASES) {
      const once = safeCaption(raw);

      expect(safeCaption(once), JSON.stringify(raw)).toBe(once);
    }
  });
});

describe("safeCaption: the shared fixture table", () => {
  // Row 6.1. There is no code path between Python and TypeScript, so nothing
  // but this table keeps one rule implemented twice from becoming two rules.

  it("agrees with tests/test_agent_caption.py pair for pair, in order", () => {
    CAPTION_FOLD_CASES.forEach(([raw, folded], index) => {
      expect(safeCaption(raw), `case-${String(index).padStart(2, "0")}`).toBe(folded);
    });
  });
});

describe("safeCaption: the cap counts code points, never UTF-16 units", () => {
  // Row 6.2. `String.prototype.slice` counts units, so a cut at an odd offset
  // in an astral run splits a surrogate pair; `Array.from` and any other
  // code-point-aware walk do not. Both sides must cut the same string in the
  // same place or the shared table above is asserting two different rules.

  it("cuts an astral caption exactly where the daemon cuts it", () => {
    const folded = safeCaption(ASTRAL_PAST_THE_CAP);

    expect(folded).toBe(ASTRAL_PAST_THE_CAP_CUT);
    expect(codePoints(folded)).toBe(MAX_CAPTION_CHARS);
  });

  it("never leaves a lone surrogate at the cut", () => {
    // Asserted directly rather than left to the string comparison above,
    // because this is what the row is for: a lone surrogate is invisible in a
    // diff and shows up only as a replacement character on a screen.
    const folded = safeCaption(ASTRAL_PAST_THE_CAP);

    expect(LONE_SURROGATE.test(folded)).toBe(false);
  });

  it("leaves no lone surrogate in any answer the shared table expects", () => {
    for (const [raw] of CAPTION_FOLD_CASES) {
      expect(LONE_SURROGATE.test(safeCaption(raw)), JSON.stringify(raw)).toBe(false);
    }
  });
});

describe("MAX_CAPTION_CHARS: the table holds the boundary, so the table pins the cap", () => {
  // Row 6.3, as the tester's consultation corrected it. Restating `60` here
  // would be two constants that merely happen to be equal -- this repository's
  // own name for the bug that follows. The number lives in the table's boundary
  // cases instead, so the table itself says what the cap is in both languages
  // at once. WITHOUT THOSE CASES THIS ROW WOULD ASSERT NOTHING: a table of
  // short strings passes identically whatever either side's cap is.

  it("equals the length of the case the table expects to come back untouched", () => {
    expect(MAX_CAPTION_CHARS).toBe(codePoints(AT_THE_CAP));
  });

  it("is one below the length of the case the table expects to be cut", () => {
    expect(codePoints(ONE_PAST_THE_CAP)).toBe(MAX_CAPTION_CHARS + 1);
  });

  it("is the length of every cut the table expects, head kept and ellipsis last", () => {
    for (const cut of [ONE_PAST_THE_CAP_CUT, ASTRAL_PAST_THE_CAP_CUT]) {
      expect(codePoints(cut)).toBe(MAX_CAPTION_CHARS);
      expect(cut.endsWith(ELLIPSIS)).toBe(true);
    }
  });

  it("has all three boundary cases present in the shared table", () => {
    // The membership check is the row: the three assertions above are about
    // strings, and they only pin the cap while the table actually asserts those
    // strings against `safeCaption`.
    const inputs = CAPTION_FOLD_CASES.map(([raw]) => raw);

    expect(inputs).toContain(AT_THE_CAP);
    expect(inputs).toContain(ONE_PAST_THE_CAP);
    expect(inputs).toContain(ASTRAL_PAST_THE_CAP);
  });
});

describe("safeCaption: a fold of dangerous characters, not an ASCII filter", () => {
  // The jaw the Python side carries, restated here because it is the assertion
  // that stops a naive implementation reaching for a printable-only filter. A
  // caption naming a file with an accent in it, or written in the language the
  // user was speaking, is legitimate text somebody wants to read, and a fold
  // that quietly deleted it would be discovered on a screen rather than here.

  it("passes ordinary text in any language below the cap through unchanged", () => {
    for (const raw of [
      "Renaming café.txt and naïve.py",
      "設定ファイルを読んでいます",
      "Shipping the release " + ROCKET,
    ]) {
      expect(safeCaption(raw), raw).toBe(raw);
    }
  });
});

describe("safeCaption: total, because the frame came off the network", () => {
  it("answers the empty caption for anything that is not text, and throws nothing", () => {
    // `parseAgentStates` degrades a mistyped `caption` to `""` today, but this
    // function is the last thing between the wire and the canvas and a daemon
    // nobody here wrote is the case it exists for. Throwing would take the
    // whole frame down and with it every other agent's state.
    const notText = [null, undefined, 7, ["Folding the events"], { activeForm: "x" }];

    for (const raw of notText) {
      expect(safeCaption(raw as unknown as string), JSON.stringify(raw)).toBe("");
    }
  });
});

describe("captionFor: the answer the renderer is handed", () => {
  // Row 6.4. The renderer takes an answer and never a question -- the
  // `setSizeColors` shape -- so this selector is the whole of what it knows
  // about captions, and it is therefore also where the browser's condition is
  // actually applied.

  it("answers the empty caption for an agent the model does not hold", () => {
    const state = modelOf(entry("a-1", "Folding the events"));

    expect(captionFor(state, "a-2")).toBe("");
  });

  it("answers the empty caption when no agent has been heard from at all", () => {
    expect(captionFor(createAgentStates(), "a-1")).toBe("");
  });

  it("answers the caption the model holds for that agent", () => {
    const state = modelOf(
      entry("a-1", "Folding the events"),
      entry("a-2", "Drawing the ring"),
    );

    expect(captionFor(state, "a-2")).toBe("Drawing the ring");
  });

  it("answers the empty caption for an agent the daemon reported without one", () => {
    // An empty caption is a published fact -- the daemon sends `caption: ""`
    // when nothing is in progress -- and it must reach the renderer as an
    // instruction to draw nothing, never as a missing answer.
    const state = modelOf(entry("a-1", ""));

    expect(captionFor(state, "a-1")).toBe("");
  });

  it("folds and caps a caption that arrived unfolded from a daemon of another version", () => {
    // The case the whole module exists for, asserted through the function the
    // renderer will actually call: a caption that never passed the daemon's own
    // fold reaches the canvas folded and capped anyway.
    const state = modelOf(entry("a-1", "Renaming \u202e " + ONE_PAST_THE_CAP));

    const caption = captionFor(state, "a-1");

    expect(caption).toBe(
      "Renaming Reading the watcher and folding its events into th" + ELLIPSIS,
    );
    expect(codePoints(caption)).toBe(MAX_CAPTION_CHARS);
    expect(caption).not.toContain("\u202e");
  });
});
