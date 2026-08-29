"""Contract tests (RED) for the session-stats counters on EventHub and Session.

Motivation: `rhizome_graph.session_stats` can count what it is handed, and
nothing hands it anything. This file is the wiring: which events reach the
counters, which deliberately do not, how the table gets onto the wire, and what a
root switch does to all of it.

Three fan-out sites carry every frame this daemon produces, and the shape of
them is the whole reason this feature is cheap:

  * `_publish` -- the write path, hook and watcher alike.
  * `_broadcast_transient` -- the read path.
  * `seed_paths` -- the boot snapshot, which builds its own message and touches
    neither of the other two.

So counters hung off the first two are counters the seed never reaches, and
**"the boot snapshot is not work" is a consequence of the existing shape rather
than a filter somebody has to remember to write.** That is the first test in this
file, deliberately: on this host's home directory the seed is 12 524 events, and
the implementation most likely to be written is one that hangs the counter off
`broadcast`, which would report 12 524 files touched by nobody in a session where
nothing has happened yet.

**`_observe` already exists.** The attention-rules feature created it for exactly
this reason, and both fan-out paths already go through it, so the seam does not
have to be cut again -- the counters hang off the one that is there. A second
hook point for one "here is an event" moment is how a later change ("reads should
not count", "deletions count double") lands in one of them and not the other, and
the symptom -- a total that is right for hook events and wrong for watcher events
-- is invisible in any single test. Section 5 is the guard on that.

The publishing half copies `_status` exactly, and the copy is not laziness:

  * **A replaceable slot, deduped on the ENCODED message**, because that is
    exactly what a client would receive. Here the dedupe fires constantly: an
    idle session republishes an identical table every five seconds forever.
  * **A poll in a task of its own, not a publish per event.** The counters update
    per event; the frame does not. A stats frame changes on *every* event, so a
    per-event publish would be a fresh `json.dumps` and a broadcast to every
    connected client for every keystroke of an agent's work.
  * **A place in `replay_messages()`**: after the status, before the seed. The
    reason is `replay_messages`'s own sentence one step further -- a per-agent
    summary painted before the caption is a table about a project the reader has
    not been told the name of, and one painted after the seed is a table arriving
    seconds late behind twenty thousand events.

The ordering assertion is by **index, not as an exact sequence** (the tester
review's correction, section 2.2 of the plan). `tests/test_hub_status.py` already
pins its own position that way, and there is no exact-sequence assertion on
`replay_messages()` anywhere in this suite: writing one here would pin the
freedom of three other planned frames -- the agent states and the attention
header already sit in that group -- for no additional safety, since what this
feature needs is only that the table follows the caption's group and precedes the
tree.

Style: Arrange-Act-Assert, one property per test.
"""

from __future__ import annotations

import ast
import asyncio
import contextlib
import inspect
import json
from pathlib import Path

import pytest
from websockets.asyncio.client import connect

import daemon.server as server
from daemon.server import EventHub, Session, start_server

ROOT = "/proj"
SESSION = "sess-abc"
SUBAGENT_ID = "a747fec535c143044"
SUBAGENT_TYPE = "developer-backend"

#: A lifecycle payload's event key, spelled as a literal exactly as
#: `tests/test_hub_agent_state.py` spells it and for its reason: it is an
#: assumption a real capture may correct, and this file must not fail on it.
EVENT_KEY = "hook_event_name"

#: What a table looks like on the wire. Written out here only as an argument to
#: `set_stats`; the shape itself is pinned in `tests/test_session_stats.py`,
#: which is the one place it is spelled in full.
EMPTY_TABLE = {"kind": "stats", "agents": []}

BUSY_TABLE = {
    "kind": "stats",
    "agents": [
        {
            "agent": SUBAGENT_ID,
            "label": SUBAGENT_TYPE,
            "writes": 3,
            "reads": 9,
            "files": 7,
            "dirs": 2,
            "topPath": "src/x.py",
            "topCount": 4,
            "firstTs": 1.0,
            "lastTs": 9.0,
            "truncated": False,
        }
    ],
}


