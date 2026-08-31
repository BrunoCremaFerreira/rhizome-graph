/**
 * Contract tests (RED) for the pure half of the ambient-sound toggle.
 *
 * The defect is that nothing on this page decides whether an event is worth
 * HEARING. `main.ts`'s event sink offers every event to five consumers and each
 * of them decides for itself whether the event is its business -- `eventHud`
 * drops a seed and a read, `attribution` ignores a seed -- and a sixth consumer
 * has to make the same kind of judgement about a channel that is far less
 * forgiving than a list. A list can be scrolled back and a wrong entry can be
 * ignored; a sound cannot be un-heard, and a page that clicks 12 524 times when
 * a client connects is a page nobody will ever switch on twice.
 *
 * Every one of those judgements lives here, in a pure module, for the reason
 * `web/vitest.config.ts` makes non-negotiable: the suite runs with
 * `environment: "node"`, so there is no `AudioContext`, no `window` and no
 * `document` in it, and this project's doctrine adds no mock to invent one (the
 * shiki boundary exists to keep this suite "mock-free, jsdom-free and fast").
 * So the split is forced rather than chosen: `sound.ts` decides and is tested,
 * `audio.ts` calls the platform and is not. **Nothing in this file proves that a
 * sound is audible.** It proves only that the model asks for the right thing at
 * the right moment, and the whole of the rest is a human with headphones.
 *
 * The four silence rules are INDEPENDENT and none is the safety net for the
 * others. Measured in the plan over 200 000 synthetic events, together they
 * leave 1 961: seeds silent, reads silent, a 40 ms floor and an 8-voice budget.
 * Dropping any one of them puts the other three in a position they were not
 * sized for -- most sharply the seed rule, since a 40 ms floor over a
 * 12 524-event backdrop is not silence, it is twenty-five clicks a second for
 * eight minutes.
 *
 * A dropped event is DROPPED, never queued. A queue turns a burst into a drone
 * that outlives the work it describes, which is the same lie about "right now"
 * that keeps read flashes out of the daemon's replay buffer. The sound is either
 * simultaneous with the event or absent.
 *
 * The clock is a PARAMETER, the way the viewport is a parameter in `labels.ts`
 * and `bottomRow.ts`. A module that reads `performance.now()` itself cannot be
 * tested without owning time; `tests/test_sound_module_boundary.py` is the scan
 * that keeps it from acquiring one.
 *
 * Expected to FAIL until src/sound.ts exists.
 *
 * One failure reason per test.
 */

import { describe, it, expect } from "vitest";
import type { AgentEvent } from "../src/protocol";
import {
  MAX_CONCURRENT_VOICES,
  MIN_VOICE_INTERVAL_MS,
  createSound,
  noteEnded,
  noteStarted,
  resetLimiter,
  shouldRun,
  toggleSound,
  voiceFor,
} from "../src/sound";
import type { SoundState, Voice } from "../src/sound";

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

/** A state with the toggle on, which is the only state most of this is about. */
function armed(): SoundState {
  return toggleSound(createSound());
}

/**
 * The loop `main.ts` runs: offer the event, and only if a voice comes back
 * record that one started.
 *
 * Written once, here, because several properties below are about a SEQUENCE of
 * events rather than about one call, and a test that drove the state by hand
 * would be free to stamp the limiter on a drop -- which is the very thing the
 * ordering property exists to forbid.
 */
function drive(
  start: SoundState,
  events: readonly (readonly [AgentEvent, number])[],
): { state: SoundState; voices: (Voice | null)[] } {
  let state = start;
  const voices: (Voice | null)[] = [];
  for (const [item, nowMs] of events) {
    const voice = voiceFor(state, item, nowMs);
    voices.push(voice);
    if (voice) state = noteStarted(state, nowMs);
  }
  return { state, voices };
}

describe("voiceFor: the toggle is the first question and it is unconditional", () => {
  it("is silent while the toggle is off, for an ordinary modification", () => {
    // Decision 1: the page loads silent, always. Nothing decided in another tab
    // or another session may make this one make a noise.
    expect(voiceFor(createSound(), event(), 1_000)).toBe(null);
  });

  it("stays silent while off even when every other rule would allow the voice", () => {
    // No seed, no read, a clock far past the floor and an empty budget: the
    // toggle is what refuses, and it refuses first.
    const off = createSound();
    expect(voiceFor(off, event({ type: "A" }), 9_999_999)).toBe(null);
  });
});

