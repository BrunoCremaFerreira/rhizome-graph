"""Contract tests (RED) for holding a watcher change until the hook has spoken.

Motivation, measured on 2026-08-29 against a live daemon with a real edit on
disk and a real payload through the real `hooks/emit_event.py`:

| sequence                                  | events published |
|-------------------------------------------|------------------|
| watcher alone, existing file              | 1 -- correct     |
| hook stamps first, then disk changes      | 1 -- correct     |
| **disk first, hook ~40 ms later**         | **2**            |
| **new file, disk first**                  | **2**            |

The last two rows are how `PostToolUse` really fires: the tool has already run
when the hook *process starts*, and that process is a 37-56 ms spawn. So the
watcher almost always wins the race, and the existing suppression points the
wrong way -- `ingest_fs_change` consults `_hook_paths`, but `ingest_line` never
consults `_fs_paths`. One suppression arrow, aimed the way the race does not go.

The new-file row is the worse one. The watcher's `A` is credited to nobody and
puts the path into `_known_paths`, so the hook's own event -- the one that knows
who did it -- normalizes to `M`: the agent is recorded as having *modified* a
file it created, and the creation belongs to a phantom. One measured session
accumulated a stats row reading `unattributed / 15 written`, every one of them
the watcher half of some agent's own edit.

**The shape specified here is deferral, not reverse suppression.** A change the
watcher sees is held for `FS_SETTLE_SECONDS`; a hook for the same path inside
that window is not a second event but the same change better described, and it
**supersedes** the pending one. Held changes nobody claims are published at the
end of the window. Dropping the *hook* instead would have been four lines and
would have converted every hook-covered write into a time-based guess -- two
subagents editing two files 40 ms apart both credited to whichever hook landed
last, which deletes exactly the exactness `CLAUDE.md` says the hook source
exists to provide.

Two consequences worth stating, because tests here rest on them:

  * **The `A`-then-`M` inversion is fixed by an absence, not by a mechanism.**
    Under deferral the watcher never reaches `_known_paths` before the hook
    normalizes, so `normalize_event` computes `A` for a genuine creation with no
    new rule at all.
  * **Deferral introduces one regression, and it lands with it.** A pending `M`
    for `src/a.py` followed by a hook `D` for `src` would flush 250 ms later and
    resurrect a file that no longer exists -- so a superseding deletion cancels
    the subtree, not only the path.

`schedule=None` keeps today's immediate publish. That is an honest default and
not a silent fork: a hub given no way to wake itself up cannot defer, and it is
what leaves the ~40 existing direct `EventHub(...)` call sites in this suite
green. Section 7 is the jaw that stops the *daemon* ever being such a hub.

Style: Arrange-Act-Assert, one failure reason per test.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

import daemon.server as server
from daemon.server import EventHub, Session
from fake_scheduler import FakeScheduler

ROOT = "/proj"
SESSION = "sess-abc"
SUBAGENT_ID = "a747fec535c143044"
SUBAGENT_TYPE = "developer-backend"

#: The hook process spawn, measured on this host and recorded in `CLAUDE.md`
#: (37-56 ms, plus a Unix-socket connect). It is the floor the settle window has
#: to clear: a window shorter than the thing it is waiting for waits for nothing.
#: Widen this only by re-measuring, and write the new number down with its date.
MEASURED_HOOK_SPAWN_SECONDS = 0.056


def _hook(
    tool_name: str = "Write",
    file_path: str | None = f"{ROOT}/src/app.py",
    command: str | None = None,
    agent_id: str | None = None,
    agent_type: str | None = None,
) -> str:
    tool_input: dict = {}
    if file_path is not None:
        tool_input["file_path"] = file_path
    if command is not None:
        tool_input = {"command": command}
    payload: dict = {
        "session_id": SESSION,
        "hook_event_name": "PostToolUse",
        "tool_name": tool_name,
        "tool_input": tool_input,
    }
    if agent_id is not None:
        payload["agent_id"] = agent_id
    if agent_type is not None:
        payload["agent_type"] = agent_type
    return json.dumps(payload)


def _sent(hub: EventHub) -> list[dict]:
    """Every message a freshly connecting client would receive, in order."""
    return [json.loads(m) for m in hub.replay_messages()]


def _events(hub: EventHub) -> list[dict]:
    """The activity frames alone -- an event is the frame with no `kind`."""
    return [m for m in _sent(hub) if "kind" not in m]


def _changes(hub: EventHub) -> list[dict]:
    """The activity frames the boot snapshot did not produce."""
    return [m for m in _events(hub) if m.get("origin") != "seed"]


def _without_ts(frames: list[dict]) -> list[dict]:
    """Frames compared field for field except the one that is a wall clock."""
    return [{k: v for k, v in frame.items() if k != "ts"} for frame in frames]


def _graph(hub: EventHub) -> set[str]:
    """The tree a client connecting *now* would end up drawing.

    The replay is the seed followed by the recent changes, and the browser
    applies them in order: an `A` or an `M` puts a node on the graph and a `D`
    takes it off. Folding them here is the difference between asserting what the
    hub said and asserting what the user is left looking at -- which is the only
    form in which "a wrong node stays on screen forever" can be pinned.
    """
    drawn: set[str] = set()
    for event in _events(hub):
        if event["type"] == "D":
            drawn.discard(event["path"])
        else:
            drawn.add(event["path"])
    return drawn


# --- 0. the double itself ---------------------------------------------------
#
# The scheduler is the fixture every specification below rests on, so it carries
# one test of its own. A double whose `cancel` did nothing would make the whole
# of section 2 pass while the daemon still published twice.


def test_cancelling_a_scheduled_callback_keeps_it_from_running():
    """The fake honours `.cancel()`, or every supersede test below is vacuous.

    `EventHub` cancels a pending change by calling `.cancel()` on the handle its
    scheduler returned, exactly as it would on an `asyncio.TimerHandle`. If the
    double ignored that, a test asserting "draining adds nothing" would be
    asserting that the double forgot, not that the hub cancelled.
    """
    schedule = FakeScheduler()
    fired: list[str] = []
    handle = schedule(0.25, lambda: fired.append("ran"))

    handle.cancel()

    assert (schedule.drain(), fired) == (0, [])


# --- 1. a watcher change is held, not published on sight --------------------


def test_a_watcher_change_is_held_instead_of_being_published_on_sight():
    """Nothing reaches the wire while the hook that owns it may still arrive.

    This is the whole feature in one assertion. Publishing here is what makes
    the hook's own event a *second* event rather than a better description of
    the same one, and publication cannot be taken back: it fans out to the
    replay buffer, the recent-changes list, the attention latch and the session
    counters, and `SessionStats.observe` is not invertible.
    """
    schedule = FakeScheduler()
    hub = EventHub(project_root=ROOT, schedule=schedule)

    hub.ingest_fs_change("src/new.py", "M")

    assert _changes(hub) == []


def test_the_held_change_is_published_verbatim_when_its_callback_runs():
    """Deferral changes *when* an unclaimed change is drawn, never *what*.

    A watcher change nobody claims is still the graph's only evidence that a
    human's editor, a build step or a `git checkout` touched the tree. The frame
    is compared against the one an unscheduled hub publishes immediately, so
    this stays true for every field at once -- type, path, colour, origin, agent
    and label -- rather than for the two a hand-written literal would name.
    """
    schedule = FakeScheduler()
    deferred = EventHub(project_root=ROOT, schedule=schedule)
    immediate = EventHub(project_root=ROOT)
    immediate.ingest_fs_change("src/new.py", "M")

    deferred.ingest_fs_change("src/new.py", "M")
    schedule.drain()

    assert _without_ts(_changes(deferred)) == _without_ts(_changes(immediate))


def test_a_hub_with_no_scheduler_publishes_immediately():
    """A JAW, not a RED: it passes today, and that is what it is for.

    `schedule=None` is the default, and roughly forty call sites across this
    suite construct an `EventHub` without one. They stay green because a hub
    with no way to wake itself up publishes on sight, exactly as it always has.
    That is a deliberate default rather than an accident of implementation, so
    it is pinned here: a later refactor that made an unscheduled hub defer would
    turn every one of those call sites into a hub that swallowed its events
    forever, and nothing else in this file would notice.
    """
    hub = EventHub(project_root=ROOT)

    hub.ingest_fs_change("src/new.py", "M")

    assert [(e["path"], e["type"]) for e in _changes(hub)] == [("src/new.py", "M")]


# --- 2. the relation between the three windows ------------------------------


def test_the_settle_window_is_shorter_than_the_windows_it_sits_inside():
    """`FS_SETTLE < COALESCE < DEDUPE`, or two docstrings stop being true.

    The values are not pinned; the relation is -- the idiom this project already
    uses for `STALE_WAIT_SECONDS > LONGEST_HUMAN_ABSENCE_SECONDS`, and it is
    what makes retuning free. What the ordering buys:

      * A settle window at or above `COALESCE_WINDOW_SECONDS` would let the
        created-then-modified pair of one write straddle the flush, so the tail
        of a write would arrive as a second edit instead of being folded away.
      * A settle window at or above `DEDUPE_WINDOW_SECONDS` would let a change
        flush after the hook's stamp had already expired, which is precisely the
        double this whole feature exists to remove, reintroduced at the far end.
    """
    assert (
        server.FS_SETTLE_SECONDS
        < server.COALESCE_WINDOW_SECONDS
        < server.DEDUPE_WINDOW_SECONDS
    )


def test_the_settle_window_outlasts_the_hook_spawn_it_waits_for():
    """The anti-degeneracy jaw: the relation above is satisfiable by zero.

    `FS_SETTLE_SECONDS = 0` orders correctly against the other two windows and
    defers nothing at all, restoring today's defect while every other assertion
    in this file still passed. So the window must clear the thing it is waiting
    for: the hook is a measured 37-56 ms process spawn plus a socket connect,
    and a window below that has already given up before the hook could possibly
    have started.
    """
    assert server.FS_SETTLE_SECONDS > MEASURED_HOOK_SPAWN_SECONDS


# --- 3. the hook supersedes the pending change ------------------------------


def test_a_hook_supersedes_the_pending_change_for_the_same_path():
    """One change, one event, and the actor is the one the hook names.

    This is the measured defect's third row. The watcher saw the edit first and
    knows only *what*; the hook knows *who*, exactly, and its event replaces the
    held one rather than joining it. Draining afterwards must add nothing -- a
    superseded change that still fires is the double moved 250 ms later, where
    it is harder to see and identical in effect.
    """
    schedule = FakeScheduler()
    hub = EventHub(project_root=ROOT, schedule=schedule)

    hub.ingest_fs_change("src/app.py", "M")
    hub.ingest_line(_hook())
    schedule.drain()

    assert [(e["path"], e["agent"]) for e in _changes(hub)] == [
        ("src/app.py", SESSION)
    ]


# --- 4. a read never cancels a pending change -------------------------------


def test_a_read_leaves_a_pending_change_alone():
    """A JAW, not a RED: it passes the moment step 3's GREEN is placed right.

    There is no new behaviour to specify here -- it pins *where* the cancel
    goes. `ingest_line` must cancel the pending change immediately before it
    stamps `_hook_paths`, which is **after** the `R` branch has already
    returned. Cancelled at the top of the method instead, a read would swallow a
    pending write: Read-then-Edit is the single commonest thing an agent does,
    the read arrives while the edit is still held, and the result is a change
    that happened on disk, was never drawn, and has no watcher correction
    coming -- because the watcher is the source that was silenced.

    The single assertion covers both halves at once: the read left no trace in
    the replay (`_broadcast_transient`'s contract, unchanged) and the held `M`
    still arrived at flush.
    """
    schedule = FakeScheduler()
    hub = EventHub(project_root=ROOT, schedule=schedule)

    hub.ingest_fs_change("src/app.py", "M")
    hub.ingest_line(_hook(tool_name="Read"))
    schedule.drain()

    assert [(e["type"], e["origin"]) for e in _changes(hub)] == [("M", "watch")]


# --- 5. op transitions inside the window ------------------------------------


def test_a_modification_folds_into_a_creation_still_being_held():
    """Writing a file emits created+modified milliseconds apart; that is one write.

    Today's `_just_reported` coalesce does this after publication. Under
    deferral the pair now lands inside the settle window instead, so the fold
    has to happen there too -- otherwise the tail of every single write becomes
    a second event, which is the defect this feature removes, produced by the
    feature itself.
    """
    schedule = FakeScheduler()
    hub = EventHub(project_root=ROOT, schedule=schedule)

    hub.ingest_fs_change("src/new.py", "A")
    hub.ingest_fs_change("src/new.py", "M")
    schedule.drain()

    assert [e["type"] for e in _changes(hub)] == ["A"]


def test_a_deletion_flushes_the_creation_it_finds_pending_before_it():
    """Create-then-delete inside one window is two facts, in that order.

    Any transition that is not the created-then-modified fold flushes the held
    entry first and then handles the new one, so the browser is never handed a
    deletion of a node it was never given. Dropping the pending `A` instead
    would leave `_known_paths` and the graph disagreeing about a file that
    briefly existed -- and the `D` would then be a deletion of nothing.
    """
    schedule = FakeScheduler()
    hub = EventHub(project_root=ROOT, schedule=schedule)

    hub.ingest_fs_change("src/new.py", "A")
    hub.ingest_fs_change("src/new.py", "D")
    schedule.drain()

    assert [e["type"] for e in _changes(hub)] == ["A", "D"]


# --- 6. a hook deletion cancels the pending subtree -------------------------


def test_a_hook_deletion_of_a_directory_cancels_the_changes_held_beneath_it():
    """The one regression deferral introduces, so it lands with the deferral.

    An agent edits `src/a.py` and then runs `rm -rf src`. The edit is still
    being held when the deletion arrives; the deletion publishes at once, and a
    quarter of a second later the held `M` fires and puts a file back on the
    graph that no longer exists -- clickable, and refused by `resolve_inside`
    when clicked. So the supersede rule is path, **plus the subtree whenever the
    superseding event is a deletion**.

    The assertion carries the matching presence beside the absence, and it was
    written the other way first: "no `M` for `src/a.py` arrives" is satisfied by
    a hub that has stopped saying anything about `src/a.py` at all, which is
    exactly what the cancel on its own produces. A pinned absence with nothing
    beside it passes over silence, and the silence here left the file on the
    graph for the rest of the session -- see the test below, which is the same
    defect stated as a graph rather than as a list of frames.
    """
    schedule = FakeScheduler()
    hub = EventHub(project_root=ROOT, schedule=schedule)
    hub.ingest_fs_change("src/a.py", "M")
    hub.seed_paths(["src/a.py"])

    hub.ingest_line(_hook(tool_name="Bash", file_path=None, command="rm -rf src"))
    schedule.drain()

    assert [e["type"] for e in _changes(hub) if e["path"] == "src/a.py"] == ["D"]


def test_an_agents_directory_deletion_still_prunes_the_subtree():
    """Cancelling the held deletions and expanding the hook's are one rule.

    Measured on 2026-08-30 in a browser against a live daemon, with a real
    watcher and a real payload through the real `hooks/emit_event.py`: a
    directory `gone/` holding `a.txt` and `b.txt`, both already drawn, and an
    agent running `rm -rf gone`. The files leave disk, the Bash hook arrives ~50
    ms later, and the only event published is `D gone`. `gone/a.txt` and
    `gone/b.txt` stay in `_known_paths`, are replayed to every client that
    connects afterwards, and are on the graph permanently -- `CLAUDE.md`: "a
    wrong node stays on screen forever".

    **This worked before the deferral landed.** The watcher published an
    expanded `D` per child and the hook's `D` was the redundant duplicate. Now
    the test above cancels the held per-child deletions, and the hook's own `D`
    goes out through `_publish`, which does not expand -- `_expand` is reached
    only from `_report_fs_change`. So the cancel and the expansion are two
    halves of one rule and only one half was implemented.

    **The specification: an agent's directory deletion deletes every file known
    beneath it as well as the directory, children first.** The order is not
    decoration. A parent removed before its children leaves the browser holding
    nodes whose ancestor is gone, and `_expand` already guarantees
    `[*children, path]` for the watcher's own deletions, so a second ordering
    for the hook's would be two answers to one question.

    Two shapes satisfy it, and they are not equivalent. Expanding the hook's
    deletion the way the watcher's is expanded makes that `D` self-sufficient,
    which is what makes cancelling the subtree safe in the first place. Letting
    the children's held `D`s flush on their own instead publishes the parent a
    quarter of a second *before* its children -- an ordering nothing in the
    browser has ever been given. The assertion is written against the behaviour
    and not against either mechanism, so the choice stays with the
    implementation.

    The second half of the assertion is what makes this a test about the graph
    rather than about a list of frames: the children must be absent from the
    tree a later client builds out of the replay, which is where the measured
    defect was actually visible.
    """
    schedule = FakeScheduler()
    hub = EventHub(project_root=ROOT, schedule=schedule)
    hub.seed_paths(["gone/a.txt", "gone/b.txt"])
    hub.ingest_fs_change("gone/a.txt", "D")
    hub.ingest_fs_change("gone/b.txt", "D")

    hub.ingest_line(_hook(tool_name="Bash", file_path=None, command="rm -rf gone"))
    schedule.drain()

    assert ([(e["type"], e["path"]) for e in _changes(hub)], _graph(hub)) == (
        [("D", "gone/a.txt"), ("D", "gone/b.txt"), ("D", "gone")],
        set(),
    )


# --- 7. the watcher's creation evidence survives the supersede --------------


def test_an_edit_hook_that_supersedes_a_held_creation_still_announces_a_creation():
    """The hook normalized before the kernel's evidence had been recorded.

    An `Edit` or `MultiEdit` payload normalizes to `M` whatever `_known_paths`
    says, and under deferral the watcher's `A` has deliberately not reached
    `_known_paths` yet. Cancel the held `A` with that hook and the creation of
    the node is never announced at all: the browser gets an amber modification
    of a file it has never been shown.

    So `_cancel_pending` reports the op it cancelled, and an `A` cancelled by an
    `M` republishes as an `A`. This is reconciliation and not a second
    add-vs-modify authority -- `known_paths` still decides; the pending `A` is
    simply the evidence of prior non-existence that the hook's normalization ran
    too early to see. Agent, label and timestamp all still come from the hook,
    and the colour has to move with the type or the frame carries a green `A`
    painted amber.
    """
    schedule = FakeScheduler()
    hub = EventHub(project_root=ROOT, schedule=schedule)

    hub.ingest_fs_change("docs/fresh.md", "A")
    hub.ingest_line(
        _hook(
            tool_name="Edit",
            file_path=f"{ROOT}/docs/fresh.md",
            agent_id=SUBAGENT_ID,
            agent_type=SUBAGENT_TYPE,
        )
    )
    schedule.drain()

    assert [
        (e["path"], e["type"], e["color"], e["agent"]) for e in _changes(hub)
    ] == [("docs/fresh.md", "A", "33FF33", SUBAGENT_ID)]


# --- 8. attribution is resolved at flush, not at arrival --------------------


def test_a_held_change_is_attributed_by_the_agent_active_when_it_flushes():
    """The glob case, which the deferral turns from a loss into a gain.

    `cp *.md docs/` reaches `_parse_bash`, which stays silent by design rather
    than inventing a path, so the hook publishes nothing -- but it does stamp
    the actor, and it does so ~40 ms *after* the copies hit disk. Reading the
    actor when the watcher's change arrives leaves every one of those files
    anonymous; reading it when the change flushes credits them all to the agent
    that ran the command. So `_defer` stores the op and the handle and no actor,
    and `_flush` asks `_active_agent()`.
    """
    schedule = FakeScheduler()
    hub = EventHub(project_root=ROOT, schedule=schedule)

    hub.ingest_fs_change("docs/copied.md", "A")
    hub.ingest_line(
        _hook(
            tool_name="Bash",
            file_path=None,
            command="cp *.md docs/",
            agent_id=SUBAGENT_ID,
            agent_type=SUBAGENT_TYPE,
        )
    )
    schedule.drain()

    assert [(e["path"], e["agent"], e["label"]) for e in _changes(hub)] == [
        ("docs/copied.md", SUBAGENT_ID, SUBAGENT_TYPE)
    ]


# --- 9. the hook-first path is unchanged ------------------------------------
#
# Three jaws. The race has a winning side as well as a losing one, and the
# winning side is the one that already worked: when the hook arrives first, the
# watcher's echo is suppressed by `_hook_paths` exactly as it always was, and
# nothing in this feature may disturb that. These mirror
# `tests/test_hub_seed_and_attribution.py`'s own two assertions on that path.


def test_a_hook_arriving_before_the_watcher_is_still_exactly_one_frame():
    """A JAW, not a RED: it passes today, and it must go on passing.

    The forward suppression is the half of the dedupe that was never broken.
    """
    hub = EventHub(project_root=ROOT)
    hub.ingest_line(_hook())

    hub.ingest_fs_change("src/app.py", "M")

    assert [e["path"] for e in _changes(hub)] == ["src/app.py"]


def test_the_same_pair_is_two_frames_once_the_dedupe_window_has_passed():
    """A JAW, not a RED: it passes today, and it must go on passing.

    The suppression is a window, not a permanent claim on the path: an edit two
    seconds after the hook is a second edit and has to be drawn.
    """
    hub = EventHub(project_root=ROOT, dedupe_window=0.0)
    hub.ingest_line(_hook())

    hub.ingest_fs_change("src/app.py", "M")

    assert [e["path"] for e in _changes(hub)] == ["src/app.py", "src/app.py"]


def test_the_hook_first_path_leaves_nothing_held():
    """A JAW, not a RED: it passes today, and that is what it is for.

    A suppressed watcher echo must be *dropped*, never *deferred*. Deferring it
    would leave a callback holding the path, so the flush would publish the very
    echo the suppression exists to remove -- the double restored, a quarter of a
    second late. Written with `getattr` because the buffer does not exist yet
    and the property is "whatever pending buffer there is, this path left
    nothing in it", which is true of a hub that has none.
    """
    hub = EventHub(project_root=ROOT)
    hub.ingest_line(_hook())

    hub.ingest_fs_change("src/app.py", "M")

    assert getattr(hub, "_pending", {}) == {}


# --- 10. the daemon hands its hub a real scheduler --------------------------
#
# Everything above proves the hub *can* defer. These two prove the daemon
# actually asks it to -- which is the one thing a fake scheduler can never show,
# and the reason `schedule=None` being a safe default is not also a way for the
# feature to ship switched off.
#
# The scheduler `Session` passes must be **lazy** -- resolving the running loop
# inside the call rather than capturing one at construction -- because many
# tests in this suite build a `Session` at module scope, off any loop at all.
# Only `ingest_fs_change` needs the loop, and it always has one: the watcher's
# thread reaches it through `call_soon_threadsafe`.


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
        session.stop()


def _run(coro):
    return asyncio.run(asyncio.wait_for(coro, timeout=30))


def test_a_session_holds_a_watcher_change_instead_of_publishing_it(
    tmp_path: Path, make_session
):
    """The daemon's own hub defers, or the whole feature is switched off.

    `EventHub(project_root=...)` built by hand keeps publishing on sight -- that
    is the default forty call sites depend on -- so nothing above would fail if
    `Session` simply never passed a scheduler. This is the assertion that would.
    """

    async def scenario():
        session = make_session(tmp_path)

        session.hub.ingest_fs_change("src/app.py", "M")

        assert _changes(session.hub) == []

    _run(scenario())


def test_a_session_publishes_the_held_change_once_the_window_has_passed(
    tmp_path: Path, make_session
):
    """And it publishes it by itself, with no second event to wake it up.

    A deferral that only ever flushed when the *next* change arrived would keep
    a lone edit off the graph for the rest of the session. The wait is the real
    `FS_SETTLE_SECONDS` against a real loop -- this is the only place in this
    file where the constant is a duration rather than a number in a relation.
    """

    async def scenario():
        session = make_session(tmp_path)
        session.hub.ingest_fs_change("src/app.py", "M")

        await asyncio.sleep(server.FS_SETTLE_SECONDS * 2 + 0.1)

        assert [(e["path"], e["type"]) for e in _changes(session.hub)] == [
            ("src/app.py", "M")
        ]

    _run(scenario())
