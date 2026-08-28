"""Contract tests (RED) for `rhizome_graph.agentstate`, the lifecycle classifier.

Motivation: the graph shows what an agent does to *files* and says nothing about
the agent itself, so **a blocked agent looks exactly like a thinking one**. Claude
Code fires a hook when it needs permission or has gone idle, and another when a
turn or a subagent ends; today those payloads reach the daemon, produce no event,
and are dropped. The figure keeps standing there at the alpha floor, and a viewer
cannot tell "waiting for a human" from "working" from "left an hour ago".

This module answers one question and only one: *what does this non-file payload
say about this agent?* It is deliberately not in `normalize.py` -- that module's
contract is "hook JSON -> Event", its whole surface is about paths, and growing a
second return type onto it would make every caller learn which of two things it
got -- and not in `daemon/server.py`, which owns state rather than classification.
The split is the one `status.py`, `checkouts.py` and `content_search.py` already
take.

Five properties hold it up, and each is a test below:

  * **The actor comes from `actor_of`, imported.** Never a second reading of
    `agent_id` / `session_id`: two copies of that rule drift, and the drift shows
    up as a lifecycle fact landing on a different figure than the events beside
    it.
  * **A `SubagentStop` refuses the session fallback.** `actor_of` falls back to
    `session_id`, which is the *orchestrator's* key, so a subagent stop that fell
    back would retire the orchestrator's figure -- the one most likely to still be
    working -- every time any specialist finished. A `Notification` may fall back:
    a permission prompt blocks the session as a whole.
  * **The state set is closed.** An unrecognised event name answers `None`, the
    same direction `EVENT_TYPES` takes in the browser: a daemon talking to another
    version must produce nothing, not something.
  * **It never raises.** The payload arrives over a socket, and the ingest loop's
    own `except` logs at DEBUG and drops the connection, so an exception here is a
    silently dead client rather than a visible failure.
  * **The module opens nothing, forks nothing, and imports neither `re` nor `os`.**
    Asserted over the parsed source, the way `checkouts.py`'s "starts no process"
    is. The `re` half is what keeps a future "parse the notification message" from
    turning a payload field into a regular expression evaluated on the daemon.

**Every test here is written against the module's constants, never against the
string literals they hold.** Nothing in this repository has ever captured a
`Notification`, a `Stop` or a `SubagentStop` payload -- the `PostToolUse` shape was
"settled by capture, not by reasoning", and these three are not. So the three event
names and the payload key they sit under are `agentstate` constants, and step 0 of
`docs/features/doing/2026-08-26-20-56-agent-lifecycle-events.md` (a real trace from
a real session, which no agent on this host can run) may correct all four of them
without changing one line below. The state machine around them is fully specifiable
today, and that is what this file specifies.

Style: Arrange-Act-Assert, one property per test.
"""

from __future__ import annotations

import ast
import importlib
import json
from pathlib import Path

import pytest

from rhizome_graph.normalize import actor_of

REPO_ROOT = Path(__file__).resolve().parent.parent
MODULE_SOURCE = REPO_ROOT / "rhizome_graph" / "agentstate.py"

SESSION = "sess-abc"
SUBAGENT_A = "a747fec535c143044"
SUBAGENT_B = "b912aad0417ce9210"
SUBAGENT_TYPE = "developer-tester"

#: The one event name that is *measured* rather than assumed: real captures carry
#: it, and `tests/test_agent_identity.py` is built from them. It is spelled here
#: as a literal for exactly that reason.
POST_TOOL_USE = "PostToolUse"


def agentstate():
    """The module under specification -- it does not exist yet.

    Imported through `importlib` rather than at the top of the file, the way
    `tests/test_hook_install_model.py` reaches `hookinstall`, for one practical
    reason: a top-level import of a missing module is a *collection* error, and
    a collection error interrupts the whole run. Every test below would then be
    replaced by a single line saying nothing, including the ones in other files.
    Here each test reports its own `ModuleNotFoundError`, which is the correct
    RED for a new module, and the rest of the suite still runs.
    """
    return importlib.import_module("rhizome_graph.agentstate")


def _payload(event: str, **fields) -> dict:
    """A hook payload naming `event`, carrying the session and whatever else."""
    payload: dict = {agentstate().EVENT_KEY: event, "session_id": SESSION}
    payload.update(fields)
    return payload


# --- 1. A notification is an agent waiting ---------------------------------

def test_a_notification_answers_waiting():
    module = agentstate()
    payload = _payload(module.NOTIFICATION)

    assert module.agent_state(payload).state == module.WAITING


def test_a_notification_takes_its_actor_from_actor_of():
    # Never a second reading of `agent_id` / `session_id`: two copies of that
    # rule drift, and the drift puts the ring on a different figure than the
    # events beside it.
    payload = _payload(
        agentstate().NOTIFICATION, agent_id=SUBAGENT_A, agent_type=SUBAGENT_TYPE
    )

    answer = agentstate().agent_state(payload)

    assert (answer.agent, answer.label) == actor_of(payload)


