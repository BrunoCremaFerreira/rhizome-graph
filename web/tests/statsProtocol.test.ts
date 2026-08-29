/**
 * Contract tests (RED) for `parseStats`: the tenth frame on the one socket.
 *
 * The daemon counts per agent -- writes, reads, distinct files, distinct
 * directories, the file it returned to most, first and last seen -- and pushes
 * the whole table in a replaceable slot, deduped on the encoded string, the way
 * `status` is pushed. The browser cannot compute any of it: a client that
 * reconnects is handed the last 200 events and nothing says how many were lost,
 * so a browser-side counter is not approximate, it is SILENTLY approximate, and
 * two tabs opened five minutes apart disagree about the same session. Hence a
 * frame, hence a parser.
 *
 * The parser is `parseSearchResult`'s degradation doctrine verbatim, because
 * this comes off the network and a summary is never worth a dead page:
 *
 *   - `kind` must be exactly `"stats"`. The gate is load-bearing in BOTH
 *     directions, as `parseStatus`'s is: an answer routed as activity would grow
 *     a node called "stats" in the graph and the 5 s poll would keep putting it
 *     back, and an activity event mistaken for an answer would replace the whole
 *     table with one row of nonsense.
 *   - `agents` is the one field whose absence costs the frame, the way `query`
 *     costs `parseSearchResult` its frame. A table frame that names no table is
 *     not a table with nothing in it -- `{"kind":"stats","agents":[]}` is how the
 *     daemon says "nobody has done anything", and the two must stay
 *     distinguishable or an empty session and a malformed frame paint the same.
 *   - Every other field DEGRADES, and a junk row is dropped ONE AT A TIME. One
 *     bad row must not cost the other thirty-one: this is a summary, and a
 *     summary that vanishes because one agent id arrived as a number is worse
 *     than a summary missing one line.
 *   - NEVER throws.
 *
 * Two properties agreed with the daemon side (`tests/test_session_stats.py`) and
 * asserted here only as shapes the parser must carry through, never recomputed:
 * `topPath` is `""` with `topCount` `0` when nothing was visited twice, and
 * `truncated` is PER ROW -- one agent past its path cap does not make the other
 * rows floors.
 *
 * ORDER. The frame arrives sorted by writes descending, ties by agent
 * ascending; the parser preserves that order and judges none of it. **That is
 * NOT the panel's order** -- `statsPanel.ts` sorts again and puts the
 * unattributed row last whatever its counts, which is why the two test files
 * disagree on purpose. See web/tests/statsPanel.test.ts.
 *
 * Reached through the module namespace rather than a named import so that the
 * absence of `parseStats` today is an assertion ("expected undefined to be
 * function") instead of a link error that would take the whole file down before
 * a single test ran -- the accessor `colors.test.ts` established.
 *
 * One failure reason per test.
 */

import { describe, it, expect } from "vitest";
import * as protocol from "../src/protocol";

/** One agent's line of the table, as the wire spells it. */
interface AgentStatsEntry {
  agent: string;
  label: string;
  writes: number;
  reads: number;
  files: number;
  dirs: number;
  topPath: string;
  topCount: number;
  firstTs: number;
  lastTs: number;
  truncated: boolean;
}

/** The whole table. */
interface SessionStatsFrame {
  agents: AgentStatsEntry[];
}

/** Today's module, plus the parser R4 adds. */
const api = protocol as typeof protocol & {
  parseStats?: (raw: unknown) => SessionStatsFrame | null;
};

function parseStats(raw: unknown): SessionStatsFrame | null {
  expect(typeof api.parseStats).toBe("function");
  return (api.parseStats as (raw: unknown) => SessionStatsFrame | null)(raw);
}

/** One well-formed row, overridable field by field. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: "a1",
    label: "developer-backend",
    writes: 2,
    reads: 0,
    files: 1,
    dirs: 1,
    topPath: "src/x.py",
    topCount: 2,
    firstTs: 1.0,
    lastTs: 9.0,
    truncated: false,
    ...overrides,
  };
}

/** A whole frame, exactly as the daemon encodes it. */
function frame(agents: unknown[]): Record<string, unknown> {
  return { kind: "stats", agents };
}

