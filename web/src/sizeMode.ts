/**
 * The state machine behind the size colour mode (F7).
 *
 * Colour in this page has always been a pure function of one path -- an
 * extension in {@link ./colors}, an author's hash for a flash -- evaluated in
 * the renderer's per-frame loop. This mode is not that: it is a ROUND TRIP.
 * The browser cannot stat the disk, so the page asks, a walk of the whole tree
 * answers, and the answer is a WHOLE DISTRIBUTION that has to be turned into
 * one colour per node before the next frame is drawn. Every step of that --
 * three phases, the refusal of a late answer, the directories the frame never
 * names, the two scales, the map the renderer is handed -- is a decision, and a
 * decision taken in `main.ts` carries no test by doctrine while one taken in
 * `renderer.ts` needs a GL context and cannot be tested at all. So the machine
 * lives here, pure, beside {@link ./search}, {@link ./contentSearch} and
 * {@link ./fileView}. Every transition returns a NEW state; nothing is mutated.
 *
 * It is not folded into {@link ./sizeColor}: that module is a ramp and a scale,
 * both pure functions of numbers, and the legend will want them without wanting
 * a state machine. It is not folded into {@link ./simulation} either: the sizes
 * are an answer ABOUT the tree, not part of it, and a `bytes` field on `SimNode`
 * would put a value with a lifetime of its own beside four channels the tick
 * decays.
 *
 * Five rules carry it, and each is the answer to a way this could fail:
 *
 *  - **A late answer is refused by identity.** F7 toggles over a request that
 *    takes a tree walk to answer, and a `reset` closes the mode outright, so an
 *    answer routinely arrives for a mode that is no longer pending -- keyed, in
 *    the `ctrl+L` case, by the paths of a project the user has left. Adopting it
 *    repaints the entire graph from a measurement of somewhere else.
 *    {@link applySizes} therefore returns the SAME REFERENCE whenever the phase
 *    is not `pending`, the idiom `applyView` established in {@link ./fileView},
 *    where `if (next !== state)` is the caller's whole adoption test.
 *  - **The toggle is unconditional; only the transition decides what is sent.**
 *    Leaving the mode is not a question, and F7 pressed while a walk is in
 *    flight CLOSES without sending -- which is what un-wedges a mode whose
 *    request was refused and will never be answered.
 *    {@link shouldRequest} is that rule as a pure function, so `main.ts` holds a
 *    call and not a comparison.
 *  - **Directories are aggregated here, from the file entries alone.** The
 *    daemon does not list directories; the graph materialises them from their
 *    children's paths, and this module uses the same ancestor rule. It
 *    deliberately does NOT consult the live node list: the answer describes the
 *    tree the daemon walked, so a directory the browser has and the walk never
 *    measured gets no colour at all, which is the correct statement.
 *  - **Two scales, built independently.** A directory is the sum of its files,
 *    so on the files' own scale two thirds of them land in the hottest fifth and
 *    the colour says only "directories are big", which is not information.
 *  - **The colours are built once, on adoption**, and {@link sizeColors} answers
 *    `null` unless the mode is armed. ONE value means "the mode is off", so the
 *    renderer needs no second boolean and the two cannot get out of step; and
 *    its per-frame cost stays one `Map.get` rather than a ramp evaluated per
 *    node per frame.
 */

import type { SizesResult } from "./protocol";
import type { SizeScale } from "./sizeColor";
import { buildScale, formatBytes, rampColor, scalePosition } from "./sizeColor";

/** Off, waiting for a walk to come back, or holding a measurement. */
export type SizeModePhase = "closed" | "pending" | "armed";

export interface SizeModeState {
  /** Which of the three states the mode is in. */
  readonly phase: SizeModePhase;
  /** The scale the files are read against, `null` when there are none. */
  readonly fileScale: SizeScale | null;
  /** The scale the aggregated directories are read against, `null` when there are none. */
  readonly dirScale: SizeScale | null;
  /** Path -> packed `0xRRGGBB`; empty while the mode is not armed. */
  readonly colors: ReadonlyMap<string, number>;
  /** Whether the daemon cut the walk short. */
  readonly truncated: boolean;
  /** Why the daemon could not answer, or `""` when it could. */
  readonly error: string;
}

