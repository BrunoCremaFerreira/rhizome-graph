/**
 * Contract tests (RED) for the size-mode key binding (F7).
 *
 * Two defects, and the second is the one worth the module.
 *
 * The easy half is that no binding claims F7 anywhere -- not in `searchKeys`,
 * `contentSearchKeys`, `rootKeys` or `fileViewKeys`. The hard half is that a
 * held F7 auto-repeats at roughly 30 Hz, and if every repeat toggled, every
 * second one would RE-ENTER the mode and fire a `sizes` command: a ~290 ms
 * walk in the executor shared with `scan_tree`, `file_view` and
 * `content_search`, plus a `json.dumps` on the daemon's loop, about fifteen
 * times a second. Holding a key is not hostile use -- it is what happens when
 * somebody rests a finger while reading -- and the result is a daemon whose
 * executor is saturated and whose other viewers' file clicks go unanswered,
 * from a cause invisible in every log this project writes. So the binding
 * declines a repeat, and the state machine separately declines to send while a
 * request is in flight. Either alone would cover the common case; both is what
 * survives someone mashing the key.
 *
 * This binding takes NO `open` parameter, and that absence is the point: it is
 * the only unconditional binding on the page. F7 must work with the file panel
 * open, with the root bar focused, and with either search bar taking
 * keystrokes, because "all other functionality keeps working normally" cuts
 * both ways. That is what earns it first position in `main.ts`'s keydown
 * chain, above `interpretFileViewKey` -- the chain below it is ordered by
 * CONTESTED keys, and a binding that contests nothing takes no part in that
 * argument.
 *
 * First position is also the risk, and the last group here is the guard on it.
 * A future contested key added to this module would silently outrank the
 * modal's Escape. So Escape, Enter and F3 are declined BY NAME rather than by a
 * blanket "some other key" case: widening this binding later has to break a
 * test that says the key it is stealing out loud.
 *
 * Every modifier is required on `SizeKeyEvent`, unlike the optional `shiftKey`
 * of `SearchKeyEvent` -- that optionality exists only to avoid a compile error
 * across a pinned test file, and a new module has nothing to preserve.
 *
 * Expected to FAIL until src/sizeKeys.ts exists.
 *
 * One failure reason per test.
 */

import { describe, it, expect } from "vitest";
import { interpretSizeKey } from "../src/sizeKeys";

/** A key event reduced to what the binding looks at. All fields are required. */
function key(
  k: string,
  mods: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    repeat?: boolean;
  } = {},
) {
  return {
    key: k,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    altKey: mods.altKey ?? false,
    repeat: mods.repeat ?? false,
  };
}

describe("interpretSizeKey: the one key it claims", () => {
  it("toggles the size colour mode on a bare F7", () => {
    expect(interpretSizeKey(key("F7"))).toBe("toggle");
  });
});

describe("interpretSizeKey: a modified F7 belongs to whoever binds it next", () => {
  it("declines ctrl+F7", () => {
    expect(interpretSizeKey(key("F7", { ctrlKey: true }))).toBe(null);
  });

  it("declines shift+F7", () => {
    expect(interpretSizeKey(key("F7", { shiftKey: true }))).toBe(null);
  });

  it("declines alt+F7", () => {
    expect(interpretSizeKey(key("F7", { altKey: true }))).toBe(null);
  });

  it("declines meta+F7", () => {
    expect(interpretSizeKey(key("F7", { metaKey: true }))).toBe(null);
  });
});

describe("interpretSizeKey: a held key is not a toggle", () => {
  it("declines an auto-repeating F7", () => {
    // Held down, F7 repeats at ~30 Hz. Every second repeat would re-enter the
    // mode, and each entry is a `sizes` command: a ~290 ms walk in the shared
    // executor, fifteen times a second, for a finger resting on a key.
    expect(interpretSizeKey(key("F7", { repeat: true }))).toBe(null);
  });
});

describe("interpretSizeKey: the guard on first position in the chain", () => {
  it("leaves Escape to the file panel, which is directly below it in the chain", () => {
    expect(interpretSizeKey(key("Escape"))).toBe(null);
  });

  it("leaves Enter to the search that opens the file the walk is resting on", () => {
    expect(interpretSizeKey(key("Enter"))).toBe(null);
  });

  it("leaves F3 to the two searches, which both step with it", () => {
    expect(interpretSizeKey(key("F3"))).toBe(null);
  });

  it("leaves a bare letter alone, because somewhere a field is being typed into", () => {
    expect(interpretSizeKey(key("f"))).toBe(null);
  });

  it("leaves ctrl+f to the name search", () => {
    expect(interpretSizeKey(key("f", { ctrlKey: true }))).toBe(null);
  });

  it("leaves ctrl+shift+f to the content search", () => {
    expect(interpretSizeKey(key("F", { ctrlKey: true, shiftKey: true }))).toBe(null);
  });

  it("declines the function keys either side of its own", () => {
    // F6 and F8 are unclaimed today, which is exactly why a binding that
    // matched on "starts with F" would pass every other test in this file.
    expect([interpretSizeKey(key("F6")), interpretSizeKey(key("F8"))]).toEqual([null, null]);
  });
});
