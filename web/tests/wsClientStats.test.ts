/**
 * Contract tests (RED) for stats/event routing in the WebSocket client.
 *
 * The session-stats table is a tenth kind of frame on the one socket the daemon
 * broadcasts on, and the client is the only place that sees all of them -- so it
 * is the only place that can misroute one.
 *
 * **HALF OF THIS IS GREEN BY ACCIDENT TODAY, AND SAYING SO IS THE POINT.** With
 * no routing branch a `stats` frame falls through to `parseEvent`, which rejects
 * it -- but only because it carries no `ts`, `agent`, `type`, `path` or `color`.
 * `parseEvent` ignores `kind` entirely. So "a stats frame never reaches the
 * event sink" is not a property the client has; it is a coincidence of the
 * fields this frame happens not to have, and the coincidence evaporates the
 * first time the frame gains a path-like field -- a `topPath` hoisted to the top
 * level, a `root`, anything. The RED here is therefore the SINK CALL: the frame
 * must reach `onStats`, which is a thing nothing does today.
 *
 * **The branch's position is asserted, not assumed.** A routing branch placed
 * AFTER `parseEvent` would pass every "the frame reaches onStats" test written
 * with a clean frame, and would still let a hybrid frame become a node in the
 * graph. So the position is pinned the only way a black-box test can pin it: by
 * delivering a frame that is a valid `stats` frame AND a valid event at the same
 * time, and requiring the stats branch to win. It sits with the other answer
 * frames -- meta, reset, completion, rootError, fileView, status, searchResult,
 * sizes, agentState, attention -- and before `parseEvent`, for the reason
 * `wsClient.ts` already states about `status`: routed as an event it would grow
 * a node called "stats" in the graph, and the poll repeats every few seconds,
 * keeping it there forever.
 *
 * Two compatibility constraints matter as much as the routing, exactly as for
 * `onMeta` and `onStatus`: `createWsClient(onEvent, url)` must keep compiling
 * and working, and a stats frame arriving at a client given no stats callback
 * must be consumed IN SILENCE -- an old page against a new daemon, where an
 * exception in `onmessage` would kill the frame handler for every event after
 * it.
 *
 * `onStats` and the existing `onStatus` are one letter apart in one options
 * object, which is a real hazard rather than a naming quibble; the two
 * cross-tests below are the guard on it.
 *
 * Signature fixed by these tests (for the implementer):
 *   WsClientOptions gains `onStats?: (frame: SessionStatsFrame) => void`
 * i.e. the sink rides in the SAME options object, no positional argument added
 * or reordered.
 *
 * Expected to FAIL until the client parses and routes stats frames.
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

const STATS_ROW = {
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
};

const STATS_FRAME = JSON.stringify({ kind: "stats", agents: [STATS_ROW] });

const EMPTY_STATS_FRAME = JSON.stringify({ kind: "stats", agents: [] });

/**
 * A frame that is a valid `stats` table AND a valid activity event.
 *
 * The daemon does not send this and is not expected to. It exists to make the
 * branch's POSITION observable from outside: with the stats branch above
 * `parseEvent` the table wins and the graph never hears about it; below it, or
 * missing, this grows a node in the graph.
 */
const HYBRID_FRAME = JSON.stringify({
  kind: "stats",
  agents: [STATS_ROW],
  ts: 1754870400.5,
  agent: "sess-abc",
  type: "M",
  path: "src/api/users.ts",
  color: "FFAA00",
});

const EVENT_FRAME = JSON.stringify({
  ts: 1754870400.5,
  agent: "sess-abc",
  type: "M",
  path: "src/api/users.ts",
  color: "FFAA00",
});

const STATUS_FRAME = JSON.stringify({
  kind: "status",
  repo: true,
  truncated: false,
  entries: [{ path: "web/src/renderer.ts", state: "modified" }],
});

const META_FRAME = JSON.stringify({
  kind: "meta",
  root: "~/projects/rhizome-graph",
  branch: "development",
});

const RESET_FRAME = JSON.stringify({ kind: "reset", root: "/home/brn/projects/other" });

const FILE_VIEW_FRAME = JSON.stringify({
  kind: "fileView",
  path: "web/src/renderer.ts",
  mode: "diff",
  content: "@@ -1,3 +1,4 @@\n",
  truncated: false,
  error: "",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebSocket client: the stats frame reaches its own sink", () => {
  it("hands a stats frame to the stats callback, parsed", () => {
    // THE RED. Nothing routes this frame today, so the sink is never called --
    // the other half of this file (that it does not become a node) is green by
    // accident and proves nothing on its own.
    const onEvent = vi.fn();
    const onStats = vi.fn();
    const socket = connect(onEvent, { onStats });

    socket.deliver(STATS_FRAME);

    expect(onStats).toHaveBeenCalledTimes(1);
    expect(onStats).toHaveBeenCalledWith({ agents: [STATS_ROW] });
  });

  it("delivers an empty table, which is how a quiet session is reported", () => {
    const onEvent = vi.fn();
    const onStats = vi.fn();
    const socket = connect(onEvent, { onStats });

    socket.deliver(EMPTY_STATS_FRAME);

    expect(onStats).toHaveBeenCalledWith({ agents: [] });
  });
});

