/**
 * What a key press means to the size colour mode.
 *
 * It claims exactly one key, F7, and it is the only binding on the page that is
 * UNCONDITIONAL: it takes no `open` parameter, because the mode has to toggle
 * with the file panel open, with the root bar focused, and with either search
 * bar taking keystrokes. "All other functionality keeps working normally" cuts
 * both ways. That is what earns it first position in the page's keydown chain,
 * above the modal's Escape -- the chain below is ordered by CONTESTED keys, and
 * a binding that contests nothing takes no part in that argument.
 *
 * First position is also the risk, and the declines below are the guard on it.
 * Every key that is not an unmodified, non-repeating F7 is answered with null,
 * so a contested key added here later fails a test before it can silently
 * outrank the modal.
 *
 * A REPEAT IS NOT A TOGGLE. Held down, F7 repeats at roughly 30 Hz, and every
 * second repeat would re-enter the mode -- each entry a `sizes` command, which
 * is a walk of the whole tree in the executor the daemon shares with
 * `scan_tree`, `file_view` and `content_search`. Resting a finger on a key is
 * not hostile use, so the repeat is declined here as well as in the state
 * machine that decides whether to send.
 */

/** The slice of a keyboard event the binding looks at. All fields required. */
export interface SizeKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly repeat: boolean;
}

/** What the caller should do. There is exactly one thing F7 means. */
export type SizeCommand = "toggle";

/** The command for this key press, or null to leave the key to the page. */
export function interpretSizeKey(event: SizeKeyEvent): SizeCommand | null {
  if (event.key !== "F7") return null;
  // A modified F7 belongs to whoever binds it next; a repeated one to nobody.
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return null;
  if (event.repeat) return null;
  return "toggle";
}
