/**
 * Contract tests (RED) for the pure model of who is waiting and who has left.
 *
 * The defect: an agent's own state has never had an owner in the browser.
 * `Actor` is `{agent, intensity}` (src/simulation.ts:46-53) and the readable
 * label lives on the renderer's `ActorView` (src/renderer.ts:91-102), which
 * needs a GL context and carries no unit test by doctrine. So between the socket
 * and the figure there is nowhere pure for a decision to live -- and this
 * feature is nothing but decisions: whether an hour-old "waiting" is still worth
 * a ring, how long a figure keeps standing after its agent stopped, and whether
 * a repeated frame is worth a repaint. Every one of those taken in `renderer.ts`
 * is a decision that silently loses its coverage, so they are taken here.
 *
 * The staleness cut leads this file deliberately. It is the property most likely
 * to be dropped as an optimisation ("nothing ever clears it, so why compute the
 * age?"), and the failure it prevents is the one the whole feature would be
 * judged by on screen: a ring latched forever on the figure of an agent that
 * died an hour ago, in a page whose entire claim is that it shows what is
 * happening RIGHT NOW. It is also the answer to the one case decision 5 cannot
 * cover, since an agent killed while blocked never sends the tool call that
 * would clear its own wait.
 *
 * Both selectors are pure functions of `(state, now)`: no clock, no timer, no
 * socket. That is what makes the rule testable at all, and it is why `now` is
 * an argument rather than a `Date.now()` read inside.
 *
 * `STALE_WAIT_SECONDS` is the sharpest of them, and it is pinned against the
 * absence it has to outlive rather than left as a bare number. `ts` is stamped
 * when the state BEGAN and no fresher one can arrive: `set_agent_state` drops a
 * frame differing only in its timestamp, and the daemon republishes nothing
 * while a wait is unchanged. So `now - ts` measures the age of the WAIT, not
 * the silence since the daemon last spoke -- and a cut on it retires the ring
 * of an agent the daemon is still reporting as blocked, which is decision 5's
 * own failure mode (reporting false progress) relocated from the daemon into
 * the browser. What the cut is actually for is decision 9's case: an agent
 * KILLED while blocked, which never sends the tool call that would clear its
 * own wait. `ts` cannot tell that agent from a slow human, so the constant has
 * to sit beyond any absence a human plausibly takes -- a relation between two
 * named spans, so the interaction is stated in code instead of living in
 * nobody's head.
 *
 * The RELATIONS between `STALE_WAIT_SECONDS`, `DEPARTURE_SECONDS` and
 * `BEAM_LIFE_SECONDS` are pinned; their VALUES are not. They are tuning for a
 * screen nobody here can see, and a test that fails when someone nudges a fade
 * by half a second is noise -- the same bargain `readMarker.test.ts` takes with
 * its radii. The one relation that is NOT tuning is
 * `DEPARTURE_SECONDS > BEAM_LIFE_SECONDS`: a figure that vanishes faster than
 * the beam claiming it as author leaves a lit line pointing at nobody.
 *
 * Expected to FAIL until `src/agentState.ts` exists, and -- for the beam
 * relation -- until `BEAM_LIFE_SECONDS` is extracted out of `renderer.ts` into a
 * pure `src/beams.ts` that a test can import.
 */

import { describe, it, expect } from "vitest";
import {
  applyAgentStates,
  closeAgentStates,
  createAgentStates,
  departedAgents,
  DEPARTURE_SECONDS,
  LONGEST_HUMAN_ABSENCE_SECONDS,
  STALE_WAIT_SECONDS,
  waitingAgents,
} from "../src/agentState";
import { BEAM_LIFE_SECONDS } from "../src/beams";
import type { AgentStateEntry, AgentStates } from "../src/protocol";

/** A wall-clock second count, as the daemon stamps one. */
const NOW = 1754870400;

/** One parsed entry, exactly as `parseAgentStates` hands it over. */
function entry(
  agent: string,
  state: string,
  ts: number,
  label = "",
  caption = "",
): AgentStateEntry {
  return { agent, label, state, caption, ts } as AgentStateEntry;
}

/** One parsed frame carrying the given entries. */
function frame(...agents: AgentStateEntry[]): AgentStates {
  return { agents };
}

/** The model after a single frame, for the tests that need no history. */
function modelOf(...agents: AgentStateEntry[]) {
  return applyAgentStates(createAgentStates(), frame(...agents));
}

