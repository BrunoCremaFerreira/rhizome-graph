/**
 * How long a beam lives, in seconds.
 *
 * These two numbers are drawn by `renderer.ts` and by nothing else, so the
 * obvious home for them is the module that paints them. They live here instead
 * because they are also a CONSTRAINT on modules that never draw anything:
 * `agentState.ts`'s `DEPARTURE_SECONDS` has to outlive the longest beam, or a
 * figure vanishes while a lit line is still pointing at it claiming it as
 * author. `renderer.ts` imports three.js and carries no unit test by doctrine,
 * so a constant declared there cannot be imported by a test, and a test that
 * respells `1.2` pins nothing — the whole point of the relation is that the two
 * numbers move together.
 *
 * Nothing else belongs in this module. It is a pure constants module on
 * purpose: `renderer.ts` owns the beam buffer, the fade and the pool cap.
 */

/** Life of a write beam — the line from an agent to the file it just changed. */
export const BEAM_LIFE_SECONDS = 1.2;

/**
 * Life of a read beam, in seconds — a fraction of {@link BEAM_LIFE_SECONDS}.
 *
 * Load-bearing, not taste. Reads arrive in bursts and the renderer's beam
 * buffer is a fixed 512: read beams that lived as long as a write's would fill
 * it and push the writes — the events the graph exists to show — out of it.
 */
export const READ_BEAM_LIFE_SECONDS = 0.6;
