/**
 * Composition root. Wires the three layers together and starts them:
 *   network (WsClient) -> model (Simulation) -> drawing (GourceRenderer)
 * Each event validated on the wire is applied to the pure model and announced
 * to the renderer for its beam/flash effect. Nothing here holds domain logic.
 */

import "./style.css";
import { createSimulation } from "./simulation";
import { createRenderer } from "./renderer";
import { createWsClient, resolveWsUrl } from "./wsClient";
import { createContextHud } from "./contextHud";
import { createEventHud } from "./eventHud";
import { createAttributionMonitor } from "./attribution";
import { createAttributionHud } from "./attributionHud";
import { createSearchHud } from "./searchHud";
import { interpretSearchKey } from "./searchKeys";
import { createRootHud } from "./rootHud";
import { interpretRootKey } from "./rootKeys";
import {
  applyCompletion,
  cancelPrompt,
  createRootPrompt,
  failPrompt,
  openPrompt,
  setText,
  type RootPromptState,
} from "./rootPrompt";
import { createFileViewHud } from "./fileViewHud";
import { createStatusHud } from "./statusHud";
import { interpretFileViewKey } from "./fileViewKeys";
import {
  applyTokens,
  applyView,
  closeView,
  createFileView,
  requestView,
  type FileViewPlacement,
  type FileViewState,
} from "./fileView";
import { buildDoc } from "./fileDoc";
import { createContentSearchHud } from "./contentSearchHud";
import { interpretContentSearchKey } from "./contentSearchKeys";
import {
  activeOccurrence,
  applyContentResults,
  closeContentSearch,
  createContentSearch,
  docMarkingFor,
  isDirty,
  matchedPaths,
  nextOccurrence,
  openContentSearch,
  requiresLoad,
  searchFrameOf,
  setContentQuery,
  submitContentSearch,
  totalMatches,
  type ContentSearchState,
} from "./contentSearch";
import { interpretSizeKey } from "./sizeKeys";
import {
  applySizes,
  closeSizeMode,
  createSizeMode,
  shouldRequest,
  sizeColors,
  sizeLegend,
  toggleSizeMode,
  type SizeModeState,
} from "./sizeMode";
import { createSizeHud } from "./sizeHud";
import {
  activePath,
  closeSearch,
  createSearchState,
  focusedFilePath,
  nextMatch,
  openSearch,
  refreshMatches,
  setQuery,
  type SearchState,
} from "./search";

