"""Contract tests (RED) for rhizome_graph.session_stats: who did what, counted.

Motivation: nothing in this program counts anything. `EventHub` holds
`_known_paths`, `_seed`, `_recent`, `_meta`, `_status`, `_agent_states`,
`_attention`, `_reset`, `_last_hook`, `_hook_paths` and `_fs_paths` -- a set, two
buffers, four slots and two dedupe maps -- and not one of them is per agent.
`_last_hook` is a single `(agent, label, timestamp)` triple that is *overwritten*,
never accumulated. So the one question anybody watching a long session asks --
"what did this agent actually do?" -- has no answer anywhere, and the browser
cannot compute it either: a client that reconnects is replayed the seed plus the
last `REPLAY_BUFFER_SIZE` (200) events, everything before that is gone, and
nothing in the replay marks the loss. A browser-side counter is therefore not
merely approximate, it is *silently* approximate, and two tabs opened five
minutes apart disagree about the same session with no way for either to know.

Hence a daemon-side accumulator, in a module of its own. Not in `server.py`
(1 285 lines already owning the hub, the session, the command parser, the two
gates, the HTTP handler and `main`, where a counter model is untestable without
constructing a hub), not in `normalize.py` (pure by contract and on the hook's
hot path), not in `status.py` (nothing about a counter is the porcelain format).

**The inversion the implementer must write into the module docstring.**
`web/src/eventLog.ts` drops every `R` outright, because that panel is a list of
*changes* and an agent reads roughly ten times more than it writes, so reads
would push every real edit off the top within seconds. This module does the
opposite on purpose: "it read 340 files and wrote 12" is the single most
informative line the panel can produce, and dropping the reads throws it away.
Say so in the docstring, or the next reader "fixes" it back into `eventLog`'s
rule and nobody notices, because the number that goes missing looks like a
number that was never there.

Four more properties, each of which is a test below:

  * **`observe` is never offered a seed event, and this module does not filter
    for one.** The exemption is the caller's wiring -- `seed_paths` builds its own
    message and touches neither fan-out path -- and `tests/test_hub_stats.py` is
    what pins it. A filter here would be a second guard that hides a wiring
    mistake instead of failing on it, so nothing in this file asserts anything
    about `origin`.
  * **Reads and writes are separate fields and are never summed into a total.**
    A total invites the reader to compare it with the recent-changes list, which
    drops reads.
  * **The per-path map's length IS the distinct-path count.** Two counters that
    have to agree are two counters that can drift; the
    `sizes.MAX_FILES is tree.DEFAULT_MAX_FILES` reflex applied to a data
    structure.
  * **The cap stops new keys and keeps incrementing the ones already there.**
    Never an LRU eviction, which can evict the very file the agent kept returning
    to and would make "most visited" wrong without saying so.

**The wire shape pinned here is the one `web/src/protocol.ts` will parse**, so it
is written out once, in `test_the_frame_is_exactly_the_shape_the_browser_parses`,
and every other assertion reads through it:

    {"kind": "stats", "agents": [
      {"agent": "a1", "label": "developer-backend", "writes": 3, "reads": 9,
       "files": 7, "dirs": 2, "topPath": "src/x.py", "topCount": 4,
       "firstTs": 1.0, "lastTs": 9.0, "truncated": false}]}

Two orderings live in it and they are deliberately not the same one. The
**frame** is ordered by write count descending, ties by agent ascending -- that
and nothing else, so a `set_status`-style dedupe on the encoded string actually
fires when nothing changed. The **panel** re-sorts, because decision 8 puts the
unattributed row last regardless of its counts; that belongs to
`web/tests/statsPanel.test.ts` and is not a property of this module.

Style: Arrange-Act-Assert, one property per test.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

from rhizome_graph.normalize import Event


# --- The module under specification, imported where it is used --------------
#
# Not at module scope: a top-level import of a module that does not exist yet
# fails at collection and reddens the whole file with one error instead of
# telling each test what it was asking for. `tests/test_content_search.py` and
# `tests/test_safe_read.py` import through a helper for the same reason.


def _module():
    import rhizome_graph.session_stats as session_stats

    return session_stats


def _stats():
    return _module().SessionStats()


#: The colours the wire carries per operation. Respelled here rather than
#: imported from `normalize`'s privates because nothing in this module may read
#: them: an event's colour says how to draw it, never who did it or how often.
COLOR = {"A": "33FF33", "M": "FFAA00", "D": "FF3333", "R": "AA66FF"}


def _event(
    agent: str,
    path: str,
    type: str = "M",
    ts: float = 1.0,
    label: str = "",
) -> Event:
    """One real `Event`, never a stand-in.

    The daemon hands this module the very dataclass `normalize` produces, so a
    stub here would specify a shape nobody has to honour.
    """
    return Event(ts=ts, agent=agent, type=type, path=path, color=COLOR[type], label=label)


def _agents(stats) -> list[dict]:
    return stats.frame()["agents"]


def _row(stats, agent: str) -> dict:
    """The one row for `agent`, or a failure naming who is actually there."""
    rows = [row for row in _agents(stats) if row["agent"] == agent]
    assert len(rows) == 1, (
        f"expected exactly one row for {agent!r}, found "
        f"{[row['agent'] for row in _agents(stats)]}"
    )
    return rows[0]


# --- 1.3 agent is identity, label is only text ------------------------------
#
# Written first, and it is the whole reason this module keys on what it keys on.
# `label` is the readable one -- `developer-backend`, `developer-tester` -- so it
# is the one an implementer reaches for, and keying on it silently merges two
# subagents of one type into a single row while a renamed type forks one agent
# into two. `CLAUDE.md` states the rule for the renderer's actors
# (`hashColor("actor:" + agent)`); a row is the same rule applied to a table.


def test_two_agents_of_the_same_type_are_two_rows():
    """Two subagents of one type are two workers, and the table must say so."""
    stats = _stats()

    stats.observe(_event("a1", "src/a.py", label="developer-backend"))
    stats.observe(_event("a2", "src/b.py", label="developer-backend"))

    assert sorted(row["agent"] for row in _agents(stats)) == ["a1", "a2"]


def test_one_agent_that_renamed_itself_is_still_one_row():
    """A changed `agent_type` must never fork one worker into two."""
    stats = _stats()

    stats.observe(_event("a1", "src/a.py", label="developer-backend"))
    stats.observe(_event("a1", "src/b.py", label="developer-tester"))

    assert len(_agents(stats)) == 1


def test_the_row_carries_the_latest_label_it_was_given():
    stats = _stats()

    stats.observe(_event("a1", "src/a.py", label="developer-backend"))
    stats.observe(_event("a1", "src/b.py", label="developer-tester"))

    assert _row(stats, "a1")["label"] == "developer-tester"


# --- 1.1 what one agent did to how many files -------------------------------


def test_two_events_on_two_paths_are_two_writes_over_two_files():
    stats = _stats()

    stats.observe(_event("a1", "src/a.py"))
    stats.observe(_event("a1", "src/b.py"))

    row = _row(stats, "a1")
    assert (row["writes"], row["files"]) == (2, 2)


def test_returning_to_a_path_leaves_the_distinct_count_alone():
    """`len(paths)` IS the distinct count: one structure answers both questions."""
    stats = _stats()

    stats.observe(_event("a1", "src/a.py"))
    stats.observe(_event("a1", "src/b.py"))
    stats.observe(_event("a1", "src/a.py"))

    row = _row(stats, "a1")
    assert (row["writes"], row["files"]) == (3, 2)


def test_a_path_returned_to_is_the_most_visited_one():
    stats = _stats()

    stats.observe(_event("a1", "src/a.py"))
    stats.observe(_event("a1", "src/b.py"))
    stats.observe(_event("a1", "src/a.py"))

    row = _row(stats, "a1")
    assert (row["topPath"], row["topCount"]) == ("src/a.py", 2)


def test_an_agent_that_touched_nothing_twice_names_no_favourite_file():
    """A count of 1 is not a favourite; naming one would be an arbitrary file."""
    stats = _stats()

    stats.observe(_event("a1", "src/a.py"))
    stats.observe(_event("a1", "src/b.py"))

    row = _row(stats, "a1")
    assert (row["topPath"], row["topCount"]) == ("", 0)


def test_a_tie_for_most_visited_is_broken_by_the_path():
    """Deterministic, or the dedupe on the encoded frame never fires."""
    stats = _stats()

    for path in ("src/b.py", "src/a.py", "src/b.py", "src/a.py"):
        stats.observe(_event("a1", path))

    assert _row(stats, "a1")["topPath"] == "src/a.py"


def test_the_directory_count_is_the_distinct_parent_directories():
    """The parent of each path, the root counted as one directory of its own.

    An agent that only edited `README.md` worked in exactly one place, and it is
    the root; reporting `0` there would read as "worked nowhere".
    """
    stats = _stats()

    stats.observe(_event("a1", "README.md"))
    stats.observe(_event("a1", "setup.py"))
    stats.observe(_event("a1", "src/a.py"))

    assert _row(stats, "a1")["dirs"] == 2


# --- 1.2 reads and writes, apart ---------------------------------------------


def test_a_read_is_counted_as_a_read_and_not_as_a_write():
    """The inversion of `eventLog.ts`'s rule, and the panel's best line."""
    stats = _stats()

    stats.observe(_event("a1", "src/a.py", type="R"))

    row = _row(stats, "a1")
    assert (row["reads"], row["writes"]) == (1, 0)


def test_a_deletion_is_a_write():
    stats = _stats()

    stats.observe(_event("a1", "src/a.py", type="D"))

    row = _row(stats, "a1")
    assert (row["writes"], row["reads"]) == (1, 0)


def test_an_add_and_a_modification_are_both_writes_and_are_not_told_apart():
    """No third counter: `A` versus `M` is already the graph's own colour."""
    stats = _stats()

    stats.observe(_event("a1", "src/a.py", type="A"))
    stats.observe(_event("a1", "src/a.py", type="M"))

    assert _row(stats, "a1")["writes"] == 2