describe("WebSocket client: the stats branch sits above parseEvent", () => {
  it("routes a frame that is both a table and an event to the stats sink", () => {
    // The position test. A branch placed below `parseEvent` sends this to the
    // graph instead, and every clean-frame test above stays green.
    const onEvent = vi.fn();
    const onStats = vi.fn();
    const socket = connect(onEvent, { onStats });

    socket.deliver(HYBRID_FRAME);

    expect(onStats).toHaveBeenCalledTimes(1);
  });

  it("never grows a node out of a frame that is both a table and an event", () => {
    // `parseEvent` ignores `kind`, so only the ORDERING keeps this frame out of
    // the simulation. Routed as activity it would flash a file the table merely
    // mentions, and the 5 s poll would put it back forever.
    const onEvent = vi.fn();
    const onStats = vi.fn();
    const socket = connect(onEvent, { onStats });

    socket.deliver(HYBRID_FRAME);

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("consumes the hybrid frame with no stats callback at all, rather than passing it on", () => {
    // The old-page case, which is where a missing branch does its damage: an
    // absent sink must mean "dropped", never "handed to the graph instead".
    const onEvent = vi.fn();
    const socket = connect(onEvent);

    socket.deliver(HYBRID_FRAME);

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("does not feed a plain stats frame to the event callback", () => {
    // Green today by accident: `parseEvent` rejects it only for lacking
    // ts/agent/type/path/color. Kept as the statement of the property.
    const onEvent = vi.fn();
    const onStats = vi.fn();
    const socket = connect(onEvent, { onStats });

    socket.deliver(STATS_FRAME);

    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("WebSocket client: stats and status are one letter apart", () => {
  it("does not feed a status frame to the stats callback", () => {
    const onEvent = vi.fn();
    const onStats = vi.fn();
    const onStatus = vi.fn();
    const socket = connect(onEvent, { onStats, onStatus });

    socket.deliver(STATUS_FRAME);

    expect(onStats).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it("does not feed a stats frame to the status callback", () => {
    const onEvent = vi.fn();
    const onStats = vi.fn();
    const onStatus = vi.fn();
    const socket = connect(onEvent, { onStats, onStatus });

    socket.deliver(STATS_FRAME);

    expect(onStatus).not.toHaveBeenCalled();
    expect(onStats).toHaveBeenCalledTimes(1);
  });

  it("does not feed an activity event to the stats callback", () => {
    const onEvent = vi.fn();
    const onStats = vi.fn();
    const socket = connect(onEvent, { onStats });

    socket.deliver(EVENT_FRAME);

    expect(onStats).not.toHaveBeenCalled();
  });
});

describe("WebSocket client: an old page against a new daemon", () => {
  it("consumes a stats frame in silence when no stats callback was given", () => {
    const onEvent = vi.fn();
    const socket = connect(onEvent);

    expect(() => socket.deliver(STATS_FRAME)).not.toThrow();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("keeps delivering events after a stats frame with no stats callback", () => {
    const onEvent = vi.fn();
    const socket = connect(onEvent);

    socket.deliver(STATS_FRAME);
    socket.deliver(EVENT_FRAME);

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("drops a malformed stats frame without calling any sink", () => {
    const onEvent = vi.fn();
    const onStats = vi.fn();
    const onMeta = vi.fn();
    const socket = connect(onEvent, { onStats, onMeta });

    expect(() =>
      socket.deliver(JSON.stringify({ kind: "stats", agents: "not a list" })),
    ).not.toThrow();

    // `agents` is the hard field, so this is not a stats frame at all; what
    // must never happen is it reaching the graph or the HUD's caption.
    expect(onEvent).not.toHaveBeenCalled();
    expect(onMeta).not.toHaveBeenCalled();
  });

  it("keeps delivering events after a malformed stats frame", () => {
    const onEvent = vi.fn();
    const onStats = vi.fn();
    const socket = connect(onEvent, { onStats });

    socket.deliver(JSON.stringify({ kind: "stats", agents: 7 }));
    socket.deliver(EVENT_FRAME);

    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

describe("WebSocket client: the frames that already worked keep working", () => {
  it("still routes a valid event to the event callback", () => {
    const onEvent = vi.fn();
    const onStats = vi.fn();
    const socket = connect(onEvent, { onStats });

    socket.deliver(EVENT_FRAME);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect((onEvent.mock.calls[0][0] as { path: string }).path).toBe("src/api/users.ts");
  });

  it.each([
    ["meta", "onMeta", META_FRAME],
    ["reset", "onReset", RESET_FRAME],
    ["fileView", "onFileView", FILE_VIEW_FRAME],
    ["status", "onStatus", STATUS_FRAME],
  ])("still routes a %s frame to its own sink, and never to onStats", (_label, sinkName, frame) => {
    const onEvent = vi.fn();
    const onStats = vi.fn();
    const sink = vi.fn();
    const socket = connect(onEvent, { onStats, [sinkName]: sink });

    socket.deliver(frame);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(onStats).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });
});
