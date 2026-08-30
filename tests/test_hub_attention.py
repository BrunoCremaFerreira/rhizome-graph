"""Contract tests (RED) for the attention verdict on EventHub, and its frame.

Motivation: `EventHub` holds the tree, who changed it, the caption, the status
panel and the agent states -- and no policy. Every activity event is encoded and
fanned out in one of exactly three places, and that shape is the whole reason
this feature is cheap:

  * `_publish` -- the write path, hook and watcher alike.
  * `_broadcast_transient` -- the read path.
  * `seed_paths` -- the boot snapshot, which builds its own message and touches
    neither of the other two.

So a verdict evaluated in the first two is a verdict the seed never asks, and
"the boot snapshot never alarms" is a consequence of the existing shape rather
than a condition somebody has to remember to write. On this host's home
directory the seed is 12 524 events; at the measured 5.35 us per match that is
67 ms of matching for a snapshot in which no agent did anything, and it is never
paid.

Two rules decide the wire, and both are read from `parse_command`'s own:

  * **The verdict is a field on the event, never a second frame.** A second frame
    would name the path again and arrive out of order with the event it
    describes, so the browser would hold unmatched alarms waiting for their
    events -- a join. A boolean on the frame that already names the path cannot
    desynchronize.
  * **The key is CONDITIONAL: present only when the answer is true.** This is
    `parse_command`'s "a key appears only when the frame carried it in a form
    this daemon understands", read from the other direction. It also makes the
    wire cost of this feature exactly zero for the events that do not alarm.

**Which is where `_encode` comes in, and it is the sharpest trap in the file.**
`_encode` is `json.dumps(asdict(event))`, and `asdict` emits **every** field of
the dataclass unconditionally. So the first implementation that adds
`attention: bool = False` to `Event` and leaves `_encode` alone puts
`"attention":false` on all 12 524 seed events --
`test_an_event_that_does_not_match_carries_no_attention_key_at_all` is what
forces `_encode` to stop being a bare `asdict`.

The rule source travels separately, and it must: `source: ""` -- no rule file was
found -- is a fact about no event at all, and it is the fact R7 exists for. It
rides a replaceable slot of its own, `set_status`'s mechanism copied, replayed
after the agent states and before the tree.

Style: Arrange-Act-Assert, one property per test.
"""

from __future__ import annotations

import ast
import asyncio
import json
from pathlib import Path

import pytest
from websockets.asyncio.client import connect

import daemon.server as server
from daemon.server import EventHub, Session, start_server
from rhizome_graph import gitignore

# The module does not exist yet: this import failing IS the first RED here, and
# it is deliberate -- the hub's new method takes an `AttentionRules`, so a test
# that faked one would be specifying a shape nobody has to honour.
from rhizome_graph import attention

ROOT = "/proj"
SESSION = "sess-abc"
SUBAGENT_ID = "a747fec535c143044"
SUBAGENT_TYPE = "developer-tester"

#: The rule every test below arms unless it says otherwise. One pattern, because
#: what is under test is the verdict reaching the wire, not the matcher.
WATCHED = "package.json"
IGNORED = "web/src/a.ts"

#: A lifecycle payload's event key and the notification name. Literals, exactly
#: as `tests/test_hub_agent_state.py` spells them and for its reason: they are
#: assumptions a real capture may correct, and this file must not fail on them.
EVENT_KEY = "hook_event_name"
NOTIFICATION = "Notification"


def _rules(text: str, source: str = f"{ROOT}/.rhizome-attention") -> "attention.AttentionRules":
    """An `AttentionRules` built without touching a disk."""
    return attention.AttentionRules(
        rules=gitignore.parse_patterns(text),
        source=source,
        refused=(),
        truncated=False,
    )


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


def _attention_frames(hub: EventHub) -> list[dict]:
    return [m for m in _sent(hub) if m.get("kind") == "attention"]


def _run(coro):
    return asyncio.run(asyncio.wait_for(coro, timeout=30))


