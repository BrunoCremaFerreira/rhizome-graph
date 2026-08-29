/**
 * RED specification for the attention verdict on the wire, and for the frame
 * that describes the rule file it came from.
 *
 * The defect: the daemon can be right and the page still blind. `parseEvent`
 * destructures seven names and builds a new object out of them, so an eighth
 * key on the wire is discarded silently -- a daemon that has decided a path
 * deserves a second look has no way to say so. Nothing downstream can alarm on
 * a field the parser threw away, and the failure is invisible: the graph looks
 * exactly like a session in which nothing worth watching happened, which is the
 * one picture a supervision feature must never produce by accident.
 *
 * The verdict rides the event that already names the path (a second frame would
 * have to name it again and would arrive out of order, turning the browser into
 * a join), and the key is CONDITIONAL: present only when it is `true`, absent
 * otherwise. So "absent" is the overwhelmingly common case and it must degrade
 * to `false` rather than dropping the frame -- `parseEvent`'s own `label` rule,
 * quoted in its docstring: a page served from a newer or older daemon than the
 * one broadcasting still draws everything it receives.
 *
 * WHICH TEST IS THE DRIVER AND WHICH IS THE GUARD, stated because the plan's
 * step 4.2 asks for it:
 *
 *  - The DRIVER is `attention: true` parsing as `attention: true`. Nothing
 *    today produces that field, so it fails on its own assertion.
 *  - The GUARD is the frame with NO `attention` key still parsing, with all
 *    seven of today's fields unchanged. That half is green before the change
 *    and must stay green; it is what stops the new field being made required.
 *  - One honest correction to the plan's row 4.2: only that half is green
 *    today. The other half of the same row -- that the parsed answer says
 *    `attention: false` -- cannot be green, because the key does not exist yet
 *    and `undefined` is not `false`. So the row is split here into its green
 *    guard and its red half, and both are named as such.
 *
 * A truthy non-boolean (`"yes"`, `1`) degrades to `false`, NOT to `true`. The
 * fail-safe direction of an alarm is the loud one, but a page that alarms on a
 * malformed frame alarms about nothing the user ever wrote, which is worse than
 * silence: it teaches the reader to ignore the marker.
 *
 * The second half of this file specifies `parseAttentionRules`, the frame that
 * carries where the rules came from, how many are in force, and which patterns
 * were refused. It is reached through the module NAMESPACE rather than a named
 * import on purpose: a named import of a function that does not exist yet is a
 * link error that takes the whole file down with it, and the `parseEvent` tests
 * above would then fail for somebody else's reason instead of their own.
 */

import { describe, it, expect } from "vitest";
import * as protocol from "../src/protocol";
import { parseEvent } from "../src/protocol";
import type { AgentEvent, AttentionRulesFrame } from "../src/protocol";

/** Today's answer, plus the field this plan adds. */
type ParsedEvent = AgentEvent & { attention?: boolean };

function validRaw(): Record<string, unknown> {
  return {
    ts: 1754870400.5,
    agent: "sess-abc",
    type: "M",
    path: "package.json",
    color: "FFAA00",
    origin: "hook",
    label: "developer-backend",
  };
}

function parsed(raw: Record<string, unknown>): ParsedEvent {
  const event = parseEvent(raw) as ParsedEvent | null;
  expect(event).not.toBeNull();
  return event as ParsedEvent;
}

/**
 * The new parser, fetched off the namespace so its absence is an assertion
 * ("expected undefined to be function") rather than a module link error.
 */
function parseAttentionRules(raw: unknown): AttentionRulesFrame | null {
  const fn = (protocol as unknown as Record<string, unknown>).parseAttentionRules;
  expect(typeof fn).toBe("function");
  return (fn as (raw: unknown) => AttentionRulesFrame | null)(raw);
}

function rulesFrame(): Record<string, unknown> {
  return {
    kind: "attention",
    source: "/home/u/proj/.rhizome-attention",
    count: 11,
    refused: ["[[:alpha:]].pem"],
    truncated: false,
  };
}

describe("parseEvent: the attention verdict (the DRIVER)", () => {
  it("carries an attention verdict of true through to the parsed event", () => {
    const raw = validRaw();
    raw.attention = true;

    expect(parsed(raw).attention).toBe(true);
  });

  it("keeps the verdict on a read, because reading a watched path is the case this exists for", () => {
    const raw = validRaw();
    raw.type = "R";
    raw.path = ".env";
    raw.attention = true;

    const event = parsed(raw);
    expect(event.type).toBe("R");
    expect(event.attention).toBe(true);
  });

  it("keeps the verdict on a watcher event, which is the half with no agent behind it", () => {
    const raw = validRaw();
    raw.origin = "watch";
    raw.agent = "";
    raw.attention = true;

    const event = parsed(raw);
    expect(event.origin).toBe("watch");
    expect(event.attention).toBe(true);
  });
});

describe("parseEvent: an event frame that says nothing about attention (the GUARD)", () => {
  it("still parses every field it carries, exactly as it did before the field existed", () => {
    // Green today, and the reason this test is here: it is what stops the new
    // key being made required, which would blank the graph against any daemon
    // that has not shipped the feature.
    expect(parsed(validRaw())).toMatchObject({
      ts: 1754870400.5,
      agent: "sess-abc",
      type: "M",
      path: "package.json",
      color: "FFAA00",
      origin: "hook",
      label: "developer-backend",
    });
  });

  it("reads an absent verdict as false rather than as undefined", () => {
    // The other half of the plan's row 4.2, and it is RED today: the key does
    // not exist, so the answer is `undefined`. A downstream `if (event
    // .attention)` would behave the same, but `alarms` is a set keyed on a
    // boolean and `undefined` is what leaks into a serialized state.
    expect(parsed(validRaw()).attention).toBe(false);
  });
});