describe("parseStats: a well-formed frame", () => {
  it("parses the daemon's own example, field for field", () => {
    expect(parseStats(frame([row()]))).toEqual({
      agents: [
        {
          agent: "a1",
          label: "developer-backend",
          writes: 2,
          reads: 0,
          files: 1,
          dirs: 1,
          topPath: "src/x.py",
          topCount: 2,
          firstTs: 1.0,
          lastTs: 9.0,
          truncated: false,
        },
      ],
    });
  });

  it("keeps the rows in the order the daemon sent them", () => {
    // The daemon sorts by writes descending, ties by agent ascending. The
    // parser re-sorts nothing: a parser with an opinion about order is a second
    // place the table can be ordered, and the panel already has the first.
    const parsed = parseStats(
      frame([row({ agent: "a1", writes: 9 }), row({ agent: "a2", writes: 4 })]),
    );

    expect(parsed?.agents.map((entry) => entry.agent)).toEqual(["a1", "a2"]);
  });

  it("carries an empty table through as an empty table", () => {
    // How the daemon says "nobody has done anything yet". It is a frame, not an
    // absence, and the panel decides on its own that it is not worth drawing.
    expect(parseStats(frame([]))).toEqual({ agents: [] });
  });

  it("keeps the unattributed row, whose agent is legitimately empty", () => {
    // An event with `agent: ""` never creates an ACTOR -- a figure, a beam --
    // but it is real work by nobody on camera, and a table that hid it would
    // not add up. The parser is not the place that decides that.
    const parsed = parseStats(frame([row({ agent: "", label: "" })]));

    expect(parsed?.agents.map((entry) => entry.agent)).toEqual([""]);
  });

  it("carries a row with nothing visited twice, rather than inventing a top file", () => {
    const parsed = parseStats(frame([row({ topPath: "", topCount: 0 })]));

    expect([parsed?.agents[0].topPath, parsed?.agents[0].topCount]).toEqual(["", 0]);
  });

  it("carries truncation per row, so one capped agent does not flag the others", () => {
    const parsed = parseStats(
      frame([row({ agent: "a1", truncated: true }), row({ agent: "a2", truncated: false })]),
    );

    expect(parsed?.agents.map((entry) => entry.truncated)).toEqual([true, false]);
  });
});

describe("parseStats: the two hard fields, whose absence costs the frame", () => {
  it("refuses a frame with no kind at all", () => {
    expect(parseStats({ agents: [row()] })).toBe(null);
  });

  it("refuses a frame of another kind that happens to carry agents", () => {
    // The gate in the other direction: a `status` frame that grew an `agents`
    // key must not replace the table.
    expect(parseStats({ kind: "status", agents: [row()] })).toBe(null);
  });

  it("refuses a frame whose agents is not an array", () => {
    // Degrading this to `[]` would report an empty session over a frame the
    // daemon never sent, which is the one lie this panel must not tell.
    expect(parseStats({ kind: "stats", agents: "a1" })).toBe(null);
  });

  it("refuses a frame with no agents key at all", () => {
    expect(parseStats({ kind: "stats" })).toBe(null);
  });

  it.each([null, undefined, 7, "stats", [], [1, 2, 3]])(
    "refuses %s, which is not an object at all",
    (raw) => {
      expect(parseStats(raw)).toBe(null);
    },
  );
});

describe("parseStats: a junk row is dropped one at a time", () => {
  it("drops the bad row and keeps the good ones on either side of it", () => {
    const parsed = parseStats(
      frame([row({ agent: "a1" }), { agent: 7 }, row({ agent: "a3" })]),
    );

    expect(parsed?.agents.map((entry) => entry.agent)).toEqual(["a1", "a3"]);
  });

  it.each([
    ["a number", 7],
    ["a string", "a1"],
    ["null", null],
    ["an array", ["a1"]],
  ])("drops a row that is %s rather than an object", (_label, junk) => {
    const parsed = parseStats(frame([junk, row({ agent: "a2" })]));

    expect(parsed?.agents.map((entry) => entry.agent)).toEqual(["a2"]);
  });

  it("drops a row whose agent is not a string, because agent is the identity", () => {
    // `agent` is the key the row is about and the seed of its swatch colour.
    // A row that names no agent cannot be attributed to one, and degrading it
    // to `""` would merge it into the unattributed row -- inventing work for
    // nobody out of work by somebody.
    const parsed = parseStats(frame([{ ...row(), agent: 7 }, row({ agent: "a2" })]));

    expect(parsed?.agents.map((entry) => entry.agent)).toEqual(["a2"]);
  });

  it("survives an array of nothing but junk, with the frame intact", () => {
    expect(parseStats(frame([7, null, "x"]))).toEqual({ agents: [] });
  });
});