# --- 2. A stop is an agent leaving ------------------------------------------

def test_a_stop_retires_the_session_that_fired_it():
    module = agentstate()
    payload = _payload(module.STOP)

    answer = module.agent_state(payload)

    assert (answer.agent, answer.state) == (SESSION, module.STOPPED)


def test_a_subagent_stop_retires_the_subagent_and_not_the_session_around_it():
    # The session id is present in the payload, as it is in every real one. The
    # answer must still name the subagent alone.
    module = agentstate()
    payload = _payload(
        module.SUBAGENT_STOP, agent_id=SUBAGENT_A, agent_type=SUBAGENT_TYPE
    )

    answer = module.agent_state(payload)

    assert (answer.agent, answer.state) == (SUBAGENT_A, module.STOPPED)


# --- 3. The asymmetry, met in one place -------------------------------------

def test_only_a_subagent_stop_refuses_the_fallback_to_the_session():
    """A specialist finishing must never retire the orchestrator's figure.

    The two halves are asserted together on purpose: apart, each reads like an
    arbitrary rule about one branch, and the next reader "tidies" one of them
    into the other.
    """
    module = agentstate()
    stopping = _payload(module.SUBAGENT_STOP)
    waiting = _payload(module.NOTIFICATION)

    assert module.agent_state(stopping) is None

    answered = module.agent_state(waiting)
    assert answered is not None and answered.agent == SESSION


# --- 4. Step 0 -------------------------------------------------------------
#
# Row 2.4 of `docs/features/doing/2026-08-26-20-56-agent-lifecycle-events.md` --
# "a permission prompt and an idle timeout both answer `waiting` and differ only
# in `caption`" -- is DELIBERATELY NOT WRITTEN HERE. It is gated on step 0's
# question 0.3, which asks whether the two are distinguishable in the payload at
# all. That is a fact about Claude Code and nothing else, obtainable only from a
# `RHIZOME_TRACE_LOG` capture of a real session, and this host is a tty with no
# session to observe. Writing it from an assumed field name is precisely what
# "settled by capture, not by reasoning" forbids. It is written after step 0,
# from what the trace actually said.


# --- 5. The set stays closed ------------------------------------------------

def test_a_tool_call_answers_working():
    module = agentstate()
    payload = _payload(POST_TOOL_USE, tool_name="Write", tool_input={"file_path": "a"})

    assert module.agent_state(payload).state == module.WORKING


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param({"hook_event_name": "PreCompact", "session_id": SESSION}, id="unknown-event"),
        pytest.param({"session_id": SESSION}, id="no-event-name"),
        pytest.param({}, id="empty"),
        pytest.param(None, id="none"),
        pytest.param([], id="list"),
        pytest.param("Notification", id="string"),
        pytest.param(7, id="number"),
    ],
)
def test_a_payload_the_module_does_not_recognise_answers_nothing(payload):
    """Produce nothing rather than something, exactly as `EVENT_TYPES` does."""
    assert agentstate().agent_state(payload) is None


def test_the_state_set_is_exactly_three():
    """A closed tuple, so a fourth state is an edit somebody makes on purpose."""
    module = agentstate()

    assert module.STATES == (module.WORKING, module.WAITING, module.STOPPED)


# --- 6. Garbage answers, and never raises -----------------------------------

def test_a_payload_that_is_garbage_in_every_field_answers_nothing():
    payload = {
        agentstate().EVENT_KEY: ["Notification"],
        "agent_id": {"nested": 1},
        "agent_type": 7,
        "session_id": None,
    }

    assert agentstate().agent_state(payload) is None


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param({"hook_event_name": {"a": 1}}, id="event-name-dict"),
        pytest.param({"hook_event_name": None, "agent_id": []}, id="event-name-null"),
        pytest.param({"agent_id": {"a": 1}, "agent_type": 3}, id="ids-of-wrong-type"),
        pytest.param({"session_id": 12}, id="session-a-number"),
        pytest.param(object(), id="not-json-at-all"),
    ],
)
def test_no_payload_shape_makes_the_classifier_raise(payload):
    """An exception here is a silently dropped client, not a visible failure.

    The ingest loop catches everything and logs at DEBUG, so a raise costs the
    connection serving one browser and says nothing anywhere a person looks.
    """
    agentstate().agent_state(payload)


# --- 7. The timestamp -------------------------------------------------------

def test_the_caller_may_stamp_the_answer_itself():
    # The browser decides what an hour-old `waiting` looks like, from this
    # number; a test that cannot fix it would have to sleep to specify anything.
    module = agentstate()

    answer = module.agent_state(_payload(module.NOTIFICATION), 1_700_000_000.5)

    assert answer.ts == 1_700_000_000.5