def test_a_read_still_counts_towards_the_files_the_agent_touched():
    stats = _stats()

    stats.observe(_event("a1", "src/a.py", type="R"))
    stats.observe(_event("a1", "src/b.py", type="M"))

    assert _row(stats, "a1")["files"] == 2


# --- 1.4 the unattributed agent gets a row ----------------------------------


def test_an_event_with_no_agent_gets_a_row_of_its_own():
    """`CLAUDE.md`'s rule about `agent: ""` is about ACTORS, not about rows.

    "An event with `agent: \"\"` must never create an actor" is about a figure
    and a beam on the graph: nobody did that work on camera, so there is nobody
    to draw. A row is neither a figure nor a beam. An unattributed change is real
    work -- a build step, a human's editor, a glob the parser refused to guess at
    -- and hiding it makes the totals not add up, which is the one thing a
    summary may not do. This is the most likely misreading of `CLAUDE.md` the
    whole feature invites, in either direction, which is why it is a test and not
    a comment.
    """
    stats = _stats()

    stats.observe(_event("", "build/out.js"))

    assert _row(stats, "")["writes"] == 1


def test_the_unattributed_row_is_not_merged_into_an_attributed_one():
    stats = _stats()

    stats.observe(_event("a1", "src/a.py"))
    stats.observe(_event("", "build/out.js"))

    assert sorted(row["agent"] for row in _agents(stats)) == ["", "a1"]


