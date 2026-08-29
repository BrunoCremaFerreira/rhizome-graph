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

/** Today's module, plus the export this plan adds. */
const api = colors as typeof colors & { actorColor?: (agent: string) => number };

function actorColor(agent: string): number {
  expect(typeof api.actorColor).toBe("function");
  return (api.actorColor as (agent: string) => number)(agent);
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
