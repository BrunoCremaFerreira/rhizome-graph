/**
 * RED specification for `attentionList.ts`: what the alarm panel shows, and
 * what its header says about the rules that produced it.
 *
 * Two defects, and the second is the sharper one.
 *
 * The first is the one `statusList.ts` was written to avoid: a panel whose
 * visibility comes from a flag rather than from its own entry count is a
 * permanent strip of chrome reporting nothing. Over a quiet session an alarm
 * panel has nothing to say, and an empty box in the corner is worse than no box
 * -- it occupies the place the reader looks. So `visible` derives from the
 * rows, exactly as it does there, and the ordering and the cap are computed
 * here rather than in the painter.
 *
 * The second is finding 5 of the plan, and it inverts the direction of failure
 * of the module this feature reuses. In `gitignore.py` a refused pattern, an
 * unreadable file or a cap reached shows MORE, never less. Reused for attention
 * rules the same refusal shows LESS: a user protecting private keys writes a
 * POSIX bracket class, the matcher refuses the pattern because `re` would
 * silently match the wrong thing, and the panel then stays empty -- which is
 * the same picture as a well-behaved session. A supervision feature whose
 * failure mode is indistinguishable from success is not a supervision feature.
 * Hence the header states, always and not only on failure, which file the rules
 * came from and how many are in force; and states the refusals, verbatim, when
 * there are any.
 *
 * "No rule file was found" and "a rule file was found and held nothing" are
 * therefore TWO SENTENCES, and that is the test to write first here: the
 * natural first implementation collapses both into an absent header, which is
 * finding 5 shipping.
 *
 * The third defect was found by the implementation of the first two, and it is
 * the second one coming back through the door `statusList.ts` held open. The
 * header answers a question the empty list cannot -- is this silence a quiet
 * session, or a rule file nobody could read? -- but a panel whose visibility
 * derives from its ROW COUNT alone hides that header exactly when it is the
 * only thing worth saying. A user protecting private keys writes a POSIX
 * bracket class, the matcher refuses it, and the panel reports nothing at all
 * until something unrelated alarms. That is finding 5 shipping a second time,
 * and R7's own words are the argument: a supervision feature whose failure mode
 * is indistinguishable from success is not a supervision feature, and the
 * header states its three facts ALWAYS AND NOT ONLY ON FAILURE.
 *
 * The correction is not a flag bolted onto the rule. `statusList.ts`'s rule is
 * `visible` derives from WHAT THERE IS TO SAY, and a refused pattern is
 * something to say. So: at least one row, OR a rules frame reporting something
 * that is not in force. Nothing else moves -- no rows and nothing wrong is
 * still `visible: false`, because a permanent empty strip reporting nothing is
 * the failure that rule exists to avoid, and `null` rules are still invisible
 * with an empty header, because nothing has been heard from the daemon yet.
 *
 * A TRUNCATED RULE FILE COUNTS AS SOMETHING TO SAY, and this is the one call
 * here that could go either way. Against: the cap is 64 patterns, a rule file
 * that long is not a supervision policy but a second `.gitignore`, and a user
 * who wrote 200 patterns arguably knows it. For, and this is what settles it:
 * the fact is the same class as a refusal and fails in the same direction --
 * rules the user wrote are silently NOT IN FORCE, the panel goes quiet, and the
 * quiet is indistinguishable from a clean session. The user cannot tell which
 * of their patterns fell off the end, and unlike a refusal there is not even a
 * malformed pattern for them to notice in their own file. Pinning it the other
 * way would leave one silent failure mode inside the feature written to remove
 * silent failure modes.
 *
 * What is deliberately NOT pinned: the wording. Only that the two cases differ,
 * that the found file is named, that the count is stated and that each refused
 * pattern is quoted well enough for a user to find it in their own file.
 */

import { describe, it, expect } from "vitest";
import { buildAttentionList } from "../src/attentionList";
import { splitPath } from "../src/eventLog";
import * as colors from "../src/colors";
import type { Alarm } from "../src/attentionState";
import type { AttentionRulesFrame } from "../src/protocol";