# --- 1.5 the per-path cap: stop adding, keep counting -----------------------
#
# The caps are monkeypatched to something small rather than reached honestly:
# 2 000 paths per agent through `observe` is a test that takes a second to say
# something a test with three can say instantly. Patched BEFORE the instance is
# built, so it makes no difference whether the implementation reads the constant
# at construction or at every call.


@pytest.fixture
def small_path_cap(monkeypatch: pytest.MonkeyPatch):
    """`MAX_TRACKED_PATHS` of 2, for the life of one test."""
    monkeypatch.setattr(_module(), "MAX_TRACKED_PATHS", 2)
    return 2


def test_past_the_path_cap_a_new_path_is_not_tracked(small_path_cap):
    stats = _stats()

    stats.observe(_event("a1", "src/a.py"))
    stats.observe(_event("a1", "src/b.py"))
    stats.observe(_event("a1", "src/c.py"))

    assert _row(stats, "a1")["files"] == 2


def test_past_the_path_cap_the_writes_are_still_counted(small_path_cap):
    """The cap bounds memory, never the totals: 2 000 paths, all the events."""
    stats = _stats()

    stats.observe(_event("a1", "src/a.py"))
    stats.observe(_event("a1", "src/b.py"))
    stats.observe(_event("a1", "src/c.py"))

    assert _row(stats, "a1")["writes"] == 3