/** The mode as it starts, and as every close returns it. */
export function createSizeMode(): SizeModeState {
  return {
    phase: "closed",
    fileScale: null,
    dirScale: null,
    colors: new Map(),
    truncated: false,
    error: "",
  };
}

/**
 * Ask for a walk: `closed` becomes `pending`.
 *
 * Any other phase returns the SAME REFERENCE, so a second call while a walk is
 * in flight changes nothing and sends nothing -- the state-machine half of "a
 * held F7 must not flood the daemon", the binding being the other half.
 */
export function requestSizes(state: SizeModeState): SizeModeState {
  if (state.phase !== "closed") return state;
  return { ...state, phase: "pending" };
}

/**
 * Put the mode away.
 *
 * What it lands on has to be indistinguishable from never having armed it: a
 * map keyed by another project's paths is the failure this prevents. Closing
 * also settles a walk still in flight, because the state it lands on is not
 * `pending` and {@link applySizes} refuses everything else.
 */
export function closeSizeMode(_state: SizeModeState): SizeModeState {
  return createSizeMode();
}

/**
 * F7: `closed` enters the mode, everything else leaves it.
 *
 * Unconditional on purpose. A toggle out of `pending` closes and asks for
 * nothing, which is how a mode whose request was refused is escaped rather than
 * wedged; {@link shouldRequest} is what tells the caller which of the two just
 * happened.
 */
export function toggleSizeMode(state: SizeModeState): SizeModeState {
  return state.phase === "closed" ? requestSizes(state) : closeSizeMode(state);
}

/** Is the mode holding a measurement the renderer can paint? */
export function isArmed(state: SizeModeState): boolean {
  return state.phase === "armed";
}

/**
 * Did this transition cross `closed -> pending`, and therefore owe the daemon a
 * command? Every other crossing owes it nothing.
 */
export function shouldRequest(before: SizeModeState, after: SizeModeState): boolean {
  return before.phase === "closed" && after.phase === "pending";
}

/**
 * The renderer's channel: the colours to paint, or `null` while the mode is off.
 *
 * An armed mode over an empty project answers an EMPTY MAP, not `null` -- the
 * mode is on and nothing was measured, which is a different statement from the
 * mode being off.
 */
export function sizeColors(state: SizeModeState): ReadonlyMap<string, number> | null {
  return isArmed(state) ? state.colors : null;
}

/**
 * Every proper prefix of a path, outermost first -- the same rule the graph
 * materialises its directory nodes by, so what is coloured is exactly what is
 * drawn. A top-level file has none.
 */
function ancestorDirs(path: string): string[] {
  const parts = path.split("/").filter((p) => p.length > 0);
  const dirs: string[] = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    dirs.push(parts.slice(0, i + 1).join("/"));
  }
  return dirs;
}

/**
 * Adopt a measurement, if the mode is still waiting for one.
 *
 * From `pending` this is where the whole answer is turned into colour: the
 * directories are summed from their children's paths, the files and the
 * directories each get a scale of their own, and every path in the answer plus
 * every directory it implies is written into one map. It costs tens of
 * milliseconds once per press, which is the right side of the per-frame line.
 *
 * From `closed` or `armed` it returns the SAME REFERENCE and does not so much as
 * rebuild the map -- a late answer must leave what the renderer is holding
 * exactly as it is.
 *
 * A frame with no files is an ANSWER, not an error: it arms with no scales and
 * no colours, because dropping it would leave the mode pending forever with
 * nothing on screen to explain why the key does nothing.
 */
export function applySizes(state: SizeModeState, frame: SizesResult): SizeModeState {
  if (state.phase !== "pending") return state;

  const dirBytes = new Map<string, number>();
  for (const entry of frame.files) {
    for (const dir of ancestorDirs(entry.path)) {
      dirBytes.set(dir, (dirBytes.get(dir) ?? 0) + entry.bytes);
    }
  }

  // Two distributions, never one: a directory is ranked among directories.
  const fileScale = buildScale(frame.files.map((entry) => entry.bytes));
  const dirScale = buildScale([...dirBytes.values()]);

  const colors = new Map<string, number>();
  if (fileScale !== null) {
    for (const entry of frame.files) {
      colors.set(entry.path, rampColor(scalePosition(fileScale, entry.bytes)));
    }
  }
  if (dirScale !== null) {
    for (const [dir, bytes] of dirBytes) {
      colors.set(dir, rampColor(scalePosition(dirScale, bytes)));
    }
  }

  return {
    phase: "armed",
    fileScale,
    dirScale,
    colors,
    truncated: frame.truncated,
    error: frame.error,
  };
}