def test_an_answer_carries_no_caption_until_something_fills_it():
    """`caption` is declared by this plan and filled by the sibling one.

    Its absence must cost nothing: the field exists so the two plans share one
    frame instead of growing a second per-agent frame kind.
    """
    module = agentstate()

    assert module.agent_state(_payload(module.NOTIFICATION)).caption == ""


# --- 8. The frame ----------------------------------------------------------

def test_the_frame_names_the_kind_and_every_field_of_every_agent():
    """Exact equality, so an added or renamed key is a decision, not a drift."""
    module = agentstate()
    state = module.AgentState(
        agent=SUBAGENT_A,
        label=SUBAGENT_TYPE,
        state=module.WAITING,
        ts=1_700_000_000.5,
    )

    assert module.agent_state_frame([state]) == {
        "kind": "agentState",
        "agents": [
            {
                "agent": SUBAGENT_A,
                "label": SUBAGENT_TYPE,
                "state": module.WAITING,
                "caption": "",
                "ts": 1_700_000_000.5,
            }
        ],
    }


def test_the_frame_carries_json_types_only():
    """An `AgentState` smuggled through whole raises inside `broadcast`.

    That is on the event loop, long after this function returned, so the failure
    surfaces nowhere near the code that caused it.
    """
    module = agentstate()
    state = module.AgentState(
        agent=SUBAGENT_A, label=SUBAGENT_TYPE, state=module.WAITING, ts=1.0
    )

    json.dumps(module.agent_state_frame([state]))


def test_a_frame_about_nobody_is_still_a_frame():
    # The last agent leaving is a state change like any other; an empty answer
    # is what clears the rings.
    assert agentstate().agent_state_frame([]) == {"kind": "agentState", "agents": []}


def test_the_frame_keeps_the_order_it_was_given():
    module = agentstate()
    first = module.AgentState(SUBAGENT_A, SUBAGENT_TYPE, module.WAITING, 1.0)
    second = module.AgentState(SUBAGENT_B, SUBAGENT_TYPE, module.WORKING, 2.0)

    frame = module.agent_state_frame([first, second])

    assert [entry["agent"] for entry in frame["agents"]] == [SUBAGENT_A, SUBAGENT_B]


# --- 9. The module's own boundary, written down ----------------------------

#: Every name by which a process is started, however it is spelled. `gitcmd` is
#: ours and is the one place in this project that forks; naming it here is what
#: stops the fork being reached indirectly.
FORKING_NAMES = (
    "subprocess",
    "multiprocessing",
    "popen",
    "system",
    "fork",
    "execv",
    "execvp",
    "spawnv",
    "spawnl",
    "gitcmd",
)

#: `open` because this module classifies a payload it was handed and has no
#: business on the disk; `re` because a regular expression built from a payload
#: field is evaluated on the daemon; `os` because a module with no filesystem
#: question to ask does not need it, and reaching for it is how the first one
#: arrives.
FORBIDDEN_NAMES = ("open", "re", "os")


def _identifiers(module: ast.Module) -> set[str]:
    """Every name the code *uses*: bare names, attributes and imported modules.

    Identifiers rather than raw text, because the module's own docstring is
    expected to say that it forks nothing and opens nothing -- a substring search
    would then fail on the promise instead of on a breach of it.
    """
    names: set[str] = set()
    for node in ast.walk(module):
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.Attribute):
            names.add(node.attr)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                names.update(alias.name.split("."))
                if alias.asname:
                    names.add(alias.asname)
        elif isinstance(node, ast.ImportFrom):
            names.update((node.module or "").split("."))
            names.update(alias.name for alias in node.names)
    return names


def _parsed_source() -> ast.Module:
    assert MODULE_SOURCE.exists(), f"there is no {MODULE_SOURCE}"
    return ast.parse(MODULE_SOURCE.read_text(encoding="utf-8"))


def test_the_classifier_never_starts_a_process():
    used = _identifiers(_parsed_source())

    offenders = sorted(used & set(FORKING_NAMES))

    assert offenders == [], (
        f"rhizome_graph/agentstate.py names {offenders}. It classifies a payload "
        "somebody sent over a socket; gitcmd stays the one place in this project "
        "where a process is started."
    )


def test_the_classifier_opens_nothing_and_matches_no_regular_expression():
    used = _identifiers(_parsed_source())

    offenders = sorted(used & set(FORBIDDEN_NAMES))

    assert offenders == [], (
        f"rhizome_graph/agentstate.py names {offenders}. It answers from the "
        "payload alone: no file descriptor, no path question, and no regular "
        "expression -- the last one is what keeps a future 'parse the "
        "notification message' from evaluating a payload field on the daemon."
    )
