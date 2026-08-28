/**
 * Contract tests (RED) for the `agentState` frame and its route in the client.
 *
 * The defect this file exists for is a SILENT one, which is why the routing half
 * has to be asserted on the sink rather than on the graph. `protocol.ts` has
 * eight parsers and `wsClient.handleMessage` eight routes; a per-agent frame
 * arriving today falls through every one of them to `parseEvent`, which IGNORES
 * `kind` (src/protocol.ts:102-127). Ours carries no `ts`/`agent`/`type`/`path`/
 * `color` at the top level, so `parseEvent` answers `null` and the frame is
 * dropped with nothing logged anywhere: the feature would simply do nothing, on
 * a page that looks healthy. A test asserting "the graph is unchanged" passes
 * over exactly that failure, so every routing test below asserts that the
 * agent-state sink was CALLED.
 *
 * The parsing half copies `parseSizes`'s degradation doctrine (src/protocol.ts:
 * 374-419, :453-479) one for one, because a frame about actors has the same
 * shape of risk as a frame about sizes:
 *
 *  - `kind` must be exactly `"agentState"`, load-bearing in both directions: an
 *    answer about actors routed as activity would grow a node called
 *    "agentState" in the tree, and an activity event mistaken for an answer
 *    would repaint every figure on the page from one file save.
 *  - `agents` DEGRADES the way `entries` and `files` do: absent, `null` or
 *    mistyped becomes `[]` with the frame SURVIVING, and a junk item is dropped
 *    ONE AT A TIME. A frame with no agents is a real answer -- nobody is
 *    waiting, everyone has left -- and dropping it would leave the last
 *    picture's rings latched on figures the daemon has stopped reporting.
 *  - An entry needs a string `agent` (it is the identity the whole model is
 *    keyed on) and a finite `ts` (staleness is computed from it, and a `NaN`
 *    compares false against every cut, so the entry would be neither fresh nor
 *    stale). Either one missing drops that entry ALONE.
 *  - A string is not enough for `agent`: it has to be USABLE text. `CLAUDE.md`
 *    states the rule for the whole program -- an event with `agent: ""` must
 *    never create an actor -- and `typeof agent === "string"` admits `""`
 *    straight into the model as a key, where a `waiting` earns a ring on a
 *    figure nobody is behind. Blank goes with it: `normalize._usable_text`
 *    strips before it answers, so the daemon cannot name a blank agent and a
 *    page that accepted one would hold a key nothing else could produce. This
 *    is the parser's business alone -- `agentState.ts` renames the wire's words
 *    and deliberately re-validates nothing, so a second rule there would be a
 *    second definition of identity, free to drift from this one.
 *  - An unrecognised `state` degrades to `"working"` rather than dropping the
 *    entry: a daemon one version newer naming a fourth phase still tells the
 *    truth about who that agent IS and when it was last heard from.
 *  - `label` and `caption` are display text and degrade to `""`. `caption` is
 *    declared by this plan and filled by the sibling todo-caption plan, so the
 *    assertion below is written now and must stay true when it is filled.
 *  - NEVER throws: this comes off the network.
 *
 * Expected to FAIL until `parseAgentStates` exists in src/protocol.ts and
 * `handleMessage` routes the frame BEFORE `parseEvent`.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { parseAgentStates } from "../src/protocol";
import { createWsClient } from "../src/wsClient";

/** A well-formed entry, as the daemon spells it on the wire. */
function wireEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: "agent-1",
    label: "developer-backend",
    state: "working",
    caption: "",
    ts: 1754870400.5,
    ...overrides,
  };
}

/** A well-formed frame carrying the given raw entries. */
function wireFrame(agents: unknown): Record<string, unknown> {
  return { kind: "agentState", agents };
}

