/**
 * Contract tests (RED) for WHERE the file viewer panel sits.
 *
 * The defect: `#file-view` has exactly one placement and it is a full-window
 * modal -- `position: fixed; inset: 0` over a 0.72-alpha backdrop. Even with the
 * backdrop unpainted the container swallows every click meant for a file dot, so
 * the panel buries the graph it is pointing at. That is tolerable for a click
 * (the user asked for one file and is reading it) and intolerable for the
 * content search, where `F3` walks from hit to hit and each step would throw a
 * modal over the tree. The search needs the SAME panel docked to the right, with
 * the graph still visible and still clickable behind it.
 *
 * So the state machine gains one field, `placement`, and the painter turns it
 * into one class; the stylesheet does the rest. Two properties carry the weight:
 *
 *  - **Modal unless something asks otherwise.** Every existing caller passes two
 *    arguments and must keep getting the modal it has always got, and no
 *    transition may lose the placement it was handed. `closeView` returns to
 *    modal because the next opener is a click until proven otherwise.
 *  - **A late answer must not undock the panel.** The content is a ROUND TRIP:
 *    the request opens the panel and the daemon's frame lands milliseconds
 *    later. `applyView` rebuilding the state without the placement would flip a
 *    docked panel into a modal mid-read -- the same race this module already
 *    guards for the path, with a failure that is visual instead of silent.
 *
 * Expected to FAIL until `placement` exists: today `createFileView().placement`
 * is `undefined` and `requestView` takes no third argument.
 */

import { describe, it, expect } from "vitest";
import {
  createFileView,
  requestView,
  applyView,
  applyTokens,
  failView,
  closeView,
  type CodeChunk,
  type FileViewPlacement,
  type FileViewState,
} from "../src/fileView";
import type { FileView } from "../src/protocol";

/** The file every scenario below is about. */
const PATH = "a.txt";

/** The daemon's answer for {@link PATH}. */
const ANSWER: FileView = {
  path: PATH,
  mode: "text",
  content: "one line\n",
  truncated: false,
  error: "",
};

/** Tokens describing {@link ANSWER}'s content, so `applyTokens` adopts them. */
const TOKENS: readonly CodeChunk[] = [[[{ text: "one line", color: "#d4d4d4", italic: false, bold: false }]]];

/** A panel waiting on the daemon's answer, opened with the given placement. */
function pending(placement?: FileViewPlacement): FileViewState {
  const fresh = createFileView();
  return placement === undefined ? requestView(fresh, PATH) : requestView(fresh, PATH, placement);
}

describe("8.1 -- the panel is modal unless something asks otherwise", () => {
  it("opens a fresh panel as a modal", () => {
    expect(createFileView().placement).toBe("modal");
  });

  it("keeps a request that names no placement modal", () => {
    expect(pending().placement).toBe("modal");
  });

  it("keeps the placement when the daemon's answer arrives", () => {
    expect(applyView(pending(), ANSWER).placement).toBe("modal");
  });

  it("keeps the placement when the syntax tokens are adopted", () => {
    const shown = applyView(pending(), ANSWER);
    expect(applyTokens(shown, ANSWER.content, TOKENS).placement).toBe("modal");
  });

  it("keeps the placement when there is nothing to show", () => {
    expect(failView(pending(), "not a text file").placement).toBe("modal");
  });

  it("returns to modal once the panel is dismissed", () => {
    expect(closeView(pending("docked")).placement).toBe("modal");
  });
});

describe("8.2 -- a caller may dock the panel beside the graph", () => {
  it("opens docked when the request asks for it", () => {
    expect(pending("docked").placement).toBe("docked");
  });

  it("stays docked when the answer lands after the request", () => {
    expect(applyView(pending("docked"), ANSWER).placement).toBe("docked");
  });
});
