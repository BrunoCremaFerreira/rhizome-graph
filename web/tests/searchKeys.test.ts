/**
 * Contract tests (RED) for the search key bindings.
 *
 * A seeded project puts hundreds of nodes on screen and there is no way to find
 * one: the user has to recognise a dot. Search fixes that, but the shortcut that
 * opens it is a decision, and decisions taken inside `renderer.ts` need a GL
 * context and cannot be tested -- so the mapping from a key event to a command
 * lives in a pure module, the same way `view.ts` and `labels.ts` do.
 *
 * The trap this module exists to avoid: once the field is open the user is
 * TYPING. A plain "f" is a character, not a command, and a handler that reacts
 * to bare letters would make the field unusable -- every match letter would
 * reopen or re-trigger the search. Only modified keys and the navigation keys
 * mean anything, and the navigation keys only while the field is open.
 *
 * Expected to FAIL until src/searchKeys.ts exists.
 *
 * One failure reason per test.
 *
 * A second defect motivates the `fileFocused` parameter and the `"openFile"`
 * command. Search walks the camera onto a file and then stops there: the only
 * way to see what is INSIDE the file just found is to abandon the keyboard, aim
 * at a dot in a moving force layout and click it. Enter is the key that already
 * means "act on the thing under the cursor" everywhere else, and while the walk
 * has a file focused it is free -- so it opens the viewer, exactly as the click
 * does. Three boundaries hold that from spreading:
 *
 *  - F3 keeps meaning "walk to the next match" even with a file focused, or
 *    stepping through matches would throw a modal over the graph on every step;
 *  - Enter with nothing focused keeps today's meaning, "next";
 *  - focus is not a reason to claim a key while the box is CLOSED -- Enter then
 *    still belongs to the rest of the page.
 *
 * A third defect motivates `shiftKey`. The branch above answers "open" for ANY
 * ctrl/meta plus a key that lowercases to "f", and `SearchKeyEvent` cannot even
 * SEE a shift -- so ctrl+shift+F opens the name box. That chord is being freed
 * for the content search, and a binding added while this holds either sits
 * behind the name search in the chain and never fires, or sits in front of it
 * and silently changes what the assertions above describe. A shifted ctrl+F
 * must answer null and fall through to whoever is next.
 *
 * The field is OPTIONAL, and that half is a compile-time claim rather than a
 * runtime one: `key()` below builds objects without it, so a required field
 * would turn one semantic change into a diff across every case in this file.
 * Absent means false, which is the unshifted meaning.
 */

import { describe, it, expect } from "vitest";
import { interpretSearchKey } from "../src/searchKeys";

/** A key event reduced to what the binding actually looks at. */
function key(k: string, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
  return { key: k, ctrlKey: mods.ctrlKey ?? false, metaKey: mods.metaKey ?? false };
}

/**
 * The same reduction, plus the shift the binding is gaining sight of.
 *
 * Deliberately NOT folded into `key()` above: that helper is what the pinned
 * cases are written against, and widening it would edit them by proxy. It is
 * also a function rather than an inline literal at the call site because an
 * object literal carrying `shiftKey` is an excess-property error against
 * today's `SearchKeyEvent` -- and this test must fail on its assertion, not on
 * a type it is waiting for.
 */
function shiftedKey(k: string, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
  return {
    key: k,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    shiftKey: true,
  };
}

const OPEN = true;
const CLOSED = false;

/** The F3 walk is sitting on a file -- `SearchState.frame === "active"`. */
const FILE_FOCUSED = true;
const NO_FILE = false;