def test_past_the_path_cap_a_path_already_tracked_still_increments(small_path_cap):
    """Not an LRU: evicting can evict the winner and lie about it silently."""
    stats = _stats()

    stats.observe(_event("a1", "src/a.py"))
    stats.observe(_event("a1", "src/b.py"))
    stats.observe(_event("a1", "src/c.py"))
    stats.observe(_event("a1", "src/a.py"))

    row = _row(stats, "a1")
    assert (row["topPath"], row["topCount"]) == ("src/a.py", 2)


def test_reaching_the_path_cap_says_so_on_the_row(small_path_cap):
    """A capped `files` is a floor, and a floor the reader is not told about is
    a wrong number."""
    stats = _stats()

    stats.observe(_event("a1", "src/a.py"))
    stats.observe(_event("a1", "src/b.py"))
    stats.observe(_event("a1", "src/c.py"))

    assert _row(stats, "a1")["truncated"] is True


def test_an_agent_under_the_path_cap_is_not_marked_truncated(small_path_cap):
    stats = _stats()

    stats.observe(_event("a1", "src/a.py"))

    assert _row(stats, "a1")["truncated"] is False


def test_a_directory_only_reached_past_the_cap_is_not_tracked_either(
    small_path_cap,
):
    """The directories are capped alongside the paths, not on their own."""
    stats = _stats()

    stats.observe(_event("a1", "one/a.py"))
    stats.observe(_event("a1", "two/b.py"))
    stats.observe(_event("a1", "three/c.py"))

    assert _row(stats, "a1")["dirs"] == 2


def test_one_agent_hitting_the_cap_does_not_truncate_another(small_path_cap):
    stats = _stats()

    for path in ("src/a.py", "src/b.py", "src/c.py"):
        stats.observe(_event("a1", path))
    stats.observe(_event("a2", "src/d.py"))

    assert _row(stats, "a2")["truncated"] is False


# --- 1.6 the agent cap ------------------------------------------------------


@pytest.fixture
def small_agent_cap(monkeypatch: pytest.MonkeyPatch):
    """`MAX_AGENTS` of 2, for the life of one test."""
    monkeypatch.setattr(_module(), "MAX_AGENTS", 2)
    return 2


def test_past_the_agent_cap_a_new_agent_is_refused(small_agent_cap):
    """The map is keyed on a string that arrived over a socket; it is bounded."""
    stats = _stats()

    stats.observe(_event("a1", "src/a.py"))
    stats.observe(_event("a2", "src/b.py"))
    stats.observe(_event("a3", "src/c.py"))

    assert sorted(row["agent"] for row in _agents(stats)) == ["a1", "a2"]


def test_past_the_agent_cap_the_agents_already_there_are_untouched(
    small_agent_cap,
):
    stats = _stats()

    stats.observe(_event("a1", "src/a.py"))
    stats.observe(_event("a2", "src/b.py"))
    stats.observe(_event("a3", "src/c.py"))
    stats.observe(_event("a1", "src/d.py"))

    row = _row(stats, "a1")
    assert (row["writes"], row["files"]) == (2, 2)


