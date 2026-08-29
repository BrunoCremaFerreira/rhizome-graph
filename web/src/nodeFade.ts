/**
 * How much of its own colour a node keeps when nobody has touched it lately.
 *
 * The last step of the renderer's per-node colour chain is a fade: a file dot
 * is multiplied by `0.35 + 0.65 * opacity`, and `opacity` decays with idleness,
 * so a file an agent wrote a minute ago is painted at roughly a third of its
 * colour. That is right for the ordinary case — the tree is the backdrop and
 * the backdrop must not compete with what is happening now — and exactly wrong
 * for two kinds of node:
 *
 *  - a SEARCH MATCH, because the user asked for that node by name and it must
 *    be visible however cold it is;
 *  - an ALARMED node, for the same reason stated the other way round: an alarm
 *    outlives the event that raised it by design (the file stays modified until
 *    a human looks at it), and an alarm that fades out is an alarm nobody sees.
 *
 * WHY THIS IS A MODULE. `renderer.ts` needs a GL context and cannot be
 * unit-tested, so an exemption written as one more condition inside its
 * per-frame loop would be a decision with no test under it — and the only
 * assertion available there is a substring search over the source, which cannot
 * see nesting and would pass over an implementation that merely mentioned the
 * alarm set in a comment. So the arithmetic moves out, the way `view.ts` and
 * `labels.ts` already did, and the renderer calls this and holds none of it.
 *
 * The unflagged expression is the exact one it replaces. This is an extraction:
 * had the constants drifted during the move, every dot on the page would have
 * changed brightness with nothing to say so.
 */

/** What exempts a node from the idle fade. Absent flags mean "no exemption". */
export interface NodeFadeFlags {
  /** The search (or the open file) is pointing at this node. */
  readonly matched?: boolean;
  /** An attention rule fired on this path and nobody has dismissed it. */
  readonly alarmed?: boolean;
}

/** The floor: a fully idle node keeps this much of its colour, never nothing. */
const IDLE_FLOOR = 0.35;
/** What warmth buys back on top of the floor. Floor + range is exactly 1. */
const IDLE_RANGE = 0.65;

/**
 * The factor a node's colour is multiplied by this frame.
 *
 * A degenerate `opacity` is clamped rather than propagated: `NaN` reaching
 * `multiplyScalar` blanks the dot outright, and a blank dot in a graph of
 * thousands is not a symptom anybody can trace back to here. It is read as a
 * fully idle node — the quietest possible lie — instead of as an invisible one.
 *
 * @param opacity The node's idle channel, nominally 0..1.
 * @param flags What exempts it; `{}` is the ordinary node.
 */
export function nodeOpacityFactor(opacity: number, flags: NodeFadeFlags): number {
  if (flags.alarmed === true || flags.matched === true) return 1;
  const warmth = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 0;
  return IDLE_FLOOR + IDLE_RANGE * warmth;
}
