/**
 * Color helpers. Gource colors file dots by extension; directories and actor
 * beams get stable per-key colors from a hash. Everything here returns a
 * `THREE.Color`-friendly 24-bit RGB integer (0xRRGGBB).
 */

/** Curated extension palette, close to Gource's defaults for common languages. */
const EXTENSION_COLORS: Readonly<Record<string, number>> = {
  ts: 0x3178c6,
  tsx: 0x3178c6,
  js: 0xf0db4f,
  jsx: 0xf0db4f,
  mjs: 0xf0db4f,
  json: 0x8bc34a,
  py: 0x4b8bbe,
  rb: 0xcc342d,
  go: 0x00add8,
  rs: 0xdea584,
  c: 0x555555,
  h: 0x777777,
  cpp: 0x00599c,
  cc: 0x00599c,
  hpp: 0x00599c,
  java: 0xe76f00,
  cs: 0x9b4f96,
  php: 0x777bb4,
  html: 0xe34c26,
  css: 0x264de4,
  scss: 0xc76494,
  md: 0x083fa1,
  yml: 0xcb171e,
  yaml: 0xcb171e,
  toml: 0x9c4221,
  sh: 0x89e051,
  sql: 0xe38c00,
  png: 0xad4fd6,
  jpg: 0xad4fd6,
  svg: 0xffb13b,
  lock: 0x999999,
};

/**
 * The grey a node wears when it carries no information of its own: a directory
 * in the normal mode, and an unmeasured node while the size mode is armed.
 *
 * It lives here, in the one pure module both callers can import, because the
 * renderer's `DIR_COLOR` and `sizeColor.ts`'s `UNMEASURED_COLOR` must be the
 * SAME grey. Two near-greys side by side is the least legible pair this page
 * could contain, and two constants that happen to be equal is the drift waiting
 * to happen: a retune has to move one literal, not find both.
 */
export const NEUTRAL_NODE_COLOR = 0x9aa0a6;

/** Parse `#RRGGBB`/`RRGGBB` hex (no `#`) into 0xRRGGBB, or `null` if malformed. */
export function hexToInt(hex: string): number | null {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return parseInt(clean, 16);
}

/** Lowercased extension of a path, or `""` when there is none. */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * The raw 32-bit FNV-1a of an agent's identity, under the `actor:` prefix.
 *
 * The hash used to be computed and reduced in the same breath — {@link hashColor}
 * took a key, folded it to `% 360` and returned a colour, so the 32-bit value
 * never escaped. Any SECOND projection of an agent's identity then had to be
 * built out of the colour, and a pitch taken as `actorColor(agent) % 15` is
 * hash mod 360 mod 15: a double reduction that correlates pitch with hue by
 * arithmetic accident and quietly shrinks the effective table. So the hash is
 * exposed as a hash and the colour as one projection of it; the sound module's
 * pitch is the other. Their agreement is then a fact about the code rather than
 * a claim in a docstring.
 *
 * Unsigned, so a caller may take it modulo a table length without discovering
 * that JavaScript's `%` keeps the sign of its left operand.
 */
export function actorHash(agent: string): number {
  return fnv1a(`actor:${agent}`) >>> 0;
}

/**
 * The hue projection: the half of {@link hashColor} that comes after the hash.
 *
 * Exported so that `actorColor` can be written as the composition of the two
 * halves rather than as a second copy of either. `% 360` is what makes every
 * hash a hue, and 0.7/0.6 are what keep every hue bright enough to read as a
 * dot on a black field.
 */
export function colorFromHash(hash: number): number {
  return hslToInt((hash >>> 0) % 360, 0.7, 0.6);
}

/** FNV-1a over the UTF-16 code units of a key. Signed, as `Math.imul` leaves it. */
function fnv1a(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash;
}

/** Deterministic bright color derived from a string (FNV-1a hash → HSL). */
export function hashColor(key: string): number {
  return colorFromHash(fnv1a(key));
}

/**
 * The colour of ONE agent: its figure, its beams, and any swatch beside its name.
 *
 * The `actor:` prefix is what keeps an agent apart from a directory of the same
 * name, since {@link hashColor} colours both. It used to be spelled inline in
 * `renderer.ts` — a module that needs a GL context and therefore carries no test
 * at all — so every second surface wanting an agent's colour had to respell it,
 * and the first typo is a page where the swatch and the figure disagree with
 * nothing on screen saying which one is lying. One spelling, here, imported by
 * both.
 *
 * `agent` is the IDENTITY, never the label: two subagents of one type must stay
 * two figures with two colours. An empty agent is nobody on camera and never
 * gets a figure, but this still answers for it rather than throwing — a caller
 * building a row does not want a crash for a value it is about to discard.
 */
export function actorColor(agent: string): number {
  return colorFromHash(actorHash(agent));
}

/** Color for a file dot: extension palette first, hashed fallback otherwise. */
export function fileColor(path: string): number {
  const ext = extensionOf(path);
  const known = EXTENSION_COLORS[ext];
  return known ?? hashColor(ext || path);
}

function hslToInt(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const to255 = (v: number): number => Math.round((v + m) * 255) & 0xff;
  return (to255(r) << 16) | (to255(g) << 8) | to255(b);
}
