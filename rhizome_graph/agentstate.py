"""What a payload says about the agent that fired it, rather than about a file.

The graph draws what an agent does to *files* and says nothing about the agent
itself, so a blocked agent looks exactly like a thinking one: the figure stands
still either way. Claude Code fires a hook when it needs permission or has gone
idle, and another when a turn or a subagent ends. Those payloads already reach
the daemon; they produce no event and are dropped. This module turns one of them
into a fact about an actor -- and into nothing at all when it recognises none.

The graph also answers *where* an agent is working and never *why*, and there
the payload that carries the answer is an ordinary tool call: ``TodoWrite`` is
how an agent writes down its own plan and marks one item ``in_progress``, so
that item is the cheapest sentence there is about what the agent thinks it is
doing. :func:`caption_of` derives it and :func:`safe_caption` says what of it
may be drawn -- two functions rather than one, because the first answers "what
does this payload say" and the second is the security surface of the feature:
this is the first thing in the program that takes a string a language model
wrote and rasterises it, so it must be reviewable without reading the
derivation beside it.

It answers those questions and only those. Not in
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

**The five ``TodoWrite`` strings are constants for exactly the same reason.**
Nobody here has captured one of those payloads either, so :data:`TODO_WRITE`,
:data:`TODOS`, :data:`ACTIVE_FORM`, :data:`CONTENT` and :data:`IN_PROGRESS` are
named and every test is written against the names: a real trace is a five-string
correction that moves no test and no caller.

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
    the notification message" from evaluating a payload field on the daemon, and
    it is why the fold below is a walk over characters rather than the
    ``re.sub`` it would otherwise obviously be.
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

#: Assumed, pending the capture in step 0 -- the tool an agent writes its own
#: plan with. The *tool* decides that a payload is about a caption, never the
#: shape of its input: a ``Write`` carrying something that looks like a todo
#: list is still a ``Write``.
TODO_WRITE = "TodoWrite"

#: Assumed -- the list of items inside ``tool_input``.
TODOS = "todos"

#: Assumed -- the present-continuous form, which is the field to paint: Claude
#: Code asks the model to write it in the form a reader wants under a figure.
ACTIVE_FORM = "activeForm"

#: Assumed -- the imperative form, and the fallback. A caption reading as an
#: instruction rather than as an activity is a degradation, not a blocker.
CONTENT = "content"

#: Assumed -- the status of the one item being worked on. The other values
#: (``pending``, ``completed``) carry no meaning here: everything that is not
#: this is "not the item being worked on".
IN_PROGRESS = "in_progress"

#: The key those statuses sit under. Assumed like the five above and unbound by
#: any test, because correcting its spelling changes no answer this module gives
#: -- an item whose status cannot be read is simply not the one in progress.
_STATUS = "status"

#: How long a caption may be, in code points. Not
#: ``labels.MAX_ACTOR_LABEL_CHARS``'s 24, which cuts most clauses mid-verb, and
#: not 200: at the label font a 60-character caption is already most of a screen
#: wide at the graph's usual zoom. The browser holds the same number and the two
#: are pinned to each other by a shared fixture table rather than by a comment.
MAX_CAPTION_CHARS = 60

#: The mark a cut caption ends with, exactly as ``actorDisplayName`` spells it.
_ELLIPSIS = "…"

#: The bidirectional marks, embeddings, overrides and isolates, named one by
#: one. ``ctx.fillText`` runs the platform's bidirectional algorithm, so a
#: right-to-left override inside a caption reverses the visual order of
#: everything after it -- and the caption sits directly under the agent's own
#: name, which is the one string on the page a user trusts to say who is acting.
#: The blast radius is a graph rather than a credential, which is why this is a
#: fold and not an alarm; it costs one character class to remove and there is no
#: case for keeping it. Spelled out rather than described, because this is the
#: class a later "simplify the fold" drops first.
_BIDI_CONTROLS = frozenset(
    (
        "\u200e",  # LEFT-TO-RIGHT MARK
        "\u200f",  # RIGHT-TO-LEFT MARK
        "\u202a",  # LEFT-TO-RIGHT EMBEDDING
        "\u202b",  # RIGHT-TO-LEFT EMBEDDING
        "\u202c",  # POP DIRECTIONAL FORMATTING
        "\u202d",  # LEFT-TO-RIGHT OVERRIDE
        "\u202e",  # RIGHT-TO-LEFT OVERRIDE
        "\u2066",  # LEFT-TO-RIGHT ISOLATE
        "\u2067",  # RIGHT-TO-LEFT ISOLATE
        "\u2068",  # FIRST STRONG ISOLATE
        "\u2069",  # POP DIRECTIONAL ISOLATE
    )
)

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
        caption: Free text under the figure -- what the agent last said it was
            doing, derived by :func:`caption_of` and bounded by
            :func:`safe_caption`. It rides this entry rather than a frame of its
            own so that one dedupe, one replay line, one ``reset`` clause, one
            parser and one route carry both facts about one actor. Filled by
            the hub and never by :func:`agent_state`: whether a caption
            *survives* a payload that says nothing about it is state, and state
            belongs to :class:`daemon.server.EventHub`.
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


def caption_of(payload: object) -> str | None:
    """What this payload says about the agent's current work; never raises.

    A tri-state, and the third state is the one that carries the feature:

      * ``None`` -- *this payload says nothing about a caption*. The
        ``tool_name`` is absent, unusable, or names another tool. The hub
        carries forward whatever caption it already holds.
      * ``""`` -- *this is a ``TodoWrite`` and there is nothing in progress*.
        The hub clears the caption.
      * the text otherwise.

    Collapsing the first two is the quiet defect this shape exists to avoid: the
    hub publishes a ``working`` state on every tool call, so an ordinary
    ``Write`` answering "nothing is in progress" would wipe a caption a
    ``TodoWrite`` set milliseconds earlier, and no sentence would ever stay on
    screen long enough to be read.

    Three rules decide the text. The **first** item marked
    :data:`IN_PROGRESS` wins -- a well-formed list has one, a confused model
    writes several, and answering nothing for an ambiguous list would hide the
    caption exactly when it is most worth reading. :data:`ACTIVE_FORM` beats
    :data:`CONTENT`. And an item in progress carrying no usable text at all
    contributes nothing and does **not** stop the scan: what is being looked for
    is something to say, so an empty item must not throw away the one below it.

    Nothing marked in progress is ``""``, and so is every malformed shape --
    never "idle", never the last completed item, never the first pending one.
    An absence is a legitimate answer, the rule ``_parse_bash`` already follows
    when it would otherwise have to guess; inventing text is how a graph starts
    lying quietly, because a reader indexes a caption as a fact.

    The fold and the cap are deliberately **not** applied here. This function
    answers what the payload says; :func:`safe_caption` answers what may be
    drawn, and keeping them apart is what lets the second be reviewed without
    the first.
    """
    try:
        return _derive_caption(payload)
    except Exception:  # noqa: BLE001 - a raise here is a silently dropped client
        # `None` rather than `""`: a guard that fired knows nothing about the
        # payload, least of all whether it was a `TodoWrite`, and clearing a
        # caption on that ignorance would erase a true sentence.
        return None


def safe_caption(text: object) -> str:
    """What of a caption may be drawn: folded, then capped, head kept.

    The order is fixed and each stage has its own reason.

    **Strip the C0 and C1 controls, leaving a separator.** ``ctx.fillText`` does
    not break lines: a newline is handed to the platform shaper and comes back
    as a missing-glyph box or as nothing at all, and the caption silently stops
    being one line of legible text. So a control is not a formatting request, it
    is noise -- but it is noise *between* words, so it folds to a space rather
    than being removed, or two words the model wrote separately would be glued
    into one it never wrote.

    **Remove the bidirectional controls outright.** Those are zero-width and sit
    *inside* words, so a separator there would break a word in half; and the
    reason to remove them at all is :data:`_BIDI_CONTROLS`'s comment.

    **Collapse runs of whitespace, then strip the ends.** After the two removals
    a caption can be mostly spaces, and a cap counted over a string of spaces is
    a wide empty texture hanging under a figure -- which reads as a rendering
    fault rather than as silence.

    **Then** cap, at :data:`MAX_CAPTION_CHARS` code points, keeping the head.
    Capping first would count characters that are about to be removed and hand
    back an ellipsis over a caption that was never too long. Head-kept rather
    than a middle cut: ``truncateMiddle`` exists for paths, where both ends
    carry information, while a caption is a clause whose head is the verb and
    its object -- the reasoning ``actorDisplayName`` already records for the
    agent's own name.

    The fold is written as a **removal** and never as a replacement of one
    character class by another, which is what makes it idempotent: the browser
    applies the same rule again over the wire, because this daemon is not the
    only thing that could ever send the frame, and a fold that was not
    idempotent would turn defence in depth into a caption mangled once per layer
    it passes. It is a fold of *dangerous* characters and not an ASCII filter --
    accented Latin, CJK and emoji are ordinary text somebody wants to read.

    Total, like the derivation: anything that is not text is nothing to draw.
    """
    if not isinstance(text, str):
        return ""

    folded = " ".join("".join(_fold(text)).split())
    if len(folded) <= MAX_CAPTION_CHARS:
        return folded
    # Counted in code points, which is what Python slices in, and what the
    # browser has to be told to count too: cut on UTF-16 units instead and an
    # astral character lands half in and half out, drawn as a replacement mark.
    return folded[: MAX_CAPTION_CHARS - 1] + _ELLIPSIS


def _fold(text: str) -> Iterable[str]:
    for char in text:
        if char in _BIDI_CONTROLS:
            continue
        code = ord(char)
        if code < 0x20 or code == 0x7F or 0x80 <= code <= 0x9F:
            yield " "
            continue
        yield char


def _derive_caption(payload: object) -> str | None:
    if not isinstance(payload, dict):
        return None
    if _usable_text(payload.get("tool_name")) != TODO_WRITE:
        return None

    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return ""
    todos = tool_input.get(TODOS)
    if not isinstance(todos, list):
        return ""

    for item in todos:
        if not isinstance(item, dict) or item.get(_STATUS) != IN_PROGRESS:
            continue
        text = _usable_text(item.get(ACTIVE_FORM)) or _usable_text(item.get(CONTENT))
        if text:
            return text
    return ""


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
