/**
 * Contract tests (RED) for the size mode's legend.
 *
 * The defect: the ramp has no absolute meaning and nothing on screen says so.
 * The scale is ROOT-RELATIVE and MEDIAN-HINGED (decisions 6 and 8 of
 * `docs/features/todo/size-mode.md`), so red means "far up THIS project's own
 * distribution" and nothing else -- the same file is blue in one project and
 * red in another, and below the median a factor of ten moves the colour a
 * different distance than a factor of ten above it. A spectrum whose anchors
 * are not printed is decorative: the user sees a graph change colour and can
 * read no number off it.
 *
 * Four properties, and each is what a plausible wrong implementation gets
 * wrong.
 *
 *  - **A legend for a mode that is not armed describes nothing.** This one is
 *    written first. The obvious implementation formats whatever scale happens
 *    to be on the state, which paints a strip of stale numbers over a graph
 *    that has already gone back to extension colours -- a caption for a mode
 *    that is off, or for a walk that has not answered yet.
 *  - **The three labels are the scale's own p10, median and p90, in that
 *    order.** They are the only thing that makes the hinge readable; printed in
 *    the wrong order they claim the ramp runs the other way.
 *  - **Two rows, because there are two scales.** A directory is the sum of its
 *    files and is ranked among directories, so one strip would be a lie about
 *    half the dots on screen. A flat project has no directory scale and must
 *    get no second row rather than a row of zeros.
 *  - **What the walk could not do is part of the legend.** A truncated walk
 *    coloured a cut tree, and the user has to be told; an error must REPLACE
 *    the rows, because numbers printed beside a failure read as a measurement
 *    that succeeded.
 *
 * Expected to FAIL until `sizeLegend` is exported from `web/src/sizeMode.ts`.
 */

import { describe, it, expect } from "vitest";
import {
  createSizeMode,
  applySizes,
  toggleSizeMode,
  closeSizeMode,
  sizeLegend,
} from "../src/sizeMode";
import type { SizeModeState, SizeLegend, SizeLegendRow } from "../src/sizeMode";
import { buildScale, formatBytes } from "../src/sizeColor";
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

/** A state in `pending`, reached the only way the page can reach it. */
function pendingMode(): SizeModeState {
  return toggleSizeMode(createSizeMode());
}

/** A state in `armed`, holding the given measurement. */
function armedMode(
  files: Record<string, number>,
  extra: { truncated?: boolean; error?: string } = {},
): SizeModeState {
  return applySizes(pendingMode(), frameOf(files, extra));
}

/** The legend of a state that must have one; a `null` here is the failure. */
function legendOf(state: SizeModeState): SizeLegend {
  const legend = sizeLegend(state);
  if (legend === null) throw new Error("expected a legend for an armed mode");
  return legend;
}

/**
 * The file row of a legend that must have one; a `null` here is the failure.
 *
 * The same shape as {@link legendOf}, one level down. `sizeLegend` answers a
 * legend with NO file row on the error path -- which the test at the bottom of
 * this file pins -- so every read of the row is a read of something that can be
 * absent, and a test that reached through it would report a missing row as a
 * `TypeError` on an unrelated line instead of as the assertion it meant.
 *
 * The widening is deliberate: it holds whether `SizeLegend.files` is declared
 * `SizeLegendRow` or the honest `SizeLegendRow | null`.
 */
function fileRowOf(legend: SizeLegend): SizeLegendRow {
  const files: SizeLegendRow | null = legend.files;
  if (files === null) throw new Error("expected a file row for a measured legend");
  return files;
}

/**
 * Eleven top-level files, no directories at all, with the three anchors of the
 * file scale landing on distinct values in three different units -- so a row
 * printed in the wrong order cannot read as the right one.
 *
 * `buildScale` takes percentiles by plain rank, so with eleven entries the
 * anchors are the sorted values at indexes 1, 5 and 9: 1024, 65536 and
 * 5242880 bytes.
 */
const FLAT_PROJECT: Record<string, number> = {
  LICENSE: 100,
  "a.txt": 1024,
  "b.txt": 2000,
  "c.txt": 3000,
  "d.txt": 4000,
  "e.txt": 65536,
  "f.txt": 70000,
  "g.txt": 80000,
  "h.txt": 90000,
  "i.bin": 5242880,
  "j.bin": 9999999,
};

/** The anchors of {@link FLAT_PROJECT}'s file scale, cold to hot. */
const FLAT_FILE_LABELS = ["1.0 KiB", "64.0 KiB", "5.0 MiB"];

