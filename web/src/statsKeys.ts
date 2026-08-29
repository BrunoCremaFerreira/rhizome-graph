/**
 * What a key press means to the session-stats panel.
 *
 * It claims exactly one key, F8, and — like `sizeKeys.ts` — it is
 * UNCONDITIONAL: it takes no `open` parameter, because the panel has to toggle
 * with the file viewer open, with the root bar focused and with either search
 * bar taking keystrokes. Placed lower in the chain the toggle would go dead in
 * exactly the states a reader is most likely to be in when they want a summary.
 * That is what earns it first position in the page's keydown chain, beside F7
 * and above the modal's Escape -- the chain below is ordered by CONTESTED keys,
 * and a binding that contests nothing takes no part in that argument.
 *
 * F8 rather than the `Tab` the brief proposed. `Tab` is focus traversal across
 * the two search inputs, the root input and the viewer's close button, so a
 * binding that takes it removes keyboard navigation from the page -- and the
 * test environment here is `node` with no jsdom, so no test on this host could
 * ever catch that. `Tab` is also already claimed CONDITIONALLY by
 * `interpretRootKey` while the root bar is open, and a binding whose meaning
 * depends on another box's state is precisely what this module earns its
 * position by not being.
 *
 * First position is also the whole risk, and the declines are the guard on it:
 * every key that is not a bare, non-repeating F8 is answered with null, so a
 * contested key widened into this module later fails a test that says out loud
 * which key it is stealing.
 *
 * A REPEAT IS NOT A TOGGLE. Held down, F8 repeats at roughly 30 Hz. Unlike F7
 * this toggle sends nothing to the daemon, so the cost is not a tree walk -- it
 * is a panel flickering fifteen times a second, which is its own defect, and
 * resting a finger on a key while reading is not hostile use.
 */

/** The slice of a keyboard event the binding looks at. All fields required. */
export interface StatsKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly repeat: boolean;
}

/** What the caller should do. There is exactly one thing F8 means. */
export type StatsCommand = "toggle";

/** The command for this key press, or null to leave the key to the page. */
export function interpretStatsKey(event: StatsKeyEvent): StatsCommand | null {
  if (event.key !== "F8") return null;
  // A modified F8 belongs to whoever binds it next; a repeated one to nobody.
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return null;
  if (event.repeat) return null;
  return "toggle";
}
