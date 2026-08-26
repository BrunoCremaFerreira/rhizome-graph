/**
 * Contract tests (RED) for the size colour mode's state machine.
 *
 * The defect: arming a colour mode that is a ROUND TRIP has no home. Every
 * decision it needs -- the three phases, the refusal of a late answer, the
 * aggregation of directories, the two independent scales, and the colour map
 * the renderer is handed -- would otherwise land in `main.ts`, which carries no
 * test by doctrine, or in `renderer.ts`, which needs a GL context and cannot be
 * unit-tested at all. Both failures look identical from outside: the mode works
 * when you try it and nobody can say why it stopped.
 *
 * The sharpest of them is the one written first. F7 is a toggle over a request
 * that takes a walk of the whole tree to answer, and `ctrl+L` closes the mode
 * outright (the size map keys paths of a project the user has left). So an
 * answer routinely arrives for a mode that is no longer pending, and adopting
 * it repaints the entire graph from a measurement of somewhere else -- the same
 * failure `publish_status`'s root re-read and `applyView`'s two guards were
 * both written for. `applySizes` must return the SAME REFERENCE in that case,
 * so `main.ts` can refuse by identity.
 *
 * Two further properties are here because they are what a plausible wrong
 * implementation gets wrong:
 *
 *  - files and directories are scaled INDEPENDENTLY. On one shared scale two
 *    thirds of every directory lands in the hottest fifth (measured), so "every
 *    directory is red" and the colour carries no information. The fixture in
 *    5.5 makes a directory hold exactly one file, so the two carry the same
 *    byte count: on a shared scale they would be painted the same colour, and
 *    on their own scales they land at opposite ends.
 *  - a file measured at 0 bytes is MEASURED. `log1p(0)` is 0, a legitimate cold
 *    end, and treating it as an absence would leave empty files wearing the
 *    grey that means "nobody looked".
 *
 * Expected to FAIL until `web/src/sizeMode.ts` exists.
 */

import { describe, it, expect } from "vitest";
import {
  createSizeMode,
  requestSizes,
  applySizes,
  closeSizeMode,
  toggleSizeMode,
  isArmed,
  shouldRequest,
  sizeColors,
} from "../src/sizeMode";
import { UNMEASURED_COLOR } from "../src/sizeColor";
import type { SizesResult } from "../src/protocol";

/** Build an answer frame the way the daemon sends it. */
function frameOf(
  files: Record<string, number>,
  extra: { truncated?: boolean; error?: string } = {},
): SizesResult {
  return {
    files: Object.entries(files).map(([path, bytes]) => ({ path, bytes })),
    truncated: extra.truncated ?? false,
    error: extra.error ?? "",
  };
}

/** Unpack a `0xRRGGBB` into its three channels. */
function channels(color: number): { r: number; g: number; b: number } {
  return { r: (color >> 16) & 0xff, g: (color >> 8) & 0xff, b: color & 0xff };
}

/** The ramp's cold end is a blue; nothing else on it is. */
function isCold(color: number): boolean {
  const { r, b } = channels(color);
  return b > r + 32;
}

/** The ramp's hot end is a red; nothing else on it is. */
function isHot(color: number): boolean {
  const { r, b } = channels(color);
  return r > b + 32;
}

/** A state in `pending`, reached the only way the page can reach it. */
function pendingMode(): ReturnType<typeof createSizeMode> {
  return toggleSizeMode(createSizeMode());
}

/** A state in `armed`, holding the given measurement. */
function armedMode(files: Record<string, number>): ReturnType<typeof createSizeMode> {
  return applySizes(pendingMode(), frameOf(files));
}

// ---------------------------------------------------------------------------
// 5.3 -- an answer that arrives after the mode was closed changes nothing.
// Written first: it is the late-answer defence, and it is asserted by
// REFERENCE identity, because that is what `main.ts` compares.
// ---------------------------------------------------------------------------

