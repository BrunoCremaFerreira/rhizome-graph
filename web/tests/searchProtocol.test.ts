/**
 * Contract tests (RED) for the `searchResult` frame behind the content search.
 *
 * The defect: `ctrl+F` searches file NAMES, so the question an agent's work
 * actually raises -- "which files mention this symbol?" -- can only be answered
 * by leaving the page for a terminal. The browser cannot read the disk, so a
 * content search is a ROUND TRIP: the page submits a query and the daemon
 * answers on the same socket the events arrive on, with
 * `{kind:"searchResult",query,files:[{path,count}],truncated,error}`.
 *
 * This parser sits beside `parseFileView` and `parseStatus` and follows their
 * contract exactly, because all of them share one socket:
 *
 *  - the `kind` gate is load-bearing in BOTH directions. A result frame routed
 *    as an activity event would grow a node called "searchResult" in the graph;
 *    an activity event mistaken for a result would replace the answer to a real
 *    submission. Each parser must refuse the other's frame.
 *  - `query` is the ONE field whose absence costs the frame, the way `path`
 *    costs `parseFileView` its frame. An answer naming no query cannot be
 *    matched to the submission that asked for it, and the state machine's
 *    supersede guard is exactly that comparison (`frame.query !== submitted`):
 *    fed a queryless frame it could only guess, and guessing means painting the
 *    counts for a query the user has already typed over.
 *  - everything else DEGRADES rather than costing the frame. `files` behaves as
 *    `parseStatus`'s `entries` does -- absent or mistyped becomes `[]`, a junk
 *    item is dropped ONE AT A TIME -- and `truncated`/`error` fall back to
 *    `false`/`""`. Dropping the whole frame instead would leave the bar pending
 *    forever, the failure `parseFileView`'s docstring already names for the
 *    panel: no second reply is coming for that submission, so the counter spins
 *    on a request that was, in fact, answered.
 *  - NEVER throws: this comes off the network.
 *
 * Expected to FAIL until `parseSearchResult` exists in src/protocol.ts. One
 * failure reason per test.
 */

import { describe, it, expect } from "vitest";
import {
  parseSearchResult,
  parseEvent,
  parseMeta,
  parseCompletion,
  parseReset,
  parseRootError,
  parseFileView,
  parseStatus,
  type SearchResult,
} from "../src/protocol";

/** A well-formed answer: three files, two of them with several occurrences. */
function validResult(): Record<string, unknown> {
  return {
    kind: "searchResult",
    query: "parseEvent",
    files: [
      { path: "web/src/protocol.ts", count: 3 },
      { path: "web/src/wsClient.ts", count: 2 },
      { path: "web/tests/protocol.test.ts", count: 1 },
    ],
    truncated: false,
    error: "",
  };
}

/** The frames that already share this socket. */
function validEvent(): Record<string, unknown> {
  return {
    ts: 1754870400.5,
    agent: "sess-abc",
    type: "M",
    path: "web/src/renderer.ts",
    color: "FFAA00",
  };
}

function validMeta(): Record<string, unknown> {
  return { kind: "meta", root: "~/projects/rhizome-graph", branch: "development" };
}

function validCompletion(): Record<string, unknown> {
  return {
    kind: "completion",
    path: "/home/brn/pro",
    completed: "/home/brn/projects/",
    matches: ["/home/brn/projects/"],
  };
}

function validReset(): Record<string, unknown> {
  return { kind: "reset", root: "/home/brn/projects/other" };
}

function validRootError(): Record<string, unknown> {
  return { kind: "rootError", path: "/nope", reason: "no such directory" };
}

function validFileView(): Record<string, unknown> {
  return {
    kind: "fileView",
    path: "web/src/renderer.ts",
    mode: "diff",
    content: "@@ -1,3 +1,4 @@\n",
    truncated: false,
    error: "",
  };
}

function validStatus(): Record<string, unknown> {
  return {
    kind: "status",
    repo: true,
    truncated: false,
    entries: [{ path: "web/src/renderer.ts", state: "modified" }],
  };
}