def _hook(tool_name: str, file_path: str, **extra) -> str:
    payload: dict = {
        "session_id": SESSION,
        EVENT_KEY: "PostToolUse",
        "tool_name": tool_name,
        "tool_input": {"file_path": file_path},
    }
    payload.update(extra)
    return json.dumps(payload)


def _write(relative: str, **extra) -> str:
    return _hook("Write", f"{ROOT}/{relative}", **extra)


def _read(relative: str, **extra) -> str:
    return _hook("Read", f"{ROOT}/{relative}", **extra)


def _sent(hub: EventHub) -> list[dict]:
    """Every message a freshly connecting client would receive, in order."""
    return [json.loads(m) for m in hub.replay_messages()]


def _events(hub: EventHub) -> list[dict]:
    """The activity frames alone -- an event is the frame with no `kind`."""
    return [m for m in _sent(hub) if "kind" not in m]


def _kinds(hub: EventHub) -> list[str]:
    return [m.get("kind", "event") for m in _sent(hub)]


def _stats_frames(hub: EventHub) -> list[dict]:
    return [m for m in _sent(hub) if m.get("kind") == "stats"]


def _table(hub: EventHub) -> list[dict]:
    """What the hub's own counters currently say, as rows.

    Read through the counter's frame rather than through its internals: the
    frame is what the browser receives, so a test that agreed with the
    accumulator but not with the wire would be agreeing with the wrong thing.
    """
    return hub.stats.frame()["agents"]


def _row(hub: EventHub, agent: str) -> dict:
    rows = [row for row in _table(hub) if row["agent"] == agent]
    assert len(rows) == 1, (
        f"expected exactly one row for {agent!r}, found "
        f"{[row['agent'] for row in _table(hub)]}"
    )
    return rows[0]


def _run(coro):
    return asyncio.run(asyncio.wait_for(coro, timeout=30))


async def _publish_stats(session: Session) -> None:
    """Ask the session to publish its table, awaiting only if it needs it.

    Whether `publish_stats` is a coroutine is genuinely open: `publish_status` is
    one because it forks `git`, and this one has nothing to fork. The effect is
    what is specified here; the signature is the implementer's to choose, and a
    test that forced one would be specifying the shape of a decision instead of
    its outcome.
    """
    result = session.publish_stats()
    if inspect.isawaitable(result):
        await result


# --- 2.4 the boot snapshot is not work --------------------------------------
#
# Written first. Today nothing counts, so it does not construct; and once it
# does, the failure it guards against is not exotic -- `broadcast` is one line
# further out than `_observe` and looks like the tidier place to count from.


def test_five_hundred_seeded_paths_leave_the_counters_empty():
    """The seed is a backdrop, not activity. 12 524 of them on a home directory.

    Same sentence `web/src/attribution.ts` already carries about the connect-time
    snapshot: "an agent id riding on a seed frame proves nothing about capture".
    """
    hub = EventHub(project_root=ROOT)

    hub.seed_paths([f"src/mod{index}.py" for index in range(500)])

    assert _table(hub) == []


def test_a_seeded_tree_does_not_invent_an_unattributed_worker():
    """The row that would appear is the empty-agent one, and it would claim the
    whole project as work done in a session where nothing has happened."""
    hub = EventHub(project_root=ROOT)

    hub.seed_paths(["src/app.py", "README.md"])

    assert [row["agent"] for row in _table(hub)] == []


# --- 2.1 a hook event reaches the counters ----------------------------------


def test_a_hook_write_is_counted_against_the_agent_that_made_it():
    hub = EventHub(project_root=ROOT)

    hub.ingest_line(_write("src/app.py", agent_id=SUBAGENT_ID, agent_type=SUBAGENT_TYPE))

    row = _row(hub, SUBAGENT_ID)
    assert (row["writes"], row["files"]) == (1, 1)


def test_the_counted_row_carries_the_agents_readable_name():
    """`agent` is identity and `label` is only text -- both travel, neither is
    derived from the other."""
    hub = EventHub(project_root=ROOT)

    hub.ingest_line(_write("src/app.py", agent_id=SUBAGENT_ID, agent_type=SUBAGENT_TYPE))

    assert _row(hub, SUBAGENT_ID)["label"] == SUBAGENT_TYPE