/** What the two rows are called on screen. */
const FILE_ROW_LABEL = "files";
const DIR_ROW_LABEL = "directories";

/** One scale as the legend prints it: what it measures, and its three anchors. */
export interface SizeLegendRow {
  /** Which of the two scales this row is -- three byte counts do not say so themselves. */
  readonly label: string;
  /** The p10, where the ramp is coldest. */
  readonly cold: string;
  /** The median. The ramp is HINGED here, which is why a row has three values and not two. */
  readonly mid: string;
  /** The p90, where the ramp is hottest. */
  readonly hot: string;
}

/** The whole strip: a row per scale, plus what the walk could not do. */
export interface SizeLegend {
  /**
   * The file row, `null` exactly when there are no numbers to print -- beside
   * an {@link error}, or over an answer that measured nothing. The same
   * statement {@link dirs} makes for a flat project.
   */
  readonly files: SizeLegendRow | null;
  /** The directory row, `null` for a flat project -- a row of zeros would be a lie. */
  readonly dirs: SizeLegendRow | null;
  /** Whether the daemon cut the walk short: the colours are a distribution over PART of the tree. */
  readonly truncated: boolean;
  /** Why the walk failed, or `""`. When it is set, both rows are gone. */
  readonly error: string;
}

/** A scale's three anchors, formatted, or `null` when there is no such scale. */
function legendRow(label: string, scale: SizeScale | null): SizeLegendRow | null {
  if (scale === null) return null;
  return {
    label,
    // The ONE byte formatter, so what the legend prints and what the daemon
    // measured cannot drift into two spellings of the same number.
    cold: formatBytes(scale.coldBytes),
    mid: formatBytes(scale.midBytes),
    hot: formatBytes(scale.hotBytes),
  };
}

/** A legend with nothing to print but why: an error REPLACES the rows. */
function rowlessLegend(state: SizeModeState): SizeLegend {
  return {
    files: null,
    dirs: null,
    truncated: state.truncated,
    error: state.error,
  };
}

/**
 * What the colours on screen are worth in bytes, or `null` while the mode is
 * not armed.
 *
 * The ramp is ROOT-RELATIVE and MEDIAN-HINGED (decisions 6 and 8), so red means
 * "far up THIS project's own distribution" and nothing else: the same file is
 * blue in one project and red in another, and a factor of ten below the median
 * moves the colour a different distance than a factor of ten above it. A
 * spectrum whose anchors are not printed states nothing at all, which is why
 * this exists.
 *
 * Three rules, each the answer to a plausible wrong implementation:
 *
 *  - **Not armed, no legend.** Formatting whatever scale happens to be on the
 *    state paints a strip of stale numbers over a graph that is already back in
 *    extension colours, or a caption for a walk that has not answered yet.
 *  - **Two rows, because there are two scales.** A directory is ranked among
 *    directories, so one strip would be a lie about half the dots on screen.
 *  - **A failure replaces the rows.** Anchors printed beside an error read as a
 *    measurement that succeeded, over a fraction of the tree nobody can name.
 */
export function sizeLegend(state: SizeModeState): SizeLegend | null {
  if (!isArmed(state)) return null;
  if (state.error !== "") return rowlessLegend(state);

  const files = legendRow(FILE_ROW_LABEL, state.fileScale);
  // Nothing was measured, so there is nothing to be the middle of: the answer
  // is the same rowless strip, without an error to explain it.
  if (files === null) return rowlessLegend(state);

  return {
    files,
    dirs: legendRow(DIR_ROW_LABEL, state.dirScale),
    truncated: state.truncated,
    error: state.error,
  };
}