describe("parseSearchResult", () => {
  it("parses a well-formed frame", () => {
    const parsed = parseSearchResult(validResult());

    expect(parsed).not.toBeNull();
    const result = parsed as SearchResult;
    expect(result.query).toBe("parseEvent");
    expect(result.truncated).toBe(false);
    expect(result.error).toBe("");
    expect(result.files).toEqual([
      { path: "web/src/protocol.ts", count: 3 },
      { path: "web/src/wsClient.ts", count: 2 },
      { path: "web/tests/protocol.test.ts", count: 1 },
    ]);
  });

  it("echoes the query verbatim, since that is what identifies the submission", () => {
    const raw = validResult();
    raw.query = "  Mixed Case  ";

    expect((parseSearchResult(raw) as SearchResult).query).toBe("  Mixed Case  ");
  });

  it("preserves the order the daemon walked, leaving the walk to contentSearch", () => {
    const raw = validResult();
    raw.files = [
      { path: "z.ts", count: 1 },
      { path: "a.ts", count: 9 },
    ];

    expect((parseSearchResult(raw) as SearchResult).files.map((f) => f.path)).toEqual([
      "z.ts",
      "a.ts",
    ]);
  });

  it("reports a query that matched nothing as an empty list, not as a dropped frame", () => {
    // A search with no hits is an ANSWER; dropping it would leave the bar
    // pending on a reply that has already arrived.
    const raw = validResult();
    raw.files = [];

    const result = parseSearchResult(raw) as SearchResult;

    expect(result).not.toBeNull();
    expect(result.files).toEqual([]);
    expect(result.query).toBe("parseEvent");
  });

  it("keeps a truncation flag, so the counter can say the walk was cut", () => {
    const raw = validResult();
    raw.truncated = true;

    expect((parseSearchResult(raw) as SearchResult).truncated).toBe(true);
  });

  it("keeps an error message, so a refusal can be shown instead of a zero count", () => {
    const raw = validResult();
    raw.files = [];
    raw.error = "query too short";

    const result = parseSearchResult(raw) as SearchResult;

    expect(result.error).toBe("query too short");
    expect(result.files).toEqual([]);
  });
});

describe("parseSearchResult: the query is the one field that costs the frame", () => {
  it.each([
    ["missing", undefined],
    ["a number", 7],
    ["null", null],
    ["an array", ["parseEvent"]],
    ["an object", { text: "parseEvent" }],
    ["a boolean", false],
  ])("returns null when query is not a string (%s)", (_label, bad) => {
    const raw = validResult();
    if (bad === undefined) delete raw.query;
    else raw.query = bad;

    expect(parseSearchResult(raw)).toBeNull();
  });

  it("accepts an empty query string, which is a frame the daemon really sends", () => {
    // The empty query short-circuits on the daemon side and answers with an
    // empty list; `""` is a value, not an absence.
    const raw = validResult();
    raw.query = "";
    raw.files = [];

    const result = parseSearchResult(raw) as SearchResult;

    expect(result).not.toBeNull();
    expect(result.query).toBe("");
  });
});