def test_the_two_caps_are_the_documented_ones():
    """Values, not relations: they are what bounds the daemon's memory."""
    module = _module()

    assert (module.MAX_AGENTS, module.MAX_TRACKED_PATHS) == (32, 2000)


# --- 1.7 the frame: JSON, and deterministic ---------------------------------


def test_the_frame_is_exactly_the_shape_the_browser_parses():
    """The one place the wire shape is written out; everything else reads it."""
    stats = _stats()

    stats.observe(_event("a1", "src/x.py", ts=1.0, label="developer-backend"))
    stats.observe(_event("a1", "src/x.py", ts=9.0, label="developer-backend"))

    assert stats.frame() == {
        "kind": "stats",
        "agents": [
            {
                "agent": "a1",
                "label": "developer-backend",
                "writes": 2,
                "reads": 0,
                "files": 1,
                "dirs": 1,
                "topPath": "src/x.py",
                "topCount": 2,
                "firstTs": 1.0,
                "lastTs": 9.0,
                "truncated": False,
            }
        ],
    }


def test_a_fresh_accumulator_frames_an_empty_table():
    assert _stats().frame() == {"kind": "stats", "agents": []}


def test_the_frame_survives_json_dumps_with_no_custom_encoder():
    """A `set` or a dataclass smuggled through raises inside `_send`, on the
    loop, long after this call returned -- the hazard `sizes_frame` and
    `completion_response` each carry a comment about."""
    stats = _stats()
    stats.observe(_event("a1", "src/a.py", label="developer-backend"))
    stats.observe(_event("a1", "src/a.py", type="R"))

    encoded = json.dumps(stats.frame(), separators=(",", ":"))

    assert json.loads(encoded) == stats.frame()


def test_every_value_in_the_frame_is_a_plain_json_type():
    """Asserted over the values themselves, so a `set` that happens to be empty
    -- and would therefore encode -- is still caught."""
    stats = _stats()
    stats.observe(_event("a1", "src/a.py"))

    exotic = [
        (key, type(value).__name__)
        for row in _agents(stats)
        for key, value in row.items()
        if not isinstance(value, (str, int, float, bool))
    ]

    assert exotic == []


def test_the_rows_are_ordered_by_write_count_descending():
    stats = _stats()

    stats.observe(_event("a1", "src/a.py"))
    for path in ("src/b.py", "src/c.py", "src/d.py"):
        stats.observe(_event("a2", path))
    for path in ("src/e.py", "src/f.py"):
        stats.observe(_event("a3", path))

    assert [row["agent"] for row in _agents(stats)] == ["a2", "a3", "a1"]


def test_rows_with_equal_write_counts_are_ordered_by_agent():
    """The tie-break has to exist, or an identical session encodes two ways and
    the dedupe on the encoded string never fires."""
    stats = _stats()

    stats.observe(_event("b", "src/b.py"))
    stats.observe(_event("a", "src/a.py"))
    stats.observe(_event("c", "src/c.py"))

    assert [row["agent"] for row in _agents(stats)] == ["a", "b", "c"]


def test_an_unchanged_session_frames_byte_for_byte_the_same_thing():
    stats = _stats()
    stats.observe(_event("a1", "src/a.py"))

    first = json.dumps(stats.frame(), separators=(",", ":"))
    second = json.dumps(stats.frame(), separators=(",", ":"))

    assert first == second


def test_a_read_only_agent_is_still_in_the_table():
    """Reading is work: an agent with `writes: 0` is exactly what this panel is
    for, and dropping it is the `eventLog.ts` rule leaking back in."""
    stats = _stats()

    stats.observe(_event("a1", "src/a.py", type="R"))

    assert [row["agent"] for row in _agents(stats)] == ["a1"]


# --- the span: two timestamps, never an "active time" -----------------------


def test_the_row_spans_the_first_and_last_moment_the_agent_was_seen():
    stats = _stats()

    stats.observe(_event("a1", "src/a.py", ts=100.0))
    stats.observe(_event("a1", "src/b.py", ts=140.0))

    row = _row(stats, "a1")
    assert (row["firstTs"], row["lastTs"]) == (100.0, 140.0)