def test_two_subagents_of_one_type_are_counted_as_two_workers():
    hub = EventHub(project_root=ROOT)

    hub.ingest_line(_write("src/a.py", agent_id="a1", agent_type=SUBAGENT_TYPE))
    hub.ingest_line(_write("src/b.py", agent_id="a2", agent_type=SUBAGENT_TYPE))

    assert sorted(row["agent"] for row in _table(hub)) == ["a1", "a2"]


def test_a_hook_call_that_draws_nothing_counts_nothing():
    """`Grep` yields no event, so there is nothing to count -- and the actor it
    refreshes is a separate fact that this table does not record."""
    hub = EventHub(project_root=ROOT)

    hub.ingest_line(_hook("Grep", f"{ROOT}/src/app.py", agent_id=SUBAGENT_ID))

    assert _table(hub) == []


# --- 2.2 a read reaches them too, and is still a read -----------------------


def test_a_read_is_counted_as_a_read():
    """The read path is `_broadcast_transient`, where the obvious implementation
    -- counting inside `_publish` alone -- never goes. And a read is the half of
    an agent's work this panel exists to show."""
    hub = EventHub(project_root=ROOT)

    hub.ingest_line(_read("src/app.py", agent_id=SUBAGENT_ID))

    row = _row(hub, SUBAGENT_ID)
    assert (row["reads"], row["writes"]) == (1, 0)


def test_a_counted_read_is_still_never_replayed():
    """Counting a read must not turn it into a fact about the project.

    Asserted through the replay, because what must not change is what a client
    connecting later is handed: a re-enactment of somebody's reading, in a finite
    ring the real changes would then be pushed out of.

    Green today, and honestly so: nothing counts yet, so nothing has moved the
    read onto the write path. It is a jaw rather than a RED -- the way to make a
    read reach the counters is to route it through `_publish`, and this is what
    stops that.
    """
    hub = EventHub(project_root=ROOT)

    hub.ingest_line(_read("src/app.py", agent_id=SUBAGENT_ID))

    assert _events(hub) == []


def test_a_counted_read_still_leaves_the_next_write_an_add():
    """The other half of "a read is not a change": `_known_paths` is untouched.

    Read-then-Edit is the commonest thing an agent does, so a read that marked
    the path as seen would draw the write that follows as a modification of a
    node no browser was ever shown. Green today, for the reason above, and a jaw
    on the same refactor.
    """
    hub = EventHub(project_root=ROOT)
    hub.ingest_line(_read("src/app.py", agent_id=SUBAGENT_ID))

    hub.ingest_line(_write("src/app.py", agent_id=SUBAGENT_ID))

    assert _events(hub)[-1]["type"] == "A"


# --- 2.3 a watcher change is counted for whoever owns it --------------------


def test_a_watcher_change_is_counted_for_the_agent_that_still_owns_it():
    """The watcher goes through `_publish` too, and carries the hook's actor."""
    hub = EventHub(project_root=ROOT)
    hub.ingest_line(_write("src/app.py", agent_id=SUBAGENT_ID, agent_type=SUBAGENT_TYPE))

    hub.ingest_fs_change("docs/guide.md", "M")

    assert _row(hub, SUBAGENT_ID)["writes"] == 2


def test_an_unattributed_watcher_change_is_counted_against_the_empty_agent():
    """`CLAUDE.md`'s "an event with `agent: \"\"` must never create an actor" is
    about a figure and a beam on the graph, not about a row in a table: a build
    step's writes are real work by nobody on camera, and dropping them makes the
    totals not add up."""
    hub = EventHub(project_root=ROOT)

    hub.ingest_fs_change("build/out.js", "M")

    assert _row(hub, "")["writes"] == 1


def test_a_directory_deletion_counts_every_file_it_took_with_it():
    """`_expand` turns one deletion into the files under it plus the directory,
    and the counters see what the wire sees -- one call site, one answer."""
    hub = EventHub(project_root=ROOT)
    hub.seed_paths(["src/a.py", "src/b.py"])

    hub.ingest_fs_change("src", "D")

    assert _row(hub, "")["writes"] == 3


