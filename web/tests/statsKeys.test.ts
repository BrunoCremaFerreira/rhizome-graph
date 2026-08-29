/**
 * Contract tests (RED) for the session-stats key binding (F8).
 *
 * The panel answers "what did this session actually do?", and nothing on the
 * page opens it. The brief proposed `Tab`; the plan refuses it, and the refusal
 * is the reason this module looks the way it does. `Tab` is focus traversal
 * across four focusable things -- the two search inputs, the root input and the
 * viewer's close button -- so a binding that `preventDefault`s it takes keyboard
 * navigation off the page, and vitest here runs `environment: "node"` with no
 * jsdom, so no test on this host could ever catch that. `Tab` is also already
 * claimed CONDITIONALLY by `interpretRootKey` while the root bar is open, so a
 * stats binding would have to sit below the root bar in the chain and consult
 * another box's state -- which is precisely what `sizeKeys.ts` earns its first
 * position by NOT doing.
 *
 * So F8, and this module is `sizeKeys.ts` line for line: all fields required, no
 * `open` parameter, two declines, one command. The absence of an `open`
 * parameter is the point -- the panel has to toggle with the file viewer open,
 * with the root bar focused and with either search bar taking keystrokes, for
 * the same reason F7 must -- and that is what puts it at the top of `main.ts`'s
 * keydown chain, above the modal's Escape. The chain below is ordered by
 * CONTESTED keys, and a binding that contests nothing takes no part in that
 * argument.
 *
 * FIRST POSITION IS ALSO THE WHOLE RISK, and the last group here is the guard on
 * it: every key that is not a bare, non-repeating F8 is declined BY NAME, so a
 * contested key widened into this module later has to break a test that says out
 * loud which key it is stealing. 6.1 passing without 6.4 is a binding that can
 * silently outrank the modal.
 *
 * A repeat is not a toggle. Held down, F8 repeats at roughly 30 Hz. Unlike F7
 * this toggle sends nothing to the daemon, so the cost is not a tree walk -- it
 * is a panel flickering fifteen times a second, which is its own defect, and
 * resting a finger on a key while reading is not hostile use.
 *
 * Every modifier is required on `StatsKeyEvent`, unlike the optional `shiftKey`
 * of `SearchKeyEvent`: that optionality exists only to avoid a compile error
 * across a pinned test file, and a new module has nothing to preserve.
 *
 * Expected to FAIL until src/statsKeys.ts exists.
 *
 * One failure reason per test.
 */

import { describe, it, expect } from "vitest";
import { interpretStatsKey } from "../src/statsKeys";

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

describe("interpretStatsKey: the guard on first position in the chain", () => {
  // Written first, and it is the reason the module exists in this shape: a
  // binding that sits above the modal must claim exactly one key, and the only
  // way a test can say that is to enumerate the keys it must not claim.

  it("leaves F7 to the size colour mode, which sits beside it at the top", () => {
    // The nearest neighbour, and the one a "starts with F" match would steal
    // while every other test in this file stayed green.
    expect(interpretStatsKey(key("F7"))).toBe(null);
  });

  it("leaves Tab to the browser and to the root bar, which is the whole of decision 9", () => {
    expect(interpretStatsKey(key("Tab"))).toBe(null);
  });

  it("leaves Escape to the file panel, which is directly below it in the chain", () => {
    expect(interpretStatsKey(key("Escape"))).toBe(null);
  });

  it("leaves Enter to the search that opens the file the walk is resting on", () => {
    expect(interpretStatsKey(key("Enter"))).toBe(null);
  });

  it("leaves F3 to the two searches, which both step with it", () => {
    expect(interpretStatsKey(key("F3"))).toBe(null);
  });

  it("leaves a bare letter alone, because somewhere a field is being typed into", () => {
    expect(interpretStatsKey(key("f"))).toBe(null);
  });

  it("leaves ctrl+f to the name search", () => {
    expect(interpretStatsKey(key("f", { ctrlKey: true }))).toBe(null);
  });

  it("leaves ctrl+shift+f to the content search", () => {
    expect(interpretStatsKey(key("F", { ctrlKey: true, shiftKey: true }))).toBe(null);
  });

  it("leaves ctrl+l to the observed-root bar", () => {
    expect(interpretStatsKey(key("l", { ctrlKey: true }))).toBe(null);
  });

  it("declines the function keys either side of its own", () => {
    // F9 is unclaimed today, which is exactly why a binding that matched on
    // "an F followed by a digit" would pass every other test here.
    expect([interpretStatsKey(key("F6")), interpretStatsKey(key("F9"))]).toEqual([null, null]);
  });
});

describe("interpretStatsKey: the one key it claims", () => {
  it("toggles the session stats panel on a bare F8", () => {
    expect(interpretStatsKey(key("F8"))).toBe("toggle");
  });
});

describe("interpretStatsKey: a modified F8 belongs to whoever binds it next", () => {
  it("declines ctrl+F8", () => {
    expect(interpretStatsKey(key("F8", { ctrlKey: true }))).toBe(null);
  });

  it("declines shift+F8", () => {
    expect(interpretStatsKey(key("F8", { shiftKey: true }))).toBe(null);
  });

  it("declines alt+F8", () => {
    expect(interpretStatsKey(key("F8", { altKey: true }))).toBe(null);
  });

  it("declines meta+F8", () => {
    expect(interpretStatsKey(key("F8", { metaKey: true }))).toBe(null);
  });
});

describe("interpretStatsKey: a held key is not a toggle", () => {
  it("declines an auto-repeating F8", () => {
    // Held down, F8 repeats at ~30 Hz. Every repeat would toggle, and a panel
    // opening and closing fifteen times a second is the defect -- there is no
    // daemon round trip here to make it worse, and none to make it acceptable.
    expect(interpretStatsKey(key("F8", { repeat: true }))).toBe(null);
  });

  it("declines a repeating F8 even when nothing else about it is unusual", () => {
    // Stated separately from the modifier group because the two declines have
    // different reasons and a later implementation could drop either one.
    expect(interpretStatsKey(key("F8", { repeat: true, ctrlKey: false }))).toBe(null);
  });
});
