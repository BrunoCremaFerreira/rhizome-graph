/**
 * How the bottom row of the page is shared out, in characters.
 *
 * `#bottom-bar` is a grid — `#hud` left, `#context` centre, `#status` right —
 * and the grid closes every collision but one: the centre box is
 * `white-space: nowrap`, so its min-content is the whole caption and it
 * overflows into the side tracks instead of shrinking. Only a character budget
 * can prevent that, and this module is that budget.
 *
 * It lives here, and not in `contextHud.ts` where it grew up, for the reason
 * `statusList.ts` lives apart from `statusHud.ts`: a painter is DOM-bound and
 * therefore untested, which is how the one number that shares out the row
 * escaped ever being checked. Pure — no DOM, no `window`; the viewport arrives
 * as an argument, as it does in `labels.ts`.
 */

/**
 * Share of the viewport the centre caption may claim before the side reserves
 * are considered at all.
 *
 * Measured in a browser over the grid: 0.34 keeps the shortcut legend at two
 * lines at both 1280 and 1600, where 0.40 wraps it to three at 1280 and 0.50 to
 * three at 1600. The legend is the widest thing in the row, so it is what pays
 * for a greedy centre.
 */
export const CONTEXT_WIDTH_FRACTION = 0.34;

/**
 * Width kept clear for EACH side box, in px.
 *
 * `#status` measures 231 px of natural, content-driven width at every viewport.
 * Pinned to that measurement rather than merely bounded by it: below it the
 * reserve stops describing the box it reserves for (zero would satisfy the
 * arithmetic while changing nothing), above it the centre is squeezed at widths
 * where nothing ever overlapped.
 */
export const MIN_SIDE_WIDTH_PX = 231;

/**
 * Upper bound on one 12px system-ui character, in px.
 *
 * Deliberately an over-estimate: a narrow glyph makes the budget look like it
 * fits while the page overflows. Measured in the browser at 5.88-6.06 px per
 * character over real paths and branch names.
 */
export const MAX_GLYPH_PX = 6.1;

/**
 * Never shrink the observed root below this, however narrow the viewport.
 *
 * A floor and the share invariant cannot both hold at every width; below some
 * viewport twelve characters plus two side reserves simply do not fit, and
 * there the floor wins, because a caption clipped to nothing identifies no
 * project.
 */
export const MIN_ROOT_CHARS = 12;

/** The ` · ` the page draws between the root and the branch. */
const SEPARATOR_CHARS = 3;

/** `#bottom-bar`'s `padding: 0 12px`: width the row never gets to spend. */
const BAR_PADDING_PX = 24;

/**
 * How many characters of the observed root fit beside a branch of this length.
 *
 * Two terms, and both are needed. The fraction term is what keeps the centre
 * modest on a wide screen: a reserve-only budget hands 1026 px to the centre at
 * 1600 and wraps the shortcut legend to three lines. The reserve term is what
 * keeps the row intact on a narrow one: a fraction-only budget is what let
 * `#context` overlap `#status` by 23 px at 800 px. The smaller of the two wins,
 * and the floor wins over both.
 */
export function contextCharBudget(viewportWidth: number, branchChars: number): number {
  const fractionBudget = Math.floor((viewportWidth * CONTEXT_WIDTH_FRACTION) / MAX_GLYPH_PX);
  const reservedForSides = viewportWidth - 2 * MIN_SIDE_WIDTH_PX - BAR_PADDING_PX;
  const reserveBudget = Math.floor(reservedForSides / MAX_GLYPH_PX);
  const shared = Math.min(fractionBudget, reserveBudget) - branchChars - SEPARATOR_CHARS;

  return Math.max(MIN_ROOT_CHARS, shared);
}