#: The last thing every live-client scenario below does. A frame that must
#: arrive after the ones under test, so a message that is never broadcast fails
#: on an assertion instead of hanging until the timeout.
MARKER = "marker.py"


async def _frames_to_the_marker(hub: EventHub, actions) -> list[dict]:
    """Run `actions` against a live client and collect frames up to the marker.

    A real socket, because a transient event is by definition not in the replay:
    the only place to see one is on the wire. Collected up to a sentinel rather
    than by a count, because what arrives before it -- a replayed slot, a second
    frame that should have been deduped -- is exactly what these tests are
    counting.
    """
    listener = await start_server(hub, host="127.0.0.1", port=0, static_root=None)
    port = next(iter(listener.sockets)).getsockname()[1]
    async with listener, connect(f"ws://127.0.0.1:{port}/ws") as ws:
        actions()
        frames: list[dict] = []
        while True:
            frames.append(json.loads(await asyncio.wait_for(ws.recv(), timeout=5)))
            if frames[-1].get("path") == MARKER:
                return frames


# --- 1. the verdict rides the event that names the path ---------------------


def test_a_hook_event_on_a_watched_path_carries_the_verdict():
    hub = EventHub(project_root=ROOT)
    hub.set_attention(_rules(f"{WATCHED}\n"))

    hub.ingest_line(_write(WATCHED))

    assert _events(hub)[-1].get("attention") is True


def test_a_hook_event_on_a_path_no_rule_names_carries_no_attention_key():
    """Absent, not `false`: the conditional key is what makes the cost zero."""
    hub = EventHub(project_root=ROOT)
    hub.set_attention(_rules(f"{WATCHED}\n"))

    hub.ingest_line(_write(IGNORED))

    assert "attention" not in _events(hub)[-1]


def test_a_watcher_change_on_a_watched_path_carries_the_verdict():
    """The watcher path is `_publish` too, so it needs nothing extra -- and the
    test is here because the obvious implementation puts the verdict in
    `ingest_line`, where the watcher never goes."""
    hub = EventHub(project_root=ROOT)
    hub.set_attention(_rules(f"{WATCHED}\n"))

    hub.ingest_fs_change(WATCHED, "M")

    assert _events(hub)[-1].get("attention") is True


def test_a_watched_watcher_change_keeps_the_agent_it_was_credited_to():
    """The verdict is added to the event, never substituted for it.

    Attribution is the whole point of the graph, and a rewritten frame is the
    cheapest way to lose it: the alarm would name a file and nobody.
    """
    hub = EventHub(project_root=ROOT)
    hub.set_attention(_rules(f"{WATCHED}\n"))
    hub.ingest_line(_write("src/app.py", agent_id=SUBAGENT_ID, agent_type=SUBAGENT_TYPE))

    hub.ingest_fs_change(WATCHED, "M")

    event = _events(hub)[-1]
    assert (event["agent"], event["label"], event.get("attention")) == (
        SUBAGENT_ID,
        SUBAGENT_TYPE,
        True,
    )


# --- 2. a read alarms, and is still a read ----------------------------------


def test_a_read_of_a_watched_path_carries_the_verdict():
    """An agent *reading* `.env` is the case a supervision feature exists for.

    It is only survivable because the browser latches one alarm per path: reads
    arrive roughly ten times more often than writes.
    """
    hub = EventHub(project_root=ROOT)
    hub.set_attention(_rules(f"{WATCHED}\n"))

    def actions() -> None:
        hub.ingest_line(_read(WATCHED))
        hub.ingest_line(_write(MARKER))

    frames = _run(_frames_to_the_marker(hub, actions))

    reads = [f for f in frames if f.get("type") == "R"]
    assert reads and reads[0].get("attention") is True