describe("parseAgentStates: the frame", () => {
  it("parses a well-formed frame, keeping the entries in the order the daemon sent them", () => {
    // Order is the daemon's statement about its own actors; re-sorting here
    // would be a second opinion held by the parser.
    const frame = parseAgentStates(
      wireFrame([
        wireEntry({ agent: "a-1", label: "developer-backend", state: "waiting", ts: 10 }),
        wireEntry({ agent: "a-2", label: "developer-tester", state: "stopped", ts: 11 }),
        wireEntry({ agent: "a-3", label: "", state: "working", ts: 12 }),
      ]),
    );

    expect(frame).toEqual({
      agents: [
        { agent: "a-1", label: "developer-backend", state: "waiting", caption: "", ts: 10 },
        { agent: "a-2", label: "developer-tester", state: "stopped", caption: "", ts: 11 },
        { agent: "a-3", label: "", state: "working", caption: "", ts: 12 },
      ],
    });
  });

  it("refuses a frame whose kind is not agentState, so no other frame can repaint the figures", () => {
    expect(parseAgentStates({ kind: "status", agents: [wireEntry()] })).toBeNull();
    expect(parseAgentStates({ kind: "sizes", agents: [wireEntry()] })).toBeNull();
    expect(parseAgentStates({ agents: [wireEntry()] })).toBeNull();
    expect(parseAgentStates({ kind: "agentstate", agents: [wireEntry()] })).toBeNull();
  });

  it("refuses a value that is not an object at all", () => {
    expect(parseAgentStates(null)).toBeNull();
    expect(parseAgentStates(undefined)).toBeNull();
    expect(parseAgentStates("agentState")).toBeNull();
    expect(parseAgentStates(7)).toBeNull();
    expect(parseAgentStates([wireEntry()])).toBeNull();
  });
});

describe("parseAgentStates: the agents list degrades, and the frame survives", () => {
  it("answers an empty list, not null, when the frame names no agents at all", () => {
    // A real answer: nobody is waiting and nobody has left. Dropping it would
    // leave the previous picture's rings latched on screen forever.
    expect(parseAgentStates({ kind: "agentState" })).toEqual({ agents: [] });
  });

  it("degrades a null agents field to an empty list and keeps the frame", () => {
    expect(parseAgentStates(wireFrame(null))).toEqual({ agents: [] });
  });

  it("degrades a string agents field to an empty list and keeps the frame", () => {
    expect(parseAgentStates(wireFrame("developer-backend"))).toEqual({ agents: [] });
  });

  it("drops a junk item while the entries either side of it survive", () => {
    const frame = parseAgentStates(
      wireFrame([wireEntry({ agent: "a-1" }), "not an object", wireEntry({ agent: "a-2" })]),
    );

    expect(frame?.agents.map((entry) => entry.agent)).toEqual(["a-1", "a-2"]);
  });

  it("drops only the entry whose agent is not a string, because agent is the identity", () => {
    const frame = parseAgentStates(
      wireFrame([
        wireEntry({ agent: 42 }),
        wireEntry({ agent: null }),
        wireEntry({ label: "developer-frontend" }),
      ]),
    );

    expect(frame?.agents).toHaveLength(1);
    expect(frame?.agents[0].label).toBe("developer-frontend");
  });

  it("drops only the entry whose agent is empty, because an empty agent never creates an actor", () => {
    // `CLAUDE.md` states the rule outright: an event with `agent: ""` must never
    // create an actor -- seeded files and unattributed changes are real, but
    // nobody did them on camera. `typeof agent === "string"` admits `""`, which
    // enters the model under an empty key and, if it says `waiting`, earns a
    // ring on a figure nobody is behind. The daemon does not send one today;
    // this parser is where that guarantee stops, because what arrives here came
    // off the network.
    const frame = parseAgentStates(
      wireFrame([
        wireEntry({ agent: "a-1" }),
        wireEntry({ agent: "" }),
        wireEntry({ agent: "a-2" }),
      ]),
    );

    expect(frame?.agents.map((entry) => entry.agent)).toEqual(["a-1", "a-2"]);
  });

  it("drops only the entry whose agent is blank, the same way the daemon refuses one", () => {
    // The same question, one step out: `normalize._usable_text` strips before it
    // answers, so an `agent_id` of spaces is already `""` by the time `actor_of`
    // returns and the daemon can never name a blank agent. A page that accepted
    // one would hold an actor key nothing else on it could ever produce.
    const frame = parseAgentStates(
      wireFrame([
        wireEntry({ agent: "   " }),
        wireEntry({ agent: "\t\n" }),
        wireEntry({ agent: "a-2" }),
      ]),
    );

    expect(frame?.agents.map((entry) => entry.agent)).toEqual(["a-2"]);
  });

  it("drops only the entry whose ts is not finite, because staleness is computed from it", () => {
    // A NaN age compares false against every cut, so such an entry would be
    // neither fresh nor stale -- a ring nothing can ever retire.
    const frame = parseAgentStates(
      wireFrame([
        wireEntry({ agent: "nan", ts: Number.NaN }),
        wireEntry({ agent: "infinite", ts: Number.POSITIVE_INFINITY }),
        wireEntry({ agent: "text", ts: "1754870400" }),
        wireEntry({ agent: "missing", ts: undefined }),
        wireEntry({ agent: "good", ts: 1754870400 }),
      ]),
    );

    expect(frame?.agents.map((entry) => entry.agent)).toEqual(["good"]);
  });
});

