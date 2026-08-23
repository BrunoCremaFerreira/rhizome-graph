/**
 * Contract tests (RED) for searchResult/event routing in the WebSocket client.
 *
 * The content search adds a seventh kind of frame to the one socket the daemon
 * broadcasts on, and the client is the only place that sees all of them -- so it
 * is the only place that can misroute one. A `searchResult` frame handed to
 * `onEvent` would be parsed as activity and grow a node called "searchResult"
 * in the graph, exactly as a `status` frame would (see wsClientStatus.test.ts),
 * and the answer to the search would never reach the state machine that asked
 * for it, leaving the bar pending on a reply that already arrived.
 *
 * Two compatibility constraints matter as much as the routing itself, exactly as
 * for `onMeta` and `onStatus`: the existing `createWsClient(onEvent, url)` call
 * must keep compiling and working, and a result frame arriving at a client given
 * no result callback must be consumed in silence -- an old page against a new
 * daemon, where a fall-through to `parseEvent` is the very defect above.
 *
 * Signature fixed by these tests (for the implementer):
 *   WsClientOptions gains `onSearchResult?: (result: SearchResult) => void`
 * i.e. the sink rides in the SAME options object, no positional argument added
 * or reordered, and the route sits BEFORE `parseEvent` in `handleMessage`.
 *
 * Expected to FAIL until the client parses and routes searchResult frames.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
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

const SEARCH_RESULT_FRAME = JSON.stringify({
  kind: "searchResult",
  query: "parseEvent",
  files: [
    { path: "web/src/protocol.ts", count: 3 },
    { path: "web/src/wsClient.ts", count: 1 },
  ],
  truncated: false,
  error: "",
});

const EVENT_FRAME = JSON.stringify({
  ts: 1754870400.5,
  agent: "sess-abc",
  type: "M",
  path: "src/api/users.ts",
  color: "FFAA00",
});

const META_FRAME = JSON.stringify({
  kind: "meta",
  root: "~/projects/rhizome-graph",
  branch: "development",
});

const RESET_FRAME = JSON.stringify({ kind: "reset", root: "/home/brn/projects/other" });

const COMPLETION_FRAME = JSON.stringify({
  kind: "completion",
  path: "/home/brn/pro",
  completed: "/home/brn/projects/",
  matches: ["/home/brn/projects/"],
});

const ROOT_ERROR_FRAME = JSON.stringify({
  kind: "rootError",
  path: "/nope",
  reason: "no such directory",
});

const FILE_VIEW_FRAME = JSON.stringify({
  kind: "fileView",
  path: "web/src/renderer.ts",
  mode: "diff",
  content: "@@ -1,3 +1,4 @@\n",
  truncated: false,
  error: "",
});

const STATUS_FRAME = JSON.stringify({
  kind: "status",
  repo: true,
  truncated: false,
  entries: [{ path: "web/src/renderer.ts", state: "modified" }],
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebSocket client: searchResult frame routing", () => {
  it("hands a searchResult frame to the search callback, parsed", () => {
    const onEvent = vi.fn();
    const onSearchResult = vi.fn();
    const socket = connect(onEvent, { onSearchResult });

    socket.deliver(SEARCH_RESULT_FRAME);

    expect(onSearchResult).toHaveBeenCalledTimes(1);
    expect(onSearchResult).toHaveBeenCalledWith({
      query: "parseEvent",
      files: [
        { path: "web/src/protocol.ts", count: 3 },
        { path: "web/src/wsClient.ts", count: 1 },
      ],
      truncated: false,
      error: "",
    });
  });

  it("does not feed a searchResult frame to the event callback", () => {
    // Routed as an event it would grow a node called "searchResult" in the
    // graph, and every submission would add another one.
    const onEvent = vi.fn();
    const onSearchResult = vi.fn();
    const socket = connect(onEvent, { onSearchResult });

    socket.deliver(SEARCH_RESULT_FRAME);

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("does not feed an activity event to the search callback", () => {
    const onEvent = vi.fn();
    const onSearchResult = vi.fn();
    const socket = connect(onEvent, { onSearchResult });

    socket.deliver(EVENT_FRAME);

    expect(onSearchResult).not.toHaveBeenCalled();
  });

  it("consumes a searchResult frame in silence when no search callback was given", () => {
    const onEvent = vi.fn();
    const socket = connect(onEvent);

    expect(() => socket.deliver(SEARCH_RESULT_FRAME)).not.toThrow();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("claims a searchResult frame by its kind even when it also looks like an event", () => {
    // `parseEvent` ignores `kind`, so this is the only way to observe from
    // outside that the route sits BEFORE it -- which is what "consumed with or
    // without a sink" actually means. The daemon does not send this frame; a
    // field added to `searchResult` later could make a real one look like it,
    // and the graph must never grow a node from an answer to a search.
    const onEvent = vi.fn();
    const socket = connect(onEvent);

    socket.deliver(
      JSON.stringify({
        kind: "searchResult",
        query: "parseEvent",
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

  it("keeps delivering events after a searchResult frame with no search callback", () => {
    const onEvent = vi.fn();
    const socket = connect(onEvent);

    socket.deliver(SEARCH_RESULT_FRAME);
    socket.deliver(EVENT_FRAME);

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("delivers every answer, since a walk may be submitted more than once", () => {
    const onEvent = vi.fn();
    const onSearchResult = vi.fn();
    const socket = connect(onEvent, { onSearchResult });

    socket.deliver(SEARCH_RESULT_FRAME);
    socket.deliver(
      JSON.stringify({ kind: "searchResult", query: "other", files: [], truncated: false, error: "" }),
    );

    expect(onSearchResult).toHaveBeenCalledTimes(2);
    expect((onSearchResult.mock.calls[1][0] as { query: string }).query).toBe("other");
  });

  it("drops a searchResult frame that names no query, without calling any sink", () => {
    // A frame the state machine could not match to a submission; it must not
    // reach the graph either.
    const onEvent = vi.fn();
    const onSearchResult = vi.fn();
    const socket = connect(onEvent, { onSearchResult });

    expect(() =>
      socket.deliver(JSON.stringify({ kind: "searchResult", files: [] })),
    ).not.toThrow();

    expect(onSearchResult).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("routes a searchResult frame whose files list is junk, since files degrade", () => {
    const onEvent = vi.fn();
    const onSearchResult = vi.fn();
    const socket = connect(onEvent, { onSearchResult });

    socket.deliver(JSON.stringify({ kind: "searchResult", query: "x", files: "nope" }));

    expect(onSearchResult).toHaveBeenCalledTimes(1);
    expect((onSearchResult.mock.calls[0][0] as { files: unknown[] }).files).toEqual([]);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("survives a frame that is not an object at all", () => {
    const onEvent = vi.fn();
    const onSearchResult = vi.fn();
    const socket = connect(onEvent, { onSearchResult });

    expect(() => socket.deliver("[1,2,3]")).not.toThrow();
    expect(onEvent).not.toHaveBeenCalled();
    expect(onSearchResult).not.toHaveBeenCalled();
  });

  it("keeps delivering events after a malformed searchResult frame", () => {
    const onEvent = vi.fn();
    const onSearchResult = vi.fn();
    const socket = connect(onEvent, { onSearchResult });

    socket.deliver(JSON.stringify({ kind: "searchResult", query: 7, files: 3 }));
    socket.deliver(EVENT_FRAME);

    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

describe("WebSocket client: the frames that already worked keep working", () => {
  it("still routes a valid event to the event callback", () => {
    const onEvent = vi.fn();
    const onSearchResult = vi.fn();
    const socket = connect(onEvent, { onSearchResult });

    socket.deliver(EVENT_FRAME);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect((onEvent.mock.calls[0][0] as { path: string }).path).toBe("src/api/users.ts");
  });

  it.each([
    ["meta", "onMeta", META_FRAME],
    ["reset", "onReset", RESET_FRAME],
    ["completion", "onCompletion", COMPLETION_FRAME],
    ["rootError", "onRootError", ROOT_ERROR_FRAME],
    ["fileView", "onFileView", FILE_VIEW_FRAME],
    ["status", "onStatus", STATUS_FRAME],
  ])(
    "still routes a %s frame to its own sink, and never to onSearchResult",
    (_label, sinkName, frame) => {
      const onEvent = vi.fn();
      const onSearchResult = vi.fn();
      const sink = vi.fn();
      const socket = connect(onEvent, { onSearchResult, [sinkName]: sink });

      socket.deliver(frame);

      expect(sink).toHaveBeenCalledTimes(1);
      expect(onSearchResult).not.toHaveBeenCalled();
      expect(onEvent).not.toHaveBeenCalled();
    },
  );
});
