"""What a payload that is not a tool call says about the agent that fired it.

The graph draws what an agent does to *files* and says nothing about the agent
itself, so a blocked agent looks exactly like a thinking one: the figure stands
still either way. Claude Code fires a hook when it needs permission or has gone
idle, and another when a turn or a subagent ends. Those payloads already reach
the daemon; they produce no event and are dropped. This module turns one of them
into a fact about an actor -- and into nothing at all when it recognises none.

It answers that one question and only that one. Not in
:mod:`rhizome_graph.normalize`, whose contract is "hook JSON -> Event" and whose
whole surface is about paths: a second return type there would make every caller
learn which of two things it got, on a module the hook's hot path goes through.
Not in :mod:`daemon.server` either, which owns *state* while this is a pure
classification -- the same split :mod:`rhizome_graph.status`,
:mod:`rhizome_graph.checkouts` and :mod:`rhizome_graph.content_search` take.

**The four payload names below are constants because nothing here has ever seen
one of these payloads.** This project's standard is that a payload shape is
"settled by capture, not by reasoning" -- the ``PostToolUse`` shape was measured
against a real session with ``RHIZOME_TRACE_LOG``, and ``Notification``,
``Stop`` and ``SubagentStop`` were not. So the event key and the three event
names are named constants and every test is written against them: a capture that
corrects a string corrects it here, in one place, and changes no test and no
caller. Step 0 of
``docs/features/doing/2026-08-26-20-56-agent-lifecycle-events.md`` is that
capture.

Five properties hold the module up, and each of them is a test:

  * **The actor comes from :func:`actor_of`, imported.** Never a second reading
    of ``agent_id`` / ``session_id``: two copies of that rule drift, and the
    drift shows up as a lifecycle fact landing on a different figure than the
    events beside it.
  * **A ``SubagentStop`` refuses the session fallback, and a ``Notification``
    does not.** The asymmetry is deliberate. :func:`actor_of` falls back to
    ``session_id``, which is the *orchestrator's* key, so a subagent stop that
    fell back would retire the orchestrator's figure -- the one most likely to
    still be working -- every time any specialist finished. A notification may
    fall back: a permission prompt blocks the session as a whole, so crediting
    it to the session is approximately true rather than backwards.
  * **The state set is closed.** An unrecognised event name answers ``None``,
    the same direction the browser's ``EVENT_TYPES`` takes: a daemon talking to
    another version must produce nothing, not something.
  * **It never raises.** The payload arrives over a socket and the ingest loop's
    own ``except`` logs at DEBUG and keeps going, so an exception here is a
    silently dropped client rather than a visible failure.
  * **It starts no process, opens no file and matches no regular expression.**
    Asserted over the parsed source. The last one is what keeps a future "parse
    the notification message" from evaluating a payload field on the daemon.
"""

from __future__ import annotations

import time
from collections.abc import Iterable
from dataclasses import dataclass

# `_usable_text` is reached across the module boundary on purpose: it is the
# helper `actor_of` itself uses, and "what counts as usable text" is one rule
# rather than two spellings of it.
from rhizome_graph.normalize import _usable_text, actor_of

#: The agent ran a tool: it is neither blocked nor gone.
WORKING = "working"

#: The agent is blocked on a human -- a permission prompt, or an idle notice.
WAITING = "waiting"

#: The agent's turn ended, or a subagent finished. It has left.
STOPPED = "stopped"

#: A closed tuple, so a fourth state is an edit somebody makes on purpose.
STATES = (WORKING, WAITING, STOPPED)

#: The payload key naming which hook fired. This one is *measured*: real
#: captures carry it beside ``session_id`` and ``tool_name``, and
#: ``tests/test_agent_identity.py`` is built from them.
EVENT_KEY = "hook_event_name"

#: Assumed, pending the capture in step 0 -- the agent needs a human.
NOTIFICATION = "Notification"

#: Assumed, pending the capture in step 0 -- the session's turn ended.
STOP = "Stop"

#: Assumed, pending the capture in step 0 -- one subagent finished.
SUBAGENT_STOP = "SubagentStop"

#: Measured, like :data:`EVENT_KEY`: the event every tool call already carries.
POST_TOOL_USE = "PostToolUse"

#: The frame kind the browser routes on, above ``parseEvent``.
FRAME_KIND = "agentState"

#: Which state each event name means. The mapping *is* the closed set: an event
#: that is not a key here answers nothing at all.
_STATE_BY_EVENT = {
    NOTIFICATION: WAITING,
    STOP: STOPPED,
    SUBAGENT_STOP: STOPPED,
    POST_TOOL_USE: WORKING,
}


@dataclass(frozen=True)
class AgentState:
    """One agent, and what is true of it right now.

    Attributes:
        agent: Actor **identity**, exactly as :class:`rhizome_graph.normalize.Event`
            means it -- ``agent_id`` for a subagent, else ``session_id``.
        label: The readable ``agent_type``, for display only. It never takes
            part in the identity.
        state: One of :data:`STATES`.
        ts: Wall-clock seconds (``time.time``), never a monotonic reading: the
            browser decides what an hour-old ``waiting`` looks like by comparing
            this against its own clock.
        caption: Free text under the figure. Declared here and filled by
            nothing in this module -- it is what lets the sibling todo-caption
            feature share this one per-agent frame instead of growing a second.
    """

    agent: str
    label: str
    state: str
    ts: float
    caption: str = ""


def agent_state(payload: dict, ts: float | None = None) -> AgentState | None:
    """What one hook payload says about its agent, or ``None``; never raises.

    ``ts`` is a parameter so a test can fix it without sleeping; left out, the
    answer is stamped with the wall clock.
    """
    try:
        return _classify(payload, time.time() if ts is None else float(ts))
    except Exception:  # noqa: BLE001 - a raise here is a silently dropped client
        return None


def agent_state_frame(states: Iterable[AgentState]) -> dict:
    """The whole current picture as a frame, in JSON types only.

    Modelled on :func:`rhizome_graph.sizes.sizes_frame`. Cumulative rather than a
    delta: a delta needs an ordering guarantee across a reconnect and a rule for
    a client that missed one, while a full picture in a deduped slot needs
    neither.

    Every value is converted rather than passed through. An
    :class:`AgentState` smuggled into the frame whole would raise inside
    ``broadcast`` -- on the event loop, long after this function returned, where
    nothing points back at the code that caused it.
    """
    return {
        "kind": FRAME_KIND,
        "agents": [
            {
                "agent": str(entry.agent),
                "label": str(entry.label),
                "state": str(entry.state),
                "caption": str(entry.caption),
                "ts": float(entry.ts),
            }
            for entry in states
        ],
    }


def _classify(payload: dict, ts: float) -> AgentState | None:
    if not isinstance(payload, dict):
        return None

    event = payload.get(EVENT_KEY)
    if not isinstance(event, str):
        return None
    state = _STATE_BY_EVENT.get(event)
    if state is None:
        return None

    agent, label = actor_of(payload)
    if event == SUBAGENT_STOP:
        # The one place `actor_of` is not enough, and a deliberate exception
        # rather than a second identity rule: its fallback is the session, which
        # is the orchestrator's key, so a subagent stop with no `agent_id` would
        # retire the orchestrator every time any specialist finished. No id, no
        # frame -- half the value of the feature, and never wrong.
        agent = _usable_text(payload.get("agent_id"))
    if not agent:
        return None

    return AgentState(agent=agent, label=label, state=state, ts=ts)