describe("interpretSearchKey", () => {
  it("opens the search on ctrl+f", () => {
    expect(interpretSearchKey(key("f", { ctrlKey: true }), CLOSED, NO_FILE)).toBe("open");
  });

  it("opens the search on cmd+f, which is the shortcut a mac user reaches for", () => {
    expect(interpretSearchKey(key("f", { metaKey: true }), CLOSED, NO_FILE)).toBe("open");
  });

  it("opens on ctrl+F, because a held shift capitalises the reported key", () => {
    // The browser reports `key` after the modifiers are applied, so caps lock or
    // a stray shift would otherwise silently disable the shortcut.
    expect(interpretSearchKey(key("F", { ctrlKey: true }), CLOSED, NO_FILE)).toBe("open");
  });

  it("still answers open when the search is already showing, so the field can be refocused", () => {
    expect(interpretSearchKey(key("f", { ctrlKey: true }), OPEN, NO_FILE)).toBe("open");
  });

  it("still answers open on ctrl+f while a file is focused", () => {
    // "open" is the SEARCH BOX; the viewer is "openFile". A focused file must
    // not turn the shortcut that summons the field into something else.
    expect(interpretSearchKey(key("f", { ctrlKey: true }), OPEN, FILE_FOCUSED)).toBe("open");
  });

  it("still answers open on cmd+f while a file is focused", () => {
    expect(interpretSearchKey(key("f", { metaKey: true }), OPEN, FILE_FOCUSED)).toBe("open");
  });

  it("steps to the next match on F3 while the search is open", () => {
    expect(interpretSearchKey(key("F3"), OPEN, NO_FILE)).toBe("next");
  });

  it("keeps stepping on F3 even while the walk has a file focused", () => {
    // The defect this guards, and the reason Enter and F3 had to part ways:
    // walking must never become opening, or a user stepping through matches
    // gets a modal thrown over the graph on every single step.
    expect(interpretSearchKey(key("F3"), OPEN, FILE_FOCUSED)).toBe("next");
  });

  it("ignores F3 when no search is running, since there is nothing to step through", () => {
    expect(interpretSearchKey(key("F3"), CLOSED, NO_FILE)).toBe(null);
  });

  it("steps to the next match on Enter when no file is focused", () => {
    expect(interpretSearchKey(key("Enter"), OPEN, NO_FILE)).toBe("next");
  });

  it("opens the focused file on Enter while the search is open", () => {
    expect(interpretSearchKey(key("Enter"), OPEN, FILE_FOCUSED)).toBe("openFile");
  });

  it("ignores Enter when the search is closed", () => {
    expect(interpretSearchKey(key("Enter"), CLOSED, NO_FILE)).toBe(null);
  });

  it("ignores Enter when the search is closed even if a file is focused", () => {
    // Focus is not a reason to claim a key the page owns: with the box shut,
    // Enter belongs to whatever else is listening.
    expect(interpretSearchKey(key("Enter"), CLOSED, FILE_FOCUSED)).toBe(null);
  });

  it("closes the search on Escape", () => {
    expect(interpretSearchKey(key("Escape"), OPEN, NO_FILE)).toBe("close");
  });

  it("ignores Escape when the search is closed, leaving the key to the rest of the page", () => {
    expect(interpretSearchKey(key("Escape"), CLOSED, NO_FILE)).toBe(null);
  });

  it("treats a bare f as a character to type, not as a command", () => {
    // The defect this guards: with the field open, typing the letter f in
    // "footer.ts" would otherwise re-fire the open command on every keystroke.
    expect(interpretSearchKey(key("f"), OPEN, NO_FILE)).toBe(null);
  });

  it("ignores an ordinary letter whether or not the search is open", () => {
    expect(interpretSearchKey(key("a"), OPEN, NO_FILE)).toBe(null);
    expect(interpretSearchKey(key("a"), CLOSED, NO_FILE)).toBe(null);
  });

  it("ignores a modified key that is not the search shortcut", () => {
    // ctrl+a, ctrl+c and friends belong to the browser and to the input.
    expect(interpretSearchKey(key("a", { ctrlKey: true }), OPEN, NO_FILE)).toBe(null);
  });

  it("leaves ctrl+shift+F to the rest of the page when the box is closed", () => {
    // The chord the content search claims. Today the shift is invisible here
    // and the name box answers first, which is the whole defect.
    expect(interpretSearchKey(shiftedKey("F", { ctrlKey: true }), CLOSED, NO_FILE)).toBe(null);
  });

  it("leaves ctrl+shift+F alone even while the name search is already open", () => {
    // Openness must not become a claim on the key: a user who has the name box
    // up is exactly the user most likely to reach for the content search next.
    expect(interpretSearchKey(shiftedKey("F", { ctrlKey: true }), OPEN, NO_FILE)).toBe(null);
  });

  it("leaves cmd+shift+F alone, since a mac user reaches for the same chord", () => {
    expect(interpretSearchKey(shiftedKey("F", { metaKey: true }), CLOSED, NO_FILE)).toBe(null);
  });

  it("still opens on a ctrl+f that names no shiftKey at all", () => {
    // The optional half, asserted at compile time as much as at run time: an
    // event object with no `shiftKey` property must remain a legal
    // `SearchKeyEvent` and must still mean "open". A required field would make
    // this line -- and every case above it -- a type error.
    expect(interpretSearchKey({ key: "f", ctrlKey: true, metaKey: false }, CLOSED, NO_FILE)).toBe(
      "open",
    );
  });
});