/** Today's module, plus the export R10 adds. Same accessor as colors.test.ts. */
const palette = colors as typeof colors & { actorColor?: (agent: string) => number };

function actorColor(agent: string): number {
  expect(typeof palette.actorColor).toBe("function");
  return (palette.actorColor as (agent: string) => number)(agent);
}

function alarm(overrides: Partial<Alarm> = {}): Alarm {
  return {
    path: "package.json",
    firstTs: 1000,
    lastTs: 1000,
    count: 1,
    agent: "sess-abc",
    label: "developer-backend",
    types: ["M"],
    ...overrides,
  } as Alarm;
}

function rules(overrides: Partial<AttentionRulesFrame> = {}): AttentionRulesFrame {
  return {
    source: "/home/u/proj/.rhizome-attention",
    count: 11,
    refused: [],
    truncated: false,
    ...overrides,
  } as AttentionRulesFrame;
}

const NO_FILE = rules({ source: "", count: 0 });
const FOUND_BUT_EMPTY = rules({ count: 0 });

describe("the header: no rule file is a different sentence from an empty one", () => {
  it("says something when no rule file was found at all", () => {
    // THE DRIVER of this file. Silence here is read as "nothing has alarmed
    // yet", which is exactly the reading a typo'd rule path produces.
    expect(buildAttentionList([], NO_FILE).header).not.toBe("");
  });

  it("does not say the same thing for a file that was found and held no rules", () => {
    expect(buildAttentionList([], NO_FILE).header).not.toBe(
      buildAttentionList([], FOUND_BUT_EMPTY).header,
    );
  });

  it("names the file the rules came from, so a re-anchored root is visible", () => {
    // An explicit rule path does not move with a `ctrl+L`, but its patterns are
    // re-interpreted against the new root. Naming the file is what makes that
    // silent re-anchoring something a reader can see.
    expect(buildAttentionList([], rules()).header).toContain("/home/u/proj/.rhizome-attention");
  });

  it("does not name a file it never found", () => {
    expect(buildAttentionList([], NO_FILE).header).not.toContain(
      "/home/u/proj/.rhizome-attention",
    );
  });

  it("states how many rules are in force", () => {
    expect(buildAttentionList([], rules({ count: 11 })).header).toContain("11");
  });

  it("keeps the header even while the panel has no rows to show", () => {
    // The header answers a question the empty list cannot: is the silence a
    // quiet session, or a rule file nobody could read?
    const model = buildAttentionList([], rules());

    expect(model.rows).toEqual([]);
    expect(model.header).not.toBe("");
  });

  it("says nothing at all before the daemon has reported any rules", () => {
    // `null` is "we have not been told yet". Claiming "no rule file was found"
    // in that window would be a statement about a disk nobody has read.
    expect(buildAttentionList([], null).header).toBe("");
  });
});

describe("the header: refusals are the loud part", () => {
  it("quotes every refused pattern verbatim, so the user can find it in their file", () => {
    const model = buildAttentionList([], rules({ count: 4, refused: ["[[:alpha:]].pem", "*.{a,b}"] }));

    expect(model.header).toContain("[[:alpha:]].pem");
    expect(model.header).toContain("*.{a,b}");
  });

  it("says the word, so a reader knows the quoted patterns are not in force", () => {
    // Only the concept is pinned, not the sentence: a refusal that is merely
    // listed reads as a rule that IS working.
    expect(buildAttentionList([], rules({ refused: ["[[:alpha:]].pem"] })).header).toMatch(/refus/i);
  });

  it("says nothing about refusals when there were none", () => {
    // A permanent "0 refused" is one more thing to read in a corner that has to
    // stay small, and it trains the reader to skip the line that matters.
    expect(buildAttentionList([], rules({ refused: [] })).header).not.toMatch(/refus/i);
  });

  it("reports refusals even over a file whose surviving rules matched nothing", () => {
    const model = buildAttentionList([], rules({ count: 0, refused: ["[[:alpha:]].pem"] }));

    expect(model.header).toContain("[[:alpha:]].pem");
  });
});

