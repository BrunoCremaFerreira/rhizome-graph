/**
 * Contract tests (RED) for the `sizes` answer frame and its route in the client.
 *
 * The defect this file exists for is not a missing feature, it is a corrupted
 * graph. `protocol.ts` has six parsers and `wsClient.handleMessage` six routes;
 * a `sizes` frame reaching the browser today falls through every one of them to
 * `parseEvent`, which IGNORES `kind`. So the answer to "how big is everything?"
 * would be read as activity and grow a phantom node called `sizes` in the tree
 * -- once per F7 press, permanently -- which is exactly what `parseStatus` and
 * `parseSearchResult` were written to prevent. Only the ORDER of the routes
 * keeps an answer out of the simulation, and order is invisible from outside
 * unless a test looks for it, which is why 4.4 is written first.
 *
 * The degradation rules are `parseSearchResult`'s (src/protocol.ts:397-419),
 * one for one, with one deliberate difference:
 *
 *  - `kind` must be exactly `"sizes"`, load-bearing in both directions.
 *  - THERE IS NO HARD FIELD BEYOND `kind`. `parseSearchResult` requires a
 *    string `query` because that comparison IS its supersede guard; a `sizes`
 *    answer echoes nothing, so there is nothing whose absence should cost the
 *    frame. A frame with `files: []` is a real answer -- an empty project --
 *    and dropping it would leave the mode pending forever, with no bar left on
 *    screen to explain why F7 does nothing.
 *  - `files` degrades to `[]` and a junk item is dropped ONE AT A TIME. An
 *    entry needs a string `path` and a `bytes` that is a non-negative integer.
 *  - `bytes` is validated by the EXISTING `isCount` (src/protocol.ts:370-372),
 *    never by a second predicate: it already means exactly "a non-negative
 *    integer" and it already lives in this module. A second copy is the
 *    `MAX_FILE_BYTES` mistake in miniature. The behaviour is pinned below so
 *    there is no reason to write one.
 *  - `truncated` and `error` fall back to `false` and `""`.
 *  - NEVER throws: this comes off the network.
 *
 * Expected to FAIL until `parseSizes` exists in src/protocol.ts and
 * `handleMessage` routes the frame BEFORE `parseEvent`.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { parseSizes, type SizesResult } from "../src/protocol";
import { createWsClient } from "../src/wsClient";

/** Minimal stand-in for the browser WebSocket, capturing the live instance. */
class FakeSocket {
  static last: FakeSocket | null = null;

  onopen: (() => void) | null = null;
  onmessage: ((msg: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    FakeSocket.last = this;
  }

  close(): void {
    /* nothing to tear down */
  }

  /** Deliver a raw frame exactly as the browser would. */
  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }
}

/** Connect a client and return the socket it opened. */
function connect(
  onEvent: (event: unknown) => void,
  options?: Record<string, unknown>,
): FakeSocket {
  FakeSocket.last = null;
  vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
  const client = createWsClient(
    onEvent as never,
    "ws://localhost:8080/ws",
    options as never,
  );
  client.connect();
  const socket = FakeSocket.last;
  if (!socket) throw new Error("client did not open a socket");
  return socket;
}

/** A well-formed answer: three files the daemon measured, in walk order. */
function validSizes(): Record<string, unknown> {
  return {
    kind: "sizes",
    files: [
      { path: "web/src/renderer.ts", bytes: 48213 },
      { path: "web/src/protocol.ts", bytes: 17004 },
      { path: "README.md", bytes: 0 },
    ],
    truncated: false,
    error: "",
  };
}

const SIZES_FRAME = JSON.stringify(validSizes());

