/**
 * What a key press means to the content search bar (ctrl+shift+F).
 *
 * A pure table, for the reason {@link ./searchKeys} is one: the alternative is a
 * decision taken inside `renderer.ts`, which needs a GL context and cannot be
 * unit-tested. It reads a keyboard event and two facts -- is the bar open, and
 * does the field disagree with what was last submitted -- and nothing else.
 * `dirty` is passed IN exactly as `fileFocused` is: the state machine in
 * {@link ./contentSearch} knows it, and the binding stays a table of keys.
 *
 * Three traps this exists to avoid:
 *
 *  - **A bare letter is a character, not a command.** With the field open the
 *    user is typing, and a handler reacting to unmodified letters would re-fire
 *    on every keystroke. A held shift does not change that: a capital F typed
 *    into the field must stay a capital F.
 *  - **Every key answers `null` while the bar is closed**, the rule
 *    `fileViewKeys` and `fileViewClicks` both state. Escape, Enter and F3 belong
 *    to the rest of the page until the bar is up, and a live handler would
 *    swallow them.
 *  - **Enter has to mean two things, and the state decides which.** The search
 *    is submitted rather than typed live, so Enter over a changed query means
 *    "ask" and over an unchanged one means "walk". A key that went dead half the
 *    time would be worse than either. F3, by contrast, always steps: making it
 *    submit while dirty would strand a user mid-word with a round trip nobody
 *    asked for, and would leave no key that walks the results still on screen.
 *
 * The UNSHIFTED ctrl+F is declined here, open or closed. It belongs to the name
 * search, and only one search is armed at a time -- it is `main.ts` that closes
 * this bar when the other opens, not this table. Claiming the chord here would
 * make the name search unreachable for as long as this bar was up.
 */

/**
 * The slice of a keyboard event the binding looks at.
 *
 * `shiftKey` is REQUIRED, unlike in {@link ./searchKeys}: this binding turns on
 * the shift, so an event that omitted it would be pinning an optionality the
 * module has no reason to offer.
 */
export interface ContentSearchKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/** What the caller should do, or `null` to leave the key to the page. */
export type ContentSearchCommand = "open" | "submit" | "next" | "close";

/**
 * @param open  whether the bar is showing and taking keystrokes.
 * @param dirty whether the field disagrees with the query the results describe.
 */
export function interpretContentSearchKey(
  event: ContentSearchKeyEvent,
  open: boolean,
  dirty: boolean,
): ContentSearchCommand | null {
  if (event.ctrlKey || event.metaKey) {
    // The browser reports `key` with the modifiers already applied, and not
    // every layout capitalises it, so the letter is compared folded. Reopening
    // is how the field is refocused, so the chord answers whatever `open` is.
    if (!event.shiftKey) return null; // Unshifted ctrl+F is the name search.
    return event.key.toLowerCase() === "f" ? "open" : null;
  }

  // Everything below is a command only while the bar is showing.
  if (!open) return null;
  if (event.key === "F3") return "next";
  if (event.key === "Enter") return dirty ? "submit" : "next";
  if (event.key === "Escape") return "close";
  return null;
}