# --- 2.5 / 3.3 a root switch forgets the project it was counting ------------


def test_a_reset_empties_the_counters():
    """The work belongs to a project nobody is watching any more."""
    hub = EventHub(project_root=ROOT)
    hub.ingest_line(_write("src/app.py", agent_id=SUBAGENT_ID))

    hub.reset("/srv/other")

    assert _table(hub) == []


def test_a_reset_drops_the_published_table_as_well_as_the_counters():
    """Two halves of one fact: a client connecting after the switch must not be
    replayed the old project's table while the new one is still being counted."""
    hub = EventHub(project_root=ROOT)
    hub.set_stats(BUSY_TABLE)

    hub.reset("/srv/other")

    assert _stats_frames(hub) == []


def test_a_table_identical_to_the_one_before_the_switch_is_still_published():
    """The dedupe must not outlive the reset, or a project whose numbers happen
    to match the previous one's is never announced at all."""
    hub = EventHub(project_root=ROOT)
    hub.set_stats(BUSY_TABLE)

    hub.reset("/srv/other")
    hub.set_stats(BUSY_TABLE)

    assert _stats_frames(hub) == [BUSY_TABLE]


# --- 3.1 the slot, and the dedupe on the encoded message --------------------


def test_a_new_client_is_handed_the_current_table():
    hub = EventHub(project_root=ROOT)

    hub.set_stats(BUSY_TABLE)

    assert _stats_frames(hub) == [BUSY_TABLE]


def test_before_any_table_there_is_none_in_the_replay():
    """Green today because there is no such frame at all; a jaw once there is.

    What it will then say is that seeding does not publish one: a table is
    published by its poll, and a client connecting during the boot walk must not
    be handed a summary of a project the daemon is still reading.
    """
    hub = EventHub(project_root=ROOT)
    hub.seed_paths(["src/app.py"])

    assert _stats_frames(hub) == []


def test_repeated_polls_leave_exactly_one_table_in_the_replay():
    """A slot, not a ring: republished every five seconds for the life of the
    session, appended it would eventually push the project's tree out."""
    hub = EventHub(project_root=ROOT)

    hub.set_stats(EMPTY_TABLE)
    hub.set_stats(BUSY_TABLE)

    assert _stats_frames(hub) == [BUSY_TABLE]


def test_the_table_goes_on_the_wire_compactly():
    """`separators=(",", ":")`, like every other republished frame here."""
    hub = EventHub(project_root=ROOT)

    hub.set_stats(BUSY_TABLE)

    raw = [m for m in hub.replay_messages() if '"stats"' in m][0]
    assert raw == json.dumps(BUSY_TABLE, separators=(",", ":"))


def test_the_table_is_not_confusable_with_an_event():
    hub = EventHub(project_root=ROOT)

    hub.set_stats(BUSY_TABLE)

    assert not {"ts", "type", "path", "color"} & set(_stats_frames(hub)[0])


async def _serve(hub: EventHub):
    listener = await start_server(hub, host="127.0.0.1", port=0, static_root=None)
    return listener, next(iter(listener.sockets)).getsockname()[1]


def test_a_table_reaches_a_client_already_on_screen():
    async def scenario():
        hub = EventHub(project_root=ROOT)
        listener, port = await _serve(hub)
        async with listener, connect(f"ws://127.0.0.1:{port}/ws") as ws:
            hub.set_stats(BUSY_TABLE)

            message = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))

            assert message == BUSY_TABLE

    _run(scenario())


def test_an_unchanged_table_is_not_rebroadcast():
    """The poll repeats the same answer every five seconds, for hours. The
    comparison is on the encoded message, not the dict, because that is exactly
    what a client would receive."""

    async def scenario():
        hub = EventHub(project_root=ROOT)
        listener, port = await _serve(hub)
        async with listener, connect(f"ws://127.0.0.1:{port}/ws") as ws:
            hub.set_stats(BUSY_TABLE)
            await asyncio.wait_for(ws.recv(), timeout=5)

            hub.set_stats(dict(BUSY_TABLE))  # same content, a different object
            hub.ingest_line(_write("marker.py"))  # a marker that must arrive next

            message = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))

            assert message.get("path") == "marker.py"

    _run(scenario())