def test_a_read_that_alarms_is_still_never_replayed():
    """A read is a flash, not a fact about the project -- verdict or no verdict.

    Asserted through the replay rather than through a private attribute, because
    what must not change is what a client connecting later is handed: a
    re-enactment of somebody's reading, in a finite ring that the real changes
    would then be pushed out of.
    """
    hub = EventHub(project_root=ROOT)
    hub.set_attention(_rules(f"{WATCHED}\n"))

    hub.ingest_line(_read(WATCHED))

    assert _events(hub) == []


def test_a_read_that_alarms_still_leaves_the_next_write_an_add():
    """The other half of "a read is not a change": `_known_paths` is untouched.

    Read-then-Edit is the commonest thing an agent does, so a read routed through
    the write path would draw the write that follows it as a modification of a
    node no browser was ever shown.
    """
    hub = EventHub(project_root=ROOT)
    hub.set_attention(_rules(f"{WATCHED}\n"))
    hub.ingest_line(_read(WATCHED))

    hub.ingest_line(_write(WATCHED))

    assert _events(hub)[-1]["type"] == "A"


# --- 3. the seed never alarms -----------------------------------------------


def test_the_seed_never_carries_the_verdict_however_well_a_path_matches():
    """Structural, not filtered: `seed_paths` simply never asks.

    The obvious "consistency" refactor is to route the seed through the same
    place the other two go, and on a home directory that is 12 524 alarms for a
    snapshot in which nobody did anything.
    """
    hub = EventHub(project_root=ROOT)
    hub.set_attention(_rules(f"{WATCHED}\n"))

    hub.seed_paths([WATCHED, IGNORED])

    assert [m.get("attention") for m in _events(hub)] == [None, None]


def test_no_replayed_frame_of_a_seeded_tree_carries_the_verdict():
    """Said of the replay as a whole, because that is what a new client gets."""
    hub = EventHub(project_root=ROOT)
    hub.set_attention(_rules(f"{WATCHED}\n"))

    hub.seed_paths([WATCHED])

    assert [m for m in _sent(hub) if "attention" in m] == []


# --- 4. absence is absence, everywhere --------------------------------------


def test_an_event_that_does_not_match_carries_no_attention_key_at_all():
    """The `asdict` jaw, and the reason this file's docstring names `_encode`.

    `_encode` is `json.dumps(asdict(event))`, and `asdict` emits every field of
    the dataclass unconditionally. So the first implementation that adds
    `attention: bool = False` to `Event` and leaves `_encode` alone passes every
    other test in this file and ships `"attention":false` on every event a daemon
    ever sends -- which is exactly what the conditional key is for. All three
    fan-out paths are asserted here in one place because all three go through
    that one function.
    """
    hub = EventHub(project_root=ROOT)
    hub.set_attention(_rules("*.pem\n"))

    hub.ingest_line(_write(IGNORED))
    hub.ingest_fs_change("docs/notes.md", "M")
    hub.seed_paths(["README.md"])

    offenders = [m for m in _events(hub) if "attention" in m]
    assert offenders == [], (
        "these frames carry an `attention` key with nothing to report: "
        f"{offenders}. The key is present only when the answer is true, so "
        "`_encode` cannot stay a bare `asdict` over a dataclass field."
    )


def test_with_no_rules_in_force_nothing_ever_carries_the_key():
    """The boot state of every project that has never heard of this feature."""
    hub = EventHub(project_root=ROOT)
    hub.set_attention(attention.EMPTY)

    hub.ingest_line(_write(WATCHED))
    hub.ingest_fs_change(WATCHED, "M")
    hub.seed_paths(["README.md"])

    assert [m for m in _events(hub) if "attention" in m] == []


def test_a_hub_nobody_ever_armed_publishes_events_exactly_as_before():
    """`set_attention` is opt-in; every existing caller of the hub omits it.

    A jaw, and green once the module exists: it is here so that a hub built by
    any of the seventy-odd existing tests cannot start emitting a key none of
    them expects.
    """
    hub = EventHub(project_root=ROOT)

    hub.ingest_line(_write(WATCHED))

    assert "attention" not in _events(hub)[-1]