describe("waitingAgents: a fact about the past has an age", () => {
  it("drops a waiting agent whose last word is older than the staleness cut", () => {
    // The case this exists for: an agent killed while blocked sends no tool
    // call, so decision 5's clear never arrives and only the age can retire the
    // ring. Without this, the figure wears it for the life of the page.
    const state = modelOf(entry("a-1", "waiting", NOW - STALE_WAIT_SECONDS - 1));

    expect(waitingAgents(state, NOW)).toEqual([]);
  });

  it("keeps a waiting agent whose last word is younger than the staleness cut", () => {
    const state = modelOf(entry("a-1", "waiting", NOW - STALE_WAIT_SECONDS + 1));

    expect(waitingAgents(state, NOW)).toEqual(["a-1"]);
  });

  it("answers from the state and the given now alone, with no clock of its own", () => {
    // The same model, two different `now`s, two different answers -- and the
    // same answer twice for the same `now`. Anything reading a clock inside
    // would make the second half flaky rather than false.
    const state = modelOf(entry("a-1", "waiting", NOW));

    expect(waitingAgents(state, NOW)).toEqual(["a-1"]);
    expect(waitingAgents(state, NOW)).toEqual(["a-1"]);
    expect(waitingAgents(state, NOW + STALE_WAIT_SECONDS + 1)).toEqual([]);
  });

  it("cuts each agent by its own age, not by the age of the newest in the frame", () => {
    const state = modelOf(
      entry("stale", "waiting", NOW - STALE_WAIT_SECONDS - 1),
      entry("fresh", "waiting", NOW - 1),
    );

    expect(waitingAgents(state, NOW)).toEqual(["fresh"]);
  });
});

describe("createAgentStates: the empty model", () => {
  it("starts with no agents at all", () => {
    expect(createAgentStates().byAgent.size).toBe(0);
  });

  it("reports nobody waiting and nobody departing", () => {
    const state = createAgentStates();

    expect(waitingAgents(state, NOW)).toEqual([]);
    expect(departedAgents(state, NOW)).toEqual([]);
  });
});

describe("applyAgentStates: adoption", () => {
  it("adopts every agent the frame names, keyed by agent", () => {
    const state = modelOf(
      entry("a-1", "waiting", NOW, "developer-backend"),
      entry("a-2", "working", NOW, "developer-tester"),
    );

    expect([...state.byAgent.keys()].sort()).toEqual(["a-1", "a-2"]);
  });

  it("keeps two subagents of one label apart, because agent is identity and label is only text", () => {
    // Two `developer-backend` subagents spawned in one turn are two figures
    // with two colours by design. Keying this model on the label would collapse
    // them into one, and the ring would land on whichever arrived last.
    const state = modelOf(
      entry("a-1", "waiting", NOW, "developer-backend"),
      entry("a-2", "working", NOW, "developer-backend"),
    );

    expect(state.byAgent.size).toBe(2);
    expect(waitingAgents(state, NOW)).toEqual(["a-1"]);
  });

  it("carries the label, the caption and the timestamp of each entry through unchanged", () => {
    const state = modelOf(entry("a-1", "waiting", NOW, "developer-backend", "needs permission"));

    expect(state.byAgent.get("a-1")).toEqual({
      agent: "a-1",
      label: "developer-backend",
      phase: "waiting",
      caption: "needs permission",
      ts: NOW,
    });
  });

  it("replaces the whole picture, dropping an agent the newest frame no longer names", () => {
    // The frame is cumulative, not a delta: what it does not name is not there.
    const first = modelOf(entry("a-1", "waiting", NOW), entry("a-2", "waiting", NOW));
    const second = applyAgentStates(first, frame(entry("a-1", "waiting", NOW)));

    expect([...second.byAgent.keys()]).toEqual(["a-1"]);
  });
});

describe("applyAgentStates: the same reference when nothing changed", () => {
  it("returns the very same reference for a frame that changes nothing", () => {
    // `if (next !== state)` is the caller's whole adoption test, as it already
    // is for `applyView` and `applySizes`. Returning a fresh object for an
    // identical frame repaints every figure on every replay.
    const state = modelOf(entry("a-1", "waiting", NOW, "developer-backend"));

    expect(applyAgentStates(state, frame(entry("a-1", "waiting", NOW, "developer-backend")))).toBe(
      state,
    );
  });

  it("returns a new reference when an agent changed phase", () => {
    const state = modelOf(entry("a-1", "waiting", NOW));

    expect(applyAgentStates(state, frame(entry("a-1", "working", NOW)))).not.toBe(state);
  });

  it("returns a new reference when the frame names an agent the model had not seen", () => {
    const state = modelOf(entry("a-1", "waiting", NOW));

    expect(
      applyAgentStates(state, frame(entry("a-1", "waiting", NOW), entry("a-2", "working", NOW))),
    ).not.toBe(state);
  });

  it("adopts a fresher timestamp, so a wait that was about to go stale is live again", () => {
    // The ts is what the staleness cut reads, so an unchanged phase with a new
    // ts is a real change: treating it as "nothing changed" would retire a ring
    // the daemon is still reporting.
    const state = modelOf(entry("a-1", "waiting", NOW - STALE_WAIT_SECONDS - 1));
    const refreshed = applyAgentStates(state, frame(entry("a-1", "waiting", NOW)));

    expect(waitingAgents(refreshed, NOW)).toEqual(["a-1"]);
  });
});

