/**
 * RED specification for `attentionState.ts`: what the page holds when an agent
 * has touched something the user asked to be told about.
 *
 * The defect: nothing on the page can hold an alarm. `SimNode` has four
 * channels and the tick decays three of them, so a value with no decay --
 * an alarm lasts until a human dismisses it, because the file stays modified --
 * has nowhere to live that is not a per-frame animation channel.
 *
 * THE DIVERGENCE THIS FILE EXISTS FOR, and the reason the fold test is written
 * first: `eventLog.ts` folds a repeat into the TOP entry only, because folding
 * into an older entry would reorder the list under the reader's eye. An alarm
 * list is a SET, not a stream. The reader is being asked "what needs looking
 * at", not "what happened last", so forty touches of one lockfile are ONE alarm
 * with a count of forty whether or not something else alarmed in between. An
 * implementation copied from `eventLog.ts` -- which is the obvious thing to
 * copy, right down to the `resolveMax` this module also wants -- passes every
 * other test here and fails that one, which is why it is the driver.
 *
 * The other properties are the ones a latch can silently lose: an acknowledged
 * alarm that re-arms must look like a NEW alarm and not like a handled one; the
 * seed must never alarm, because the boot snapshot is twelve thousand paths
 * nobody touched; the list must be bounded, since a refactor across a watched
 * subtree is the ordinary case rather than the hostile one; and a `false`
 * verdict must return the SAME REFERENCE, the `applyView` idiom, so `main.ts`
 * holds an adoption test and not a comparison of its own.
 *
 * Pure, like `search.ts`, `contentSearch.ts` and `sizeMode.ts`, for the reason
 * all three give: a decision taken in `main.ts` carries no test by doctrine and
 * one taken in `renderer.ts` cannot be tested at all.
 */

import { describe, it, expect } from "vitest";
import {
  MAX_ALARMS,
  acknowledge,
  acknowledgeAll,
  alarms,
  createAttention,
  isAlarmed,
  observe,
  resetAttention,
} from "../src/attentionState";
import type { AttentionState } from "../src/attentionState";
import type { AgentEvent } from "../src/protocol";

/** Today's event, plus the verdict the daemon rides on it. */
type AttentionEvent = AgentEvent & { attention: boolean };

function event(overrides: Partial<AttentionEvent> = {}): AttentionEvent {
  return {
    ts: 1000,
    agent: "sess-abc",
    type: "M",
    path: "package.json",
    color: "FFAA00",
    origin: "hook",
    label: "developer-backend",
    attention: true,
    ...overrides,
  } as AttentionEvent;
}

/** Feed a whole run of events through one state, left to right. */
function observeAll(state: AttentionState, events: readonly AttentionEvent[]): AttentionState {
  return events.reduce((current, next) => observe(current, next), state);
}

function pathsOf(state: AttentionState): string[] {
  return alarms(state).map((alarm) => alarm.path);
}

describe("an alarm list is a set, not a stream", () => {
  it("folds forty touches of one path into one alarm counting forty", () => {
    let state = createAttention();
    for (let i = 0; i < 40; i += 1) {
      state = observe(state, event({ ts: 1000 + i }));
    }

    const list = alarms(state);
    expect(list).toHaveLength(1);
    expect(list[0].count).toBe(40);
  });

  it("folds against the matching alarm wherever it sits, not only against the newest", () => {
    // THE DRIVER. An `eventLog.ts`-shaped fold -- against the top entry only --
    // answers two alarms for `package.json` here, one of them stranded below
    // `src/a.ts` with a count of 1, and the reader is asked to add them up.
    let state = createAttention();
    state = observe(state, event({ path: "package.json", ts: 1000 }));
    state = observe(state, event({ path: "src/a.ts", ts: 1001 }));
    state = observe(state, event({ path: "package.json", ts: 1002 }));
    state = observe(state, event({ path: "src/a.ts", ts: 1003 }));
    state = observe(state, event({ path: "package.json", ts: 1004 }));

    const list = alarms(state);
    expect(list).toHaveLength(2);
    const lockfile = list.find((alarm) => alarm.path === "package.json");
    expect(lockfile?.count).toBe(3);
  });

  it("keeps the first timestamp for ordering and the last one for the count line", () => {
    let state = createAttention();
    state = observe(state, event({ ts: 1000 }));
    state = observe(state, event({ path: "src/a.ts", ts: 1500 }));
    state = observe(state, event({ ts: 2000 }));

    const lockfile = alarms(state).find((alarm) => alarm.path === "package.json");
    expect(lockfile?.firstTs).toBe(1000);
    expect(lockfile?.lastTs).toBe(2000);
  });

  it("leaves a re-touched alarm where its first sighting put it, instead of pulling it to the top", () => {
    // The consequence of ordering by `firstTs`: a lockfile written every few
    // seconds does not shuffle the panel under the reader while they are trying
    // to read the entry below it.
    let state = createAttention();
    state = observe(state, event({ path: "package.json", ts: 1000 }));
    state = observe(state, event({ path: "src/a.ts", ts: 2000 }));
    state = observe(state, event({ path: "package.json", ts: 3000 }));

    expect(pathsOf(state)).toEqual(["src/a.ts", "package.json"]);
  });

  it("returns a new reference when a fold changed a count, so the caller can adopt it", () => {
    const first = observe(createAttention(), event({ ts: 1000 }));
    const second = observe(first, event({ ts: 1001 }));

    expect(second).not.toBe(first);
  });
});

