/**
 * The alarm panel in the top-left corner: what an agent touched that the user
 * asked to be told about.
 *
 * Presentation only, exactly as `statusHud.ts` is. Every decision — whether the
 * panel belongs on screen, the order, the cut, what the header says about the
 * rule file, which colour a row's swatch wears — belongs to the pure
 * {@link buildAttentionList}; this module only paints what it returns, because
 * the test environment is `node` and a DOM-bound module cannot be unit-tested.
 * If you find yourself choosing an order or a sentence here, you are in the
 * wrong file.
 *
 * Three details are load-bearing, and the first two are `statusHud.ts`'s own:
 *
 *  - **A full repaint, with `scrollTop` restored.** The rows are rebuilt
 *    wholesale, which resets the scroll to the top; without restoring it the
 *    list jumps under the reader every time an alarm folds a repeat in.
 *  - **One delegated listener on the `<ol>`,** not one per row. The rows are
 *    thrown away and rebuilt on every paint, so per-row listeners would be
 *    re-bound wholesale each time, for no gain.
 *  - **A click on a row DISMISSES that alarm, and dismissal gets no key.**
 *    Escape is contested three ways in `main.ts`'s keydown chain already, and
 *    this panel does not cover the graph, so there is nothing for a key to
 *    rescue the reader from. Dismissing does not suppress: a later event on the
 *    same path opens a fresh alarm, which `attentionState.ts` already does.
 */

import { buildAttentionList, type AttentionRow } from "./attentionList";
import { cssHex } from "./avatar";
import type { Alarm } from "./attentionState";
import type { AttentionRulesFrame } from "./protocol";

export interface AttentionHud {
  /** Paint the open alarms under the last rule report. */
  render(alarms: readonly Alarm[], rules: AttentionRulesFrame | null): void;
  /**
   * Empty the panel and hide it, because the daemon switched roots: the rows
   * name files of a project that is no longer on screen.
   */
  clear(): void;
}

/** Build the `<li>` for a row: the agent's swatch, dimmed directory, name, count. */
function buildRow(row: AttentionRow): HTMLLIElement {
  const item = document.createElement("li");

  // No swatch at all for an unattributed change: an empty agent is nobody on
  // camera, and a coloured dot beside the row would invent an author for it.
  if (row.swatch !== null) {
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = cssHex(row.swatch);
    item.append(swatch);
  }

  const dirEl = document.createElement("span");
  dirEl.className = "dir";
  dirEl.textContent = row.dir;

  const nameEl = document.createElement("span");
  nameEl.className = "name";
  nameEl.textContent = row.name;

  item.append(dirEl, nameEl);

  // A single touch needs no number beside it; repeats are the whole reason the
  // fold exists, so they are the only thing worth printing.
  if (row.count > 1) {
    const countEl = document.createElement("span");
    countEl.className = "count";
    countEl.textContent = `×${row.count}`;
    item.append(countEl);
  }

  item.title = row.label ? `${row.path} · ${row.label}` : row.path;
  // The delegated handler reads the path back off the row it was given.
  item.dataset.path = row.path;
  return item;
}

/** `N alarms`, plus what the cap left out. */
function countText(total: number, hidden: number): string {
  const base = total === 1 ? "1 alarm" : `${total} alarms`;
  return hidden > 0 ? `${base} · +${hidden} hidden` : base;
}

/**
 * Bind the alarm panel to its container.
 *
 * @param rootEl The `<div id="attention">` wrapper; its `hidden` attribute is
 *   what keeps the panel off screen while nothing is alarming.
 * @param onAcknowledge Called with the path of a clicked row: that one alarm
 *   has been seen.
 * @param onClearAll Called when the clear control is pressed.
 * @param max Row cap, forwarded to the underlying model.
 */
export function createAttentionHud(
  rootEl: HTMLElement,
  onAcknowledge: (path: string) => void,
  onClearAll: () => void,
  max?: number,
): AttentionHud {
  const listEl = rootEl.querySelector("#attention-list");
  const countEl = rootEl.querySelector("#attention-count");
  const rulesEl = rootEl.querySelector("#attention-rules");
  const clearEl = rootEl.querySelector("#attention-clear");

  listEl?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest("li");
    const path = row instanceof HTMLElement ? row.dataset.path : undefined;
    if (path) onAcknowledge(path);
  });

  clearEl?.addEventListener("click", () => onClearAll());

  return {
    render(alarms: readonly Alarm[], rules: AttentionRulesFrame | null): void {
      const model = buildAttentionList(alarms, rules, max);
      rootEl.hidden = !model.visible;
      if (countEl) countEl.textContent = countText(model.total, model.hidden);
      if (rulesEl) rulesEl.textContent = model.header;
      if (!listEl) return;

      const scroll = listEl.scrollTop;
      listEl.replaceChildren(...model.rows.map(buildRow));
      listEl.scrollTop = scroll;
    },

    clear(): void {
      rootEl.hidden = true;
      if (countEl) countEl.textContent = "";
      if (rulesEl) rulesEl.textContent = "";
      if (!listEl) return;
      listEl.replaceChildren();
      listEl.scrollTop = 0;
    },
  };
}
