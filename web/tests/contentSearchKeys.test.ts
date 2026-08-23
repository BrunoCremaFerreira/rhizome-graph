/**
 * Contract tests (RED) for the content search's key binding.
 *
 * The defect: `ctrl+shift+F` currently opens the NAME search. `interpretSearchKey`
 * answers "open" for any ctrl/meta plus a key that lowercases to "f", so the two
 * searches collide on one chord -- whichever the page consults second never
 * fires. R5 taught the name binding to see the shift and decline; this module is
 * what picks the chord up. Neither half is any use without the other.
 *
 * Like `searchKeys.ts`, this is a pure table because the alternative is a
 * decision taken inside `renderer.ts`, which needs a GL context and cannot be
 * tested. It reads a keyboard event and two facts -- is the bar open, and does
 * the field disagree with what was last submitted -- and nothing else. `dirty`
 * is passed IN for the same reason `fileFocused` is: the state machine knows it,
 * the binding must stay a table of keys.
 *
 * Three traps this exists to avoid:
 *
 *  - **A bare letter is a character, not a command.** With the field open the
 *    user is typing; a handler reacting to unmodified letters would re-fire the
 *    shortcut on every keystroke. A held shift does not change that -- typing a
 *    capital F into the field must stay a capital F.
 *  - **Every key answers null while the bar is closed**, the rule `fileViewKeys`
 *    and `fileViewClicks` both state. Escape, Enter and F3 belong to the rest of
 *    the page until the bar is up; a live handler would swallow them.
 *  - **Enter has to mean two things, and the state decides which.** The content
 *    search is submitted rather than typed live (decision 5), so Enter over a
 *    changed query means "ask", and over an unchanged one means "walk". One key
 *    that goes dead half the time would be worse than either.
 *
 * Note the unshifted ctrl+F is declined here, open or closed: it belongs to the
 * name search, and only one search is armed at a time (decision 4), so it is
 * main.ts that closes this bar when the other opens -- not this table.
 *
 * Expected to FAIL until src/contentSearchKeys.ts exists.
 *
 * One failure reason per test.
 */

import { describe, it, expect } from "vitest";
import { interpretContentSearchKey } from "../src/contentSearchKeys";

/**
 * A key event reduced to what the binding looks at.
 *
 * All four fields are always supplied: this binding turns on the shift, so an
 * event that omitted it would be pinning an optionality the module has no
 * reason to offer.
 */
function key(
  k: string,
  mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {},
) {
  return {
    key: k,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    shiftKey: mods.shiftKey ?? false,
  };
}

const OPEN = true;
const CLOSED = false;

/** The field disagrees with the query the results describe. */
const DIRTY = true;
const CLEAN = false;

