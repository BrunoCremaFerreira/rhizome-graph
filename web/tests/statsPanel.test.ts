/**
 * Contract tests (RED) for the session-stats panel's model.
 *
 * The panel answers "what did this session actually do?" -- per agent: writes
 * against reads, distinct files, distinct directories, the file it returned to
 * most, first and last seen. The daemon counts; this module decides what is on
 * screen, in what order, and how much of it. Pure, beside `statusList.ts`,
 * `eventLog.ts` and `sizeMode.ts`, for the reason all three give: a painter is
 * DOM-bound and therefore untested, "which is how the one number that shares out
 * the row escaped ever being checked".
 *
 * **ORDER, and why this file and web/tests/statsProtocol.test.ts disagree on
 * purpose.** The frame arrives sorted by writes descending, ties by agent
 * ascending, and `parseStats` preserves exactly that. **That is NOT the panel's
 * order.** The panel sorts again and puts the unattributed row LAST whatever its
 * counts, because a row nobody is behind is not a competitor for the top of a
 * table about who did what. The panel therefore must not lean on the frame's
 * order at all, which is why every fixture below arrives shuffled.
 *
 * Five properties hold this module up.
 *
 *  - **`visible` derives from the row count AND the toggle**, never from a flag
 *    on the frame -- `statusList.ts`'s rule, whose own docstring says a panel
 *    that appears empty is "a permanent strip of chrome reporting nothing".
 *    Closed, and open with nothing to show, are the same absence.
 *  - **The unattributed row sorts last and carries `swatch: null`.** `CLAUDE.md`
 *    says an event with `agent: ""` must never create an ACTOR -- a figure, a
 *    beam, a colour -- and it also says an unattributed change is real work. A
 *    stats row is not an actor, so it is shown; a coloured swatch beside it
 *    would invent an author for it, so it has none. Getting this wrong in either
 *    direction (hiding the row, or colouring it) is the likeliest misreading of
 *    `CLAUDE.md` this feature invites, which is why it is two tests and not a
 *    comment.
 *  - **`swatch` is `actorColor(agent)`**, imported and never respelled, so the
 *    swatch in the corner and the figure in the graph cannot disagree about who
 *    an agent is.
 *  - **`topPath` is `""` when nothing was touched twice**, and the row says so
 *    rather than naming an arbitrary file with a count of 1.
 *  - **The row cap is the PANEL's, not the frame's**, so a daemon that ever
 *    raises its own `MAX_AGENTS` cannot make the panel taller than the corner it
 *    lives in. The cap's value is not pinned here; that it exists and that it
 *    reports what it cut, are.
 *
 * Nothing here recomputes a number the daemon sent. The browser cannot: a client
 * that reconnects is handed the last 200 events, so every count it could derive
 * would be silently short. The panel's job is to order, split, colour and cap.
 *
 * Expected to FAIL until src/statsPanel.ts exists.
 *
 * One failure reason per test.
 */

import { describe, it, expect } from "vitest";
import { buildStatsPanel } from "../src/statsPanel";
import { splitPath } from "../src/eventLog";
import { actorColor } from "../src/colors";

/** One agent's line of the table, as `parseStats` hands it over. */
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