def test_an_event_arriving_out_of_order_cannot_invert_the_span():
    """Hook and watcher timestamps are taken by different clocks in different
    processes, so `last` is the largest seen and `first` the smallest -- never
    "the one that arrived last", which can put the end before the beginning."""
    stats = _stats()

    stats.observe(_event("a1", "src/a.py", ts=140.0))
    stats.observe(_event("a1", "src/b.py", ts=100.0))

    row = _row(stats, "a1")
    assert (row["firstTs"], row["lastTs"]) == (100.0, 140.0)


# --- 1.8 reset --------------------------------------------------------------


def test_a_reset_leaves_the_table_exactly_as_a_fresh_one():
    """A root switch means the counted work belongs to a project nobody is
    watching; a table that survived it would report another project's numbers
    under this project's name."""
    stats = _stats()
    stats.observe(_event("a1", "src/a.py"))
    stats.observe(_event("", "build/out.js", type="R"))

    stats.reset()

    assert stats.frame() == _stats().frame()


def test_an_agent_seen_before_a_reset_starts_from_zero_after_it():
    stats = _stats()
    stats.observe(_event("a1", "src/a.py"))

    stats.reset()
    stats.observe(_event("a1", "src/a.py"))

    row = _row(stats, "a1")
    assert (row["writes"], row["files"]) == (1, 1)


def test_the_agent_cap_is_released_by_a_reset(small_agent_cap):
    """The cap bounds one project's session, not the daemon's lifetime."""
    stats = _stats()
    stats.observe(_event("a1", "src/a.py"))
    stats.observe(_event("a2", "src/b.py"))

    stats.reset()
    stats.observe(_event("a3", "src/c.py"))

    assert [row["agent"] for row in _agents(stats)] == ["a3"]


# --- 1.9 the contract, over the parsed source -------------------------------
#
# The same shape `tests/test_content_search.py` and `tests/test_checkouts.py`
# already use. This module is offered every event the daemon fans out, on the
# hot path, so it touches no disk and starts no process; and it must not import
# the daemon, or a counter model becomes untestable without an event loop -- the
# exact coupling that keeps it out of `server.py` in the first place.

#: Modules this one may not import at all.
FORBIDDEN_IMPORTS = frozenset({"subprocess", "multiprocessing", "daemon", "asyncio"})

#: Every spelling of "touch the disk" or "start a process".
FORBIDDEN_NAMES = (
    "open",
    "read_text",
    "read_bytes",
    "listdir",
    "scandir",
    "walk",
    "stat",
    "lstat",
    "subprocess",
    "popen",
    "system",
    "fork",
    "gitcmd",
    "safe_read",
)


def _source() -> str:
    return Path(_module().__file__).read_text(encoding="utf-8")


def _imported_modules(module: ast.Module) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(module):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.update(alias.name.split("."))
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            names.update(part for part in base.split(".") if part)
            if base.split(".")[0] in ("rhizome_graph", "daemon", "hooks") or node.level:
                continue
            names.update(alias.name for alias in node.names)
    return names


def _identifiers(module: ast.Module) -> set[str]:
    """Every name the code *uses*, so the docstring that is expected to promise
    all this does not satisfy the assertion by containing the words."""
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


def test_the_counter_imports_nothing_from_the_daemon_side():
    imported = _imported_modules(ast.parse(_source()))

    offenders = sorted(imported & FORBIDDEN_IMPORTS)

    assert offenders == [], (
        f"rhizome_graph/session_stats.py imports {offenders}. It is a pure model "
        "of what the hub hands it; importing the daemon is what would make it "
        "untestable without an event loop."
    )


def test_the_counter_names_no_way_of_touching_the_disk_or_forking():
    used = _identifiers(ast.parse(_source()))

    offenders = sorted(used & set(FORBIDDEN_NAMES))

    assert offenders == [], (
        f"rhizome_graph/session_stats.py names {offenders}. It is offered every "
        "event the daemon fans out: it counts what it is given and asks nothing "
        "of the machine."
    )