describe("voiceFor: the backdrop is silent, and being silent costs the limiter nothing", () => {
  it("drops a seed burst and still sounds the real event that follows it", () => {
    // THE ordering test. A connecting client is replayed the whole tree -- up to
    // 20 000 `A` events inside a second -- and the natural implementation puts
    // the cheap integer comparison (the rate floor) before the string
    // comparison (the origin), which is faster and is what an optimiser would
    // do. Under that order the first seed sounds, stamps the limiter, and the
    // real change 3 ms later is swallowed by a floor that backdrop set.
    const seed = event({ origin: "seed", type: "A" });
    const { voices } = drive(armed(), [
      [seed, 1_000],
      [seed, 1_001],
      [seed, 1_002],
      [event(), 1_003],
    ]);

    expect(voices.slice(0, 3)).toEqual([null, null, null]);
    expect(voices[3]).not.toBe(null);
  });

  it("is silent for a seed even when the clock has been idle for an hour", () => {
    expect(voiceFor(armed(), event({ origin: "seed" }), 3_600_000)).toBe(null);
  });
});

describe("voiceFor: a read is not a change, and this channel has no scrollback", () => {
  it("is silent for a read", () => {
    // An agent reads roughly ten times more often than it writes. In the recent
    // changes list that would push every real edit off the top; here it is nine
    // tenths of the noise carrying one tenth of the meaning, in a medium that
    // cannot be scrolled back.
    expect(voiceFor(armed(), event({ type: "R" }), 1_000)).toBe(null);
  });

  it("sounds an add, a modification and a deletion", () => {
    const voices = (["A", "M", "D"] as const).map((type) =>
      voiceFor(armed(), event({ type }), 1_000),
    );
    expect(voices.every((voice) => voice !== null)).toBe(true);
  });

  it("gives one agent the SAME voice for all three, because the graph already says which kind", () => {
    // Decision 4: one perceptual dimension, one meaning. The voice says WHO and
    // the click says that something happened; `A` green, `M` amber and `D` red
    // already answer what kind of change it was. A timbre per operation would
    // fight the timbre per agent for the same dimension.
    const [add, modify, remove] = (["A", "M", "D"] as const).map((type) =>
      voiceFor(armed(), event({ type, agent: "agent-7" }), 1_000),
    );
    expect(modify).toEqual(add);
    expect(remove).toEqual(add);
  });
});

describe("voiceFor: the rate floor, whose boundary is >=", () => {
  it("sounds the first event after the toggle, whatever the page's clock reads", () => {
    // `performance.now()` is milliseconds since the document was created, so the
    // first event of a session arrives at an arbitrary large number. A limiter
    // initialised to something in the future would swallow it and the feature
    // would look broken exactly once per page load.
    expect(voiceFor(armed(), event(), 12_345.6)).not.toBe(null);
  });

  it("drops a second event one millisecond inside the floor", () => {
    const { voices } = drive(armed(), [
      [event(), 1_000],
      [event(), 1_000 + MIN_VOICE_INTERVAL_MS - 1],
    ]);
    expect([voices[0] === null, voices[1]]).toEqual([false, null]);
  });

  it("sounds a second event exactly one interval later, so the boundary is >= and not >", () => {
    const { voices } = drive(armed(), [
      [event(), 1_000],
      [event(), 1_000 + MIN_VOICE_INTERVAL_MS],
    ]);
    expect(voices.every((voice) => voice !== null)).toBe(true);
  });
});