describe("parseAgentStates: a field the page cannot read costs the field, never the entry", () => {
  it("degrades an unrecognised state to working, because the agent and its ts are still true", () => {
    const frame = parseAgentStates(
      wireFrame([
        wireEntry({ agent: "a-1", state: "compacting" }),
        wireEntry({ agent: "a-2", state: 3 }),
        wireEntry({ agent: "a-3", state: undefined }),
        wireEntry({ agent: "a-4", state: "WAITING" }),
      ]),
    );

    expect(frame?.agents.map((entry) => entry.agent)).toEqual(["a-1", "a-2", "a-3", "a-4"]);
    expect(frame?.agents.map((entry) => entry.state)).toEqual([
      "working",
      "working",
      "working",
      "working",
    ]);
  });

  it("keeps the three states it does recognise", () => {
    const frame = parseAgentStates(
      wireFrame([
        wireEntry({ agent: "a-1", state: "working" }),
        wireEntry({ agent: "a-2", state: "waiting" }),
        wireEntry({ agent: "a-3", state: "stopped" }),
      ]),
    );

    expect(frame?.agents.map((entry) => entry.state)).toEqual(["working", "waiting", "stopped"]);
  });

  it("degrades an absent label to the empty string, which is the orchestrator's real case", () => {
    const frame = parseAgentStates(
      wireFrame([wireEntry({ agent: "a-1", label: undefined }), wireEntry({ agent: "a-2", label: 9 })]),
    );

    expect(frame?.agents.map((entry) => entry.label)).toEqual(["", ""]);
  });

  it("degrades an absent caption to the empty string, so the field costs nothing until it is filled", () => {
    // `caption` is declared by this plan and filled by the sibling todo-caption
    // plan. This assertion is written now and must stay true when it is filled:
    // a daemon that does not send one must not cost the page its figures.
    const frame = parseAgentStates(
      wireFrame([
        wireEntry({ agent: "a-1", caption: undefined }),
        wireEntry({ agent: "a-2", caption: { text: "3 of 7 done" } }),
      ]),
    );

    expect(frame?.agents.map((entry) => entry.caption)).toEqual(["", ""]);
  });

  it("keeps a caption the daemon did send", () => {
    const frame = parseAgentStates(wireFrame([wireEntry({ caption: "needs permission" })]));

    expect(frame?.agents[0].caption).toBe("needs permission");
  });

  it("never throws on garbage from the network", () => {
    expect(() =>
      parseAgentStates({
        kind: "agentState",
        agents: [null, [], 0, "", { agent: {} }, { agent: "a", ts: {} }],
      }),
    ).not.toThrow();
  });
});

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
  const client = createWsClient(onEvent as never, "ws://localhost:8080/ws", options as never);
  client.connect();
  const socket = FakeSocket.last;
  if (!socket) throw new Error("client did not open a socket");
  return socket;
}

