/**
 * What of an agent's own sentence this page is willing to draw.
 *
 * The graph answers *where* an agent is working and never *why*; the caption is
 * the one line that answers *why*, and it is the first thing on this page
 * rasterised from a string a language model wrote. `rhizome_graph/agentstate.py`
 * holds the same rule under the names `safe_caption` and `MAX_CAPTION_CHARS`,
 * and a reader who calls this module redundant with it has read only half the
 * path.
 *
 * **Two conditions on one path, never two paths.** The daemon's cap bounds the
 * wire and protects a browser of another version; this one bounds the canvas and
 * protects the page from a DAEMON of another version, or from one nobody here
 * wrote — a page is pointed at a daemon by `ssh -L`, through a proxy, or from a
 * different release, and `CLAUDE.md` records that `vite.config.ts` "handed the
 * whole LAN a gate that says 127.0.0.1" for exactly this class of reason.
 * Neither condition is a second route to the sink and neither stands in for the
 * other.
 *
 * Deliberately not in `protocol.ts`, whose job is "is this frame well-formed":
 * a cap is a POLICY about drawing rather than a validation of the wire, the same
 * split that keeps `truncateMiddle` a helper rather than part of `parseStatus`.
 * And deliberately not in `renderer.ts`, which needs a GL context and carries no
 * unit test by doctrine, so a rule taken there is a rule that silently loses its
 * coverage.
 *
 * **Deliberately NOT done: no HTML escaping and no quoting.** The sink is a
 * canvas and `ctx.fillText` cannot execute markup, so escaping here would be a
 * defence against a sink this feature does not have — which is how a reader
 * concludes the real sink was never thought about. If anyone later routes a
 * caption to a DOM element, `textContent` is the rule and `fileViewHud.ts`
 * states it.
 *
 * The two languages share no code — there is no code path between them — so the
 * only thing keeping one rule from becoming two is the fixture table asserted in
 * `tests/test_agent_caption.py` and in `web/tests/agentCaption.test.ts`, in the
 * same order with the same expectations. **The two test files are edited
 * together.**
 */

import type { AgentStateModel } from "./agentState";

/**
 * How long a caption may be, in CODE POINTS.
 *
 * The daemon holds the same number and the two are pinned to each other through
 * the shared table's three boundary cases rather than by this comment. 60 rather
 * than `MAX_ACTOR_LABEL_CHARS`'s 24, which cuts most clauses mid-verb; 60 rather
 * than 200, because at the label font a 60-character caption is already most of
 * a screen wide at the graph's usual zoom. It is also the number the pixel bound
 * at the sink is sized against: 60 × `MAX_FONT_PIXELS` at a full-width glyph
 * plus padding is 3 872 px, under `MAX_LABEL_TEXTURE_PX`, and
 * `web/tests/labelTextureBound.test.ts` is what stops either being retuned
 * alone.
 */
export const MAX_CAPTION_CHARS = 60;

/** The mark a cut caption ends with, exactly as `actorDisplayName` spells it. */
const ELLIPSIS = "…";

/**
 * The bidirectional marks, embeddings, overrides and isolates, named one by one.
 *
 * `ctx.fillText` runs the platform's bidirectional algorithm, so a right-to-left
 * override inside a caption reverses the visual order of everything after it —
 * and the caption sits directly under the agent's own name, which is the one
 * string on this page a user trusts to say who is acting. The blast radius is a
 * graph rather than a credential, which is why this is a fold and not an alarm;
 * it costs one character class to remove and there is no case for keeping it.
 * Spelled out rather than described, because this is the class a later "simplify
 * the fold" drops first.
 */
const BIDI_CONTROLS = new Set([
  "\u200e", // LEFT-TO-RIGHT MARK
  "\u200f", // RIGHT-TO-LEFT MARK
  "\u202a", // LEFT-TO-RIGHT EMBEDDING
  "\u202b", // RIGHT-TO-LEFT EMBEDDING
  "\u202c", // POP DIRECTIONAL FORMATTING
  "\u202d", // LEFT-TO-RIGHT OVERRIDE
  "\u202e", // RIGHT-TO-LEFT OVERRIDE
  "\u2066", // LEFT-TO-RIGHT ISOLATE
  "\u2067", // RIGHT-TO-LEFT ISOLATE
  "\u2068", // FIRST STRONG ISOLATE
  "\u2069", // POP DIRECTIONAL ISOLATE
]);