describe("interpretContentSearchKey", () => {
  it("opens the content search on ctrl+shift+F", () => {
    expect(interpretContentSearchKey(key("F", { ctrlKey: true, shiftKey: true }), CLOSED, CLEAN)).toBe("open");
  });

  it("opens on cmd+shift+F, which is the chord a mac user reaches for", () => {
    expect(interpretContentSearchKey(key("F", { metaKey: true, shiftKey: true }), CLOSED, CLEAN)).toBe("open");
  });

  it("opens on a lowercase f too, since the reported key depends on the layout", () => {
    // The browser reports `key` with the modifiers applied, but not every
    // keyboard layout capitalises it -- so the letter is compared folded.
    expect(interpretContentSearchKey(key("f", { ctrlKey: true, shiftKey: true }), CLOSED, CLEAN)).toBe("open");
  });

  it("still answers open when the bar is already showing, so the field can be refocused", () => {
    expect(interpretContentSearchKey(key("F", { ctrlKey: true, shiftKey: true }), OPEN, CLEAN)).toBe("open");
  });

  it("still answers open on the chord while the field holds an unsubmitted query", () => {
    // Refocusing is not submitting: dirtiness is Enter's business, never the
    // opening chord's.
    expect(interpretContentSearchKey(key("F", { ctrlKey: true, shiftKey: true }), OPEN, DIRTY)).toBe("open");
  });

  it("leaves an unshifted ctrl+f to the name search, whose chord it is", () => {
    expect(interpretContentSearchKey(key("f", { ctrlKey: true }), CLOSED, CLEAN)).toBe(null);
  });

  it("leaves an unshifted ctrl+f alone even while the content bar is open", () => {
    // Only one search is armed at a time, and it is main.ts that swaps them.
    // A binding that claimed the chord here would make the name search
    // unreachable for as long as this bar was up.
    expect(interpretContentSearchKey(key("f", { ctrlKey: true }), OPEN, CLEAN)).toBe(null);
  });

  it("leaves an unshifted cmd+f alone as well", () => {
    expect(interpretContentSearchKey(key("f", { metaKey: true }), CLOSED, CLEAN)).toBe(null);
  });

  it("ignores a shifted modifier chord on some other letter", () => {
    // ctrl+shift+A and friends belong to the browser and to the input.
    expect(interpretContentSearchKey(key("A", { ctrlKey: true, shiftKey: true }), OPEN, CLEAN)).toBe(null);
  });

  it("submits on Enter while the field disagrees with the last submission", () => {
    expect(interpretContentSearchKey(key("Enter"), OPEN, DIRTY)).toBe("submit");
  });

  it("steps to the next occurrence on Enter once the field matches the results", () => {
    // The key never goes dead: with nothing new to ask, Enter walks.
    expect(interpretContentSearchKey(key("Enter"), OPEN, CLEAN)).toBe("next");
  });

  it("steps to the next occurrence on F3", () => {
    expect(interpretContentSearchKey(key("F3"), OPEN, CLEAN)).toBe("next");
  });

  it("steps on F3 even while the field holds an unsubmitted query", () => {
    // F3 is the stepping key and only the stepping key. Making it submit when
    // dirty would strand a user mid-word with a round trip they did not ask
    // for, and would leave no key that walks the results still on screen.
    expect(interpretContentSearchKey(key("F3"), OPEN, DIRTY)).toBe("next");
  });

  it("closes the bar on Escape", () => {
    expect(interpretContentSearchKey(key("Escape"), OPEN, CLEAN)).toBe("close");
  });

  it("closes the bar on Escape even with an unsubmitted query in the field", () => {
    expect(interpretContentSearchKey(key("Escape"), OPEN, DIRTY)).toBe("close");
  });

  it("ignores Enter while the bar is closed, leaving the key to the rest of the page", () => {
    expect(interpretContentSearchKey(key("Enter"), CLOSED, CLEAN)).toBe(null);
  });

  it("ignores Enter while the bar is closed even if the last field text was dirty", () => {
    // Dirtiness is not a claim on a key: with the bar shut, Enter belongs to
    // whatever else is listening.
    expect(interpretContentSearchKey(key("Enter"), CLOSED, DIRTY)).toBe(null);
  });

  it("ignores F3 while the bar is closed, since there is nothing to step through", () => {
    expect(interpretContentSearchKey(key("F3"), CLOSED, CLEAN)).toBe(null);
  });

  it("ignores Escape while the bar is closed", () => {
    // The docked panel and the name search both want this key; a content
    // binding that answered here would take it from whichever runs later.
    expect(interpretContentSearchKey(key("Escape"), CLOSED, CLEAN)).toBe(null);
  });

  it("treats a bare f as a character to type, not as a command", () => {
    expect(interpretContentSearchKey(key("f"), OPEN, CLEAN)).toBe(null);
  });

  it("treats a shifted F with no ctrl or meta as a capital letter being typed", () => {
    // The exact keystroke that puts a capital F in the field. Claiming it
    // would make the query unwritable.
    expect(interpretContentSearchKey(key("F", { shiftKey: true }), OPEN, CLEAN)).toBe(null);
  });

  it("ignores an ordinary letter whether or not the bar is open", () => {
    expect(interpretContentSearchKey(key("a"), OPEN, CLEAN)).toBe(null);
    expect(interpretContentSearchKey(key("a"), CLOSED, CLEAN)).toBe(null);
  });
});
