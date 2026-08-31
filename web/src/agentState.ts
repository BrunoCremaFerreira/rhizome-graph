/**
 * Who is waiting, who is working and who has just left.
 *
 * The pure model between the socket and the figure. `Actor` in `simulation.ts`
 * is `{agent, intensity}` and the readable caption lives on the renderer's
 * `ActorView`, which needs a GL context and carries no unit test by doctrine —
 * so before this module there was nowhere for a decision about an agent's own
 * state to live and still be covered. Every decision here is one that would
 * silently lose its coverage in `renderer.ts`: whether an hour-old "waiting" is
 * still worth a ring, how long a figure keeps standing after its agent stopped,
 * and whether a repeated frame is worth a repaint.
 *
 * Both selectors are pure functions of `(state, now)`. There is no clock, no
 * timer and no stored "stale" flag anywhere in here: the daemon stamps a
 * wall-clock `ts` on every entry and this module decides what an old fact looks
 * like. That is what makes the rule testable with a number instead of a wait,
 * and it is why the renderer evaluates them EVERY FRAME from the `now` it
 * already has — evaluating them once on adoption would freeze the answer.
 *
 * The frame is cumulative, never a delta: what it does not name is not there.
 */

import type { AgentStates } from "./protocol";

/**
 * What an agent is doing, in the model's own vocabulary.
 *
 * The same three words the wire uses. The rename from `state` to `phase` is
 * deliberate: `AgentStateEntry.state` is what the daemon said, `AgentEntry.
 * phase` is what this page believes, and keeping the two names apart is what
 * stops a renderer reading a wire field directly.
 */
export type AgentPhase = "working" | "waiting" | "stopped";

/** One agent as the page holds it. */
export interface AgentEntry {
  /** The actor key — identity, and the seed of the figure's colour. */
  agent: string;
  /** The readable agent type, DISPLAY only; `""` for the orchestrator. */
  label: string;
  /** What the agent is doing. */
  phase: AgentPhase;
  /** A short line about what it is doing, or `""`. */
  caption: string;
  /** Wall-clock seconds when the daemon last heard from this agent. */
  ts: number;
}

/** The whole picture, keyed on `agent` — identity, never on `label`. */
export interface AgentStateModel {
  readonly byAgent: ReadonlyMap<string, AgentEntry>;
}

/**
 * The longest absence this page reads as "somebody stepped away", in seconds.
 *
 * Not a fade and not a tuning knob for a screen: it is the span
 * {@link STALE_WAIT_SECONDS} is measured against. `EventHub.set_agent_state`
 * drops a frame differing from the one it holds only in its timestamp — a
 * notification repeated while the human is still away is one fact told twice —
 * so a waiting entry's `ts` is when the wait BEGAN, and no fresher stamp can
 * ever arrive. An age is therefore all this page has, and an age alone cannot
 * tell a slow human from a killed agent.
 *
 * Eight hours: a lunch, a meeting, a night, a working day spent elsewhere. The
 * daemon's own `_record_agent_state` names an hour as the absence a human
 * plausibly takes, so that is the floor; this is deliberately well above it,
 * because the cost of being wrong here is retiring the ring of an agent that is
 * genuinely still blocked, which is decision 5's own failure mode — reporting
 * false progress — moved from the daemon into the browser.
 */
export const LONGEST_HUMAN_ABSENCE_SECONDS = 8 * 60 * 60;

/**
 * How old a `waiting` may be and still be drawn, in seconds.
 *
 * A wait is cleared by the agent's own next tool call, never by a timer: a
 * human can be away from the keyboard for a long time with the agent genuinely
 * still blocked, and a timeout that cleared the state would report false
 * progress. This constant does NOT clear anything — it decides how an OLD fact
 * is drawn, and it exists for the one case that rule cannot cover: an agent
 * killed while blocked never sends the tool call that would clear its own wait,
 * so without an age its ring is latched on that figure for the life of the
 * page.
 *
 * The trade runs both ways and has no comfortable middle. Too short retires a
 * ring the daemon is still reporting, telling the viewer an agent got on with
 * its work when it is in fact still blocked. Too long leaves a dead agent's
 * ring standing in a page nobody reloads. Twelve hours sits strictly above
 * {@link LONGEST_HUMAN_ABSENCE_SECONDS} — every absence this page is willing to
 * call human keeps its ring — and still clears the overnight case, where a
 * viewer left open since yesterday would otherwise be a field of rings for
 * agents that died hours ago. A relation and a value: the relation is pinned by
 * the tests, the value above it is free to retune once somebody has watched a
 * real session.
 */
export const STALE_WAIT_SECONDS = 12 * 60 * 60;

/**
 * How long a stopped agent's figure keeps standing, in seconds.
 *
 * This one is NOT free tuning. It must outlive the longest beam
 * ({@link BEAM_LIFE_SECONDS}, 1.2 s) and a full write flash (~1.1 s at
 * `HIGHLIGHT_DECAY_PER_SEC`), because a subagent that stops while its last
 * write is still flashing must not vanish and orphan a lit line that claims it
 * as author. 2.5 s clears both with margin.
 *
 * The departure rides ON TOP of the existing idle decay and does not replace
 * it: the decay stays the floor for every fact that never arrives — a missed
 * `SubagentStop`, a killed process, a hook that turns out not to fire.
 */