describe("departedAgents: a figure leaves over a window, not in a frame", () => {
  it("reports a stopped agent for the whole departure window, so the renderer can fade it", () => {
    const state = modelOf(entry("a-1", "stopped", NOW));

    expect(departedAgents(state, NOW)).toEqual(["a-1"]);
    expect(departedAgents(state, NOW + DEPARTURE_SECONDS / 2)).toEqual(["a-1"]);
    expect(departedAgents(state, NOW + DEPARTURE_SECONDS - 0.01)).toEqual(["a-1"]);
  });

  it("drops a stopped agent once the departure window has passed", () => {
    const state = modelOf(entry("a-1", "stopped", NOW));

    expect(departedAgents(state, NOW + DEPARTURE_SECONDS + 1)).toEqual([]);
  });

  it("never reports a stopped agent as waiting", () => {
    // An agent that has finished is not blocked, and a ring on a figure that is
    // leaving says the opposite of what the departure says.
    const state = modelOf(entry("a-1", "stopped", NOW));

    expect(waitingAgents(state, NOW)).toEqual([]);
  });

  it("never reports a working or a waiting agent as departing", () => {
    const state = modelOf(entry("a-1", "working", NOW), entry("a-2", "waiting", NOW));

    expect(departedAgents(state, NOW)).toEqual([]);
  });
});

describe("the windows, as relations rather than values", () => {
  it("keeps a departing figure alive longer than the beams that name it as author", () => {
    // A subagent that stops while its last write is still flashing must not
    // vanish and orphan a lit beam pointing at nobody. This is the one constant
    // here that is not free tuning, and it is the one somebody would quietly
    // retune to 0.5 having found the fade slow.
    expect(DEPARTURE_SECONDS).toBeGreaterThan(BEAM_LIFE_SECONDS);
  });

  it("outlives the longest absence a human plausibly takes, so a real block keeps its ring", () => {
    // The failure this prevents: an agent genuinely still blocked loses its
    // ring while the daemon is still reporting it `waiting`, because the stamp
    // it is aged against is the moment the wait BEGAN and no fresher one is
    // ever sent -- `set_agent_state` drops a frame differing only in its
    // timestamp. Cutting below a human absence therefore reports false
    // progress, which is exactly what decision 5 refuses to do in the daemon.
    //
    // `LONGEST_HUMAN_ABSENCE_SECONDS` is the span this page is willing to call
    // "somebody stepped away and the agent is still waiting for them": a lunch,
    // a meeting, a night. It is not a fade and not a tuning knob for a screen;
    // it is the thing `STALE_WAIT_SECONDS` has to be measured against, because
    // a `ts` alone cannot tell a slow human from a killed agent.
    expect(STALE_WAIT_SECONDS).toBeGreaterThan(LONGEST_HUMAN_ABSENCE_SECONDS);
  });

  it("measures that absence on a human scale, so the relation above cannot be met degenerately", () => {
    // Without this the relation is satisfiable by declaring the absence at one
    // second, which states nothing at all. The hour is not tuning: it is the
    // premise decision 5 is written on, and `EventHub._record_agent_state`'s
    // own docstring spells it -- a human can be away from the keyboard for an
    // hour with the agent genuinely still blocked. Raise it freely; it is a
    // floor, and the relation above moves the staleness cut with it.
    expect(LONGEST_HUMAN_ABSENCE_SECONDS).toBeGreaterThanOrEqual(60 * 60);
  });

  it("measures both windows as positive, finite spans of seconds", () => {
    expect(Number.isFinite(STALE_WAIT_SECONDS)).toBe(true);
    expect(Number.isFinite(DEPARTURE_SECONDS)).toBe(true);
    expect(STALE_WAIT_SECONDS).toBeGreaterThan(0);
    expect(DEPARTURE_SECONDS).toBeGreaterThan(0);
  });
});

describe("closeAgentStates: the root switch", () => {
  it("empties the model, because the actors of the old project are not the new one's", () => {
    const state = modelOf(entry("a-1", "waiting", NOW), entry("a-2", "stopped", NOW));

    expect(closeAgentStates(state)).toEqual(createAgentStates());
  });

  it("leaves nobody waiting and nobody departing after the close", () => {
    const closed = closeAgentStates(modelOf(entry("a-1", "waiting", NOW)));

    expect(waitingAgents(closed, NOW)).toEqual([]);
    expect(departedAgents(closed, NOW)).toEqual([]);
  });
});

describe("a wait is cleared by the agent's own next tool call, never by a timer", () => {
  it("takes an agent out of waitingAgents the moment a later frame says it is working", () => {
    // Decision 5 arriving in the browser: the daemon clears the wait when the
    // agent runs its next tool, so the model must not hold the ring for any
    // window of its own after that frame lands.
    const waiting = modelOf(entry("a-1", "waiting", NOW));
    const working = applyAgentStates(waiting, frame(entry("a-1", "working", NOW + 1)));

    expect(waitingAgents(waiting, NOW)).toEqual(["a-1"]);
    expect(waitingAgents(working, NOW + 1)).toEqual([]);
  });
});