# --- 3.2 where it sits in the replay ----------------------------------------


def test_the_table_follows_the_status_panel_and_precedes_the_tree():
    """By index, never as an exact sequence.

    The property is only that the summary arrives after the group that names the
    project it belongs to and before the tree it summarises -- a table painted
    ahead of the caption describes a project the reader has not been told the
    name of, and one painted behind twenty thousand seed events arrives seconds
    late on a graph that has already settled. Pinning the whole list as a
    sequence would additionally freeze the positions of the agent-state and
    attention frames, which belong to other features and buy nothing here.
    """
    hub = EventHub(project_root=ROOT)

    hub.set_meta("~/p", "main")
    hub.set_status({"kind": "status", "repo": True, "truncated": False, "entries": []})
    hub.set_stats(BUSY_TABLE)
    hub.seed_paths(["src/app.py"])

    kinds = _kinds(hub)
    assert kinds.index("status") < kinds.index("stats") < kinds.index("event")


def test_a_pending_reset_still_comes_before_the_table():
    """A client connecting mid-switch clears before it is handed anything."""
    hub = EventHub(project_root=ROOT)

    hub.reset("/srv/other")
    hub.set_stats(BUSY_TABLE)

    assert _kinds(hub)[0] == "reset"


def test_the_table_does_not_consume_the_recent_event_buffer():
    hub = EventHub(project_root=ROOT, buffer_size=2)
    hub.ingest_line(_write("notes.md"))

    for count in range(5):
        hub.set_stats({**BUSY_TABLE, "agents": [{"agent": f"a{count}"}]})

    assert [m["path"] for m in _events(hub)] == ["notes.md"]


# --- 5. one call site for one policy, over the parsed source ----------------
#
# `_observe` already exists -- the attention rules created it -- and the counters
# hang off it rather than beside it. Two hook points for one "here is an event"
# moment is how a later change lands in one of them and not the other, and the
# symptom is a total that is right for hook events and wrong for watcher events,
# or right for writes and wrong for reads: a bug nobody would find by reading
# either site.

#: The name that means "the counters were offered this event". The accumulator's
#: own method, so `self._stats.observe(event)` and `self.stats.observe(event)`
#: both count however the field ends up being spelled.
COUNTING_NAME = "observe"

#: The one method of the hub that may offer, and the two that must go through it.
OBSERVER = "_observe"
FAN_OUT = ("_publish", "_broadcast_transient")


def _hub_methods() -> dict[str, ast.AST]:
    """Every method of `EventHub`, by name, from the parsed source.

    Scoped to the class rather than to the file, exactly as
    `tests/test_hub_attention.py` scopes the same assertion: `completion_response`
    at module level has a local of its own, and a file-wide scan reads as
    satisfied by the wrong function.
    """
    tree = ast.parse(Path(server.__file__).read_text(encoding="utf-8"))
    hub = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "EventHub"
    )
    return {
        node.name: node
        for node in ast.walk(hub)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _names_used(node: ast.AST) -> set[str]:
    """Identifiers used inside one function: bare names and attributes alike.

    Identifiers rather than raw text, so a docstring explaining this rule does
    not satisfy it.
    """
    used: set[str] = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Name):
            used.add(child.id)
        elif isinstance(child, ast.Attribute):
            used.add(child.attr)
    return used


def test_exactly_one_method_of_the_hub_offers_an_event_to_the_counters():
    offerers = sorted(
        name
        for name, node in _hub_methods().items()
        if COUNTING_NAME in _names_used(node)
    )

    assert offerers == [OBSERVER], (
        f"{offerers or 'no method of EventHub'} offers events to the counters; "
        f"they belong on {OBSERVER}, which both fan-out paths already share, and "
        "nowhere else."
    )