describe("the panel is on screen only when it has something to say", () => {
  it("is invisible over an empty alarm list", () => {
    const model = buildAttentionList([], rules());

    expect(model.visible).toBe(false);
    expect(model.rows).toEqual([]);
    expect(model.total).toBe(0);
    expect(model.hidden).toBe(0);
  });

  it("is invisible over an empty list when a rule file loaded cleanly", () => {
    // Rules in force and nothing to report is a quiet session, and a quiet
    // session gets no panel. This is the case `statusList.ts`'s rule is for and
    // it does not move.
    expect(buildAttentionList([], rules({ count: 11, refused: [] })).visible).toBe(false);
  });

  it("is invisible over an empty list when no rule file was found", () => {
    // Also unchanged, and deliberately so: "no rule file" is the normal state
    // of a project nobody has written rules for, and a panel that appears in
    // every project that never asked for this feature is chrome.
    expect(buildAttentionList([], NO_FILE).visible).toBe(false);
  });

  it("stays invisible before the daemon has reported any rules at all", () => {
    const model = buildAttentionList([], null);

    expect(model.visible).toBe(false);
    expect(model.header).toBe("");
  });

  it("is visible over an empty list when a pattern was refused", () => {
    // THE CORRECTION. A refused pattern means the user wrote a rule that is not
    // in force, so the graph will stay silent about the very file they asked to
    // be told about -- and with visibility keyed on the row count, the header
    // saying so is on screen only once something UNRELATED alarms. The failure
    // mode is then indistinguishable from success, which is the sentence this
    // whole section is written against.
    expect(buildAttentionList([], rules({ count: 4, refused: ["[[:alpha:]].pem"] })).visible).toBe(
      true,
    );
  });

  it("quotes the refused pattern while that refusal is the only reason it is on screen", () => {
    // Visible with nothing to read would be worse than invisible: the reader
    // sees a panel appear and has no way to learn why.
    const model = buildAttentionList([], rules({ count: 4, refused: ["[[:alpha:]].pem"] }));

    expect(model.visible).toBe(true);
    expect(model.header).toContain("[[:alpha:]].pem");
  });

  it("is visible over an empty list when the rule file was cut short", () => {
    // The call argued in this file's header: a truncated file means patterns
    // the user wrote are not in force, which is a refusal by another name and
    // fails in the same direction.
    expect(buildAttentionList([], rules({ truncated: true, refused: [] })).visible).toBe(true);
  });

  it("shows no rows while it is on screen for a refusal alone", () => {
    // Visible is not a claim that something alarmed. The list is still empty
    // and still says so, or the header would read as a summary of rows nobody
    // can see.
    const model = buildAttentionList([], rules({ refused: ["[[:alpha:]].pem"] }));

    expect(model.rows).toEqual([]);
    expect(model.total).toBe(0);
    expect(model.hidden).toBe(0);
  });

  it("keeps saying what was refused once a row finally arrives", () => {
    // The refusal does not stop being true because something else alarmed, and
    // the row must not push the header off the panel it was holding open.
    const model = buildAttentionList([alarm()], rules({ count: 4, refused: ["[[:alpha:]].pem"] }));

    expect(model.visible).toBe(true);
    expect(model.rows).toHaveLength(1);
    expect(model.header).toContain("[[:alpha:]].pem");
  });

  it("goes on hiding an empty panel whose rules are clean, whatever alarmed before", () => {
    // The rule is a function of the arguments and holds nothing from a previous
    // call: an alarm acknowledged back to an empty list over a clean rule file
    // takes the panel off screen again.
    expect(buildAttentionList([alarm()], rules()).visible).toBe(true);
    expect(buildAttentionList([], rules()).visible).toBe(false);
  });

  it("is visible as soon as one alarm is open", () => {
    expect(buildAttentionList([alarm()], rules()).visible).toBe(true);
  });
});