describe("what opens an alarm and what does not", () => {
  it("opens one alarm counting one for an event carrying the verdict", () => {
    const state = observe(createAttention(), event({ path: "package.json", ts: 1234 }));

    const list = alarms(state);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      path: "package.json",
      count: 1,
      firstTs: 1234,
      lastTs: 1234,
      agent: "sess-abc",
      label: "developer-backend",
    });
  });

  it("returns the same reference for an event that did not alarm", () => {
    // `applyView`'s idiom: `if (next !== state)` is the whole of `main.ts`'s
    // adoption test, so an ordinary edit -- which is nearly every event -- must
    // cost the page no repaint at all.
    const state = createAttention();

    expect(observe(state, event({ attention: false }))).toBe(state);
  });

  it("returns the same reference for an ordinary event even once alarms are open", () => {
    const state = observe(createAttention(), event({ path: "package.json" }));

    expect(observe(state, event({ path: "src/a.ts", attention: false }))).toBe(state);
  });

  it("never alarms on the boot snapshot, however the daemon flagged it", () => {
    // The seed is the whole project tree -- twelve thousand paths on a home
    // directory -- and nobody touched any of it. A panel that opens full of
    // backdrop is a panel the reader learns to close.
    const state = createAttention();
    const next = observe(state, event({ origin: "seed", attention: true }));

    expect(alarms(next)).toEqual([]);
    expect(next).toBe(state);
  });

  it("still alarms on a watcher event, which is a real change with no agent behind it", () => {
    const state = observe(
      createAttention(),
      event({ origin: "watch", agent: "", label: "", attention: true }),
    );

    expect(alarms(state)).toHaveLength(1);
    expect(alarms(state)[0].agent).toBe("");
  });

  it("orders the list newest first by the first sighting", () => {
    let state = createAttention();
    state = observe(state, event({ path: "a", ts: 1000 }));
    state = observe(state, event({ path: "b", ts: 2000 }));
    state = observe(state, event({ path: "c", ts: 3000 }));

    expect(pathsOf(state)).toEqual(["c", "b", "a"]);
  });

  it("answers set membership for a path", () => {
    const state = observe(createAttention(), event({ path: "package.json" }));

    expect(isAlarmed(state, "package.json")).toBe(true);
    expect(isAlarmed(state, "src/a.ts")).toBe(false);
    expect(isAlarmed(state, "")).toBe(false);
  });

  it("mutates nothing the caller already read", () => {
    const state = observe(createAttention(), event({ path: "package.json", ts: 1000 }));
    const before = alarms(state);

    observe(state, event({ path: "package.json", ts: 2000 }));

    expect(before).toHaveLength(1);
    expect(before[0].count).toBe(1);
    expect(before[0].lastTs).toBe(1000);
  });
});

describe("who the alarm names", () => {
  it("keeps the latest agent and label, because one row cannot answer which of them did it", () => {
    let state = createAttention();
    state = observe(state, event({ agent: "agent-1", label: "developer-backend", ts: 1000 }));
    state = observe(state, event({ agent: "agent-2", label: "developer-frontend", ts: 2000 }));

    const alarm = alarms(state)[0];
    expect(alarm.agent).toBe("agent-2");
    expect(alarm.label).toBe("developer-frontend");
    expect(alarm.count).toBe(2);
  });

  it("records a read as a read, so a painter can tell it from a write", () => {
    const state = observe(createAttention(), event({ type: "R", path: ".env" }));

    expect(alarms(state)[0].types).toEqual(["R"]);
  });

  it("carries both kinds once a read is followed by a write on the same path", () => {
    let state = createAttention();
    state = observe(state, event({ type: "R", path: ".env", ts: 1000 }));
    state = observe(state, event({ type: "M", path: ".env", ts: 2000 }));

    const alarm = alarms(state)[0];
    expect(alarm.count).toBe(2);
    expect([...alarm.types].sort()).toEqual(["M", "R"]);
  });

  it("records each kind once, however many times it repeats", () => {
    let state = createAttention();
    for (let i = 0; i < 5; i += 1) {
      state = observe(state, event({ type: "R", path: ".env", ts: 1000 + i }));
    }
    state = observe(state, event({ type: "M", path: ".env", ts: 2000 }));

    const alarm = alarms(state)[0];
    expect(alarm.types).toHaveLength(2);
    expect(alarm.count).toBe(6);
  });
});