def test_the_seed_does_not_reach_the_counters_through_any_method():
    """The exemption is structural, and this is the guard on the refactor.

    Green today: the attention rules already put both fan-out paths through
    `_observe` and left `seed_paths` off it. It is restated here because the
    property this feature depends on is that same one, and a later "route the
    seed through it for consistency" would break both features at once.
    """
    functions = _hub_methods()
    callers = sorted(
        name
        for name, node in functions.items()
        if name != OBSERVER and OBSERVER in _names_used(node)
    )

    assert callers == sorted(FAN_OUT), (
        f"{OBSERVER} is called by {callers}. It exists for the two fan-out paths "
        "and nothing else: `seed_paths` asking it would count 12 524 files as "
        "work on a fresh home directory."
    )


# --- 6. Session: who publishes, how often -----------------------------------


@pytest.fixture
def make_session(monkeypatch: pytest.MonkeyPatch):
    """Sessions whose watcher threads are stopped, and which fork no `git`."""

    async def _no_status(_root):
        return None

    monkeypatch.setattr(server, "git_status", _no_status, raising=False)
    made: list[Session] = []

    def _make(project_root: Path) -> Session:
        session = Session(project_root=str(project_root), home=str(project_root))
        made.append(session)
        return session

    yield _make

    for session in made:
        with contextlib.suppress(Exception):
            session.stop()


def test_publishing_puts_the_hubs_own_counters_in_the_replay(
    tmp_path: Path, make_session
):
    """The session publishes what the hub counted; it counts nothing itself."""

    async def scenario():
        session = make_session(tmp_path)
        session.hub.ingest_line(
            _write("src/app.py", agent_id=SUBAGENT_ID, agent_type=SUBAGENT_TYPE)
        )

        await _publish_stats(session)

        frames = _stats_frames(session.hub)
        assert frames and frames[-1] == session.hub.stats.frame()

    _run(scenario())


def test_a_session_that_counted_nothing_still_publishes_an_empty_table(
    tmp_path: Path, make_session
):
    """An empty table is a fact -- "nobody has done anything yet" -- and the
    panel's own visibility rule is what decides whether it is drawn."""

    async def scenario():
        session = make_session(tmp_path)

        await _publish_stats(session)

        assert _stats_frames(session.hub) == [{"kind": "stats", "agents": []}]

    _run(scenario())


def test_the_poll_keeps_republishing_the_table(tmp_path: Path, make_session):
    async def scenario():
        session = make_session(tmp_path)
        poll = asyncio.create_task(session.poll_stats(interval=0.01))
        await asyncio.sleep(0.05)

        session.hub.ingest_line(_write("src/app.py", agent_id=SUBAGENT_ID))
        await asyncio.sleep(0.1)
        poll.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await poll

        assert [row["agent"] for row in _stats_frames(session.hub)[-1]["agents"]] == [
            SUBAGENT_ID
        ]

    _run(scenario())


def test_the_poll_starts_no_round_while_one_is_still_in_flight(
    tmp_path: Path, make_session
):
    """`poll_status`'s own rule, copied along with the shape.

    Nothing the publisher does today can outlast a tick -- it reads a dict and
    encodes it -- so the flag is set by hand here rather than by inventing a
    concurrency this code cannot currently produce. That is deliberate: the guard
    is a jaw for the day the publisher grows an await (a table built off the loop,
    a figure that has to be measured), and a poll without it would stack a round
    per tick the first time that happened.
    """

    async def scenario():
        session = make_session(tmp_path)
        session.hub.ingest_line(_write("src/app.py", agent_id=SUBAGENT_ID))
        session._stats_busy = True

        poll = asyncio.create_task(session.poll_stats(interval=0.01))
        await asyncio.sleep(0.1)
        poll.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await poll

        assert _stats_frames(session.hub) == []

    _run(scenario())


def test_the_stats_are_polled_every_five_seconds():
    """Slower than the status panel's three: this is a summary, and nothing in
    it is clickable, so staleness costs nothing."""
    assert getattr(server, "STATS_POLL_INTERVAL_SECONDS", None) == 5.0