describe("parseStats: every other field degrades rather than costing the row", () => {
  it("degrades a mistyped reads to 0 and keeps the row", () => {
    const parsed = parseStats(frame([row({ reads: "many" })]));

    expect(parsed?.agents.map((entry) => [entry.agent, entry.reads])).toEqual([["a1", 0]]);
  });

  it("degrades a mistyped label to the empty string", () => {
    // Display text only, and the orchestrator legitimately has none. It is
    // never a reason to drop a row: the agent id is still who this is.
    const parsed = parseStats(frame([row({ label: 7 })]));

    expect(parsed?.agents[0].label).toBe("");
  });

  it("degrades a mistyped topPath to the empty string", () => {
    const parsed = parseStats(frame([row({ topPath: { name: "x" } })]));

    expect(parsed?.agents[0].topPath).toBe("");
  });

  it.each(["writes", "reads", "files", "dirs", "topCount"])(
    "degrades a missing %s to 0",
    (field) => {
      const incomplete = row();
      delete incomplete[field];

      const parsed = parseStats(frame([incomplete]));

      expect((parsed?.agents[0] as unknown as Record<string, unknown>)[field]).toBe(0);
    },
  );

  it.each([
    ["a negative count", -3],
    ["a fractional count", 2.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("degrades %s to 0, because a table prints what it is given", (_label, value) => {
    // These reach a corner of the page as text. `NaN writes` and `-3 files` are
    // not numbers a reader can act on, and half a write does not exist. Same
    // rule `parseSearchResult` states for its counts, one outcome milder:
    // there is no index here to shift, so the row survives without the number.
    const parsed = parseStats(frame([row({ writes: value })]));

    expect(parsed?.agents[0].writes).toBe(0);
  });

  it("keeps a fractional timestamp, which is what a timestamp is", () => {
    // Deliberately NOT the counts' rule: `ts` is a float on every frame this
    // protocol carries, and rounding it here would make the span wrong.
    const parsed = parseStats(frame([row({ firstTs: 1754870400.5, lastTs: 1754870402.25 })]));

    expect([parsed?.agents[0].firstTs, parsed?.agents[0].lastTs]).toEqual([
      1754870400.5, 1754870402.25,
    ]);
  });

  it.each([
    ["a string", "yesterday"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("degrades %s in firstTs to 0 rather than dropping the row", (_label, value) => {
    const parsed = parseStats(frame([row({ firstTs: value })]));

    expect(parsed?.agents[0].firstTs).toBe(0);
  });

  it.each([
    ["a missing flag", undefined],
    ["a truthy string", "yes"],
    ["the number 1", 1],
  ])("reads %s as not truncated, never as truncated", (_label, value) => {
    // The `attention` rule: a truthy non-boolean is `false`. A panel that
    // claimed its numbers were floors because a daemon of another version spelt
    // a flag differently would teach the reader to ignore the caveat.
    const built = row();
    if (value === undefined) delete built.truncated;
    else built.truncated = value;

    expect(parseStats(frame([built]))?.agents[0].truncated).toBe(false);
  });
});

describe("parseStats: it comes off the network, so it never throws", () => {
  it.each([
    ["a row of undefined", { kind: "stats", agents: [undefined] }],
    ["agents holding a function-shaped object", { kind: "stats", agents: [{ agent: {} }] }],
    ["a deeply nested value where a count belongs", frame([row({ writes: { n: 1 } })])],
    ["every field mistyped at once", frame([
      { agent: "a1", label: [], writes: "x", reads: null, files: {}, dirs: "1",
        topPath: 4, topCount: "2", firstTs: "t", lastTs: [], truncated: "no" },
    ])],
  ])("survives %s", (_label, raw) => {
    expect(() => parseStats(raw)).not.toThrow();
  });

  it("keeps the row whose every optional field was junk, because the agent was not", () => {
    const parsed = parseStats(
      frame([
        {
          agent: "a1",
          label: [],
          writes: "x",
          reads: null,
          files: {},
          dirs: "1",
          topPath: 4,
          topCount: "2",
          firstTs: "t",
          lastTs: [],
          truncated: "no",
        },
      ]),
    );

    expect(parsed?.agents).toEqual([
      {
        agent: "a1",
        label: "",
        writes: 0,
        reads: 0,
        files: 0,
        dirs: 0,
        topPath: "",
        topCount: 0,
        firstTs: 0,
        lastTs: 0,
        truncated: false,
      },
    ]);
  });
});
