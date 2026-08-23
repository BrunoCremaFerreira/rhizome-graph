/**
 * Contract tests (RED) for the arithmetic that shares the bottom row.
 *
 * The defect, measured in a headless browser against a live daemon: the three
 * boxes pinned to the bottom of the page -- `#hud` (left), `#context` (centre),
 * `#status` (right) -- overlap each other at every realistic viewport.
 * `getBoundingClientRect`, in CSS px, positive meaning horizontal overlap:
 *
 *     viewport   .keys x #context   .keys x #status   #context x #status
 *     1600              276              -637               -201
 *     1280              373              -317               -104
 *      960              438                 3                -18
 *      900              412                63                 -1
 *      800              360                23                163
 *
 * At 960 the observed-root caption is buried whole. The keys caption is 143
 * characters and measures 708 px at every viewport, while the centre box is
 * placed at half the viewport, so the collision has a closed form --
 * `12 + 708 > W/2 - 0.45*W/2`, true for every viewport under about 2618 px.
 * There is no clean case.
 *
 * Two jaws close on this, because it is two defects wearing one symptom. The
 * row's *layout* is CSS (one container, one grid) and no unit test can assert
 * it; `tests/test_bottom_row_containment.py` pins the structure that makes it
 * expressible. The row's *share* is arithmetic, and it is currently hidden in a
 * DOM-bound painter: `contextHud.ts` budgets the centre's characters from
 * `CHAR_PX = 6.6` (an over-estimate; real glyphs measure 5.88-6.06 px) and
 * `WIDTH_FRACTION = 0.5` (a mirror of a CSS `max-width` that never binds),
 * reserving nothing at all for the two boxes beside it. That module's own
 * docstring says it is not unit-tested, which is exactly why the number has
 * never been checked.
 *
 * So the decision moves to a pure `src/bottomRow.ts`, the relation `statusList.ts`
 * has to `statusHud.ts`. Expected to FAIL until that module exists.
 *
 * WHAT THE GRID ALREADY CLOSES, AND THE ONE THING IT DOES NOT. The CSS jaw was
 * prototyped in the live page -- the three boxes moved into a `#bottom-bar` with
 * `grid-template-columns: minmax(0,1fr) auto minmax(0,1fr)` and `justify-self`
 * on each -- and re-measured over a dirty repository with a long root, with
 * today's `contextHud` budget untouched:
 *
 *     viewport   .keys x #context   .keys x #status   #context x #status   caption lines
 *     1600               0              -913               -201                  2
 *     1280               0              -690               -104                  3
 *      960               0              -456                -18                  4
 *      900               0              -413                 -1                  4
 *      800               0              -337                +23                  4
 *
 * The left collision is gone at every width: the caption wraps inside its own
 * track instead of running under the centre. `#context x #status` at 800 px is
 * the one collision the grid does NOT close, and the next reader will otherwise
 * assume the CSS covers it: the centre track is `auto` and `#context` is
 * `white-space: nowrap`, so its min-content is the entire string and it
 * overflows into the side tracks rather than shrinking. Nothing but the
 * character budget can prevent that, which is the standing reason this
 * arithmetic exists at all.
 *
 * THE INVARIANT IS OVER THE RENDERED CENTRE, NOT OVER THE BUDGET.
 * `contextCharBudget` answers for the root path ALONE, but what occupies the
 * centre track is root + branch + the ` . ` separator (and the ellipsis
 * `truncateMiddle` leaves behind). At 800 px the budget is 46 characters while
 * the page renders 61 and measures 361 px -- so an invariant written over the
 * budget under-counts by about 15 characters, which is exactly the slack that
 * let today's arithmetic satisfy it unchanged. Left-hand side is therefore
 * `(budget + branchChars + SEPARATOR_CHARS) * MAX_GLYPH_PX`, plus the two side
 * reserves, plus the bar's own horizontal padding.
 *
 * The arithmetic and the browser agree on where the row breaks, and that
 * correspondence is the point of the numbers below rather than a coincidence to
 * be tidied: against today's budget the invariant fails at 800 px and only
 * there, which is the single width where an overlap was still measured.
 *
 * SCOPING RULE, so the next reader does not "fix" an apparent contradiction:
 * the share invariant and the `MIN_ROOT_CHARS` floor cannot both hold at every
 * width. A floor is a floor -- below some viewport, twelve characters plus two
 * side reserves simply do not fit -- and there the floor wins, because a
 * caption clipped to nothing identifies no project. The invariant is therefore
 * asserted only for `W >= 800` (the narrowest viewport actually measured), and
 * the floor for every width, absurd ones included.
 */