# --- 5. one call site, asserted over the parsed source ----------------------
#
# Two call sites for one policy is how a later "reads should not alarm" change
# lands in one of them and not the other, and the symptom -- reads alarming in
# one build and not the next -- is invisible in any single test. It is also the
# seam the planned session-stats counters need, so whichever feature lands first
# creates it and the second must not add a parallel hook.

#: The names that mean "the verdict was asked for". `match_rules` is in the list
#: as well as `matches`, because reaching past `attention.py` straight into the
#: matcher is the same breach wearing a different spelling.
MATCHER_NAMES = ("matches", "match_rules")

#: The one method that may ask, and the two that must go through it.
OBSERVER = "_observe"
FAN_OUT = ("_publish", "_broadcast_transient")


def _hub_methods() -> dict[str, ast.AST]:
    """Every method of `EventHub`, by name, from the parsed source.

    Scoped to the class rather than to the file on purpose: `completion_response`
    at module level has a local named `matches` -- the tab-completion candidates
    -- and a file-wide scan would count it, then read as satisfied by the wrong
    function and go red the moment the right one appears.
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

    Identifiers rather than raw text, so the docstring that is expected to
    explain this rule does not satisfy it.
    """
    used: set[str] = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Name):
            used.add(child.id)
        elif isinstance(child, ast.Attribute):
            used.add(child.attr)
    return used


def test_exactly_one_method_of_the_hub_asks_the_matcher():
    """One policy, one call site -- and it is the one both fan-outs share.

    Two call sites is how a later "reads should not alarm" change lands in the
    write path and not the read path, and the symptom is a build where a read
    alarms and the next where it does not, invisible to any single test.
    """
    askers = sorted(
        name
        for name, node in _hub_methods().items()
        if _names_used(node) & set(MATCHER_NAMES)
    )

    assert askers == [OBSERVER], (
        f"{askers or 'no method of EventHub'} asks the attention matcher; it "
        f"belongs in {OBSERVER} and nowhere else."
    )


def test_both_fan_out_paths_go_through_the_observer():
    functions = _hub_methods()

    assert OBSERVER in functions, (
        f"there is no {OBSERVER} in daemon/server.py: the verdict and the "
        "encoding belong in one place that both the write path and the read path "
        "call."
    )
    missing = [name for name in FAN_OUT if OBSERVER not in _names_used(functions[name])]
    assert missing == [], f"{missing} does not go through {OBSERVER}."


def test_the_seed_does_not_go_through_the_observer():
    """The exemption is structural, and this is the guard on the refactor."""
    functions = _hub_methods()
    callers = sorted(
        name
        for name, node in functions.items()
        if name != OBSERVER and OBSERVER in _names_used(node)
    )

    assert callers == sorted(FAN_OUT), (
        f"{OBSERVER} is called by {callers}. It exists for the two fan-out paths "
        "and for nothing else: `seed_paths` asking it would alarm 12 524 times "
        "on a fresh home directory."
    )


# --- 6. the rule source, in a frame of its own ------------------------------


def test_arming_the_rules_tells_every_client_which_file_they_came_from():
    """The header's three facts: which file, how many rules, how many refused.

    Stated always, not only on failure. "No rule file was found" and "eleven
    rules are in force" are both things the reader has to be able to see, because
    an empty alarm panel is what a healthy session looks like too.
    """
    hub = EventHub(project_root=ROOT)
    rules = attention.AttentionRules(
        rules=gitignore.parse_patterns(f"{WATCHED}\n*.pem\n"),
        source=f"{ROOT}/.rhizome-attention",
        refused=("[[:alpha:]].pem",),
        truncated=False,
    )

    hub.set_attention(rules)

    assert _attention_frames(hub) == [
        {
            "kind": "attention",
            "source": f"{ROOT}/.rhizome-attention",
            "count": 2,
            "refused": ["[[:alpha:]].pem"],
            "truncated": False,
        }
    ]