describe("the order and the cut", () => {
  it("lists the newest alarm first, by when it first fired", () => {
    const model = buildAttentionList(
      [
        alarm({ path: "a", firstTs: 1000 }),
        alarm({ path: "b", firstTs: 3000 }),
        alarm({ path: "c", firstTs: 2000 }),
      ],
      rules(),
    );

    expect(model.rows.map((row) => row.path)).toEqual(["b", "c", "a"]);
  });

  it("cuts the list after the cap and says how many it left out", () => {
    const model = buildAttentionList(
      [
        alarm({ path: "a", firstTs: 1000 }),
        alarm({ path: "b", firstTs: 2000 }),
        alarm({ path: "c", firstTs: 3000 }),
      ],
      rules(),
      2,
    );

    expect(model.rows.map((row) => row.path)).toEqual(["c", "b"]);
    expect(model.total).toBe(3);
    expect(model.hidden).toBe(1);
  });

  it("cuts AFTER ordering, so what survives is the newest and not the daemon's order", () => {
    const model = buildAttentionList(
      [alarm({ path: "old", firstTs: 1000 }), alarm({ path: "new", firstTs: 9000 })],
      rules(),
      1,
    );

    expect(model.rows.map((row) => row.path)).toEqual(["new"]);
  });

  it.each([
    ["zero", 0],
    ["a negative", -3],
    ["NaN", Number.NaN],
  ])("falls back to the default cap when the cap is %s", (_label, max) => {
    const model = buildAttentionList([alarm({ path: "a" }), alarm({ path: "b" })], rules(), max);

    expect(model.rows).toHaveLength(2);
    expect(model.hidden).toBe(0);
  });

  it("does not reorder the list the caller still holds", () => {
    const list = [alarm({ path: "a", firstTs: 1000 }), alarm({ path: "b", firstTs: 3000 })];

    buildAttentionList(list, rules());

    expect(list.map((entry) => entry.path)).toEqual(["a", "b"]);
  });
});

describe("a row", () => {
  it("carries what the reader needs to read it", () => {
    const model = buildAttentionList(
      [alarm({ path: "src/api/users.ts", count: 7, agent: "agent-1", label: "developer-backend" })],
      rules(),
    );

    expect(model.rows[0]).toMatchObject({
      path: "src/api/users.ts",
      count: 7,
      agent: "agent-1",
      label: "developer-backend",
    });
  });

  it.each([
    "src/api/users.ts",
    "package.json",
    ".github/workflows/ci.yml",
    "/absolute/path.txt",
    "trailing/",
    "double//slash.ts",
  ])("splits %s the way the activity list splits it, never with a rule of its own", (path) => {
    // `splitPath` from `eventLog.ts`, imported and not respelled: the directory
    // and the name paint in two greys, and two implementations of "where does
    // the name start" would disagree on exactly these paths.
    const row = buildAttentionList([alarm({ path })], rules()).rows[0];

    expect({ dir: row.dir, name: row.name }).toEqual(splitPath(path));
    expect(row.dir + row.name).toBe(path);
  });

  it("wears the colour of the figure that did it", () => {
    // The same function the renderer's avatar uses, so the swatch in the corner
    // and the figure in the graph cannot disagree about who this was.
    const row = buildAttentionList([alarm({ agent: "agent-1" })], rules()).rows[0];

    expect(row.swatch).toBe(actorColor("agent-1"));
  });

  it("gives two agents two swatches", () => {
    const model = buildAttentionList(
      [alarm({ path: "a", agent: "agent-1" }), alarm({ path: "b", agent: "agent-2" })],
      rules(),
    );

    expect(model.rows[0].swatch).not.toBe(model.rows[1].swatch);
  });

  it("wears no swatch at all when nobody was on camera", () => {
    // An empty agent is not an actor: a watcher change with no attribution is a
    // real alarm, and a coloured dot beside it would invent an author for it.
    const row = buildAttentionList([alarm({ agent: "", label: "" })], rules()).rows[0];

    expect(row.swatch).toBeNull();
  });
});
