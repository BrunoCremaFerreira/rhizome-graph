/**
 * The bottom-centre caption: which directory is on screen, and on what branch.
 *
 * Presentation only — no domain logic. It takes an already-parsed
 * {@link DaemonMeta} and writes text into two spans. How many characters fit is
 * `bottomRow.ts`'s answer and the truncation is `truncateMiddle`'s, both pure
 * and both tested: the budget shares the bottom row out between three boxes, so
 * it is the last thing that should have lived in an untested painter. Clipping
 * with CSS is not an option either — it would hide exactly the tail segment
 * that identifies the project.
 *
 * DOM-bound, so it is not unit-tested; keep it that thin.
 */

import { contextCharBudget } from "./bottomRow";
import { truncateMiddle, type DaemonMeta } from "./protocol";

/** Branch names get their own slice so a long path cannot eat them. */
const MAX_BRANCH_CHARS = 24;

export interface ContextHud {
  /** Show a meta frame the daemon just sent. */
  setMeta(meta: DaemonMeta): void;
  /** Re-fit the text after a viewport change. */
  refresh(): void;
}

/**
 * Bind the caption to `#context` (root span + branch span).
 *
 * Before the first meta frame arrives both spans stay empty and the branch span
 * stays hidden, so a page talking to an older daemon simply shows nothing
 * rather than a placeholder.
 */
export function createContextHud(container: HTMLElement): ContextHud {
  const rootEl = container.querySelector<HTMLElement>("#context-root");
  const branchEl = container.querySelector<HTMLElement>("#context-branch");
  let meta: DaemonMeta | null = null;

  function render(): void {
    if (!meta || !rootEl || !branchEl) return;

    const branch = meta.branch ? truncateMiddle(meta.branch, MAX_BRANCH_CHARS) : "";
    const viewport = typeof window !== "undefined" ? window.innerWidth : 0;

    rootEl.textContent = truncateMiddle(meta.root, contextCharBudget(viewport, branch.length));
    branchEl.textContent = branch;
    // Hiding the span hides its `::before` separator too: no orphan " · ".
    branchEl.hidden = branch.length === 0;
  }

  return {
    setMeta(next: DaemonMeta): void {
      meta = next;
      render();
    },
    refresh: render,
  };
}