function boot(): void {
  const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
  if (!canvas) throw new Error("missing #stage canvas");

  const sim = createSimulation();

  /**
   * Show a file's contents, whichever way it was asked for.
   *
   * The browser cannot read the disk, so this is a round trip; the answer comes
   * back through `onFileView`. The panel opens now, in `loading`, or the click
   * reads as one that missed and gets repeated. Shared by every way in — a dot
   * in the graph, a row in the git status panel, Enter on the name search's
   * walk and a step of the content search's — so all of them open exactly what
   * clicking the same file in the graph opens.
   *
   * Both extra parameters are defaulted to what every older caller already
   * does, and both are supplied by ONE caller, the content search's walk: it
   * wants the panel beside the graph rather than over it, and it wants the
   * file's TEXT, because a diff of a dirty file may not contain the line that
   * matched (R4). `prefer: "diff"` is what the daemon does by default, so the
   * key is sent unconditionally rather than branched on here.
   */
  function openFile(
    path: string,
    placement: FileViewPlacement = "modal",
    prefer: "diff" | "text" = "diff",
  ): void {
    client.send({ kind: "file", path, prefer });
    showFileView(requestView(fileView, path, placement));
  }

  const renderer = createRenderer(canvas, sim, {
    // The renderer reports which file was clicked and stops there; asking the
    // daemon for it and opening the panel is this layer's job.
    onFileClick: openFile,
  });
  const contextEl = document.getElementById("context");
  const contextHud = contextEl ? createContextHud(contextEl) : null;
  const logEl = document.getElementById("log");
  const eventHud = logEl ? createEventHud(logEl) : null;
  const attributionEl = document.getElementById("attribution");
  const attributionHud = attributionEl ? createAttributionHud(attributionEl) : null;
  const attribution = createAttributionMonitor();
  const searchEl = document.getElementById("search");
  const searchHud = searchEl ? createSearchHud(searchEl) : null;
  const contentSearchEl = document.getElementById("content-search");
  const contentSearchHud = contentSearchEl ? createContentSearchHud(contentSearchEl) : null;
  const rootEl = document.getElementById("root-bar");
  const rootHud = rootEl ? createRootHud(rootEl) : null;
  const fileViewEl = document.getElementById("file-view");
  const fileViewHud = fileViewEl ? createFileViewHud(fileViewEl) : null;
  const statusEl = document.getElementById("status");
  const statusHud = statusEl ? createStatusHud(statusEl, openFile) : null;
  const sizeLegendEl = document.getElementById("size-legend");
  const sizeHud = sizeLegendEl ? createSizeHud(sizeLegendEl) : null;

  // The search's whole state machine is in `search.ts`; this is just the one
  // variable holding the state it returns, and the wiring that shows it.
  let search: SearchState = createSearchState();

  function showSearch(next: SearchState): void {
    search = next;
    if (!search.open) {
      searchHud?.close();
      renderer.clearSearch();
      return;
    }
    searchHud?.setStatus(search.matches.length, search.activeIndex);
    renderer.setSearch(search.matches, activePath(search), search.frame);
  }

  // And once more for the content search. Everything it decides — what the
  // counter says, which paths light up, whether the camera frames them all or
  // approaches one — is `contentSearch.ts`'s; this is the variable and the
  // paint. Note it drives the SAME renderer channel as the name search: only
  // one of the two is ever open, so there is nothing here for the renderer to
  // learn about content searching.
  let contentSearch: ContentSearchState = createContentSearch();

  function showContentSearch(next: ContentSearchState): void {
    contentSearch = next;
    if (!contentSearch.open) {
      contentSearchHud?.close();
      renderer.clearSearch();
      return;
    }
    contentSearchHud?.setStatus({
      pending: contentSearch.pending,
      submitted: contentSearch.submitted,
      total: totalMatches(contentSearch),
      occurrence: contentSearch.occurrence,
      truncated: contentSearch.truncated,
      error: contentSearch.error,
    });
    renderer.setSearch(
      matchedPaths(contentSearch),
      activeOccurrence(contentSearch)?.path ?? null,
      searchFrameOf(contentSearch),
    );
  }

  // Same shape for the root bar: the state machine is `rootPrompt.ts`, this is
  // the variable holding what it returns plus the wiring that paints it.
  let rootPrompt: RootPromptState = createRootPrompt();
  /** The observed root, as of the last meta frame; what ctrl+L prefills. */
  let observedRoot = "";

  function showRoot(next: RootPromptState): void {
    rootPrompt = next;
    if (!rootPrompt.open) {
      rootHud?.close();
      return;
    }
    rootHud?.setText(rootPrompt.text);
    rootHud?.setMatches(rootPrompt.matches);
    rootHud?.setError(rootPrompt.error);
  }

  // And the same shape once more for the file viewer: `fileView.ts` holds the
  // state machine (including which late answers to ignore), this holds what it
  // returned and paints it.
  let fileView: FileViewState = createFileView();

  /**
   * Paint the panel, and colour it when there is colour to be had.
   *
   * The document is built once per paint (`fileDoc.ts` decides everything about
   * it, including whether the file is worth tokenizing at all), and the
   * highlighter is a dynamic import: the wasm engine and the grammar are
   * downloaded by the first file that needs them and never by the page.
   *
   * `keepScroll` belongs to exactly one caller — the repaint below, which adds
   * colour to text already on screen and must not throw the reader back to
   * line 1. Everything else is a new file, which starts at its first line.
   */
  function showFileView(next: FileViewState, keepScroll = false): void {
    fileView = next;
    if (!fileView.open) {
      fileViewHud?.close();
      // The dot in the graph stops being the one on screen at the same moment
      // the panel does.
      renderer.setOpenFile(null);
      // Nothing covers the graph any more, so the camera frames matches on the
      // whole viewport again.
      renderer.setOccludedRight(fileViewHud?.occludedFraction() ?? 0);
      return;
    }
    // The marks are the SEARCH's, not the panel's: `docMarkingFor` answers null
    // for every path the content search did not match, which is every path the
    // modal route ever opens, and the panel then behaves exactly as it did.
    const doc = buildDoc(fileView, docMarkingFor(contentSearch, fileView.path) ?? undefined);
    fileViewHud?.open();
    fileViewHud?.render(fileView, doc, keepScroll);
    renderer.setOpenFile(fileView.path);
    // Measured after the paint, because the panel has just been shown and its
    // placement class set; a docked panel hides part of the graph, and the
    // camera has to aim at what is left of it.
    renderer.setOccludedRight(fileViewHud?.occludedFraction() ?? 0);

    // Already coloured, or nothing to colour. The first half is what stops the
    // repaint below from asking again — and again.
    if (fileView.highlight !== null || doc.requests.length === 0) return;
    // The content the tokens will describe, captured before the round trip:
    // `applyTokens` compares against it and refuses everything stale.
    const forContent = fileView.content;
    void import("./highlight")
      .then(({ highlightChunks }) => highlightChunks(doc.lang, doc.requests))
      .then((chunks) => {
        if (!chunks) return;
        const coloured = applyTokens(fileView, forContent, chunks);
        // Refusal returns the same reference, so this is the whole adoption test.
        if (coloured !== fileView) showFileView(coloured, true);
      })
      // No colour is an acceptable degradation; nothing about it reaches the
      // screen, and the file is already readable without it.
      .catch(() => {});
  }

  // And the same shape for the size mode: `sizeMode.ts` owns the phases, the two
  // scales and every ramp evaluation; this is the variable holding what it
  // returned plus the one channel that paints it. `sizeColors` answers null
  // unless the mode is armed, which is how the renderer is told the mode is off
  // without learning that a mode exists.
  let sizeMode: SizeModeState = createSizeMode();

  function showSizeMode(next: SizeModeState): void {
    sizeMode = next;
    renderer.setSizeColors(sizeColors(sizeMode));
    // The same one value drives both: `sizeLegend` answers null exactly when
    // `sizeColors` does, so the strip cannot outlive the colours it explains.
    sizeHud?.render(sizeLegend(sizeMode));
  }

  const client = createWsClient(
    (event) => {
      sim.applyEvent(event);
      renderer.onEvent(event);
      eventHud?.push(event);
      attribution.observe(event);
      attributionHud?.update(eventHud?.hasEntries() ?? false, attribution.attributed());
      // The tree changed under the query: a new file may answer it and a
      // deleted one no longer exists to be framed. `refreshMatches`, not
      // `setQuery`, so the recount does not throw an F3 walk back to the
      // overview every time an event lands.
      if (search.open && search.query) showSearch(refreshMatches(search, sim.listNodes()));
    },
    resolveWsUrl(),
    {
      onMeta: (meta) => {
        observedRoot = meta.root;
        contextHud?.setMeta(meta);
      },
      // The daemon answered a Tab. `applyCompletion` decides whether the answer
      // is still the one being waited for -- it travelled the network while the
      // user kept typing -- so nothing here inspects it.
      onCompletion: (completion) => showRoot(applyCompletion(rootPrompt, completion)),
      // A refused path keeps the bar open with the text still in it, so the typo
      // can be fixed; that rule is `failPrompt`'s, not this handler's.
      onRootError: (error) => showRoot(failPrompt(rootPrompt, error.reason)),
      // A file's contents came back. `applyView` decides whether this answer is
      // still the one being waited for -- the user may have clicked elsewhere,
      // or closed the panel, while it travelled -- so nothing here inspects it.
      onFileView: (view) => showFileView(applyView(fileView, view)),
      // The daemon answered a content search. `applyContentResults` decides
      // whether this answer is still the one being waited for — the bar may
      // have been closed, or the query typed over and resubmitted, while it
      // travelled — so nothing here inspects it.
      onSearchResult: (result) => showContentSearch(applyContentResults(contentSearch, result)),
      // The walk came back. `applySizes` decides whether this answer is still
      // the one being waited for -- the mode may have been toggled off, or a
      // reset may have closed it, while it travelled -- and it is also where the
      // directories are summed and both scales are built, once per answer.
      onSizes: (frame) => showSizeMode(applySizes(sizeMode, frame)),
      // What is uncommitted right now. The frame is deduped by the daemon, so
      // this only fires when the working tree really changed.
      onStatus: (status) => statusHud?.render(status),
      onReset: () => {
        // The root changed: everything on screen belongs to the old project and
        // the new tree is already on its way.
        sim.reset();
        renderer.resetScene();
        eventHud?.clear();
        // The rows name files of the old project, and the new root's status is
        // already on its way.
        statusHud?.clear();
        // The open file was a file of the old project: its contents are now
        // about a path nobody is looking at.
        showFileView(closeView(fileView));
        // The results name files of the old project: their highlights would
        // point at nodes the new tree does not have. Closing also settles the
        // request that may still be in flight — the state it lands on is no
        // longer pending, so `applyContentResults` refuses it.
        showContentSearch(closeContentSearch(contentSearch));
        // The map is keyed by paths of the old project, so every colour on
        // screen would be about a file the new tree does not have. Closing also
        // settles a walk that may still be in flight, by the same rule: the
        // state it lands on is no longer pending, so `applySizes` refuses it.
        showSizeMode(closeSizeMode(sizeMode));
        attribution.reset();
        attributionHud?.update(false, false);
        // Only now does the bar close: the switch is confirmed, not merely sent.
        showRoot(cancelPrompt(rootPrompt));
      },
    },
  );

  // The button and Escape below share one close path; two would drift apart.
  fileViewHud?.onClose(() => showFileView(closeView(fileView)));
  searchHud?.onQueryChange((query) => showSearch(setQuery(search, query, sim.listNodes())));
  // Typing does NOT search here: the round trip is submitted with Enter, and
  // `setContentQuery` deliberately leaves the previous answer on screen.
  contentSearchHud?.onQueryChange((query) =>
    showContentSearch(setContentQuery(contentSearch, query)),
  );
  rootHud?.onTextChange((text) => showRoot(setText(rootPrompt, text)));

  window.addEventListener("keydown", (event) => {
    // F7 sits above the chain below and takes no part in its precedence
    // argument: that argument is about keys two bindings both want, and this
    // one is contested by nothing and conditional on nothing. The mode has to
    // toggle with a modal open, with the root bar focused and with either
    // search bar taking keystrokes. `interpretSizeKey` declines everything that
    // is not a bare, non-repeating F7, and the test that pins that is what
    // keeps this position defensible.
    if (interpretSizeKey(event)) {
      event.preventDefault(); // Firefox binds F7 to caret browsing.
      const next = toggleSizeMode(sizeMode);
      // Only the closed -> pending crossing owes the daemon a walk, so a held
      // key and a toggle back off both send nothing.
      if (shouldRequest(sizeMode, next)) client.send({ kind: "sizes" });
      showSizeMode(next);
      return;
    }

    // The modal goes before everything: while a panel covers the graph, Escape
    // is the panel's, not the search box's and not the root bar's. The binding
    // declines every key while the panel is closed, so nothing below it loses
    // Escape the rest of the time.
    if (interpretFileViewKey(event, fileView.open)) {
      event.preventDefault();
      showFileView(closeView(fileView));
      return;
    }

    // The root bar goes next, and an answered key never reaches the search: an
    // open bar owns Enter and Escape, which the search box also answers.
    const rootCommand = interpretRootKey(event, rootPrompt.open);
    if (rootCommand) {
      // Without this the browser takes all three back: ctrl+L focuses its own
      // address bar, Tab moves focus out of the field, and Enter submits.
      event.preventDefault();
      if (rootCommand === "open") {
        // Already open: ctrl+L only refocuses and selects, as in the search box.
        // Reopening over a half-typed path would throw it away.
        if (!rootPrompt.open) showRoot(openPrompt(rootPrompt, observedRoot));
        rootHud?.open();
      } else if (rootCommand === "complete") {
        // The browser cannot read the disk, so Tab is a round trip; the reply
        // comes back through `onCompletion`.
        client.send({ kind: "complete", path: rootHud?.text() ?? rootPrompt.text });
      } else if (rootCommand === "submit") {
        // The bar stays open until the daemon confirms with a `reset` frame, or
        // refuses with a `rootError`.
        client.send({ kind: "setRoot", path: rootHud?.text() ?? rootPrompt.text });
      } else {
        showRoot(cancelPrompt(rootPrompt));
      }
      return;
    }

    // The content search goes before the name search and after the two above.
    // Three consequences, all of them worked out in the plan and none of them a
    // rule added here: with a docked panel open Escape closes the PANEL first
    // (the binding above claims it) and a second Escape closes this bar, which
    // is what VS Code does; F3 is not claimed up there, so it reaches this
    // binding while the panel is docked, which is the walk; and closing this
    // bar deliberately leaves a docked panel open, because the file is still
    // perfectly readable.
    const contentCommand = interpretContentSearchKey(
      event,
      contentSearch.open,
      isDirty(contentSearch),
    );
    if (contentCommand) {
      // ctrl+shift+F is the browser's own "search in files" in some builds, F3
      // is find-again, and Enter would submit a form.
      event.preventDefault();
      if (contentCommand === "open") {
        // Only one search is armed at a time, so opening this one closes the
        // other — otherwise two sets of highlights would share one renderer
        // channel and the last paint would win.
        if (search.open) showSearch(closeSearch(search));
        // Already open: the chord only refocuses and selects, as ctrl+F does.
        contentSearchHud?.open();
        if (!contentSearch.open) showContentSearch(openContentSearch(contentSearch));
      } else if (contentCommand === "submit") {
        // The browser cannot read the disk, so this is a round trip; the answer
        // comes back through `onSearchResult`. `submitted` is the state
        // machine's own copy of the field, and the string the answer will be
        // matched against.
        const asked = submitContentSearch(contentSearch);
        showContentSearch(asked);
        client.send({ kind: "search", query: asked.submitted });
      } else if (contentCommand === "next") {
        const walked = nextOccurrence(contentSearch);
        showContentSearch(walked);
        // Whether the step left the file already on screen is `requiresLoad`'s
        // question, not this handler's: seven occurrences in one document are
        // one round trip, not seven.
        const needed = requiresLoad(walked, fileView.path);
        if (needed !== null) {
          // Docked, so the graph stays visible beside the match, and as text,
          // because a diff of a dirty file may not contain the matched line.
          openFile(needed, "docked", "text");
        } else {
          // Same file, next occurrence: only the marking moved, so the panel is
          // repainted from the state it already holds.
          showFileView(fileView, true);
        }
      } else {
        showContentSearch(closeContentSearch(contentSearch));
      }
      return;
    }

    // Resolved BEFORE the binding is consulted, and handed to it: `search.ts`
    // owns the question of what the walk is resting on, `searchKeys.ts` only
    // reads the keyboard. It is also the path the branch below opens, so the
    // answer is worked out once.
    const focusedFile = focusedFilePath(search, sim.listNodes());
    const command = interpretSearchKey(event, search.open, focusedFile !== null);
    if (!command) return;
    // ctrl+F would otherwise open the browser's own find bar, and F3 its
    // find-again; both would search the page's text instead of the graph.
    event.preventDefault();
    if (command === "open") {
      // Already open: ctrl+F only refocuses and selects the text, leaving the
      // state alone. `openSearch` returns a CLEAN state by contract, so
      // applying it here would wipe a live query's matches and highlights while
      // the field still showed the old text -- and `setStatus`, which reads the
      // field, would then report "no matches" over a search that had 12.
      // The selection is what lets the next keystroke replace the query, and
      // that fires `input`, which goes through `setQuery`.
      // The other half of "only one search is armed at a time": the content bar
      // goes out, taking its highlights with it, before this one lights its own.
      if (contentSearch.open) showContentSearch(closeContentSearch(contentSearch));
      searchHud?.open();
      if (!search.open) showSearch(openSearch(search));
    } else if (command === "next") {
      showSearch(nextMatch(search));
    } else if (command === "openFile") {
      // Non-null by construction -- it is what made the binding answer openFile
      // -- but the compiler wants it said, and a stray null must not fall
      // through to the close branch below.
      if (focusedFile !== null) {
        // The same entry point the graph click and the git status row use, on
        // purpose: one way into the panel means one thing to keep right.
        openFile(focusedFile);
        // Hand the keyboard to the modal. The field still holds focus, so
        // typing and arrows would go to it rather than to the panel over the
        // graph. The SEARCH stays open -- the highlights are still wanted and
        // F3 keeps stepping, because the listener is on `window`, not on the
        // field.
        searchHud?.blur();
      }
    } else {
      showSearch(closeSearch(search));
    }
  });

  window.addEventListener("resize", () => {
    renderer.resize();
    contextHud?.refresh();
    // The panel's share of the width is measured, not assumed, so it is
    // re-measured whenever the width it is a share of changes.
    renderer.setOccludedRight(fileViewHud?.occludedFraction() ?? 0);
  });
  renderer.resize();
  renderer.start();
  client.connect();
}

boot();
