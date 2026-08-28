"""Contract tests (RED) for what EventHub does with a payload that is not a tool call.

Two defects, one file, because they are the same seam read from both sides.

**1. A payload that is not a tool call already decides who the watcher's next
change belongs to.** `ingest_line` runs `actor_of(payload)` and stamps
`_last_hook` *before* it knows what the payload is, and `_active_agent` then hands
that actor to every filesystem change for `ATTRIBUTION_WINDOW_SECONDS`. That is
correct today, because the only payloads that arrive are tool calls -- the comment
above it explains exactly why a glob-expanding `cp` must still stamp it. It stops
being correct the moment a lifecycle matcher is installed, and it fails in the
worst available direction: **the agent that is blocked waiting for a human becomes
the author of whatever changes on disk in the next five seconds**, which is very
likely the editor of the human who is at that moment reading the prompt. A
confidently wrong actor is worse than the empty one the watcher would carry.

The decision belongs in a pure `refreshes_actor(payload) -> bool` in
`rhizome_graph/normalize.py` -- beside `actor_of`, which the ingest loop already
shares with the normalizer -- and never in the socket loop. It is keyed on
`tool_name` rather than on the event name so that it degrades correctly if a
payload shape turns out not to carry one.

**2. The hub has no slot for a fact about an actor.** A lifecycle fact names no
path, so it has nothing to say to `known_paths`, nothing for the watcher to echo,
and nothing worth replaying as a change -- one step further out than a read, whose
whole argument `_broadcast_transient`'s docstring already spells. But it is a
*standing* fact rather than a flash: a client connecting one second after the
notification must be told, or it draws a working figure over a blocked agent and
stays wrong until the agent unblocks. So the mechanism is `set_status`'s, not
`_broadcast_transient`'s: one replaceable slot, deduped on the encoded message
because that is exactly what a client receives, replayed in a fixed place.

Where it goes in the replay is an argument, not a list: clear the canvas, caption
the project, then the things *about* the project, then the tree. An agent state is
a thing about the project's actors and is smaller and more perishable than the
tree, so it sits with the status panel and before the seed. It cannot go after the
seed -- `register` sends the replay in order and the client draws as it arrives, so
a ring behind twenty thousand seed events appears seconds late on a graph that has
already settled.

**On the event names spelled below.** Nothing in this repository has ever captured
a `Notification`, a `Stop` or a `SubagentStop` payload, so the three names and the
key they sit under are constants of `rhizome_graph.agentstate` that a real trace
may correct. They are spelled here as literals for one reason: written as imports,
every test in this file would report `ModuleNotFoundError` and say nothing at all
about the hub, which is the behaviour this file exists to specify.
`test_this_file_spells_the_event_names_the_classifier_spells` is the single point
that binds the two, and correcting a captured name is an edit to that test alone.

Style: Arrange-Act-Assert, one property per test.
"""

from __future__ import annotations

import asyncio
import importlib
import json
from typing import Callable

import pytest
from websockets.asyncio.client import connect

from daemon.server import EventHub, start_server

ROOT = "/proj"
SESSION = "sess-abc"
SUBAGENT_A = "a747fec535c143044"
SUBAGENT_B = "b912aad0417ce9210"
SUBAGENT_TYPE = "developer-tester"

#: See the note in the module docstring: literals here, bound to the classifier's
#: constants by one test, so every other test below fails on the hub's behaviour.
EVENT_KEY = "hook_event_name"
NOTIFICATION = "Notification"
STOP = "Stop"
SUBAGENT_STOP = "SubagentStop"
WORKING = "working"
WAITING = "waiting"
STOPPED = "stopped"

#: A watcher change published after the lines under test, so a frame that is
#: never broadcast fails on an assertion instead of hanging until the timeout.
#: It is a *filesystem* change on purpose: a hook payload would itself be a
#: lifecycle fact and would land in the counts it is supposed to terminate.
MARKER = "marker.py"


def _lifecycle(event: str, **fields) -> str:
    """One raw ingest line for a lifecycle payload naming `event`."""
    payload: dict = {EVENT_KEY: event, "session_id": SESSION}
    payload.update(fields)
    return json.dumps(payload)


def _write(file_path: str = f"{ROOT}/src/app.py", **fields) -> str:
    """One raw ingest line for a `Write`, the payload shape real captures show."""
    payload: dict = {
        "session_id": SESSION,
        EVENT_KEY: "PostToolUse",
        "tool_name": "Write",
        "tool_input": {"file_path": file_path},
    }
    payload.update(fields)
    return json.dumps(payload)


def _sent(hub: EventHub) -> list[dict]:
    """Every message a freshly connecting client would receive, in order."""
    return [json.loads(m) for m in hub.replay_messages()]


def _kinds(hub: EventHub) -> list[str]:
    return [m.get("kind", "event") for m in _sent(hub)]