const EVENT_FRAME = JSON.stringify({
  ts: 1754870400.5,
  agent: "sess-abc",
  type: "M",
  path: "src/api/users.ts",
  color: "FFAA00",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 4.4 -- an answer about files is never mistaken for a change to them.
// Written first: it is the property whose absence corrupts the graph.
// ---------------------------------------------------------------------------

describe("WebSocket client: sizes frame routing", () => {
  it("hands a sizes frame to the sizes callback, parsed", () => {
    const onEvent = vi.fn();
    const onSizes = vi.fn();
    const socket = connect(onEvent, { onSizes });

    socket.deliver(SIZES_FRAME);

    expect(onSizes).toHaveBeenCalledTimes(1);
    expect(onSizes).toHaveBeenCalledWith({
      files: [
        { path: "web/src/renderer.ts", bytes: 48213 },
        { path: "web/src/protocol.ts", bytes: 17004 },
        { path: "README.md", bytes: 0 },
      ],
      truncated: false,
      error: "",
    });
  });

  it("never feeds a sizes frame to the event callback", () => {
    // Routed as an event it would grow a node called "sizes" in the graph, and
    // every F7 press would put it back.
    const onEvent = vi.fn();
    const onSizes = vi.fn();
    const socket = connect(onEvent, { onSizes });

    socket.deliver(SIZES_FRAME);

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("consumes a sizes frame in silence when no sizes callback was given", () => {
    // An old page against a new daemon: the frame must be swallowed, not
    // forwarded to the simulation.
    const onEvent = vi.fn();
    const socket = connect(onEvent);

    expect(() => socket.deliver(SIZES_FRAME)).not.toThrow();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("claims a sizes frame by its kind even when it also looks like an event", () => {
    // `parseEvent` ignores `kind`, so this is the only way to observe from
    // outside that the route sits BEFORE it. The daemon does not send this
    // frame; a field added to `sizes` later could make a real one look like it.
    const onEvent = vi.fn();
    const socket = connect(onEvent);

    socket.deliver(
      JSON.stringify({
        kind: "sizes",
        files: [],
        truncated: false,
        error: "",
        ts: 1754870400.5,
        agent: "sess-abc",
        type: "M",
        path: "src/api/users.ts",
        color: "FFAA00",
      }),
    );

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("keeps delivering events after a sizes frame with no sizes callback", () => {
    const onEvent = vi.fn();
    const socket = connect(onEvent);

    socket.deliver(SIZES_FRAME);
    socket.deliver(EVENT_FRAME);

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("does not feed an activity event to the sizes callback", () => {
    const onEvent = vi.fn();
    const onSizes = vi.fn();
    const socket = connect(onEvent, { onSizes });

    socket.deliver(EVENT_FRAME);

    expect(onSizes).not.toHaveBeenCalled();
  });

  it("delivers an empty answer, since an empty project is an answer", () => {
    // The frame the mode would wedge on if it were dropped: no files, nothing
    // wrong, and the state machine is waiting for exactly this.
    const onEvent = vi.fn();
    const onSizes = vi.fn();
    const socket = connect(onEvent, { onSizes });

    socket.deliver(JSON.stringify({ kind: "sizes", files: [] }));

    expect(onSizes).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4.1 -- the frame parses, and the kind gate holds in both directions.
// ---------------------------------------------------------------------------

describe("parseSizes: the frame and its kind gate", () => {
  it("parses a well-formed frame with its entries in walk order", () => {
    const parsed = parseSizes(validSizes());

    expect(parsed).toEqual({
      files: [
        { path: "web/src/renderer.ts", bytes: 48213 },
        { path: "web/src/protocol.ts", bytes: 17004 },
        { path: "README.md", bytes: 0 },
      ],
      truncated: false,
      error: "",
    });
  });

  it("refuses a frame whose kind is not exactly sizes", () => {
    for (const kind of ["searchResult", "status", "fileView", "meta", "Sizes", "size", ""]) {
      expect(parseSizes({ ...validSizes(), kind })).toBeNull();
    }
  });

  it("refuses an activity event, which carries no kind at all", () => {
    expect(parseSizes(JSON.parse(EVENT_FRAME))).toBeNull();
  });

  it("refuses anything that is not an object", () => {
    for (const raw of [null, undefined, 7, "sizes", true, [], () => undefined]) {
      expect(parseSizes(raw)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 4.2 -- `files` degrades, and a junk entry costs only itself.
// ---------------------------------------------------------------------------

describe("parseSizes: the files list degrades one entry at a time", () => {
  it("survives a files field that is absent, null or a string, with an empty list", () => {
    for (const files of [undefined, null, "nope", 3, {}]) {
      const parsed = parseSizes({ kind: "sizes", files });
      expect(parsed).not.toBeNull();
      expect((parsed as SizesResult).files).toEqual([]);
    }
  });

  it("drops a junk item while its neighbours survive", () => {
    const parsed = parseSizes({
      kind: "sizes",
      files: [
        { path: "a.txt", bytes: 1 },
        null,
        "b.txt",
        42,
        [],
        { path: "c.txt", bytes: 2 },
      ],
    });

    expect((parsed as SizesResult).files).toEqual([
      { path: "a.txt", bytes: 1 },
      { path: "c.txt", bytes: 2 },
    ]);
  });

  it("drops an entry whose path is not a string, and only that entry", () => {
    const parsed = parseSizes({
      kind: "sizes",
      files: [
        { path: "a.txt", bytes: 1 },
        { path: 7, bytes: 2 },
        { bytes: 3 },
        { path: null, bytes: 4 },
        { path: "e.txt", bytes: 5 },
      ],
    });

    expect((parsed as SizesResult).files).toEqual([
      { path: "a.txt", bytes: 1 },
      { path: "e.txt", bytes: 5 },
    ]);
  });

  it("drops an entry whose bytes is not a non-negative integer, and only that entry", () => {
    // This is `isCount` (src/protocol.ts:370-372) doing its existing job. It
    // already means exactly this; the implementer must reuse it rather than
    // write a second predicate beside it.
    const rejected: unknown[] = [
      2.5,
      -1,
      -0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "3",
      true,
      null,
      undefined,
      [4],
    ];

    for (const bytes of rejected) {
      const parsed = parseSizes({
        kind: "sizes",
        files: [
          { path: "keep-before.txt", bytes: 1 },
          { path: "junk.txt", bytes },
          { path: "keep-after.txt", bytes: 2 },
        ],
      });

      expect((parsed as SizesResult).files).toEqual([
        { path: "keep-before.txt", bytes: 1 },
        { path: "keep-after.txt", bytes: 2 },
      ]);
    }
  });

  it("keeps an entry measured at zero bytes, which is a real measurement", () => {
    // An empty file is not an absent one, and the mode paints it at the cold
    // end rather than leaving it grey.
    const parsed = parseSizes({ kind: "sizes", files: [{ path: "empty.txt", bytes: 0 }] });

    expect((parsed as SizesResult).files).toEqual([{ path: "empty.txt", bytes: 0 }]);
  });

  it("keeps extra keys out of the parsed entry", () => {
    const parsed = parseSizes({
      kind: "sizes",
      files: [{ path: "a.txt", bytes: 1, mtime: 1754870400, mode: 33188 }],
    });

    expect((parsed as SizesResult).files).toEqual([{ path: "a.txt", bytes: 1 }]);
  });

  it("never throws on whatever comes off the network", () => {
    for (const raw of [
      { kind: "sizes", files: [{ path: "a.txt" }] },
      { kind: "sizes", files: [undefined] },
      { kind: "sizes", truncated: "yes", error: 5 },
    ]) {
      expect(() => parseSizes(raw)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 4.3 -- the fallbacks, and the deliberate absence of a hard field.
// ---------------------------------------------------------------------------

describe("parseSizes: nothing but kind is a hard field", () => {
  it("parses a frame carrying only its kind", () => {
    // A `sizes` answer echoes nothing, so there is no `query`-shaped field
    // whose absence could cost the frame.
    expect(parseSizes({ kind: "sizes" })).toEqual({
      files: [],
      truncated: false,
      error: "",
    });
  });

  it("treats an empty files list as an answer, not as a failure", () => {
    const parsed = parseSizes({ kind: "sizes", files: [], truncated: false, error: "" });

    expect(parsed).not.toBeNull();
    expect((parsed as SizesResult).files).toEqual([]);
  });

  it("falls back to false for a truncated flag that is absent or mistyped", () => {
    for (const truncated of [undefined, null, "true", 1, {}]) {
      const parsed = parseSizes({ kind: "sizes", files: [], truncated });
      expect((parsed as SizesResult).truncated).toBe(false);
    }
  });

  it("keeps a truncated flag that is exactly true", () => {
    const parsed = parseSizes({ kind: "sizes", files: [], truncated: true });

    expect((parsed as SizesResult).truncated).toBe(true);
  });

  it("falls back to an empty string for an error that is absent or mistyped", () => {
    for (const error of [undefined, null, 7, true, {}]) {
      const parsed = parseSizes({ kind: "sizes", files: [], error });
      expect((parsed as SizesResult).error).toBe("");
    }
  });

  it("carries the reason the daemon could not answer", () => {
    const parsed = parseSizes({ kind: "sizes", files: [], error: "no such directory" });

    expect((parsed as SizesResult).error).toBe("no such directory");
  });
});