const AGENT_STATE_FRAME = JSON.stringify({
  kind: "agentState",
  agents: [
    { agent: "a-1", label: "developer-backend", state: "waiting", caption: "", ts: 10 },
    { agent: "a-2", label: "developer-tester", state: "working", caption: "", ts: 11 },
  ],
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

const STATUS_FRAME = JSON.stringify({
  kind: "status",
  repo: true,
  truncated: false,
  entries: [{ path: "web/src/renderer.ts", state: "modified" }],
});

const SIZES_FRAME = JSON.stringify({
  kind: "sizes",
  files: [{ path: "web/src/renderer.ts", bytes: 61000 }],
  truncated: false,
  error: "",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebSocket client: agentState frame routing", () => {
  it("hands an agentState frame to the agent-state callback, parsed", () => {
    const onEvent = vi.fn();
    const onAgentStates = vi.fn();
    const socket = connect(onEvent, { onAgentStates });

    socket.deliver(AGENT_STATE_FRAME);

    expect(onAgentStates).toHaveBeenCalledTimes(1);
    expect(onAgentStates).toHaveBeenCalledWith({
      agents: [
        { agent: "a-1", label: "developer-backend", state: "waiting", caption: "", ts: 10 },
        { agent: "a-2", label: "developer-tester", state: "working", caption: "", ts: 11 },
      ],
    });
  });

  it("never feeds an agentState frame to the event callback", () => {
    // The route has to sit ABOVE `parseEvent`, which ignores `kind`. Today the
    // frame reaches it, is answered `null`, and vanishes with nothing logged --
    // so this assertion alone would pass over a feature that does nothing. The
    // one above, that the sink was called, is what makes the pair meaningful.
    const onEvent = vi.fn();
    const onAgentStates = vi.fn();
    const socket = connect(onEvent, { onAgentStates });

    socket.deliver(AGENT_STATE_FRAME);

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("never feeds an activity event to the agent-state callback", () => {
    const onEvent = vi.fn();
    const onAgentStates = vi.fn();
    const socket = connect(onEvent, { onAgentStates });

    socket.deliver(EVENT_FRAME);

    expect(onAgentStates).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("consumes an agentState frame in silence when no agent-state callback was given", () => {
    // An old page against a new daemon. An exception in `onmessage` would kill
    // the frame handler for every event after it.
    const onEvent = vi.fn();
    const socket = connect(onEvent);

    expect(() => socket.deliver(AGENT_STATE_FRAME)).not.toThrow();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("keeps delivering events after an agentState frame with no callback", () => {
    const onEvent = vi.fn();
    const socket = connect(onEvent);

    socket.deliver(AGENT_STATE_FRAME);
    socket.deliver(EVENT_FRAME);

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("keeps delivering events after a malformed agentState frame", () => {
    const onEvent = vi.fn();
    const onAgentStates = vi.fn();
    const socket = connect(onEvent, { onAgentStates });

    socket.deliver(JSON.stringify({ kind: "agentState", agents: 7 }));
    socket.deliver(EVENT_FRAME);

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["meta", "onMeta", META_FRAME],
    ["reset", "onReset", RESET_FRAME],
    ["status", "onStatus", STATUS_FRAME],
    ["sizes", "onSizes", SIZES_FRAME],
  ])(
    "still routes a %s frame to its own sink, and never to the agent-state one",
    (_label, sinkName, frame) => {
      const onEvent = vi.fn();
      const onAgentStates = vi.fn();
      const sink = vi.fn();
      const socket = connect(onEvent, { onAgentStates, [sinkName]: sink });

      socket.deliver(frame);

      expect(sink).toHaveBeenCalledTimes(1);
      expect(onAgentStates).not.toHaveBeenCalled();
      expect(onEvent).not.toHaveBeenCalled();
    },
  );
});