describe("parseSearchResult: files degrade, one item at a time", () => {
  it("degrades a missing files list to an empty one", () => {
    const raw = validResult();
    delete raw.files;

    expect((parseSearchResult(raw) as SearchResult).files).toEqual([]);
  });

  it.each([
    ["a string", "web/src/protocol.ts"],
    ["a number", 3],
    ["null", null],
    ["an object", { "a.ts": 2 }],
  ])("degrades a non-array files (%s) to an empty list", (_label, bad) => {
    const raw = validResult();
    raw.files = bad;

    const result = parseSearchResult(raw) as SearchResult;

    expect(result).not.toBeNull();
    expect(result.files).toEqual([]);
  });

  it.each([
    ["a string", "a.ts"],
    ["a number", 7],
    ["null", null],
    ["an array", ["a.ts", 2]],
  ])("drops an item that is not an object (%s) without losing the frame", (_label, bad) => {
    const raw = validResult();
    raw.files = [bad, { path: "a.ts", count: 1 }];

    expect((parseSearchResult(raw) as SearchResult).files).toEqual([
      { path: "a.ts", count: 1 },
    ]);
  });

  it("drops an item with no path, since a row that names no file cannot be opened", () => {
    const raw = validResult();
    raw.files = [{ count: 4 }, { path: "a.ts", count: 1 }];

    expect((parseSearchResult(raw) as SearchResult).files).toEqual([
      { path: "a.ts", count: 1 },
    ]);
  });

  it.each([
    ["a number", 42],
    ["null", null],
    ["an object", { path: "a.ts" }],
    ["an array", ["a.ts"]],
  ])("drops an item whose path has the wrong type (%s)", (_label, bad) => {
    const raw = validResult();
    raw.files = [{ path: bad, count: 2 }, { path: "a.ts", count: 1 }];

    expect((parseSearchResult(raw) as SearchResult).files).toEqual([
      { path: "a.ts", count: 1 },
    ]);
  });

  it.each([
    ["missing", undefined],
    ["a string", "3"],
    ["null", null],
    ["a boolean", true],
    ["an object", { count: 3 }],
  ])("drops an item whose count is not a number (%s)", (_label, bad) => {
    const raw = validResult();
    const item: Record<string, unknown> = { path: "bad.ts" };
    if (bad !== undefined) item.count = bad;
    raw.files = [item, { path: "a.ts", count: 1 }];

    expect((parseSearchResult(raw) as SearchResult).files).toEqual([
      { path: "a.ts", count: 1 },
    ]);
  });

  it("drops an item whose count is not an integer", () => {
    // The counter sums these and the walk indexes into them; half an
    // occurrence has no position to walk to.
    const raw = validResult();
    raw.files = [{ path: "bad.ts", count: 2.5 }, { path: "a.ts", count: 1 }];

    expect((parseSearchResult(raw) as SearchResult).files).toEqual([
      { path: "a.ts", count: 1 },
    ]);
  });

  it("drops an item whose count is negative", () => {
    // A negative count would shift every later file's global index, sending
    // the walk to the wrong file rather than merely to the wrong line.
    const raw = validResult();
    raw.files = [{ path: "bad.ts", count: -1 }, { path: "a.ts", count: 1 }];

    expect((parseSearchResult(raw) as SearchResult).files).toEqual([
      { path: "a.ts", count: 1 },
    ]);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("drops an item whose count is %s", (_label, bad) => {
    // JSON has no NaN, but `JSON.parse` is not the only way here and a
    // non-finite count poisons every comparison the walk makes.
    const raw = validResult();
    raw.files = [{ path: "bad.ts", count: bad }, { path: "a.ts", count: 1 }];

    expect((parseSearchResult(raw) as SearchResult).files).toEqual([
      { path: "a.ts", count: 1 },
    ]);
  });

  it("keeps every valid item around a run of junk, dropping one at a time", () => {
    const raw = validResult();
    raw.files = [
      { path: "keep-1.ts", count: 2 },
      "junk",
      { path: "bad.ts", count: -3 },
      null,
      { path: 7, count: 1 },
      { path: "keep-2.ts", count: 5 },
    ];

    expect((parseSearchResult(raw) as SearchResult).files).toEqual([
      { path: "keep-1.ts", count: 2 },
      { path: "keep-2.ts", count: 5 },
    ]);
  });
});

describe("parseSearchResult: truncated and error degrade", () => {
  it.each([
    ["missing", undefined],
    ["the string \"true\"", "true"],
    ["1", 1],
    ["null", null],
    ["an object", {}],
  ])("degrades a non-boolean truncated (%s) to false", (_label, bad) => {
    // A truthy non-boolean would put a "results cut" notice over a list that
    // is whole, which is a lie about what the user is reading.
    const raw = validResult();
    if (bad === undefined) delete raw.truncated;
    else raw.truncated = bad;

    const result = parseSearchResult(raw) as SearchResult;

    expect(result).not.toBeNull();
    expect(result.truncated).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["a number", 500],
    ["null", null],
    ["an object", { message: "boom" }],
    ["a boolean", true],
  ])("degrades a non-string error (%s) to the empty string", (_label, bad) => {
    const raw = validResult();
    if (bad === undefined) delete raw.error;
    else raw.error = bad;

    const result = parseSearchResult(raw) as SearchResult;

    expect(result).not.toBeNull();
    expect(result.error).toBe("");
  });
});

describe("parseSearchResult: the kind gate", () => {
  it.each([
    ["missing", undefined],
    ["search", "search"],
    ["SearchResult", "SearchResult"],
    ["searchresult", "searchresult"],
    ["fileView", "fileView"],
    ["status", "status"],
    ["a number", 1],
    ["null", null],
  ])("returns null when kind is not \"searchResult\" (%s)", (_label, badKind) => {
    const raw = validResult();
    if (badKind === undefined) delete raw.kind;
    else raw.kind = badKind;

    expect(parseSearchResult(raw)).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 5],
    ["a string", "searchResult"],
    ["an array", [{ kind: "searchResult", query: "x", files: [] }]],
  ])("returns null for a non-object input (%s)", (_label, value) => {
    expect(parseSearchResult(value)).toBeNull();
  });

  it("never throws on malformed input", () => {
    expect(() => parseSearchResult(undefined)).not.toThrow();
    expect(() => parseSearchResult("garbage")).not.toThrow();
    expect(() => parseSearchResult({ kind: "searchResult" })).not.toThrow();
    expect(() =>
      parseSearchResult({ kind: "searchResult", query: "x", files: [undefined, null] }),
    ).not.toThrow();
    expect(() => parseSearchResult([])).not.toThrow();
  });
});

describe("parseSearchResult refuses the frames that already share the socket", () => {
  it("returns null for an activity event, so a file save never answers a search", () => {
    expect(parseSearchResult(validEvent())).toBeNull();
  });

  it("returns null for a meta frame", () => {
    expect(parseSearchResult(validMeta())).toBeNull();
  });

  it("returns null for a completion frame, even though both carry a list of paths", () => {
    expect(parseSearchResult(validCompletion())).toBeNull();
  });

  it("returns null for a reset frame", () => {
    expect(parseSearchResult(validReset())).toBeNull();
  });

  it("returns null for a rootError frame", () => {
    expect(parseSearchResult(validRootError())).toBeNull();
  });

  it("returns null for a fileView frame, even though both carry truncated and error", () => {
    expect(parseSearchResult(validFileView())).toBeNull();
  });

  it("returns null for a status frame, even though both carry a list of paths", () => {
    expect(parseSearchResult(validStatus())).toBeNull();
  });
});

describe("the existing parsers refuse the searchResult frame", () => {
  it("parseEvent returns null, so no node is ever named after a search answer", () => {
    expect(parseEvent(validResult())).toBeNull();
  });

  it("parseMeta returns null, so an answer does not relabel the HUD", () => {
    expect(parseMeta(validResult())).toBeNull();
  });

  it("parseCompletion returns null, so an answer is never typed into the root bar", () => {
    expect(parseCompletion(validResult())).toBeNull();
  });

  it("parseReset returns null, so a search does not wipe the graph", () => {
    expect(parseReset(validResult())).toBeNull();
  });

  it("parseRootError returns null, so an answer does not accuse the observed root", () => {
    expect(parseRootError(validResult())).toBeNull();
  });

  it("parseFileView returns null, so an answer does not open the file viewer", () => {
    expect(parseFileView(validResult())).toBeNull();
  });

  it("parseStatus returns null, so an answer does not repaint the git status panel", () => {
    expect(parseStatus(validResult())).toBeNull();
  });
});
