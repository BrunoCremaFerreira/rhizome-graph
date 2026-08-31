/**
 * Every decision behind the ambient sound: what is worth hearing, and in whose voice.
 *
 * The page has never made a noise, and a sound is the least forgiving channel it
 * has. A list can be scrolled back and a wrong row can be ignored; a click
 * cannot be un-heard, and a page that clicks 12 524 times the moment a client
 * connects is a page nobody switches on twice. So every judgement lives here,
 * pure, beside {@link ./search}, {@link ./contentSearch}, {@link ./sizeMode} and
 * {@link ./eventLog}, and the module that calls the platform ({@link ./audio})
 * decides nothing at all.
 *
 * The split is FORCED, not chosen. `web/vitest.config.ts` runs the front end's
 * suite with `environment: "node"`: there is no audio API in it, no `document`
 * and no global page object, and this project's doctrine adds no mock to invent
 * one -- keeping the suite "mock-free, jsdom-free and fast" is the stated reason
 * the shiki boundary exists. A decision taken in the sink would be a decision no
 * assertion in this repository could ever reach; a decision taken in `main.ts`
 * carries no test by doctrine either.
 *
 * It is deliberately NOT folded into {@link ./eventLog}. That module's two drop
 * rules are the recent-changes list's own policy, and two callers of one
 * `shouldDrop` would be one change away from silencing the panel a user is
 * reading in order to quieten the speakers. Nor into {@link ./simulation}: a
 * sound has a lifetime of its own, and `SimNode` is four channels the tick
 * decays -- the same objection {@link ./sizeMode} makes to putting `bytes`
 * there.
 *
 * FOUR SILENCE RULES, INDEPENDENT, AND NONE IS THE SAFETY NET FOR THE OTHERS.
 * Measured in the plan over 200 000 synthetic events they leave 1 961: seeds
 * silent, reads silent, a rate floor and a voice budget. Drop any one and the
 * other three are in a position they were not sized for -- most sharply the seed
 * rule, since a 40 ms floor over a 12 524-event backdrop is not silence, it is
 * twenty-five clicks a second for eight minutes.
 *
 * A DROPPED EVENT IS DROPPED, NEVER QUEUED. There is no pending slot in
 * {@link SoundState} and no function that would drain one. A queue turns a burst
 * into a drone that outlives the work it describes -- the same lie about "right
 * now" that keeps read flashes out of the daemon's replay buffer. The sound is
 * simultaneous with the event or it is absent.
 *
 * THE CLOCK IS A PARAMETER, the way the viewport is a parameter in
 * {@link ./labels} and {@link ./bottomRow}. A module that read the page's own
 * clock could not be tested without owning time.
 *
 * WHAT A ROOT SWITCH TAKES, AND WHAT IT LEAVES. This is the one place the
 * feature contradicts the page's strongest pattern: `onReset` clears everything,
 * and everything it clears is a fact about the OLD PROJECT. The toggle is a fact
 * about the person in the chair, so {@link resetLimiter} clears the limiter's
 * clock and keeps `enabled` -- otherwise sound has to be re-enabled every time
 * the user changes what they are watching.
 */

import { actorHash } from "./colors";
import type { AgentEvent } from "./protocol";

/**
 * The rate floor: no two voices closer together than this, in milliseconds.
 *
 * A ceiling of 25 voices per second, from two figures in the perception
 * literature and not from anything measured here: roughly 20 ms is where two
 * clicks fuse into one perceived event, and roughly 25 per second is where
 * discrete clicks stop being countable and start being texture. **It is the
 * first constant a listening session should retune**, and nothing else depends
 * on its value -- the tests pin the boundary (`>=`, not `>`) rather than the
 * number.
 */
export const MIN_VOICE_INTERVAL_MS = 40;

/**
 * How many voices may sound at once. Above it, an event is silent.
 *
 * The same shape as the renderer's fixed `MAX_BEAMS` on a burst-driven channel,
 * applied to a resource that is not a buffer but an audio thread: simultaneous
 * sine voices sum toward clipping, and a browser caps how many nodes a graph may
 * hold far lower than it caps textures. `live` is maintained by the CALLER,
 * through {@link noteStarted} and {@link noteEnded}, because the real end of a
 * note is an event the platform reports -- a timer here would be a decision this
 * module could not test without owning a clock.
 */