def test_the_frame_says_so_when_no_rule_file_was_read_at_all():
    """`source: ""` is the case R7 exists for, and it must reach the browser.

    A typo in `RHIZOME_ATTENTION` that names a *readable* file with the wrong
    contents, or a `ctrl+L` into a project with no rule file, both end here -- and
    the panel can only tell the reader if the daemon says it.
    """
    hub = EventHub(project_root=ROOT)

    hub.set_attention(attention.EMPTY)

    assert _attention_frames(hub) == [
        {
            "kind": "attention",
            "source": "",
            "count": 0,
            "refused": [],
            "truncated": False,
        }
    ]


def test_the_rule_source_follows_the_status_panel_and_the_agent_states():
    # Pairwise, never by absolute index: other planned frames insert into this
    # same gap, and none of them is a regression in this one.
    hub = EventHub(project_root=ROOT)

    hub.set_status({"kind": "status", "repo": True, "truncated": False, "entries": []})
    hub.ingest_line(json.dumps({EVENT_KEY: NOTIFICATION, "session_id": SESSION}))
    hub.set_attention(_rules(f"{WATCHED}\n"))

    kinds = _kinds(hub)
    assert "attention" in kinds, "arming the rules put nothing on the wire"
    assert "agentState" in kinds, "the lifecycle line produced no agent state at all"
    assert kinds.index("status") < kinds.index("attention")
    assert kinds.index("agentState") < kinds.index("attention")


def test_the_rule_source_precedes_the_tree():
    """A header behind twenty thousand seed events is a header nobody sees.

    `set_status`'s own rule: the panel is right on the first paint rather than
    seconds later, on a graph that has already settled.
    """
    hub = EventHub(project_root=ROOT)

    hub.set_attention(_rules(f"{WATCHED}\n"))
    hub.seed_paths([WATCHED])

    kinds = _kinds(hub)
    assert "attention" in kinds, "arming the rules put nothing on the wire"
    assert kinds.index("attention") < kinds.index("event")


def test_a_reset_forgets_which_rules_were_in_force():
    """The rules belong to a project the user has left.

    Left in place, the header would name the previous project's rule file over
    the new project's graph -- and after a `ctrl+L` an explicit rule file is
    re-anchored to the new root, so the numbers would be wrong as well as stale.
    """
    hub = EventHub(project_root=ROOT)
    hub.set_attention(_rules(f"{WATCHED}\n"))

    hub.reset("/other")

    assert _attention_frames(hub) == []


def test_arming_the_same_rules_twice_says_nothing_the_second_time():
    """Deduped on the encoded message, exactly as `set_status` is.

    The rules are re-read on every root switch and may be re-armed by any caller;
    a header that has not changed costs nothing on the wire.
    """
    hub = EventHub(project_root=ROOT)
    rules = _rules(f"{WATCHED}\n")

    def actions() -> None:
        hub.set_attention(rules)
        hub.set_attention(_rules(f"{WATCHED}\n"))
        hub.ingest_line(_write(MARKER))

    frames = _run(_frames_to_the_marker(hub, actions))

    assert [f.get("kind", "event") for f in frames] == ["attention", "event"]


# --- 7. the rules belong to the root, and follow it -------------------------


@pytest.fixture
def make_session(monkeypatch):
    """Sessions whose watcher threads are stopped, and which fork no `git`.

    `switch_root` publishes the status panel, which would otherwise fork `git`
    once per test for an answer nothing here reads.
    """
    async def _no_status(_root):
        return None

    monkeypatch.setattr(server, "git_status", _no_status)
    made: list[Session] = []

    def _make(project_root: Path, **kwargs) -> Session:
        session = Session(project_root=str(project_root), home=str(project_root), **kwargs)
        made.append(session)
        return session

    yield _make

    for session in made:
        session.stop()