describe("voiceFor: the voice budget, which the caller maintains", () => {
  it("is silent while every voice is in use, however long the clock has been idle", () => {
    // `live` is maintained by the caller through noteStarted/noteEnded rather
    // than by a timer inside the model: a timer is a decision the model cannot
    // test without owning a clock, and the real end of a note is an event the
    // platform reports.
    let state = armed();
    for (let i = 0; i < MAX_CONCURRENT_VOICES; i += 1) {
      state = noteStarted(state, 1_000 + i * MIN_VOICE_INTERVAL_MS);
    }
    expect(state.live).toBe(MAX_CONCURRENT_VOICES);
    expect(voiceFor(state, event(), 9_999_999)).toBe(null);
  });

  it("sounds again as soon as one note has ended", () => {
    let state = armed();
    for (let i = 0; i < MAX_CONCURRENT_VOICES; i += 1) {
      state = noteStarted(state, 1_000 + i * MIN_VOICE_INTERVAL_MS);
    }
    state = noteEnded(state);
    expect(voiceFor(state, event(), 9_999_999)).not.toBe(null);
  });

  it("counts a budget of more than one, or the floor would be the only limit that ever fires", () => {
    expect(MAX_CONCURRENT_VOICES).toBeGreaterThan(1);
  });
});

describe("voiceFor: a dropped event is gone, not deferred", () => {
  it("plays three voices for a hundred-event burst and holds nothing back", () => {
    // A queue would turn this burst into a drone that outlives the work it
    // describes -- a lie about "right now", which is the same objection that
    // keeps read flashes out of the daemon's replay buffer. 100 events one
    // millisecond apart admit exactly one voice per interval and no more.
    const burst = Array.from(
      { length: 100 },
      (_unused, i) => [event(), 1_000 + i] as const,
    );
    const { voices } = drive(armed(), burst);

    const heard = voices.filter((voice) => voice !== null).length;
    expect(heard).toBe(1 + Math.floor(99 / MIN_VOICE_INTERVAL_MS));
  });

  it("carries no pending queue in its state at all", () => {
    // The structural half of the same property: there is nowhere for a deferred
    // voice to sit. `tests/test_sound_wiring.py` pins the other half -- that no
    // exported function exists to drain one.
    const { state } = drive(armed(), [
      [event(), 1_000],
      [event(), 1_001],
    ]);
    expect(Object.keys(state).sort()).toEqual(["enabled", "lastVoiceMs", "live"]);
  });
});

describe("toggleSound and resetLimiter: what a root switch takes and what it leaves", () => {
  it("turns the toggle on from a fresh state", () => {
    expect(createSound().enabled).toBe(false);
    expect(toggleSound(createSound()).enabled).toBe(true);
  });

  it("turns it off again", () => {
    expect(toggleSound(toggleSound(createSound())).enabled).toBe(false);
  });

  it("keeps the live-voice count across a toggle, because those notes are still sounding", () => {
    const playing = noteStarted(armed(), 1_000);
    expect(toggleSound(playing).live).toBe(playing.live);
  });

  it("keeps the toggle across a reset, because it is a property of the listener and not of the tree", () => {
    // Decision 9, and the one place this feature contradicts the page's
    // strongest pattern: `onReset` clears everything, and everything it clears
    // is something about the OLD PROJECT. The audio toggle is about the person
    // in the chair. Silencing it on `ctrl+L` means re-enabling sound every time
    // you change what you are watching.
    expect(resetLimiter(armed()).enabled).toBe(true);
    expect(resetLimiter(createSound()).enabled).toBe(false);
  });

  it("clears the limiter's clock, so the new project's first event is not blocked by the old one's last", () => {
    const { state } = drive(armed(), [[event(), 1_000]]);
    expect(voiceFor(state, event(), 1_001)).toBe(null);
    expect(voiceFor(resetLimiter(state), event(), 1_001)).not.toBe(null);
  });
});

describe("shouldRun: the two facts that decide whether the context should be running", () => {
  it("runs when the toggle is on and the tab is visible", () => {
    expect(shouldRun(true, false)).toBe(true);
  });

  it("stops when the tab is hidden, so the vendor's throttling is not what decides", () => {
    // A window BEHIND another window is not hidden -- `visibilitychange` fires
    // for a backgrounded tab, not for an occluded one -- so a user who switches
    // applications keeps hearing the session, which is arguably the whole point
    // of the feature.
    expect(shouldRun(true, true)).toBe(false);
  });

  it("stays stopped while the toggle is off, whatever the tab is doing", () => {
    expect([shouldRun(false, false), shouldRun(false, true)]).toEqual([false, false]);
  });
});
