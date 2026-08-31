/**
 * What a key press means to the ambient sound.
 *
 * It claims exactly one key, F9, and like {@link ./sizeKeys} and
 * {@link ./statsKeys} it is UNCONDITIONAL: no `open` parameter, because the
 * toggle has to work with the file panel open, with the root bar focused and
 * with either search bar taking keystrokes -- which are the states a listener is
 * MOST likely to be in when a noise has stopped being welcome, not least. That
 * is what earns it a place beside F7 and F8 above the page's keydown chain: the
 * chain below is ordered by CONTESTED keys, and a binding that contests nothing
 * takes no part in that argument.
 *
 * First position is also the whole risk, and the declines are the guard on it.
 * Every key that is not a bare, non-repeating F9 is answered with null, so a
 * binding widened here later has to break a test that says out loud which key it
 * is stealing -- F7 and F8 most of all, both live on this page, both immediately
 * above this one, and both taken by anything matching on "starts with an F".
 *
 * A REPEAT IS NOT A TOGGLE, and the reason is sharper here than for F7 or F8.
 * Held down, F9 repeats at roughly 30 Hz, and every second repeat would
 * construct or suspend the audio context -- a platform resource with a
 * construction cost and a browser-imposed limit on how many may exist, not a
 * state field. Resting a finger on a key while reading is not hostile use.
 *
 * Every modifier is required on {@link SoundKeyEvent}, unlike the optional
 * `shiftKey` of `SearchKeyEvent`: that optionality exists only so a pinned test
 * file kept compiling, and a new module has nothing to preserve.
 */

/** The slice of a keyboard event the binding looks at. All fields required. */
export interface SoundKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly repeat: boolean;
}

/** What the caller should do. There is exactly one thing F9 means. */
export type SoundCommand = "toggle";

/** The command for this key press, or null to leave the key to the page. */
export function interpretSoundKey(event: SoundKeyEvent): SoundCommand | null {
  if (event.key !== "F9") return null;
  // A modified F9 belongs to whoever binds it next; a repeated one to nobody.
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return null;
  if (event.repeat) return null;
  return "toggle";
}
