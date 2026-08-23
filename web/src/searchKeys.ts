/**
 * What a key press means to the search box.
 *
 * The mapping is a decision, and decisions taken inside `renderer.ts` need a GL
 * context and cannot be tested -- so it lives in a pure module, the way
 * {@link ./view} and {@link ./labels} do. It reads nothing but the fields below,
 * so a real `KeyboardEvent` and a plain object both fit.
 *
 * The trap this exists to avoid: once the field is open the user is TYPING. A
 * bare "f" is a character, not a command; a handler reacting to unmodified
 * letters would re-fire the shortcut on every keystroke of "footer.ts" and make
 * the field unusable. Only the modified shortcut and the navigation keys mean
 * anything, and the navigation keys only while the field is open.
 *
 * Enter and F3 used to be the same command, and they had to part ways. The walk
 * puts the camera on a file and stops there, so seeing what is INSIDE the file
 * just found meant abandoning the keyboard to aim at a dot in a force layout
 * that never stops moving. Enter opens it instead -- but WALKING MUST NEVER
 * BECOME OPENING: F3 stays "next match" whatever is focused, or stepping
 * through a query would throw a modal over the graph on every single step. With
 * nothing focused Enter keeps its old meaning, so the key never goes dead.
 *
 * `fileFocused` is passed IN rather than worked out here. This module reads a
 * keyboard event and nothing else -- the tree, the match list and the walk live
 * in {@link ./search}, which answers the question with `focusedFilePath`. Taking
 * the answer as an argument keeps that boundary intact and keeps the binding a
 * table of keys.
 */

/** The slice of a keyboard event the binding looks at. */
export interface SearchKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/**
 * What the caller should do, or null to leave the key to the page.
 *
 * `open` is the SEARCH BOX, `openFile` the viewer over the graph: two different
 * things summoned by two different keys, which is why neither name is short.
 */
export type SearchCommand = "open" | "next" | "close" | "openFile";

/**
 * @param open        whether the field is showing and taking keystrokes.
 * @param fileFocused whether the walk is resting on a file Enter could open.
 */
export function interpretSearchKey(
  event: SearchKeyEvent,
  open: boolean,
  fileFocused: boolean,
): SearchCommand | null {
  if (event.ctrlKey || event.metaKey) {
    // The browser reports `key` with the modifiers already applied, so a stray
    // shift or caps lock would otherwise silently disable the shortcut. cmd is
    // the same shortcut: it is what a mac user reaches for.
    return event.key.toLowerCase() === "f" ? "open" : null;
  }

  // Everything below is a command only while the field is showing; closed,
  // these keys belong to the rest of the page.
  if (!open) return null;
  // F3 walks, unconditionally: it is the key for stepping, and a step that
  // opened a panel would bury the graph the user is stepping through.
  if (event.key === "F3") return "next";
  if (event.key === "Enter") return fileFocused ? "openFile" : "next";
  if (event.key === "Escape") return "close";
  return null;
}