describe("parseEvent: a malformed verdict is silence, never noise", () => {
  it.each([
    ["the string yes", "yes"],
    ["the string true", "true"],
    ["the number 1", 1],
    ["null", null],
    ["an object", { alarm: true }],
    ["an array", ["true"]],
  ])("degrades a verdict spelled as %s to false", (_label, value) => {
    const raw = validRaw();
    raw.attention = value;

    expect(parsed(raw).attention).toBe(false);
  });

  it.each([
    ["the string yes", "yes"],
    ["null", null],
    ["the number 1", 1],
  ])("never drops the event over a verdict spelled as %s", (_label, value) => {
    // The event is a real change to a real file. A frame dropped over a field
    // this page invented would take the node off the graph entirely.
    const raw = validRaw();
    raw.attention = value;

    const event = parsed(raw);
    expect(event.path).toBe("package.json");
    expect(event.type).toBe("M");
  });

  it("reads false as false, which is a value the wire may still spell out", () => {
    const raw = validRaw();
    raw.attention = false;

    expect(parsed(raw).attention).toBe(false);
  });
});

describe("parseAttentionRules: which frames it answers for", () => {
  it("parses the daemon's description of the rule file it loaded", () => {
    expect(parseAttentionRules(rulesFrame())).toEqual({
      source: "/home/u/proj/.rhizome-attention",
      count: 11,
      refused: ["[[:alpha:]].pem"],
      truncated: false,
    });
  });

  it.each([
    ["an activity event", { ts: 1, agent: "a", type: "M", path: "p", color: "FFAA00" }],
    ["a meta frame", { kind: "meta", root: "/x", branch: "main" }],
    ["a status frame", { kind: "status", repo: true, entries: [] }],
    ["a near miss", { kind: "attentionRules", source: "/x", count: 1 }],
    ["no kind at all", { source: "/x", count: 1 }],
  ])("returns null for %s", (_label, frame) => {
    // The gate is load-bearing in both directions: a rule report routed as
    // activity would grow a node called "attention" in the graph, and an
    // activity event mistaken for a rule report would rewrite the panel's
    // header from one file save.
    expect(parseAttentionRules(frame)).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 5],
    ["a string", "attention"],
    ["an array", [{ kind: "attention" }]],
  ])("returns null for a non-object input (%s)", (_label, value) => {
    expect(parseAttentionRules(value)).toBeNull();
  });
});

describe("parseAttentionRules: every field degrades, none costs the frame", () => {
  it("has no hard field beyond its kind, so a daemon that found nothing is still heard", () => {
    // The same rule `parseSizes` and `parseAgentStates` follow. A frame naming
    // no source IS the answer this feature most needs to show -- "no rule file
    // was found" -- and dropping it leaves the panel unable to tell that case
    // from a file full of rules that matched nothing.
    expect(parseAttentionRules({ kind: "attention" })).toEqual({
      source: "",
      count: 0,
      refused: [],
      truncated: false,
    });
  });

  it.each([
    ["a number", 7],
    ["null", null],
    ["an object", { path: "/x" }],
    ["an array", ["/x"]],
  ])("degrades a source spelled as %s to the empty string", (_label, value) => {
    const frame = rulesFrame();
    frame.source = value;

    expect(parseAttentionRules(frame)?.source).toBe("");
  });

  it.each([
    ["a string", "11"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["null", null],
    ["an array", [1]],
  ])("degrades a count spelled as %s to zero", (_label, value) => {
    const frame = rulesFrame();
    frame.count = value;

    expect(parseAttentionRules(frame)?.count).toBe(0);
  });

  it.each([
    ["a string", "one pattern"],
    ["null", null],
    ["a number", 1],
    ["an object", { 0: "x" }],
  ])("degrades a refusal list spelled as %s to an empty list", (_label, value) => {
    const frame = rulesFrame();
    frame.refused = value;

    expect(parseAttentionRules(frame)?.refused).toEqual([]);
  });

  it("drops a junk refusal one at a time, keeping the patterns it can quote", () => {
    // `parseStatus`'s rule: a partial list is worth more than none, because an
    // empty refusal list does not read as "I could not parse one item", it
    // reads as "nothing was refused" -- which is exactly the lie this frame
    // exists to prevent.
    const frame = rulesFrame();
    frame.refused = ["[[:alpha:]].pem", 42, null, "*.{a,b}", { pattern: "x" }];

    expect(parseAttentionRules(frame)?.refused).toEqual(["[[:alpha:]].pem", "*.{a,b}"]);
  });

  it("preserves the order the daemon listed the refusals in", () => {
    const frame = rulesFrame();
    frame.refused = ["c", "a", "b"];

    expect(parseAttentionRules(frame)?.refused).toEqual(["c", "a", "b"]);
  });

  it.each([
    ["the number 1", 1],
    ["the string true", "true"],
    ["null", null],
    ["an object", {}],
  ])("degrades a truncated flag spelled as %s to false", (_label, value) => {
    const frame = rulesFrame();
    frame.truncated = value;

    expect(parseAttentionRules(frame)?.truncated).toBe(false);
  });

  it("keeps a truncated flag that really is true", () => {
    const frame = rulesFrame();
    frame.truncated = true;

    expect(parseAttentionRules(frame)?.truncated).toBe(true);
  });

  it("never throws, whatever comes off the network", () => {
    expect(() => parseAttentionRules(undefined)).not.toThrow();
    expect(() => parseAttentionRules("garbage")).not.toThrow();
    expect(() => parseAttentionRules({ kind: "attention", refused: [undefined] })).not.toThrow();
    expect(() =>
      parseAttentionRules({ kind: "attention", source: {}, count: {}, truncated: [] }),
    ).not.toThrow();
  });
});