export const DEPARTURE_SECONDS = 2.5;

/** The empty model: no agent has been heard from yet. */
export function createAgentStates(): AgentStateModel {
  return { byAgent: new Map<string, AgentEntry>() };
}

/**
 * Whether two entries say the same thing about the same agent.
 *
 * A type predicate rather than a plain boolean, so the caller may hand back the
 * entry it compared against without a cast: "nothing moved" and "there is a
 * previous object to reuse" are one answer, and spelling them as two invites the
 * next reader to reuse an entry the comparison never approved.
 */
function sameEntry(a: AgentEntry | undefined, b: AgentEntry): a is AgentEntry {
  return (
    a !== undefined &&
    a.agent === b.agent &&
    a.label === b.label &&
    a.phase === b.phase &&
    a.caption === b.caption &&
    // The `ts` counts: it is what the staleness cut reads. The daemon never
    // sends a fresher stamp for a fact it is already holding — `set_agent_state`
    // drops a frame differing only in its timestamp — so this compares two
    // stamps that differ only when the fact itself is new, and it is here to
    // keep the picture exact rather than to catch a refresh.
    a.ts === b.ts
  );
}

/**
 * Adopt the daemon's picture, or hand back the very same reference.
 *
 * The `applyView` / `applySizes` idiom: `if (next !== state)` is the caller's
 * whole adoption test, and it is what keeps `main.ts` from repainting every
 * figure on every deduped frame and every replay.
 *
 * The frame REPLACES the picture rather than merging into it, because it is
 * cumulative by contract: an agent the newest frame does not name is an agent
 * the daemon is no longer reporting, and keeping it would strand its ring.
 */
export function applyAgentStates(state: AgentStateModel, frame: AgentStates): AgentStateModel {
  const byAgent = new Map<string, AgentEntry>();
  let changed = frame.agents.length !== state.byAgent.size;

  for (const wire of frame.agents) {
    const entry: AgentEntry = {
      agent: wire.agent,
      label: wire.label,
      // A rename, not a translation: `protocol.ts` owns the closed set of
      // words, and a second validation here would be a second definition of it,
      // free to drift from the one on the wire.
      phase: wire.state,
      caption: wire.caption,
      ts: wire.ts,
    };
    // The identity check one level down, and it is not the same question as the
    // one above: that one keeps a deduped frame or a replay from repainting
    // anything at all, while this one keeps an agent NOBODY touched from being
    // repainted because a neighbour moved. The daemon republishes the whole
    // picture whenever any single entry changes, so with three agents at work a
    // figure that never moves is handed to the renderer as a fresh object
    // several times a minute -- a canvas and a texture upload each time, for a
    // caption whose text is identical. Reusing the previous object is what makes
    // those uploads proportional to real changes rather than to frames, and
    // reference identity is the only thing a renderer can cheaply test.
    const previous = state.byAgent.get(entry.agent);
    if (sameEntry(previous, entry)) {
      byAgent.set(entry.agent, previous);
      continue;
    }
    changed = true;
    byAgent.set(entry.agent, entry);
  }

  // A frame naming the same agent twice would leave `byAgent` shorter than the
  // list; that is a real difference from the previous picture either way.
  if (!changed && byAgent.size !== state.byAgent.size) changed = true;

  return changed ? { byAgent } : state;
}

/**
 * Forget every actor, because the daemon switched roots.
 *
 * The agents of the old project are not the new one's, and a ring left behind
 * would sit on a figure standing over a tree it never touched.
 */
export function closeAgentStates(_state: AgentStateModel): AgentStateModel {
  return createAgentStates();
}

/**
 * Who is blocked right now, in the order the daemon listed them.
 *
 * Each agent is cut by its OWN age, never by the age of the newest entry in the
 * frame: one agent still reporting must not keep another's dead wait alive.
 */
export function waitingAgents(state: AgentStateModel, now: number): readonly string[] {
  const waiting: string[] = [];
  for (const entry of state.byAgent.values()) {
    if (entry.phase !== "waiting") continue;
    if (now - entry.ts >= STALE_WAIT_SECONDS) continue;
    waiting.push(entry.agent);
  }
  return waiting;
}

/**
 * Who is leaving right now, in the order the daemon listed them.
 *
 * A stopped agent is reported for the whole {@link DEPARTURE_SECONDS} window
 * and then is gone, so the renderer has a span in which to fade a figure out
 * rather than a deletion it has to react to within one frame.
 */
export function departedAgents(state: AgentStateModel, now: number): readonly string[] {
  const departing: string[] = [];
  for (const entry of state.byAgent.values()) {
    if (entry.phase !== "stopped") continue;
    if (now - entry.ts >= DEPARTURE_SECONDS) continue;
    departing.push(entry.agent);
  }
  return departing;
}