/**
 * What of a caption may be drawn: folded, then capped, head kept.
 *
 * The order is fixed and each stage has its own reason.
 *
 * **A C0 or C1 control folds to a SPACE.** `ctx.fillText` does not break lines:
 * a newline is handed to the platform shaper and comes back as a missing-glyph
 * box or as nothing at all, and the caption silently stops being one line of
 * legible text. So a control is not a formatting request, it is noise — but it
 * is noise *between* words, and removing it outright would glue two words the
 * model wrote separately into one it never wrote.
 *
 * **A bidirectional control is REMOVED.** Those are zero-width and sit *inside*
 * words, so a separator there would break a word in half.
 *
 * **Runs of whitespace collapse and the ends are stripped.** After the two
 * removals a caption can be mostly spaces, and a cap counted over a string of
 * spaces is a wide empty texture hanging under a figure — which reads as a
 * rendering fault rather than as silence.
 *
 * **Then** cap, at {@link MAX_CAPTION_CHARS} CODE POINTS, keeping the head.
 * Capping first would count characters that are about to be removed and hand
 * back an ellipsis over a caption that was never too long. Head-kept rather than
 * a middle cut: `truncateMiddle` exists for paths, where both ends carry
 * information, while a caption is a clause whose head is the verb and its object
 * — the reasoning `actorDisplayName` already records for the agent's own name.
 *
 * The cut counts code points and never UTF-16 units, which is the one place the
 * two languages could quietly disagree about the same string: a `slice(0, 59)`
 * on units lands inside a surrogate pair and leaves a lone surrogate the browser
 * draws as a replacement mark, while Python would have kept the character whole.
 *
 * The fold is written as a **removal**, never as a replacement of one class by
 * another, which is what makes it idempotent — the daemon has already applied
 * the same rule, and a fold that was not idempotent would turn defence in depth
 * into a caption mangled once per layer it passes. It is a fold of *dangerous*
 * characters and not an ASCII filter: accented Latin, CJK and emoji are ordinary
 * text somebody wants to read.
 *
 * Total, because the frame came off the network: anything that is not text is
 * nothing to draw, and throwing would take down every other agent's state with
 * it.
 */
export function safeCaption(text: string): string {
  if (typeof text !== "string") return "";

  let folded = "";
  // `for...of` walks CODE POINTS, so an astral character is one iteration and is
  // never split into its surrogates on the way through the fold.
  for (const char of text) {
    if (BIDI_CONTROLS.has(char)) continue;
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      folded += " ";
      continue;
    }
    folded += char;
  }

  // One known and harmless divergence from the daemon: JavaScript counts U+FEFF
  // as whitespace and Python does not, so the browser drops one more invisible
  // character than the wire did. The direction is the safe one — what is removed
  // could not have been seen — and it touches no pair of the shared table.
  const collapsed = folded.replace(/\s+/g, " ").trim();

  const points = Array.from(collapsed);
  if (points.length <= MAX_CAPTION_CHARS) return collapsed;
  return points.slice(0, MAX_CAPTION_CHARS - 1).join("") + ELLIPSIS;
}

/**
 * The caption to draw under one agent's figure, or `""`.
 *
 * The renderer takes an answer and never a question — the `setSizeColors` shape
 * — so this selector is the whole of what it knows about captions, and it is
 * therefore also where the browser's condition is actually applied.
 *
 * An agent the model does not hold answers `""`, and so does one the daemon
 * reported without a caption: an empty caption is a published fact, meaning
 * *nothing is in progress*, and it reaches the renderer as an instruction to
 * draw nothing rather than as a missing answer.
 */
export function captionFor(state: AgentStateModel, agent: string): string {
  return safeCaption(state.byAgent.get(agent)?.caption ?? "");
}