import { describe, it, expect } from "vitest";
import {
  contextCharBudget,
  CONTEXT_WIDTH_FRACTION,
  MIN_SIDE_WIDTH_PX,
  MAX_GLYPH_PX,
  MIN_ROOT_CHARS,
} from "../src/bottomRow";

/** `"development"`, the branch this repository is on: the everyday case. */
const BRANCH_CHARS = 11;

/** `MAX_BRANCH_CHARS` in `contextHud.ts`: the worst a branch can cost. */
const LONGEST_BRANCH_CHARS = 24;

/** The viewports the overlap was measured at. Every one of them is broken. */
const MEASURED_VIEWPORTS = [800, 900, 960, 1280, 1600];

/**
 * The ` . ` between root and branch, spelled as the `- 3` in `contextHud.ts`.
 * Deliberately a local constant and not an import: it is what the PAGE renders
 * beside the budget, so a module that quietly redefined it would still have to
 * fit inside the row the browser measured.
 */
const SEPARATOR_CHARS = 3;

/** `#bottom-bar`'s `padding: 0 12px`: width the row never gets to spend. */
const BAR_PADDING_PX = 24;

/** Root + branch + separator: what actually occupies the centre track. */
function renderedCentrePx(viewport: number, branchChars: number): number {
  return (contextCharBudget(viewport, branchChars) + branchChars + SEPARATOR_CHARS) * MAX_GLYPH_PX;
}

describe("contextCharBudget", () => {
  it.each(MEASURED_VIEWPORTS)(
    "leaves room for both side boxes at a %ipx viewport",
    (viewport) => {
      const occupied = renderedCentrePx(viewport, BRANCH_CHARS) + 2 * MIN_SIDE_WIDTH_PX;

      expect(occupied + BAR_PADDING_PX).toBeLessThanOrEqual(viewport);
    },
  );

  it("never returns a smaller budget for a wider viewport", () => {
    const widths = [0, 320, 480, 640, 800, 900, 960, 1280, 1600, 2618, 3840];

    const budgets = widths.map((width) => contextCharBudget(width, BRANCH_CHARS));

    for (let i = 1; i < budgets.length; i += 1) {
      expect(budgets[i]).toBeGreaterThanOrEqual(budgets[i - 1]);
    }
  });

  it("keeps the floor on an absurdly narrow viewport", () => {
    for (const viewport of [0, 1, 120, 320, 480]) {
      expect(contextCharBudget(viewport, BRANCH_CHARS)).toBeGreaterThanOrEqual(MIN_ROOT_CHARS);
    }
  });

  it("keeps the floor when the branch name eats the whole line", () => {
    for (const viewport of [0, 320, ...MEASURED_VIEWPORTS]) {
      const budget = contextCharBudget(viewport, LONGEST_BRANCH_CHARS);

      expect(budget).toBeGreaterThanOrEqual(MIN_ROOT_CHARS);
      expect(budget).toBeGreaterThan(0);
    }
  });

  it("budgets whole characters, since the caption is truncated by count", () => {
    for (const viewport of MEASURED_VIEWPORTS) {
      expect(Number.isInteger(contextCharBudget(viewport, BRANCH_CHARS))).toBe(true);
    }
  });
});

describe("the constants the invariant rests on", () => {
  it("does not under-estimate a glyph", () => {
    // The share invariant is trivially satisfiable by declaring a narrow
    // glyph, which would re-open the defect while the suite stayed green.
    // Measured in the browser: 5.88-6.06 px per character at 12px system-ui.
    expect(MAX_GLYPH_PX).toBeGreaterThanOrEqual(6.0);
  });

  it("reserves the width the side box actually measures", () => {
    // Pinned to the measurement, not bounded by it, because BOTH directions of
    // drift break the correspondence with the browser. Below 231 the reserve
    // stops describing the box it is reserving for and the invariant goes slack
    // -- zero would satisfy it while changing nothing. Above 231 the invariant
    // starts demanding a narrower caption at widths where no overlap was ever
    // measured, and the arithmetic would be answering a question the page is
    // not asking. `#status` measures 231 px of natural, content-driven width at
    // every viewport; its `32vw` cap only binds below about 722 px. Re-measure
    // the box and this number moves with the table in the header.
    expect(MIN_SIDE_WIDTH_PX).toBe(231);
  });

  it("gives the centre less than the whole row", () => {
    expect(CONTEXT_WIDTH_FRACTION).toBeGreaterThan(0);
    expect(CONTEXT_WIDTH_FRACTION).toBeLessThan(1);
  });
});
