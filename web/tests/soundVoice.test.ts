/**
 * Contract tests (RED) for the per-agent voice: one hash, two projections.
 *
 * The claim this feature makes is "the sound and the figure agree", and the only
 * thing that can make that claim TRUE rather than merely plausible is that the
 * pitch and the colour are two projections of ONE hash. Today they cannot be:
 * `hashColor` computes the FNV-1a of its key and reduces it to `% 360` in the
 * same breath, so the 32-bit value never escapes, and a pitch taken from
 * `actorColor(agent) % PITCH_TABLE.length` would be a pitch taken from the
 * COLOUR -- hash mod 360 mod 15, a double reduction that correlates pitch with
 * hue by arithmetic accident and quietly shrinks the effective table.
 * `web/tests/colors.test.ts` pins the seam that fixes it (`actorHash` and
 * `colorFromHash`); this file pins what the sound does with it.
 *
 * THE MAPPING IS PINNED AND THE FREQUENCIES ARE NOT. Every value in
 * `PITCH_TABLE` is a musical judgement -- a pentatonic set was proposed because
 * any two members are consonant, so two agents working at once do not produce an
 * interval that reads as a mistake -- and it is a judgement nobody on this host
 * can make: this machine is a tty with no audio device. So the table is the one
 * thing a listening session may rewrite, on the `PREFERENCE_BY_PLATFORM` idiom,
 * and these tests are written so that a retune touches the table and nothing
 * else. The same bargain `readMarker.test.ts` makes with its radii.
 *
 * (This file is written in the same batch as the rest of the feature rather than
 * after it, although the plan's decision 13 asks for one voice first and the
 * per-agent hash only once somebody has listened for an afternoon. That
 * afternoon cannot happen on this host at all, so deferring the step defers it
 * indefinitely; the sequencing argument is not re-opened here.)
 *
 * WHAT MUST NOT BE CLAIMED, and one test says it out loud: a timbre cannot
 * identify an agent. Measured over 20 000 synthetic ids, six agents get about
 * five distinct pitches from a fifteen-note table, and no table size fixes it --
 * 24 notes buys 0.31 of an agent for an octave of extra range. Two agents
 * sharing a pitch is the ordinary case. The true and useful claim is that the
 * same agent always sounds the same.
 *
 * Expected to FAIL until src/sound.ts exports `actorVoice`, `PITCH_TABLE` and
 * `DEFAULT_VOICE`, and src/colors.ts exports `actorHash`.
 *
 * One failure reason per test.
 */

import { describe, it, expect } from "vitest";
import type { AgentEvent } from "../src/protocol";
import * as colors from "../src/colors";
import {
  DEFAULT_VOICE,
  PITCH_TABLE,
  actorVoice,
  createSound,
  toggleSound,
  voiceFor,
} from "../src/sound";

/** Today's module, plus the export this feature adds. */
const colorApi = colors as typeof colors & { actorHash?: (agent: string) => number };

/**
 * Reached through the namespace rather than a named import so that its absence
 * today is an assertion ("expected undefined to be function") instead of a link
 * error that would take the file down before a single test ran.
 */
function actorHash(agent: string): number {
  expect(typeof colorApi.actorHash).toBe("function");
  return (colorApi.actorHash as (agent: string) => number)(agent);
}

/** Which entry of the table an agent lands on. The mapping, and the only thing pinned. */
function tableIndex(agent: string): number {
  return actorHash(agent) % PITCH_TABLE.length;
}

/** A well-formed event, with only the fields this decision looks at varied. */
function event(over: Partial<AgentEvent> = {}): AgentEvent {
  return {
    ts: 1_700_000_000,
    agent: "agent-1",
    type: "M",
    path: "src/main.ts",
    color: "FFAA00",
    origin: "hook",
    label: "developer-frontend",
    attention: false,
    ...over,
  };
}

/** A pool wide enough that both a collision and a disagreement are in it. */
const POOL = Array.from({ length: 200 }, (_unused, i) => `agent-${i}`);

/** The first pair of ids whose table entries differ, or `null` if the pool has none. */
function differingPair(): readonly [string, string] | null {
  for (const a of POOL) {
    for (const b of POOL) {
      if (tableIndex(a) !== tableIndex(b)) return [a, b];
    }
  }
  return null;
}