/**
 * Six directories of two equal files each, so the two scales are different
 * distributions of the same tree: every directory is exactly twice either of
 * its files, and the two sets of anchors share no value.
 *
 * Files sorted: 2048 2048 4096 4096 8192 8192 16384 16384 32768 32768 65536
 * 65536 -- twelve entries, so the anchors are indexes 1, 5 and 9.
 * Directories sorted: 4096 8192 16384 32768 65536 131072 -- six entries, so the
 * anchors are indexes 0, 2 and 4.
 */
const NESTED_PROJECT: Record<string, number> = {
  "src/a.ts": 2048,
  "src/b.ts": 2048,
  "docs/a.md": 4096,
  "docs/b.md": 4096,
  "web/a.js": 8192,
  "web/b.js": 8192,
  "tests/a.py": 16384,
  "tests/b.py": 16384,
  "assets/a.png": 32768,
  "assets/b.png": 32768,
  "vendor/a.bin": 65536,
  "vendor/b.bin": 65536,
};

/** The anchors of {@link NESTED_PROJECT}'s file scale, cold to hot. */
const NESTED_FILE_LABELS = ["2.0 KiB", "8.0 KiB", "32.0 KiB"];

/** The anchors of {@link NESTED_PROJECT}'s DIRECTORY scale, cold to hot. */
const NESTED_DIR_LABELS = ["4.0 KiB", "16.0 KiB", "64.0 KiB"];

// ---------------------------------------------------------------------------
// 9.1 -- a legend for a mode that is not armed describes nothing.
// Written first: it is the only property that fails silently on screen, as a
// caption nobody can connect to anything the graph is currently doing.
// ---------------------------------------------------------------------------