def _agent_frames(hub: EventHub) -> list[dict]:
    return [m for m in _sent(hub) if m.get("kind") == "agentState"]


def _entries(hub: EventHub) -> list[dict]:
    """The agents the replay currently describes, or none at all."""
    frames = _agent_frames(hub)
    agents = frames[-1].get("agents") if frames else []
    return list(agents) if isinstance(agents, list) else []


def _state_of(hub: EventHub, agent: str) -> str | None:
    for entry in _entries(hub):
        if entry.get("agent") == agent:
            return entry.get("state")
    return None


def _run(coro):
    return asyncio.run(asyncio.wait_for(coro, timeout=30))


def _watch(actions: Callable[[EventHub], None]) -> list[dict]:
    """Every frame a client watching while `actions` runs actually receives."""

    async def scenario():
        hub = EventHub(project_root=ROOT)
        listener = await start_server(hub, host="127.0.0.1", port=0, static_root=None)
        port = next(iter(listener.sockets)).getsockname()[1]
        async with listener, connect(f"ws://127.0.0.1:{port}/ws") as ws:
            actions(hub)
            hub.ingest_fs_change(MARKER, "A")
            frames: list[dict] = []
            while True:
                frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                if frame.get("path") == MARKER:
                    return frames
                frames.append(frame)

    return _run(scenario())


# ===========================================================================
# 1. Only a tool call says who is at work
# ===========================================================================

def test_a_payload_that_is_not_a_tool_call_does_not_claim_the_next_change():
    """The blocked agent is the one entity provably not writing files.

    `_last_hook` means "the last agent that ran a tool", which is what
    `_active_agent`'s own docstring already claims it means.
    """
    hub = EventHub(project_root=ROOT)
    hub.ingest_line(json.dumps({"session_id": "s-1", EVENT_KEY: NOTIFICATION}))

    hub.ingest_fs_change("src/a.py", "M")

    assert _sent(hub)[-1]["agent"] == ""


def test_a_tool_call_the_normalizer_ignores_still_claims_the_next_change():
    """The jaw. `Grep` draws nothing, and it is still proof of who is at work.

    This is the behaviour the comment above the stamp was written for -- a
    `find` or a glob-expanding `cp` yields no event and its changes are still
    that agent's doing -- so narrowing the condition to Write/Edit/Read would
    take the test above green by breaking attribution for everything else.
    """
    hub = EventHub(project_root=ROOT)
    hub.ingest_line(
        json.dumps(
            {
                "session_id": "s-2",
                EVENT_KEY: "PostToolUse",
                "tool_name": "Grep",
                "tool_input": {"pattern": "resolve_inside"},
            }
        )
    )

    hub.ingest_fs_change("src/a.py", "M")

    assert _sent(hub)[-1]["agent"] == "s-2"


@pytest.mark.parametrize(
    "tool_name",
    [
        pytest.param(123, id="number"),
        pytest.param(None, id="null"),
        pytest.param("", id="empty"),
        pytest.param("   ", id="blank"),
        pytest.param({"name": "Write"}, id="object"),
        pytest.param(["Write"], id="array"),
    ],
)
def test_a_tool_name_that_is_not_usable_text_does_not_claim_the_next_change(tool_name):
    """Pinned so that `if "tool_name" in payload` cannot creep back in."""
    hub = EventHub(project_root=ROOT)
    hub.ingest_line(json.dumps({"session_id": "s-4", "tool_name": tool_name}))

    hub.ingest_fs_change("src/a.py", "M")

    assert _sent(hub)[-1]["agent"] == ""


# --- the same rule, at the pure level --------------------------------------

def test_a_payload_carrying_a_usable_tool_name_refreshes_the_actor():
    """The decision is a pure predicate beside `actor_of`, not a socket-loop `if`.

    Same reason `actor_of` is shared: the ingest loop and the normalizer must
    not hold two opinions about what a tool call is.
    """
    from rhizome_graph.normalize import refreshes_actor

    assert refreshes_actor({"session_id": SESSION, "tool_name": "Grep"}) is True


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param({"session_id": SESSION}, id="no-tool-name"),
        pytest.param({"tool_name": ""}, id="empty"),
        pytest.param({"tool_name": "   "}, id="blank"),
        pytest.param({"tool_name": 123}, id="number"),
        pytest.param({"tool_name": None}, id="null"),
        pytest.param({"tool_name": {"name": "Write"}}, id="object"),
        pytest.param({EVENT_KEY: NOTIFICATION, "session_id": SESSION}, id="lifecycle"),
    ],
)
def test_a_payload_without_usable_tool_name_does_not_refresh_the_actor(payload):
    from rhizome_graph.normalize import refreshes_actor

    assert refreshes_actor(payload) is False


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param(None, id="none"),
        pytest.param([], id="list"),
        pytest.param("Write", id="string"),
        pytest.param(7, id="number"),
    ],
)
def test_a_payload_that_is_not_an_object_never_refreshes_the_actor(payload):
    """Total, like `actor_of`: what arrives over a socket is not a promise."""
    from rhizome_graph.normalize import refreshes_actor

    assert refreshes_actor(payload) is False


