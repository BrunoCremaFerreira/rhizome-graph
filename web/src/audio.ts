/**
 * The one door onto the platform's audio API: it plays a voice and decides nothing.
 *
 * **No test in this repository executes a single line of this file, and none ever
 * will.** `web/vitest.config.ts` runs the front end's suite with
 * `environment: "node"`, where there is no audio API to construct, and this
 * project's doctrine adds no mock to invent one -- keeping the suite
 * "mock-free, jsdom-free and fast" is the stated reason the shiki boundary
 * exists at all. Adding jsdom or a fake context would buy assertions about the
 * fake and pay for them with the property that makes this suite trusted. So the
 * defence available for this module is the negative one, exactly as it is for
 * `highlight.ts`: there are very few lines here, none of them decides anything,
 * and `tests/test_sound_module_boundary.py` is the scan that keeps it that way.
 *
 * Five rules, and if one of them is broken here nothing will notice.
 *
 *  - **It decides nothing.** It receives a resolved {@link Voice} and plays it.
 *    It knows nothing about seeds, reads, rate floors, budgets or agents; all of
 *    that is {@link ./sound}, which is testable. If a condition about an event
 *    appears in this file, it is in the wrong file -- which is why this module
 *    may not import `./protocol` or `./simulation`: a module that can see an
 *    `AgentEvent` is a module that can start deciding things about one.
 *  - **`start()` is only ever called from inside a gesture handler.** That is
 *    the caller's contract and it cannot be checked here. A context constructed
 *    outside a user gesture starts suspended under every current autoplay
 *    policy, and `resume()` away from a gesture is refused -- so the toggle IS
 *    the gesture, and the context cannot be built at boot and enabled later.
 *  - **Every voice disconnects when it ends, and calls back.** A node that is
 *    not disconnected stays in the graph forever, and at twenty-five per second
 *    that is a leak with a measurable shape and no test to catch it. The
 *    callback is what lets the model give the budget slot back.
 *  - **The envelope has a ramp at BOTH ends.** An oscillator started or stopped
 *    at full gain produces a click artefact at that edge -- and for a feature
 *    whose whole output is a click, the artefact and the signal are
 *    indistinguishable. A short linear attack into an exponential decay is the
 *    shape; the numbers are for the afternoon of listening this feature cannot
 *    have on a machine with no audio device.
 *  - **IT NEVER THROWS.** A browser that refuses to construct a context, a
 *    `resume()` that is rejected, a voice scheduled after suspension: each of
 *    them is silence, never an exception. `wsClient.send`'s reason applies
 *    unchanged -- this is called straight from a key handler, and an exception
 *    thrown out of it leaves the page with a dead keyboard.
 */

import type { Voice } from "./sound";

/** How long the attack takes, in seconds. Long enough to have no edge, short enough to be a click. */
const ATTACK_SECONDS = 0.004;

/**
 * Where the decay ends.
 *
 * An exponential ramp may not reach zero, so it reaches something inaudible and
 * the oscillator is stopped there.
 */
const SILENT_GAIN = 0.0001;

/** The whole of what the page may ask the platform for. */
export interface AudioSink {
  /** Construct the context if needed and resume it. Call only inside a gesture. */
  start(): void;
  /** Stop the context without destroying it: a closed one cannot be reopened. */
  suspend(): void;
  /** Play one resolved voice, and call back when it has ended. */
  play(voice: Voice, onEnded: () => void): void;
  /** Whether a context exists and is running. */
  running(): boolean;
}

/** The constructor, under either of its two spellings. */
type ContextConstructor = new () => AudioContext;

/**
 * The vendor-prefixed spelling is looked up here and nowhere else: a Safari
 * fallback written in a second module would be a second door onto one platform
 * resource.
 */
function contextConstructor(): ContextConstructor | null {
  const scope = globalThis as unknown as {
    AudioContext?: ContextConstructor;
    webkitAudioContext?: ContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** A sink that holds at most one context for the life of the page. */
export function createAudioSink(): AudioSink {
  let context: AudioContext | null = null;

  function ensure(): AudioContext | null {
    if (context) return context;
    const Constructor = contextConstructor();
    if (!Constructor) return null;
    try {
      context = new Constructor();
    } catch {
      // A browser that will not build one is a page that stays quiet.
      context = null;
    }
    return context;
  }

  return {
    start(): void {
      const live = ensure();
      if (!live) return;
      // `resume` returns a promise that rejects when the call is not inside a
      // gesture. A rejection here is silence, not an unhandled rejection.
      void live.resume().catch(() => undefined);
    },

    suspend(): void {
      // `suspend`, never `close`: a closed context cannot be reopened, so the
      // next press would have to build another, and a browser will refuse to
      // create very many. Suspending costs a few kilobytes of idle graph and
      // makes the toggle instant.
      if (!context) return;
      void context.suspend().catch(() => undefined);
    },

    play(voice: Voice, onEnded: () => void): void {
      const live = context;
      if (!live || live.state !== "running") {
        // Nothing will sound, so nothing will report an end: the callback runs
        // now, or the budget slot the model has already taken is never given
        // back and the feature wedges silent after eight events.
        onEnded();
        return;
      }
      try {
        const oscillator = live.createOscillator();
        const envelope = live.createGain();
        const startAt = live.currentTime;
        const endAt = startAt + voice.durationMs / 1000;

        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(voice.freq, startAt);

        // The ramp at both ends: up from silence, then down to it.
        envelope.gain.setValueAtTime(SILENT_GAIN, startAt);
        envelope.gain.linearRampToValueAtTime(voice.gain, startAt + ATTACK_SECONDS);
        envelope.gain.exponentialRampToValueAtTime(SILENT_GAIN, endAt);

        oscillator.connect(envelope);
        envelope.connect(live.destination);
        oscillator.onended = (): void => {
          try {
            oscillator.disconnect();
            envelope.disconnect();
          } catch {
            // Already gone; there is nothing to report and nowhere to report it.
          }
          onEnded();
        };
        oscillator.start(startAt);
        oscillator.stop(endAt);
      } catch {
        // A voice that could not be built is silence, and its slot goes back.
        onEnded();
      }
    },

    running(): boolean {
      return context !== null && context.state === "running";
    },
  };
}
