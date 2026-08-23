/**
 * The content search box (ctrl+shift+F): a field, a caption, and a count.
 *
 * Presentation only — no domain logic, the way {@link ./searchHud} is. What a
 * keystroke means lives in {@link ./contentSearchKeys}, what a query matched
 * and where the walk is resting in {@link ./contentSearch}; this module shows a
 * field, reports what was typed, and paints numbers it is handed. DOM-bound, so
 * it is not unit-tested: keep it this thin.
 *
 * It sits in the same screen slot as the name search's box, which only one of
 * them can occupy at a time. That is why `#content-search` carries a visible
 * label: two identical boxes in one place, answering different questions, is
 * worse than either of them alone.
 */

/** Shown between `Enter` and the daemon's answer. */
const SEARCHING = "searching…";
/** Shown when the answer named no file. */
const NO_MATCHES = "no matches";
/** Appended when the daemon cut the walk short, so a low count is not read as all of them. */
const TRUNCATED = " (truncated)";

/**
 * The facts the caption is painted from, as primitives.
 *
 * The state machine's own type is deliberately not imported: this module paints
 * numbers and strings, and taking `ContentSearchState` would invite it to start
 * reading the parts of the state that are not about the caption.
 */
export interface ContentSearchStatus {
  /** True between `Enter` and the daemon's frame. */
  readonly pending: boolean;
  /** The query the numbers describe, `""` when nothing has been submitted. */
  readonly submitted: string;
  /** Occurrences across every matched file. */
  readonly total: number;
  /** Where the walk is resting, 0-based; negative before the first step. */
  readonly occurrence: number;
  /** Whether the daemon cut the walk short. */
  readonly truncated: boolean;
  /** Why there is no answer, or `""`. */
  readonly error: string;
}

export interface ContentSearchHud {
  /** Show the field, focused, with any previous text selected. */
  open(): void;
  /** Hide the field and forget what was typed. */
  close(): void;
  isOpen(): boolean;
  /** What is currently typed. */
  query(): string;
  /** Paint the count, the wait, or the reason there is neither. */
  setStatus(status: ContentSearchStatus): void;
  /** Called on every keystroke in the field, with the new text. */
  onQueryChange(callback: (query: string) => void): void;
}

/** Bind the box to `#content-search` (an input, a label and a count span). */
export function createContentSearchHud(container: HTMLElement): ContentSearchHud {
  const input = container.querySelector<HTMLInputElement>("#content-search-input");
  const countEl = container.querySelector<HTMLElement>("#content-search-count");

  return {
    open(): void {
      container.hidden = false;
      // Selected, not just focused: reopening over an old query lets the next
      // keystroke replace it instead of appending to it.
      input?.focus();
      input?.select();
    },

    close(): void {
      container.hidden = true;
      if (input) input.value = "";
      if (countEl) countEl.textContent = "";
      // Give the keyboard back to the page: a focused field inside a hidden
      // box would keep swallowing keys.
      input?.blur();
    },

    isOpen(): boolean {
      return !container.hidden;
    },

    query(): string {
      return input?.value ?? "";
    },

    setStatus(status: ContentSearchStatus): void {
      if (!countEl) return;
      countEl.textContent = caption(status);
    },

    onQueryChange(callback: (query: string) => void): void {
      input?.addEventListener("input", () => callback(input.value));
    },
  };
}

/**
 * The one line of text the box shows to the right of the field.
 *
 * A refusal outranks everything, then the wait — a search nobody has answered
 * yet must not read as one that found nothing. Nothing submitted is blank
 * rather than "no matches", because the box has only just opened.
 */
function caption(status: ContentSearchStatus): string {
  if (status.error !== "") return status.error;
  if (status.pending) return SEARCHING;
  if (status.submitted === "") return "";
  if (status.total === 0) return NO_MATCHES;
  // Before the first step there is no current occurrence to number, only a
  // total; the index is 0-based inside the model and 1-based on screen.
  const count =
    status.occurrence < 0
      ? `${status.total}`
      : `${status.occurrence + 1} / ${status.total}`;
  return status.truncated ? count + TRUNCATED : count;
}