# ===========================================================================
# 2. The hub's slot
# ===========================================================================

def test_this_file_spells_the_event_names_the_classifier_spells():
    """The one binding point between this file's literals and the constants.

    Step 0 of the plan may correct any of these four names from a real capture.
    When it does, this test is the only one here that has to change -- which is
    the whole reason the other tests below spell the literal rather than the
    import.
    """
    agentstate = importlib.import_module("rhizome_graph.agentstate")

    assert (
        agentstate.EVENT_KEY,
        agentstate.NOTIFICATION,
        agentstate.STOP,
        agentstate.SUBAGENT_STOP,
        agentstate.WORKING,
        agentstate.WAITING,
        agentstate.STOPPED,
    ) == (EVENT_KEY, NOTIFICATION, STOP, SUBAGENT_STOP, WORKING, WAITING, STOPPED)


def test_a_notification_puts_its_agent_on_camera_as_waiting():
    hub = EventHub(project_root=ROOT)

    hub.ingest_line(_lifecycle(NOTIFICATION))

    assert [(e.get("agent"), e.get("state")) for e in _entries(hub)] == [
        (SESSION, WAITING)
    ]


def test_a_stop_puts_its_agent_on_camera_as_stopped():
    hub = EventHub(project_root=ROOT)

    hub.ingest_line(_lifecycle(STOP))

    assert _state_of(hub, SESSION) == STOPPED


# --- a lifecycle fact is even less of a change than a read ------------------

def test_a_lifecycle_line_does_not_make_a_later_write_a_modification():
    """`known_paths` is the point: it decides add-vs-modify.

    Asserted through the event a client receives rather than through the set
    itself -- the set is private, and what matters is what the browser draws.
    """
    hub = EventHub(project_root=ROOT)
    hub.ingest_line(_lifecycle(NOTIFICATION))
    assert _entries(hub), "the lifecycle line produced no agent state at all"

    hub.ingest_line(_write())

    assert _sent(hub)[-1]["type"] == "A"


def test_a_lifecycle_line_leaves_the_replayed_event_ring_empty():
    """It is a slot, for the same reason the status panel is one.

    Appended to `_recent` instead, a fact republished for the life of the
    session would grow the replay without bound and push the project's own tree
    out of a finite ring.
    """
    hub = EventHub(project_root=ROOT)

    hub.ingest_line(_lifecycle(NOTIFICATION))

    assert _entries(hub), "the lifecycle line produced no agent state at all"
    assert [m for m in _sent(hub) if "kind" not in m] == []


def test_the_watchers_report_of_a_path_is_not_swallowed_by_a_lifecycle_line():
    """`_hook_paths` suppresses the echo of a change a hook reported.

    A lifecycle payload names no path at all, so there is nothing of the kind to
    suppress, and stamping anything there would swallow a genuine write.
    """
    hub = EventHub(project_root=ROOT)
    hub.ingest_line(_lifecycle(NOTIFICATION))

    hub.ingest_fs_change("src/app.py", "M")

    assert [m["path"] for m in _sent(hub) if m.get("origin") == "watch"] == [
        "src/app.py"
    ]


# --- the dedupe -------------------------------------------------------------

def test_the_same_state_twice_is_broadcast_once():
    """The poll-shaped rule: identical frames are pure noise on the wire."""

    def actions(hub: EventHub) -> None:
        hub.ingest_line(_lifecycle(NOTIFICATION))
        hub.ingest_line(_lifecycle(NOTIFICATION))

    frames = [f for f in _watch(actions) if f.get("kind") == "agentState"]

    assert len(frames) == 1


def test_a_state_that_actually_changed_is_broadcast_again():
    """The other half: a dedupe that swallowed a change would freeze the ring."""

    def actions(hub: EventHub) -> None:
        hub.ingest_line(_lifecycle(NOTIFICATION))
        hub.ingest_line(_lifecycle(STOP))

    frames = [f for f in _watch(actions) if f.get("kind") == "agentState"]

    assert [
        [(e.get("agent"), e.get("state")) for e in f.get("agents", [])] for f in frames
    ] == [[(SESSION, WAITING)], [(SESSION, STOPPED)]]


# --- where it sits in the replay --------------------------------------------

