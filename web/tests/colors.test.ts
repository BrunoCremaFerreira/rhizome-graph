/**
 * RED specification for `actorColor`: the one place the `actor:` hash prefix is
 * spelled.
 *
 * The defect is pre-existing and this plan only exposes it. `renderer.ts`
 * computes an agent's colour as `hashColor(`actor:${agent}`)` inline, in a
 * module that needs a GL context and therefore carries no test at all. The
 * prefix is a literal inside untestable code, and it is not decorative: it is
 * what separates an agent's colour from a directory's, both of which come out
 * of the same hash. Every second surface that wants an agent's colour -- this
 * plan's alarm swatch, the session stats panel, the per-agent timbre -- has to
 * respell it, and the first typo is a page where the swatch beside an agent's
 * name and the figure standing in the graph are two different colours, with
 * nothing on screen saying which one is lying.
 *
 * So the prefix moves into the pure module both callers can import, and this is
 * the test that pins it. Only the RELATION is asserted -- `actorColor(x)` is
 * `hashColor("actor:" + x)` -- never a colour value: the hash and the palette
 * are free to be retuned, and a test that fails when a hue moves is noise.
 *
 * Reached through the module namespace rather than a named import so that its
 * absence today is an assertion ("expected undefined to be function") instead
 * of a link error that would take the file down before a single test ran.
 */

import { describe, it, expect } from "vitest";
import * as colors from "../src/colors";
import { hashColor } from "../src/colors";

/** Today's module, plus the exports these plans add. */
const api = colors as typeof colors & {
  actorColor?: (agent: string) => number;
  actorHash?: (agent: string) => number;
  colorFromHash?: (hash: number) => number;
};

function actorColor(agent: string): number {
  expect(typeof api.actorColor).toBe("function");
  return (api.actorColor as (agent: string) => number)(agent);
}

function actorHash(agent: string): number {
  expect(typeof api.actorHash).toBe("function");
  return (api.actorHash as (agent: string) => number)(agent);
}

function colorFromHash(hash: number): number {
  expect(typeof api.colorFromHash).toBe("function");
  return (api.colorFromHash as (hash: number) => number)(hash);
}

describe("actorColor", () => {
  it("is the hash of the agent under the actor prefix, which is the only thing that can drift", () => {
    expect(actorColor("x")).toBe(hashColor("actor:x"));
  });

  it.each(["sess-abc", "agent-1", "developer-backend", "0", "a/b:c"])(
    "agrees with the prefixed hash for the agent id %s",
    (agent) => {
      expect(actorColor(agent)).toBe(hashColor(`actor:${agent}`));
    },
  );

  it("keeps an agent apart from a directory of the same name", () => {
    // The whole point of the prefix: `hashColor` is also what colours a
    // directory node, so without it an agent called `src` and the directory
    // `src` would be the same colour on the same screen.
    expect(actorColor("src")).not.toBe(hashColor("src"));
  });

  it("gives two different agents two different colours", () => {
    // Identity is `agent`, never the label: two subagents of one type must
    // stay two figures with two colours.
    expect(actorColor("agent-1")).not.toBe(actorColor("agent-2"));
  });

  it("is stable across calls, because a figure may not change colour as it works", () => {
    expect(actorColor("sess-abc")).toBe(actorColor("sess-abc"));
  });

  it("answers for the empty agent without throwing, even though nobody is behind it", () => {
    // An empty agent never creates an actor, so this colour is never painted --
    // but a swatch model asking for it must not crash the panel.
    expect(() => actorColor("")).not.toThrow();
    expect(actorColor("")).toBe(hashColor("actor:"));
  });

  it("returns a colour inside the 24-bit range the renderer feeds three.js", () => {
    const color = actorColor("sess-abc");
    expect(Number.isInteger(color)).toBe(true);
    expect(color).toBeGreaterThanOrEqual(0);
    expect(color).toBeLessThanOrEqual(0xffffff);
  });
});

/**
 * The seam the ambient-sound plan needs, and the reason it needs it.
 *
 * `hashColor` computes the FNV-1a of its key and immediately does
 * `(hash >>> 0) % 360` into a private `hslToInt`, so the 32-bit value never
 * escapes the function. A second projection of an agent's identity -- a pitch
 * for the per-agent timbre -- can therefore only be built out of the COLOUR:
 * hash mod 360 mod the table length, a double reduction that correlates pitch
 * with hue by arithmetic accident and quietly shrinks the effective table. The
 * feature's one claim is that the sound and the figure AGREE, and it deserves to
 * be true because both are projections of one hash rather than true because one
 * is computed from the other.
 *
 * So `colors.ts` splits into two exported halves, `actorHash` and
 * `colorFromHash`, and `actorColor` becomes their composition. The test is an
 * equality and not a claim about "derivability", which has no operational
 * meaning: the composition holds, and the colour on screen does not move.
 *
 * Expected to FAIL until `actorHash` and `colorFromHash` exist.
 */
describe("actorHash: the raw value, exposed as a value", () => {
  it("composes with colorFromHash into exactly the colour actorColor already gives", () => {
    expect(actorColor("x")).toBe(colorFromHash(actorHash("x")));
  });

  it.each(["sess-abc", "agent-1", "developer-backend", "0", "", "a/b:c"])(
    "composes the same way for the agent id %s, so no figure changes colour",
    (agent) => {
      expect(actorColor(agent)).toBe(colorFromHash(actorHash(agent)));
    },
  );

  it("is a 32-bit unsigned integer, so a caller may take it modulo a table length", () => {
    const hash = actorHash("sess-abc");
    expect(Number.isInteger(hash)).toBe(true);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThan(2 ** 32);
  });

  it("hands back the hash and not the hue, which is the whole point of the split", () => {
    // A reduced value would be under 360 for every input. One id above it is
    // enough to say the raw value escaped; a pool is used because any single id
    // could legitimately hash low.
    const pool = Array.from({ length: 64 }, (_unused, i) => `agent-${i}`);
    expect(pool.some((agent) => actorHash(agent) >= 360)).toBe(true);
  });

  it("is stable across calls, because a pitch and a colour may not drift apart", () => {
    expect(actorHash("sess-abc")).toBe(actorHash("sess-abc"));
  });

  it("keeps two agents apart at the hash, not merely at the colour", () => {
    expect(actorHash("agent-1")).not.toBe(actorHash("agent-2"));
  });
});