/** A row of the table, overridable field by field. */
function entry(overrides: Partial<AgentStatsEntry> = {}): AgentStatsEntry {
  return {
    agent: "a1",
    label: "developer-backend",
    writes: 2,
    reads: 7,
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

/** The parsed frame, exactly as the client would hand it over. */
function frame(...agents: AgentStatsEntry[]) {
  return { agents } as never;
}

/** The panel as this file reads it. */
type Panel = {
  visible: boolean;
  rows: {
    agent: string;
    label: string;
    swatch: number | null;
    writes: number;
    reads: number;
    files: number;
    dirs: number;
    topPath: string;
    topDir: string;
    topName: string;
    topCount: number;
    firstTs: number;
    lastTs: number;
    truncated: boolean;
  }[];
  total: number;
  hidden: number;
  truncated: boolean;
};

function build(f: unknown, open: boolean, max?: number): Panel {
  return buildStatsPanel(f as never, open, max as never) as unknown as Panel;
}

describe("buildStatsPanel: closed is closed, whatever the daemon is saying", () => {
  it("is invisible while the toggle is off, over a table full of work", () => {
    const panel = build(frame(entry({ agent: "a1" }), entry({ agent: "a2" })), false);

    expect(panel.visible).toBe(false);
  });

  it("is invisible while the toggle is off even when a row is truncated", () => {
    // A caveat is not a reason to open a panel nobody asked for.
    const panel = build(frame(entry({ truncated: true })), false);

    expect(panel.visible).toBe(false);
  });
});

describe("buildStatsPanel: an empty summary is not on screen at all", () => {
  it("is invisible when the daemon has not reported yet", () => {
    // `null` is "nothing heard", and a box claiming an empty session before
    // anyone counted is a statement about a session nobody measured.
    const panel = build(null, true);

    expect(panel.visible).toBe(false);
  });

  it("is invisible over a table with no rows in it", () => {
    // The `statusList.ts` rule: visibility derives from the entry count, never
    // from a flag. An open panel with no rows is a permanent empty box.
    const panel = build(frame(), true);

    expect(panel.visible).toBe(false);
  });

  it("is visible once there is a single row and the toggle is on", () => {
    const panel = build(frame(entry()), true);

    expect(panel.visible).toBe(true);
  });
});

describe("buildStatsPanel: the order is the panel's own", () => {
  it("puts the busiest agent first, by writes descending", () => {
    const panel = build(
      frame(
        entry({ agent: "a1", writes: 2 }),
        entry({ agent: "a2", writes: 40 }),
        entry({ agent: "a3", writes: 9 }),
      ),
      true,
    );

    expect(panel.rows.map((row) => row.agent)).toEqual(["a2", "a3", "a1"]);
  });

  it("breaks a tie on writes by the agent id, ascending", () => {
    const panel = build(
      frame(entry({ agent: "a3", writes: 5 }), entry({ agent: "a1", writes: 5 })),
      true,
    );

    expect(panel.rows.map((row) => row.agent)).toEqual(["a1", "a3"]);
  });

  it("compares agent ids as plain strings, not by the runtime's locale", () => {
    // `statusList.ts`'s rule: `localeCompare` depends on the runtime's locale
    // data, so the same session would list differently on two machines and rows
    // would swap under the reader's eye every time the poll republished.
    // Code-point order puts "B" before "a"; a locale collation does not.
    const panel = build(
      frame(entry({ agent: "a", writes: 5 }), entry({ agent: "B", writes: 5 })),
      true,
    );

    expect(panel.rows.map((row) => row.agent)).toEqual(["B", "a"]);
  });

  it("sorts nothing by the order the frame happened to arrive in", () => {
    // The frame is already sorted by the daemon; a panel that trusted that
    // order would look correct until the day it stopped being the panel's.
    const panel = build(
      frame(entry({ agent: "z", writes: 1 }), entry({ agent: "a", writes: 1 })),
      true,
    );

    expect(panel.rows.map((row) => row.agent)).toEqual(["a", "z"]);
  });

  it("puts the unattributed row last, however much work it holds", () => {
    // Decision 8. The empty agent is the watcher's unattributed changes: real
    // work, by nobody on camera. It is never a competitor for the top of a
    // table about who did what, so the frame's own writes-descending order is
    // exactly what must NOT decide this.
    const panel = build(
      frame(
        entry({ agent: "", writes: 4000 }),
        entry({ agent: "a1", writes: 2 }),
        entry({ agent: "a2", writes: 1 }),
      ),
      true,
    );

    expect(panel.rows.map((row) => row.agent)).toEqual(["a1", "a2", ""]);
  });

  it("puts the unattributed row last even when it is the only busy one", () => {
    const panel = build(
      frame(entry({ agent: "", writes: 99 }), entry({ agent: "a1", writes: 0 })),
      true,
    );

    expect(panel.rows[panel.rows.length - 1].agent).toBe("");
  });
});

describe("buildStatsPanel: the swatch is the agent's identity, or nothing", () => {
  it("wears the colour of the figure standing in the graph", () => {
    // The same function the renderer's avatar uses. Two respellings of the
    // `actor:` prefix is a page where the swatch and the figure disagree about
    // which agent is which, with nothing on screen saying which one lies.
    const panel = build(frame(entry({ agent: "agent-1" })), true);

    expect(panel.rows[0].swatch).toBe(actorColor("agent-1"));
  });

  it("gives two subagents of one type two different swatches", () => {
    // `agent` is identity and `label` is only text. Keyed on the label these
    // two would be one row in one colour.
    const panel = build(
      frame(
        entry({ agent: "a1", label: "developer-backend" }),
        entry({ agent: "a2", label: "developer-backend" }),
      ),
      true,
    );

    const swatches = panel.rows.map((row) => row.swatch);
    expect(swatches[0]).not.toBe(swatches[1]);
  });

  it("gives the unattributed row no swatch at all", () => {
    // The swatch is an actor's identity and there is no actor: a coloured dot
    // beside this row would invent an author for a change nobody claimed.
    const panel = build(frame(entry({ agent: "" })), true);

    expect(panel.rows[0].swatch).toBe(null);
  });
});

describe("buildStatsPanel: the file an agent kept returning to", () => {
  it("carries the daemon's most-visited path and its count through untouched", () => {
    const panel = build(frame(entry({ topPath: "src/api/users.ts", topCount: 12 })), true);

    expect([panel.rows[0].topPath, panel.rows[0].topCount]).toEqual(["src/api/users.ts", 12]);
  });

  it("says nothing rather than naming a file visited once", () => {
    // The daemon answers `""` / `0` when nothing was touched twice. A panel that
    // filled that in with an arbitrary path would report a habit that does not
    // exist, and the reader has no way to tell the two apart.
    const panel = build(frame(entry({ topPath: "", topCount: 0 })), true);

    expect([panel.rows[0].topPath, panel.rows[0].topCount]).toEqual(["", 0]);
  });

  it("splits an empty top path into two empty halves, not into a stray slash", () => {
    const panel = build(frame(entry({ topPath: "", topCount: 0 })), true);

    expect([panel.rows[0].topDir, panel.rows[0].topName]).toEqual(["", ""]);
  });

  it.each([
    "src/api/users.ts",
    "package.json",
    ".github/workflows/ci.yml",
    "/absolute/path.txt",
    "trailing/",
    "double//slash.ts",
  ])("splits %s the way every other panel splits it, never with a rule of its own", (path) => {
    // `splitPath` from `eventLog.ts`, imported and not respelled: the directory
    // and the name paint in two greys, and two implementations of "where does
    // the name start" would disagree on exactly these paths -- so the same file
    // would read differently in the alarm panel and in this one.
    const row = build(frame(entry({ topPath: path, topCount: 2 })), true).rows[0];

    expect({ dir: row.topDir, name: row.topName }).toEqual(splitPath(path));
    expect(row.topDir + row.topName).toBe(path);
  });
});

describe("buildStatsPanel: reading is work", () => {
  it("shows an agent that only ever read, with no writes at all", () => {
    // `eventLog.ts` drops reads outright, because that list is a list of
    // CHANGES. This panel inverts that deliberately: "it read 340 files and
    // wrote 12" is the single most informative line it can produce, and an
    // agent filtered out for having written nothing is an agent that spent the
    // session reading and vanished from the report of it.
    const panel = build(frame(entry({ agent: "a1", writes: 0, reads: 340 })), true);

    expect(panel.visible).toBe(true);
    expect([panel.rows[0].writes, panel.rows[0].reads]).toEqual([0, 340]);
  });

  it("keeps reads and writes apart, never summing them into one number", () => {
    const panel = build(frame(entry({ writes: 12, reads: 340 })), true);

    expect(panel.rows[0].reads).not.toBe(352);
    expect(panel.rows[0].writes).toBe(12);
  });

  it("carries the counts the daemon sent, recomputing none of them", () => {
    // The browser cannot: its history is the last 200 events plus the seed, and
    // nothing in the replay says how much was lost.
    const panel = build(
      frame(entry({ writes: 3, reads: 5, files: 7, dirs: 2, firstTs: 100.5, lastTs: 900.25 })),
      true,
    );
    const row = panel.rows[0];

    expect([row.writes, row.reads, row.files, row.dirs, row.firstTs, row.lastTs]).toEqual([
      3, 5, 7, 2, 100.5, 900.25,
    ]);
  });
});

describe("buildStatsPanel: a number that is a floor must say so", () => {
  it("carries truncation on the row that was capped", () => {
    const panel = build(
      frame(entry({ agent: "a1", truncated: true }), entry({ agent: "a2", truncated: false })),
      true,
    );
    const byAgent = new Map(panel.rows.map((row) => [row.agent, row.truncated]));

    expect([byAgent.get("a1"), byAgent.get("a2")]).toEqual([true, false]);
  });

  it("surfaces one truncated row on the panel as a whole", () => {
    // "Files touched: 2000" with the flag missed is a wrong number, not a
    // caveat. The header is where a reader who is not scanning rows will see
    // it, so the panel carries the fact as well as the row does.
    const panel = build(
      frame(entry({ agent: "a1", truncated: false }), entry({ agent: "a2", truncated: true })),
      true,
    );

    expect(panel.truncated).toBe(true);
  });

  it("claims no truncation when every row is exact", () => {
    const panel = build(
      frame(entry({ agent: "a1" }), entry({ agent: "a2" })),
      true,
    );

    expect(panel.truncated).toBe(false);
  });
});

describe("buildStatsPanel: the cap belongs to the panel, not to the daemon", () => {
  /** A table of `count` agents, in an order the panel must not trust. */
  function manyAgents(count: number) {
    const agents = Array.from({ length: count }, (_, index) =>
      entry({ agent: `a${String(index).padStart(3, "0")}`, writes: index }),
    );
    return frame(...agents);
  }

  it("draws fewer rows than a daemon that doubled its own agent cap would send", () => {
    // The value is deliberately not pinned -- only that the panel bounds itself
    // rather than inheriting whatever the daemon decided to count.
    const panel = build(manyAgents(64), true);

    expect(panel.rows.length).toBeLessThan(64);
  });

  it("reports what it cut, so the count in the corner is never silently short", () => {
    const panel = build(manyAgents(64), true);

    expect(panel.total).toBe(64);
    expect(panel.rows.length + panel.hidden).toBe(64);
  });

  it("cuts the sorted order, not the order the frame arrived in", () => {
    // What survives a long session is the top of the panel's order. Cutting
    // first and sorting after would show three arbitrary agents.
    const panel = build(
      frame(
        entry({ agent: "a1", writes: 1 }),
        entry({ agent: "a2", writes: 50 }),
        entry({ agent: "a3", writes: 20 }),
        entry({ agent: "a4", writes: 30 }),
      ),
      true,
      2,
    );

    expect(panel.rows.map((row) => row.agent)).toEqual(["a2", "a4"]);
    expect(panel.hidden).toBe(2);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to its own default for a degenerate cap of %s",
    (max) => {
      // `resolveMax`'s rule, copied from `eventLog.ts` and `statusList.ts`: a
      // cap of 0 would empty the panel and a cap of Infinity would uncap it.
      const panel = build(manyAgents(64), true, max);

      expect(panel.rows.length).toBeGreaterThan(0);
      expect(panel.rows.length).toBeLessThan(64);
    },
  );

  it("does not mutate the frame it was handed", () => {
    // The frame is the parsed message the caller keeps; a sort in place would
    // leak this panel's order into anything else reading the same object.
    const agents = [entry({ agent: "a1", writes: 1 }), entry({ agent: "a2", writes: 50 })];
    const f = { agents } as never;

    build(f, true);

    expect(agents.map((row) => row.agent)).toEqual(["a1", "a2"]);
  });
});