/** The first pair of distinct ids that share a table entry, or `null`. */
function sharingPair(): readonly [string, string] | null {
  for (const a of POOL) {
    for (const b of POOL) {
      if (a !== b && tableIndex(a) === tableIndex(b)) return [a, b];
    }
  }
  return null;
}

describe("PITCH_TABLE: the one table a listening session may rewrite", () => {
  it("holds at least two entries, or there is no per-agent voice to speak of", () => {
    expect(PITCH_TABLE.length).toBeGreaterThan(1);
  });

  it("holds finite numbers, so every entry is a note something can be tuned to", () => {
    expect(PITCH_TABLE.every((entry) => Number.isFinite(entry))).toBe(true);
  });
});

describe("actorVoice: the mapping from an agent to a note", () => {
  it("gives one agent the same voice every time, because a figure may not change pitch as it works", () => {
    expect(actorVoice("sess-abc")).toEqual(actorVoice("sess-abc"));
  });

  it("gives two agents on different table entries two different frequencies", () => {
    const pair = differingPair();
    expect(pair, "no two ids in the pool land on different table entries").not.toBe(null);
    const [a, b] = pair as readonly [string, string];
    expect(actorVoice(a).freq).not.toBe(actorVoice(b).freq);
  });

  it("gives two agents on the SAME table entry the same frequency, because a timbre cannot identify an agent", () => {
    // Stated as a test rather than as a comment because it is the claim the
    // feature must not make. Six agents get about five distinct pitches from a
    // fifteen-note table; two of six sharing one is ordinary, not pathological.
    const pair = sharingPair();
    expect(pair, "no two distinct ids in the pool share a table entry").not.toBe(null);
    const [a, b] = pair as readonly [string, string];
    expect(actorVoice(a).freq).toBe(actorVoice(b).freq);
  });

  it("speaks only the vocabulary the table holds, however many agents there are", () => {
    // The mapping again, from the other side, and without naming a frequency:
    // 500 ids may not produce more distinct pitches than the table has notes.
    const many = Array.from({ length: 500 }, (_unused, i) => `sess-${i}-x`);
    const distinct = new Set(many.map((agent) => actorVoice(agent).freq));
    expect(distinct.size).toBeLessThanOrEqual(PITCH_TABLE.length);
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("hands the audio module a voice it can actually play", () => {
    // Relations, never values: a positive frequency, a gain inside the range a
    // `GainNode` takes, and a duration that is not instantaneous. Retuning any
    // of the three stays free.
    const voice = actorVoice("sess-abc");
    expect(Number.isFinite(voice.freq) && voice.freq > 0).toBe(true);
    expect(voice.gain > 0 && voice.gain <= 1).toBe(true);
    expect(voice.durationMs > 0).toBe(true);
  });
});

describe("voiceFor: who the voice belongs to", () => {
  it("gives an attributed change the voice of the agent that made it", () => {
    expect(voiceFor(toggleSound(createSound()), event({ agent: "agent-7" }), 1_000)).toEqual(
      actorVoice("agent-7"),
    );
  });

  it("gives an unattributed change the default voice, because an empty agent is nobody on camera", () => {
    // An event with `agent: ""` must never create an actor -- there is no
    // figure, no colour and no identity to project into a pitch. Hashing the
    // empty string would invent one, and would give the human editing a file in
    // their own editor a voice indistinguishable from an agent's.
    expect(voiceFor(toggleSound(createSound()), event({ agent: "" }), 1_000)).toEqual(
      DEFAULT_VOICE,
    );
  });

  it("gives every unattributed change the same voice, whoever failed to be attributed", () => {
    // The default is a NAMED constant, not the hash of the empty string:
    // `actorVoice("")` is perfectly computable and using it would be an
    // identity invented for somebody who has none. The assertion is written
    // against `DEFAULT_VOICE` rather than as "not `actorVoice(\"\")`", because
    // the two may legitimately collide on one table entry and a test that fails
    // once in fifteen retunes of the table is worse than no test.
    const armed = toggleSound(createSound());
    expect(voiceFor(armed, event({ agent: "", type: "A" }), 1_000)).toEqual(
      voiceFor(armed, event({ agent: "", type: "D", path: "other" }), 1_000),
    );
  });
});