describe("dismissing an alarm", () => {
  it("removes the one named and leaves the others standing", () => {
    let state = createAttention();
    state = observe(state, event({ path: "a", ts: 1000 }));
    state = observe(state, event({ path: "b", ts: 2000 }));
    state = observe(state, event({ path: "c", ts: 3000 }));

    state = acknowledge(state, "b");

    expect(pathsOf(state)).toEqual(["c", "a"]);
    expect(isAlarmed(state, "b")).toBe(false);
  });

  it("opens a fresh alarm when an acknowledged path is touched again", () => {
    // Decision 11: an alarm that keeps re-arming must not look like one that
    // was handled. Suppressing it, or resuming the old count, hides the exact
    // case worth watching -- an agent going back to the same file after a human
    // said they had seen it.
    let state = createAttention();
    state = observe(state, event({ path: "package.json", ts: 1000 }));
    state = observe(state, event({ path: "package.json", ts: 1001 }));
    state = acknowledge(state, "package.json");
    state = observe(state, event({ path: "package.json", ts: 5000 }));

    const alarm = alarms(state)[0];
    expect(alarm.count).toBe(1);
    expect(alarm.firstTs).toBe(5000);
    expect(alarm.lastTs).toBe(5000);
  });

  it("leaves the list alone when asked about a path that never alarmed", () => {
    const state = observe(createAttention(), event({ path: "a" }));

    expect(pathsOf(acknowledge(state, "b"))).toEqual(["a"]);
  });

  it("clears every alarm at once when asked", () => {
    let state = createAttention();
    state = observe(state, event({ path: "a", ts: 1000 }));
    state = observe(state, event({ path: "b", ts: 2000 }));

    expect(alarms(acknowledgeAll(state))).toEqual([]);
  });

  it("re-arms after a clear-all as it does after a single acknowledgement", () => {
    let state = createAttention();
    state = observe(state, event({ path: "a", ts: 1000 }));
    state = acknowledgeAll(state);
    state = observe(state, event({ path: "a", ts: 2000 }));

    expect(alarms(state)[0].count).toBe(1);
  });
});

describe("the root changed under it", () => {
  it("empties the list, because the paths belong to a project nobody is watching", () => {
    let state = createAttention();
    state = observe(state, event({ path: "a" }));
    state = observe(state, event({ path: "b" }));

    expect(alarms(resetAttention(state))).toEqual([]);
  });

  it("answers an empty list on a state nothing has been observed into", () => {
    expect(alarms(createAttention())).toEqual([]);
  });

  it("still opens alarms after a reset", () => {
    let state = resetAttention(createAttention());
    state = observe(state, event({ path: "a", ts: 9000 }));

    expect(alarms(state)).toHaveLength(1);
  });
});

describe("the list is bounded", () => {
  it("caps at a hundred alarms by default", () => {
    expect(MAX_ALARMS).toBe(100);
  });

  it("drops the oldest and keeps the newest once the cap is passed", () => {
    let state = createAttention(3);
    state = observeAll(state, [
      event({ path: "a", ts: 1000 }),
      event({ path: "b", ts: 2000 }),
      event({ path: "c", ts: 3000 }),
      event({ path: "d", ts: 4000 }),
    ]);

    expect(pathsOf(state)).toEqual(["d", "c", "b"]);
  });

  it("keeps exactly the cap, never one more", () => {
    let state = createAttention(3);
    state = observeAll(state, [
      event({ path: "a", ts: 1000 }),
      event({ path: "b", ts: 2000 }),
      event({ path: "c", ts: 3000 }),
    ]);

    expect(alarms(state)).toHaveLength(3);
  });

  it("folds a repeat without spending a slot", () => {
    let state = createAttention(2);
    state = observeAll(state, [
      event({ path: "a", ts: 1000 }),
      event({ path: "a", ts: 1001 }),
      event({ path: "b", ts: 2000 }),
    ]);

    expect(pathsOf(state)).toEqual(["b", "a"]);
    expect(alarms(state)[1].count).toBe(2);
  });

  it("holds the default cap when nothing is asked for", () => {
    let state = createAttention();
    for (let i = 0; i < MAX_ALARMS + 5; i += 1) {
      state = observe(state, event({ path: `file-${i}.ts`, ts: 1000 + i }));
    }

    expect(alarms(state)).toHaveLength(MAX_ALARMS);
    expect(isAlarmed(state, "file-0.ts")).toBe(false);
    expect(isAlarmed(state, `file-${MAX_ALARMS + 4}.ts`)).toBe(true);
  });

  it.each([
    ["zero", 0],
    ["a negative", -5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("falls back to the default cap when the cap is %s", (_label, max) => {
    // `eventLog.resolveMax`'s rule, and the reason it is a rule: a cap of zero
    // is a panel that can never show anything, which is indistinguishable from
    // a feature that is not working.
    let state = createAttention(max);
    for (let i = 0; i < MAX_ALARMS + 1; i += 1) {
      state = observe(state, event({ path: `file-${i}.ts`, ts: 1000 + i }));
    }

    expect(alarms(state)).toHaveLength(MAX_ALARMS);
  });
});
