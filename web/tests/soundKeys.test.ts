/**
 * Contract tests (RED) for the ambient-sound key binding (F9).
 *
 * Nothing on the page answers F9, and the toggle has nowhere to live until
 * something does. This module is `sizeKeys.ts` and `statsKeys.ts` line for
 * line: all fields required, no `open` parameter, two declines, one command.
 *
 * The absence of an `open` parameter is the point. Sound has to toggle with the
 * file viewer open, with the root bar focused and with either search bar taking
 * keystrokes -- the states a listener is MOST likely to be in when a noise
 * starts being unwelcome -- so the binding is conditional on nothing, and that
 * is what earns it a place beside F7 and F8 at the top of `main.ts`'s keydown
 * chain, above the modal's Escape. The chain below is ordered by CONTESTED
 * keys, and a binding that contests nothing takes no part in that argument.
 *
 * FIRST POSITION IS ALSO THE WHOLE RISK, and the last group here is the guard
 * on it: every key that is not a bare, non-repeating F9 is declined BY NAME, so
 * a contested key widened into this module later has to break a test that says
 * out loud which key it is stealing. F7 and F8 are the two that matter most --
 * both are live bindings on this page today, both sit immediately above this
 * one, and a binding that matched on "starts with an F" would pass every other
 * test in this file while silently taking the size mode and the session summary
 * off the keyboard.
 *
 * A REPEAT IS NOT A TOGGLE, and here the reason is sharper than F7's or F8's.
 * Held down, F9 repeats at roughly 30 Hz, and every second repeat would
 * construct or suspend an `AudioContext` -- a real platform resource with a
 * construction cost and a browser-imposed limit on how many may exist, not a
 * state field. Resting a finger on a key while reading is not hostile use.
 *
 * Every modifier is required on `SoundKeyEvent`, unlike the optional `shiftKey`
 * of `SearchKeyEvent`: that optionality exists only to avoid a compile error
 * across a pinned test file, and a new module has nothing to preserve.
 *
 * Expected to FAIL until src/soundKeys.ts exists.
 *
 * One failure reason per test.
 */

import { describe, it, expect } from "vitest";
import { interpretSoundKey } from "../src/soundKeys";

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

describe("interpretSoundKey: the one key it claims", () => {
  it("toggles the ambient sound on a bare F9", () => {
    expect(interpretSoundKey(key("F9"))).toBe("toggle");
  });
});

describe("interpretSoundKey: a modified F9 belongs to whoever binds it next", () => {
  it("declines ctrl+F9", () => {
    expect(interpretSoundKey(key("F9", { ctrlKey: true }))).toBe(null);
  });

  it("declines shift+F9", () => {
    expect(interpretSoundKey(key("F9", { shiftKey: true }))).toBe(null);
  });

  it("declines alt+F9", () => {
    expect(interpretSoundKey(key("F9", { altKey: true }))).toBe(null);
  });

  it("declines meta+F9", () => {
    expect(interpretSoundKey(key("F9", { metaKey: true }))).toBe(null);
  });
});

describe("interpretSoundKey: a held key is not a toggle", () => {
  it("declines an auto-repeating F9", () => {
    // Held down, F9 repeats at ~30 Hz, and every second repeat would construct
    // or suspend an `AudioContext`: a platform resource, not a state field.
    expect(interpretSoundKey(key("F9", { repeat: true }))).toBe(null);
  });

  it("declines a repeating F9 even when nothing else about it is unusual", () => {
    // The repeat decline is its own rule, not a side effect of the modifier
    // one: an implementation that only looked at modifiers would pass the test
    // above by accident if it were written with one set.
    expect(interpretSoundKey(key("F9", { repeat: true, ctrlKey: false }))).toBe(null);
  });
});

describe("interpretSoundKey: the guard on first position in the chain", () => {
  it("leaves F7 to the size colour mode, which sits above it", () => {
    expect(interpretSoundKey(key("F7"))).toBe(null);
  });

  it("leaves F8 to the session summary, which sits between the two", () => {
    expect(interpretSoundKey(key("F8"))).toBe(null);
  });

  it("leaves F3 to the two searches, which both step with it", () => {
    expect(interpretSoundKey(key("F3"))).toBe(null);
  });

  it("leaves Tab to focus traversal and to the root bar's completion", () => {
    expect(interpretSoundKey(key("Tab"))).toBe(null);
  });

  it("leaves Escape to the file panel, which is below it in the chain", () => {
    expect(interpretSoundKey(key("Escape"))).toBe(null);
  });

  it("leaves Enter to the search that opens the file the walk is resting on", () => {
    expect(interpretSoundKey(key("Enter"))).toBe(null);
  });

  it("leaves a bare letter alone, because somewhere a field is being typed into", () => {
    expect(interpretSoundKey(key("f"))).toBe(null);
  });

  it("leaves ctrl+f to the name search", () => {
    expect(interpretSoundKey(key("f", { ctrlKey: true }))).toBe(null);
  });

  it("leaves ctrl+shift+f to the content search", () => {
    expect(interpretSoundKey(key("F", { ctrlKey: true, shiftKey: true }))).toBe(null);
  });

  it("declines the function keys either side of its own", () => {
    // F6 and F10 are unclaimed today, which is exactly why a binding that
    // matched on "starts with F" would pass every other test in this file.
    expect([interpretSoundKey(key("F6")), interpretSoundKey(key("F10"))]).toEqual([
      null,
      null,
    ]);
  });
});