export const MAX_CONCURRENT_VOICES = 8;

/** How loud one voice is, and how long it lasts. Both are for the afternoon of listening. */
const VOICE_GAIN = 0.12;
const VOICE_DURATION_MS = 90;

/** The note the table's offsets are counted from: A3. */
const BASE_FREQ_HZ = 220;

/**
 * THE ONE TABLE A LISTENING SESSION MAY REWRITE, and nothing else changes.
 *
 * The `PREFERENCE_BY_PLATFORM` idiom: semitone offsets from A3, and every value
 * in it is a musical judgement rather than a measurement -- a pentatonic set was
 * chosen because any two of its members are consonant, so two agents working at
 * once cannot produce an interval that reads as a mistake. Nobody on the host
 * this was written on could hear any of it. The tests pin the MAPPING (an agent
 * lands on `actorHash(agent) % PITCH_TABLE.length`) and never the frequencies,
 * so a retune is an edit to these fifteen numbers.
 *
 * WHAT THIS TABLE DOES NOT DO: it does not let you tell agents apart by ear.
 * Measured over 20 000 synthetic ids, six agents get about five distinct pitches
 * from fifteen notes, and no table size fixes it -- 24 notes buys 0.31 of an
 * agent for an octave of extra range. Two agents sharing a pitch is the ordinary
 * case. The true claim, and the only one worth making, is that **the same agent
 * always sounds the same**, so the pitch and the figure's colour agree because
 * both are projections of one hash.
 */
export const PITCH_TABLE: readonly number[] = [
  0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27, 29, 31, 34,
];

/** A resolved note, and the whole of what the audio sink is ever told. */
export interface Voice {
  /** Pitch in Hz. */
  readonly freq: number;
  /** Peak gain, 0..1. */
  readonly gain: number;
  /** How long the envelope runs, in milliseconds. */
  readonly durationMs: number;
}

/**
 * The voice of a change nobody can be credited for.
 *
 * An event with `agent: ""` never creates an actor: there is no figure, no
 * colour and no identity to project into a pitch. `actorVoice("")` is perfectly
 * computable, and using it would invent an identity for somebody who has none --
 * giving the human editing a file in their own editor a voice indistinguishable
 * from an agent's. So the default is a NAMED constant: the tonic, one note every
 * unattributed change shares.
 */
export const DEFAULT_VOICE: Voice = {
  freq: BASE_FREQ_HZ,
  gain: VOICE_GAIN,
  durationMs: VOICE_DURATION_MS,
};

/** The toggle, the limiter's clock, and how many notes are sounding right now. */
export interface SoundState {
  /** Off until F9 is pressed in THIS tab. Nothing persists it anywhere. */
  readonly enabled: boolean;
  /** When the last voice started, on the caller's clock. */
  readonly lastVoiceMs: number;
  /** Notes currently sounding, maintained by the caller. */
  readonly live: number;
}

/**
 * A silent page, which is the only state a page may load in.
 *
 * Off by default, and the default is not a setting: no environment variable, no
 * persistence, nothing carried from another tab. A page that starts making noise
 * because of something decided in another session is the worst failure available
 * to this feature, and persistence is exactly that failure. The price is one key
 * press per page load, which is the correct annoyance.
 *
 * The clock starts at negative infinity rather than at zero: the page's clock is
 * milliseconds since the document was created, so the first event of a session
 * arrives at an arbitrary large number and a limiter initialised into the future
 * would swallow it once per page load.
 */
export function createSound(): SoundState {
  return { enabled: false, lastVoiceMs: Number.NEGATIVE_INFINITY, live: 0 };
}

/**
 * Flip the toggle, and keep everything else.
 *
 * `live` survives because those notes are still sounding and their `ended`
 * callbacks are still coming; zeroing it here would drift the count below zero
 * the moment they arrive.
 */
export function toggleSound(state: SoundState): SoundState {
  return { ...state, enabled: !state.enabled };
}

/**
 * The pitch of one agent: the second projection of the hash that gives it its colour.
 *
 * Built on {@link actorHash} rather than on the colour, because a pitch taken as
 * `actorColor(agent) % PITCH_TABLE.length` would be hash mod 360 mod 15 -- a
 * double reduction that correlates pitch with hue by arithmetic accident. One
 * hash, two projections.
 */