def test_the_agent_states_follow_the_status_panel():
    # Pairwise, never by absolute index: three other planned frames insert into
    # this same gap, and none of them is a regression in this one.
    hub = EventHub(project_root=ROOT)

    hub.set_status({"kind": "status", "repo": True, "truncated": False, "entries": []})
    hub.ingest_line(_lifecycle(NOTIFICATION))

    kinds = _kinds(hub)
    assert "agentState" in kinds, "the lifecycle line produced no agent state at all"
    assert kinds.index("status") < kinds.index("agentState")


def test_the_agent_states_precede_the_tree():
    """A ring behind twenty thousand seed events arrives seconds late."""
    hub = EventHub(project_root=ROOT)

    hub.ingest_line(_lifecycle(NOTIFICATION))
    hub.seed_paths(["src/app.py"])

    kinds = _kinds(hub)
    assert "agentState" in kinds, "the lifecycle line produced no agent state at all"
    assert kinds.index("agentState") < kinds.index("event")


# --- who is worth a frame at all --------------------------------------------

def test_an_agent_that_has_never_been_blocked_is_not_put_on_camera_by_its_tool_calls():
    """A `working` answer only ever *clears* a wait; it introduces nobody.

    A tool call already says everything a `working` entry would: the event it
    produces builds the figure, names the actor and lights the beam. Publishing
    a state for an agent that was never blocked builds a second description of
    the same agent out of a payload that adds nothing to it -- and it does so on
    the commonest payload the daemon hears, so the slot would be rewritten and
    rebroadcast on every tool call in the session.
    """
    hub = EventHub(project_root=ROOT)

    hub.ingest_line(_write())

    assert _agent_frames(hub) == []


def test_a_tool_call_clears_the_wait_on_camera_without_putting_anybody_else_on_it():
    """Both halves of the guard in one picture, because they pull opposite ways.

    Narrowing "never publish a `working`" until it also swallows the clear takes
    the test above green by breaking decision 5: the ring would then be retired
    by nothing but the browser's staleness cut, ten minutes after the agent went
    back to work.
    """
    hub = EventHub(project_root=ROOT)
    hub.ingest_line(_lifecycle(NOTIFICATION))

    hub.ingest_line(_write(agent_id=SUBAGENT_A, agent_type=SUBAGENT_TYPE))
    hub.ingest_line(_write())

    assert [(e.get("agent"), e.get("state")) for e in _entries(hub)] == [
        (SESSION, WORKING)
    ]


# --- what clears a wait -----------------------------------------------------

def test_a_waiting_agent_that_runs_a_tool_is_working_again():
    """Cleared by the agent's own next tool call, never by a timer.

    A human can be away from the keyboard for an hour with the agent genuinely
    still blocked, so a timeout reports false progress -- worse than a stale
    flag, because it is an answer rather than an absence.
    """
    hub = EventHub(project_root=ROOT)
    hub.ingest_line(_lifecycle(NOTIFICATION))

    hub.ingest_line(_write())

    assert _state_of(hub, SESSION) == WORKING


def test_another_agents_tool_call_leaves_the_waiting_one_waiting():
    # The subagent's payload carries the session id too, as every real one does.
    hub = EventHub(project_root=ROOT)
    hub.ingest_line(_lifecycle(NOTIFICATION))

    hub.ingest_line(_write(agent_id=SUBAGENT_A, agent_type=SUBAGENT_TYPE))

    assert _state_of(hub, SESSION) == WAITING


# --- a switch of root -------------------------------------------------------

def test_a_reset_forgets_the_actors_of_the_project_left_behind():
    """Actors of the old project are the clearest case the docstring predicts."""
    hub = EventHub(project_root=ROOT)
    hub.ingest_line(_lifecycle(NOTIFICATION))
    assert _entries(hub), "the lifecycle line produced no agent state at all"

    hub.reset("/srv/other")

    assert _agent_frames(hub) == []


def test_a_client_connecting_mid_switch_is_told_to_clear_first():
    hub = EventHub(project_root=ROOT)
    hub.ingest_line(_lifecycle(NOTIFICATION))
    hub.reset("/srv/other")

    hub.ingest_line(_lifecycle(NOTIFICATION))

    assert _entries(hub), "the lifecycle line produced no agent state at all"
    assert _kinds(hub)[0] == "reset"


# --- identity is the agent, never the label ---------------------------------

def test_two_subagents_of_one_type_are_two_actors():
    """The rule stated twice in CLAUDE.md, pinned against a dedupe by label."""
    hub = EventHub(project_root=ROOT)

    hub.ingest_line(
        _lifecycle(NOTIFICATION, agent_id=SUBAGENT_A, agent_type=SUBAGENT_TYPE)
    )
    hub.ingest_line(
        _lifecycle(NOTIFICATION, agent_id=SUBAGENT_B, agent_type=SUBAGENT_TYPE)
    )

    assert sorted(e.get("agent") for e in _entries(hub)) == sorted(
        [SUBAGENT_A, SUBAGENT_B]
    )