describe("applySizes: a late answer is refused by identity", () => {
  it("returns the same state object when the mode is closed", () => {
    // The walk was in flight when F7 or a `reset` closed the mode. Adopting it
    // would arm a mode nobody asked for, from a measurement that may describe
    // another project entirely.
    const closed = createSizeMode();

    const after = applySizes(closed, frameOf({ "a.txt": 10, "b.txt": 20 }));

    expect(after).toBe(closed);
  });

  it("returns the same state object when the mode is already armed", () => {
    // A superseded answer: the mode was closed and re-armed while the first
    // walk was still running, and this is the older of the two.
    const armed = armedMode({ "a.txt": 10, "b.txt": 20, "c.txt": 30 });

    const after = applySizes(armed, frameOf({ "elsewhere/x.txt": 999 }));

    expect(after).toBe(armed);
  });

  it("adopts from pending and becomes armed", () => {
    const pending = pendingMode();

    const after = applySizes(pending, frameOf({ "a.txt": 10, "b.txt": 20, "c.txt": 30 }));

    expect(after).not.toBe(pending);
    expect(after.phase).toBe("armed");
    expect(isArmed(after)).toBe(true);
  });

  it("leaves the refused state's colours untouched", () => {
    // Not merely the same phase: the map the renderer is holding must not have
    // been rebuilt from the abandoned answer.
    const armed = armedMode({ "a.txt": 10, "b.txt": 20, "c.txt": 30 });

    const after = applySizes(armed, frameOf({ "elsewhere/x.txt": 999 }));

    expect(sizeColors(after)).toBe(sizeColors(armed));
    expect([...after.colors.keys()].sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
  });
});

// ---------------------------------------------------------------------------
// 5.1 -- the mode starts off, and one value says so.
// ---------------------------------------------------------------------------

describe("createSizeMode: the mode starts closed", () => {
  it("starts closed, unscaled and uncoloured", () => {
    const state = createSizeMode();

    expect(state.phase).toBe("closed");
    expect(state.fileScale).toBeNull();
    expect(state.dirScale).toBeNull();
    expect(state.colors.size).toBe(0);
    expect(state.truncated).toBe(false);
    expect(state.error).toBe("");
    expect(isArmed(state)).toBe(false);
  });

  it("answers null for the renderer channel while it is not armed", () => {
    // ONE value means "the mode is off", so the renderer needs no second
    // boolean and cannot get the two out of step.
    expect(sizeColors(createSizeMode())).toBeNull();
    expect(sizeColors(pendingMode())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5.2 -- the toggle is unconditional; only the transition decides what is sent.
// ---------------------------------------------------------------------------

describe("toggleSizeMode: pressing F7 again always closes", () => {
  it("takes a closed mode to pending", () => {
    expect(toggleSizeMode(createSizeMode()).phase).toBe("pending");
  });

  it("takes a pending mode to closed, so the mode can never wedge", () => {
    // A request that will never be answered -- a refused token -- is escaped by
    // pressing F7 again.
    expect(toggleSizeMode(pendingMode()).phase).toBe("closed");
  });

  it("takes an armed mode to closed", () => {
    expect(toggleSizeMode(armedMode({ "a.txt": 10, "b.txt": 20 })).phase).toBe("closed");
  });

  it("asks for a walk only on the closed to pending crossing", () => {
    // The pure half of "a held F7 must not flood the daemon": each entry into
    // the mode is a walk of the whole tree, and leaving it is not a question.
    const closed = createSizeMode();
    const pending = pendingMode();
    const armed = armedMode({ "a.txt": 10, "b.txt": 20 });

    expect(shouldRequest(closed, toggleSizeMode(closed))).toBe(true);
    expect(shouldRequest(pending, toggleSizeMode(pending))).toBe(false);
    expect(shouldRequest(armed, toggleSizeMode(armed))).toBe(false);
  });

  it("arms pending from closed and refuses to re-enter it, by reference", () => {
    // `requestSizes` is the transition itself; a second call while a walk is in
    // flight must change nothing at all.
    const closed = createSizeMode();
    const pending = requestSizes(closed);
    const armed = armedMode({ "a.txt": 10, "b.txt": 20 });

    expect(pending.phase).toBe("pending");
    expect(requestSizes(pending)).toBe(pending);
    expect(requestSizes(armed)).toBe(armed);
  });
});

// ---------------------------------------------------------------------------
// 5.4 -- directories are materialised from the paths of their children.
// ---------------------------------------------------------------------------

describe("applySizes: every ancestor directory is coloured too", () => {
  it("colours three files and both of their two directories", () => {
    // `a/b` is implicit: no entry names it, and the graph draws it because
    // `a/b/c.txt` has it as a prefix (simulation.ts's own rule). The daemon
    // does not list directories, so a mode that only coloured what the frame
    // named would leave every folder grey.
    const state = armedMode({
      "a/b/c.txt": 300,
      "a/e.txt": 200,
      "README.md": 100,
    });

    expect([...state.colors.keys()].sort()).toEqual([
      "README.md",
      "a",
      "a/b",
      "a/b/c.txt",
      "a/e.txt",
    ]);
  });

  it("gives a top-level file no directory of its own", () => {
    const state = armedMode({ "README.md": 100, "LICENSE": 200 });

    expect([...state.colors.keys()].sort()).toEqual(["LICENSE", "README.md"]);
  });
});

// ---------------------------------------------------------------------------
// 5.5 -- files and directories are on independent scales.
// ---------------------------------------------------------------------------

describe("applySizes: a directory is placed among directories", () => {
  /**
   * `hot/` holds exactly ONE file, so the directory and the file carry the
   * SAME byte count -- and that file is the largest file in the tree while its
   * directory is the smallest directory in the tree. On one shared scale the
   * two would be painted identically. On their own scales they land at
   * opposite ends of the ramp.
   */
  function twoScaleFixture(): Record<string, number> {
    return {
      "hot/one.bin": 1_000_000,
      "d1/a.txt": 400_000,
      "d1/b.txt": 400_000,
      "d1/c.txt": 400_000,
      "d2/a.txt": 500_000,
      "d2/b.txt": 500_000,
      "d2/c.txt": 500_000,
      "d3/a.txt": 600_000,
      "d3/b.txt": 600_000,
      "d3/c.txt": 600_000,
      "d4/a.txt": 700_000,
      "d4/b.txt": 700_000,
      "d4/c.txt": 700_000,
    };
  }

  it("paints the largest file and its smallest-directory parent differently", () => {
    const state = armedMode(twoScaleFixture());

    const file = state.colors.get("hot/one.bin");
    const dir = state.colors.get("hot");

    expect(file).toBeDefined();
    expect(dir).toBeDefined();
    expect(dir).not.toBe(file);
  });

  it("puts the largest file at the warm end and its parent at the cold end", () => {
    const state = armedMode(twoScaleFixture());

    expect(isHot(state.colors.get("hot/one.bin") as number)).toBe(true);
    expect(isCold(state.colors.get("hot") as number)).toBe(true);
  });

  it("puts the largest directory at the warm end although its files are not the largest", () => {
    // Every file in `d4` is smaller than `hot/one.bin`, and `d4` is still the
    // hottest directory -- which is only true if directories are ranked among
    // directories.
    const state = armedMode(twoScaleFixture());

    expect(isHot(state.colors.get("d4") as number)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5.6 -- an empty project is an answer.
// ---------------------------------------------------------------------------

describe("applySizes: a measurement of nothing", () => {
  it("arms on an empty file list with no scales and no colours", () => {
    // Dropping this frame would leave the mode pending forever, with nothing on
    // screen to explain why F7 does nothing.
    const state = applySizes(pendingMode(), frameOf({}));

    expect(state.phase).toBe("armed");
    expect(isArmed(state)).toBe(true);
    expect(state.fileScale).toBeNull();
    expect(state.dirScale).toBeNull();
    expect(state.colors.size).toBe(0);
    expect(sizeColors(state)).not.toBeNull();
  });

  it("leaves the directory scale null when every file is at the top level", () => {
    const state = armedMode({ "README.md": 100, "LICENSE": 200, "setup.py": 300 });

    expect(state.fileScale).not.toBeNull();
    expect(state.dirScale).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5.7 -- what the frame said, and how the mode is put away.
// ---------------------------------------------------------------------------

describe("applySizes: the frame's own flags, and closing", () => {
  it("carries truncated and error onto the state", () => {
    const state = applySizes(
      pendingMode(),
      frameOf({ "a.txt": 10 }, { truncated: true, error: "walk cut short" }),
    );

    expect(state.truncated).toBe(true);
    expect(state.error).toBe("walk cut short");
  });

  it("returns to the state it started in when closed", () => {
    // `ctrl+L` closes the mode, and what it lands on has to be indistinguishable
    // from never having armed it: a stale map keyed by another project's paths
    // is the failure this prevents.
    const armed = applySizes(
      pendingMode(),
      frameOf({ "a/b.txt": 10, "c.txt": 20 }, { truncated: true, error: "walk cut short" }),
    );

    expect(closeSizeMode(armed)).toEqual(createSizeMode());
    expect(sizeColors(closeSizeMode(armed))).toBeNull();
  });

  it("closes a pending mode too, settling a walk still in flight", () => {
    expect(closeSizeMode(pendingMode())).toEqual(createSizeMode());
  });
});

// ---------------------------------------------------------------------------
// 5.8 -- an empty file is measured, not absent.
// ---------------------------------------------------------------------------

describe("applySizes: identical sizes and the zero-byte file", () => {
  function zeroFixture(): Record<string, number> {
    return {
      "zero.txt": 0,
      "same-a.txt": 500,
      "same-b.txt": 500,
      "mid.txt": 5_000,
      "big.txt": 50_000,
    };
  }

  it("paints two files of identical size identically", () => {
    const state = armedMode(zeroFixture());

    expect(state.colors.get("same-a.txt")).toBe(state.colors.get("same-b.txt"));
  });

  it("gives a file measured at zero bytes a colour of its own", () => {
    // log1p(0) is 0 -- a legitimate cold end, not an absence. A mode that
    // treated it as unmeasured would leave every empty file wearing the grey
    // that means "the daemon never looked at this".
    const state = armedMode(zeroFixture());

    expect(state.colors.has("zero.txt")).toBe(true);
    expect(state.colors.get("zero.txt")).not.toBe(UNMEASURED_COLOR);
    expect(isCold(state.colors.get("zero.txt") as number)).toBe(true);
  });

  it("leaves a file the frame never named out of the map", () => {
    // This is who "unmeasured" really is: a file created since the walk. It
    // gets no entry, and the renderer paints it the grey it already has.
    const state = armedMode(zeroFixture());

    expect(state.colors.has("created-since.txt")).toBe(false);
  });
});