export function actorVoice(agent: string): Voice {
  const semitones = PITCH_TABLE[actorHash(agent) % PITCH_TABLE.length];
  return {
    freq: BASE_FREQ_HZ * Math.pow(2, semitones / 12),
    gain: VOICE_GAIN,
    durationMs: VOICE_DURATION_MS,
  };
}

/**
 * The voice this event earns right now, or `null` for silence.
 *
 * A pure function of its three arguments: same state, same event, same clock,
 * same answer. **The order of the checks is the design, not an accident of
 * writing.**
 */
export function voiceFor(
  state: SoundState,
  event: AgentEvent,
  nowMs: number,
): Voice | null {
  // The toggle refuses first and unconditionally: nothing decided anywhere else
  // may make a silent page make a noise.
  if (!state.enabled) return null;

  // THE SEED CHECK COMES BEFORE THE LIMITER, AND THAT IS THE POINT.
  // A connecting client is replayed the whole tree -- up to 20 000 `A` events
  // inside a second. Putting the cheap integer comparison (the floor, below)
  // ahead of this string comparison is faster and is what an optimiser would
  // do; under that order the first seed sounds, stamps `lastVoiceMs`, and the
  // real change three milliseconds later is swallowed by a floor that backdrop
  // set. Being silent must cost the limiter nothing.
  if (event.origin === "seed") return null;

  // A read is not a change. An agent reads roughly ten times more often than it
  // writes, which in the recent-changes list would push every real edit off the
  // top; here it is nine tenths of the noise carrying one tenth of the meaning,
  // in a medium with no scrollback.
  if (event.type === "R") return null;

  // The floor, whose boundary is `>=`: a voice exactly one interval after the
  // last one is allowed. A refused event is gone, not deferred.
  if (nowMs - state.lastVoiceMs < MIN_VOICE_INTERVAL_MS) return null;

  // The budget, which the caller maintains.
  if (state.live >= MAX_CONCURRENT_VOICES) return null;

  // `A`, `M` and `D` all sound, and they sound the SAME: the graph already
  // answers what kind of change it was, in colour. One perceptual dimension,
  // one meaning -- the voice says WHO, and the click says that something
  // happened.
  return event.agent ? actorVoice(event.agent) : DEFAULT_VOICE;
}

/** One note has begun: stamp the limiter and take a slot from the budget. */
export function noteStarted(state: SoundState, nowMs: number): SoundState {
  return { ...state, lastVoiceMs: nowMs, live: state.live + 1 };
}

/**
 * One note has ended: give its slot back.
 *
 * Floored at zero, because the caller is a platform callback: a sink that fired
 * `ended` twice for one voice, or once for a voice a suspended context never
 * played, would otherwise drive the budget negative and the limit would never
 * fire again.
 */
export function noteEnded(state: SoundState): SoundState {
  return { ...state, live: Math.max(0, state.live - 1) };
}

/**
 * A root switch: the clock goes, the toggle stays.
 *
 * The clock was set by the last event of a project nobody is watching any more,
 * and the first change in the new one must not be swallowed by it. `enabled` is
 * a property of the listener rather than of the tree and survives -- which is
 * the one place this feature contradicts `onReset`'s rule that everything is
 * cleared, and the reason there is no exported function that could turn the
 * sound off.
 *
 * `live` survives too: those notes are still sounding, and their `ended`
 * callbacks are still on their way.
 */
export function resetLimiter(state: SoundState): SoundState {
  return { ...state, lastVoiceMs: Number.NEGATIVE_INFINITY };
}

/**
 * Whether the audio should be running, given the toggle and whether the tab is hidden.
 *
 * Browsers already throttle or suspend audio in background tabs, inconsistently;
 * deciding it here makes the behaviour ours rather than the vendor's. **A tab
 * behind another APPLICATION is not hidden** -- the visibility event fires for a
 * backgrounded tab, not for an occluded one -- so a user who switches
 * applications keeps hearing the session, which is arguably the whole point of
 * the feature. Both expectations are plausible and only one of them is what
 * happens, so it is written down rather than left to be discovered.
 */
export function shouldRun(enabled: boolean, hidden: boolean): boolean {
  return enabled && !hidden;
}