def _project(root: Path, rules: str | None = None) -> Path:
    """A directory, optionally carrying a rule file at the default name."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "package.json").write_text("{}\n", encoding="utf-8")
    (root / "key.pem").write_text("not a key\n", encoding="utf-8")
    if rules is not None:
        (root / attention.DEFAULT_RULE_FILE).write_text(rules, encoding="utf-8")
    return root


def test_a_session_loads_the_rule_file_under_the_root_it_observes(
    tmp_path: Path, make_session
):
    """The default is `<root>/.rhizome-attention`, resolved by the session.

    `Settings` carries the path as a string and never resolves it, because
    resolving needs a root -- and the root is the one thing a `ctrl+L` can
    change. So the join lives here, in the object that owns the root.
    """
    root = _project(tmp_path / "observed", f"{WATCHED}\n")

    session = make_session(root)

    frames = _attention_frames(session.hub)
    assert frames and frames[-1]["source"] == str(root / attention.DEFAULT_RULE_FILE)


def test_a_root_switch_publishes_the_new_projects_rule_file(
    tmp_path: Path, make_session
):
    old = _project(tmp_path / "old", f"{WATCHED}\n")
    new = _project(tmp_path / "new", "*.pem\n*.lock\n")
    session = make_session(old)

    async def scenario():
        await session.switch_root(str(new))

    _run(scenario())

    frames = _attention_frames(session.hub)
    assert frames and (frames[-1]["source"], frames[-1]["count"]) == (
        str(new / attention.DEFAULT_RULE_FILE),
        2,
    )


def test_an_event_after_a_switch_is_matched_against_the_new_projects_rules(
    tmp_path: Path, make_session
):
    """Loaded before the re-seed, so the first event after a switch is right.

    The two rule files disagree on purpose: `package.json` alarms under the old
    project and `key.pem` under the new one, so a session that kept the old rules
    fails on both halves at once.
    """
    old = _project(tmp_path / "old", f"{WATCHED}\n")
    new = _project(tmp_path / "new", "*.pem\n")
    session = make_session(old)

    async def scenario():
        await session.switch_root(str(new))
        session.hub.ingest_fs_change(WATCHED, "M")
        session.hub.ingest_fs_change("key.pem", "M")
        # A session's hub defers what the watcher reports for
        # `FS_SETTLE_SECONDS`, so a hook arriving a moment later supersedes it
        # instead of adding a second event for one change (see
        # `tests/test_hub_fs_settle.py`). Nothing about the rules changes; the
        # two frames simply are not on the wire yet when the scenario returns,
        # so the loop is advanced past the window before anything is read.
        # `getattr` on purpose: this test specifies the attention rules and not
        # the settle window, so it must stay green on both sides of that GREEN.
        await asyncio.sleep(getattr(server, "FS_SETTLE_SECONDS", 0.0) * 2 + 0.1)

    _run(scenario())

    changed = [m for m in _events(session.hub) if m.get("origin") == "watch"]
    assert [(m["path"], m.get("attention")) for m in changed] == [
        (WATCHED, None),
        ("key.pem", True),
    ]


def test_an_explicit_rule_file_does_not_move_with_the_root(
    tmp_path: Path, make_session
):
    """"A default may be adjusted; an explicit request may not", once more.

    The patterns *are* re-anchored to the new root, silently -- a pattern language
    whose meaning depends on a root the page can change cannot avoid that -- and
    naming the file in the frame is what makes the re-anchoring visible instead
    of merely surprising.
    """
    explicit = tmp_path / "elsewhere" / "attention-rules"
    explicit.parent.mkdir(parents=True)
    explicit.write_text("*.pem\n", encoding="utf-8")
    old = _project(tmp_path / "old", f"{WATCHED}\n")
    new = _project(tmp_path / "new", f"{WATCHED}\n")
    session = make_session(old, attention_rules=str(explicit))

    async def scenario():
        await session.switch_root(str(new))

    _run(scenario())

    frames = _attention_frames(session.hub)
    assert frames and frames[-1]["source"] == str(explicit)