describe("sizeLegend: a mode that is not armed describes nothing", () => {
  it("answers null before the mode has ever been opened", () => {
    expect(sizeLegend(createSizeMode())).toBeNull();
  });

  it("answers null while the walk is still in flight", () => {
    // Pending is the phase with the longest wall-clock life -- a walk of the
    // whole tree -- so a legend here is the one a user would actually see, and
    // it would describe a measurement that has not happened.
    expect(sizeLegend(pendingMode())).toBeNull();
  });

  it("answers null for a closed mode that still carries a scale", () => {
    // The obvious wrong implementation: format whatever scale is on the state.
    // Nothing in the phase check is exercised unless the state it refuses has
    // something to print.
    const stale: SizeModeState = {
      phase: "closed",
      fileScale: buildScale([100, 1024, 65536]),
      dirScale: buildScale([2048, 4096, 8192]),
      colors: new Map([["a.txt", 0x3b6dff]]),
      truncated: false,
      error: "",
    };

    expect(sizeLegend(stale)).toBeNull();
  });

  it("answers null for a pending mode that still carries a scale", () => {
    const stale: SizeModeState = {
      phase: "pending",
      fileScale: buildScale([100, 1024, 65536]),
      dirScale: buildScale([2048, 4096, 8192]),
      colors: new Map([["a.txt", 0x3b6dff]]),
      truncated: false,
      error: "",
    };

    expect(sizeLegend(stale)).toBeNull();
  });

  it("answers a legend once the mode is armed", () => {
    // The other half of the guard: the null above must not be unconditional.
    expect(sizeLegend(armedMode(FLAT_PROJECT))).not.toBeNull();
  });

  it("stops answering the moment the mode is closed again", () => {
    // F7 twice. The strip must leave the screen with the colours it explains.
    const armed = armedMode(FLAT_PROJECT);

    expect(sizeLegend(closeSizeMode(armed))).toBeNull();
    expect(sizeLegend(toggleSizeMode(armed))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9.2 -- the file row prints the file scale's own three anchors, in order.
// ---------------------------------------------------------------------------

describe("sizeLegend: the file row is the file scale's three anchors", () => {
  it("prints the p10, the median and the p90 in that order", () => {
    // Cold to hot, left to right, the way the ramp runs. Three distinct units
    // so a transposed row cannot pass.
    const legend = legendOf(armedMode(FLAT_PROJECT));
    const files = fileRowOf(legend);

    expect([files.cold, files.mid, files.hot]).toEqual(FLAT_FILE_LABELS);
  });

  it("prints exactly what formatBytes prints for the scale on the state", () => {
    // The legend must read the scale it was handed, not recompute a
    // distribution of its own: two definitions of the median is the drift this
    // pins shut.
    const state = armedMode(NESTED_PROJECT);
    const scale = state.fileScale;
    if (scale === null) throw new Error("the fixture has files, so it has a file scale");
    const legend = legendOf(state);
    const files = fileRowOf(legend);

    expect(files.cold).toBe(formatBytes(scale.coldBytes));
    expect(files.mid).toBe(formatBytes(scale.midBytes));
    expect(files.hot).toBe(formatBytes(scale.hotBytes));
    expect([files.cold, files.mid, files.hot]).toEqual(NESTED_FILE_LABELS);
  });

  it("carries a label saying which of the two scales the row is", () => {
    // The wording is the painter's business; that the row is named at all is
    // not, because an unnamed row of three byte counts is the same strip twice.
    const legend = legendOf(armedMode(FLAT_PROJECT));
    const files = fileRowOf(legend);

    expect(files.label.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 9.3 -- two scales mean two rows, and a flat project means one.
// ---------------------------------------------------------------------------

describe("sizeLegend: the directory row is a second scale, not a copy", () => {
  it("answers no directory row for a project with no directories", () => {
    // There is no directory scale to print. A row of zeros here would be a
    // measurement of nothing, presented as a measurement.
    const legend = legendOf(armedMode(FLAT_PROJECT));

    expect(legend.dirs).toBeNull();
  });

  it("prints the directory scale's own three anchors when there are directories", () => {
    const state = armedMode(NESTED_PROJECT);
    const scale = state.dirScale;
    if (scale === null) throw new Error("the fixture has directories, so it has a directory scale");
    const legend = legendOf(state);
    const dirs = legend.dirs;
    if (dirs === null) throw new Error("expected a directory row for a project with directories");

    expect([dirs.cold, dirs.mid, dirs.hot]).toEqual(NESTED_DIR_LABELS);
    expect(dirs.cold).toBe(formatBytes(scale.coldBytes));
    expect(dirs.mid).toBe(formatBytes(scale.midBytes));
    expect(dirs.hot).toBe(formatBytes(scale.hotBytes));
  });

  it("gives the directory row values the file row does not have", () => {
    // A directory is ranked among directories, so over this fixture the two
    // rows share no anchor at all. Both rows built from the file scale is the
    // failure -- and it is invisible on screen, since both rows would look
    // perfectly plausible.
    const legend = legendOf(armedMode(NESTED_PROJECT));
    const files = fileRowOf(legend);
    const dirs = legend.dirs;
    if (dirs === null) throw new Error("expected a directory row for a project with directories");

    expect(dirs.cold).not.toBe(files.cold);
    expect(dirs.mid).not.toBe(files.mid);
    expect(dirs.hot).not.toBe(files.hot);
  });

  it("names the two rows differently", () => {
    const legend = legendOf(armedMode(NESTED_PROJECT));
    const files = fileRowOf(legend);
    const dirs = legend.dirs;
    if (dirs === null) throw new Error("expected a directory row for a project with directories");

    expect(dirs.label.length).toBeGreaterThan(0);
    expect(dirs.label).not.toBe(files.label);
  });
});

// ---------------------------------------------------------------------------
// 9.4 -- what the walk could not do belongs on the legend.
// ---------------------------------------------------------------------------

describe("sizeLegend: a cut walk and a failed one", () => {
  it("reports a walk the daemon cut short", () => {
    // The colours are a distribution over a TRUNCATED tree: every anchor is
    // computed from the part that was measured, and the user cannot tell that
    // from the ramp itself.
    const legend = legendOf(armedMode(FLAT_PROJECT, { truncated: true }));

    expect(legend.truncated).toBe(true);
  });

  it("reports a complete walk as complete", () => {
    const legend = legendOf(armedMode(FLAT_PROJECT));

    expect(legend.truncated).toBe(false);
  });

  it("carries the daemon's own reason when the walk failed", () => {
    const legend = legendOf(armedMode({}, { error: "root is gone" }));

    expect(legend.error).toBe("root is gone");
  });

  it("replaces the rows with the error rather than printing numbers beside it", () => {
    // A partial answer the daemon could not finish. Anchors printed under a
    // failure read as a measurement that worked, and the numbers describe a
    // fraction of the tree nobody can name.
    const legend = legendOf(armedMode({ "a.txt": 10, "b/c.txt": 20 }, { error: "walk failed" }));

    expect(legend.error).toBe("walk failed");
    expect(legend.files).toBeNull();
    expect(legend.dirs).toBeNull();
  });

  it("reports no error at all for a walk that answered", () => {
    const legend = legendOf(armedMode(FLAT_PROJECT));

    expect(legend.error).toBe("");
  });
});
