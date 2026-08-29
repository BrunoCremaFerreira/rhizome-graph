"""Per-agent counters for one session: who did what, and to how many files.

Nothing else in this program counts anything. ``EventHub`` holds the tree, two
replay buffers, a handful of replaceable slots and two dedupe maps, and not one
of them is per agent -- ``_last_hook`` is a single triple that is *overwritten*,
never accumulated. The browser cannot fill the gap either: a client that
reconnects is replayed the seed plus the last ``REPLAY_BUFFER_SIZE`` events, so
a browser-side counter would be not merely approximate but *silently*
approximate, and two tabs opened five minutes apart would disagree about the
same session with no way for either to know.

So the accumulation happens here, daemon-side, in a module of its own: this is a
pure model of what the hub hands it, it opens nothing, forks nothing, and
imports nothing from the daemon -- which is what keeps a counter testable
without an event loop.

Five decisions are written down here because the next reader would otherwise
"fix" them, and in every case the number that would go missing looks exactly
like a number that was never there.

**Reads are counted, and kept apart from writes.** ``web/src/eventLog.ts`` drops
every ``R`` outright, because that panel is a list of *changes* and an agent
reads roughly ten times more than it writes, so reads would push every real edit
off the top within seconds. This module does the opposite on purpose: "it read
340 files and wrote 12" is the single most informative line the panel can
produce, and dropping the reads throws it away. The two are never summed into a
total either -- a total invites the reader to compare it with the
recent-changes list, which drops the reads.

**At ``MAX_TRACKED_PATHS`` new keys stop being added and the existing ones keep
incrementing**, and the row says ``truncated``. Never an LRU eviction: that can
evict the very file the agent kept returning to, which makes the most-visited
answer wrong without saying so. Under this rule the answer is exact whenever the
winner appeared among the first ``MAX_TRACKED_PATHS`` distinct paths -- likely
for a file an agent returns to, and not guaranteed. A stated degradation, and
the cap bounds memory alone: the totals count every event.

**:meth:`SessionStats.observe` is never offered a seed event, and this module
does not filter for one.** The exemption is the caller's wiring -- ``seed_paths``
builds its own message and touches neither fan-out path -- so the boot snapshot
is exempt as a consequence of the hub's shape. A filter here would be a second
guard that hides a wiring mistake instead of failing on it.

**``agent`` is identity, ``label`` is only text, and ``agent: ""`` gets a row of
its own.** Two subagents of one type are two workers, so keying on the readable
name would silently merge them while a renamed type would fork one worker in
two. ``CLAUDE.md``'s other rule -- an event with ``agent: ""`` must never create
an actor -- is about a figure and a beam on the graph: an unattributed change is
real work by nobody on camera, a row is neither a figure nor a beam, and hiding
it would make the totals not add up.

**:meth:`SessionStats.frame` emits only JSON types.** A ``set`` or a dataclass
smuggled through raises inside the daemon's ``_send``, on the loop, long after
the call returned -- the hazard ``sizes_frame`` and ``completion_response`` each
carry a comment about. The frame is deterministic too, ordered by write count
and then by agent, so a dedupe on the encoded string actually fires when nothing
changed.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from rhizome_graph.normalize import Event

#: How many distinct actors one session may be counted for. The map is keyed on
#: a string that arrived over a socket, so it is bounded.
MAX_AGENTS = 32

#: How many distinct paths are tracked per agent. Reaching it stops new keys and
#: keeps the counts already there -- see the module docstring.
MAX_TRACKED_PATHS = 2000

#: The operation that is a read. Everything else that reaches here changed the
#: tree: ``A`` and ``M`` are both writes and are deliberately not told apart (a
#: third counter for "created" against "modified" is a column nobody reads, and
#: the distinction is already the graph's own colour), and ``D`` is a write too.
READ = "R"


@dataclass
class AgentStats:
    """What one actor has done so far this session.

    ``paths`` maps a path to how often this agent touched it, and its length
    **is** the distinct-path count: two counters that have to agree are two
    counters that can drift, so one structure answers both questions. ``dirs``
    is the same idea for the parent directories, and it is capped alongside
    ``paths`` rather than on its own -- a directory only ever reached through a
    path that was refused was never observed.
    """

    agent: str
    label: str = ""
    writes: int = 0
    reads: int = 0
    paths: dict[str, int] = field(default_factory=dict)
    dirs: set[str] = field(default_factory=set)
    first_ts: float = 0.0
    last_ts: float = 0.0
    truncated: bool = False


class SessionStats:
    """The table of actors, accumulated one event at a time."""

    def __init__(self) -> None:
        self._agents: dict[str, AgentStats] = {}

    def observe(self, event: Event) -> None:
        """Count one event against the actor that caused it.

        Nothing is dropped and nothing is filtered: whatever the hub fans out is
        work somebody did, including the events nobody is on camera for.
        """
        entry = self._agents.get(event.agent)
        if entry is None:
            if len(self._agents) >= MAX_AGENTS:
                return
            entry = AgentStats(
                agent=event.agent, first_ts=event.ts, last_ts=event.ts
            )
            self._agents[event.agent] = entry

        # Only when the event carried one: a later event with no readable name
        # must not blank the name an earlier one supplied.
        if event.label:
            entry.label = event.label

        if event.type == READ:
            entry.reads += 1
        else:
            entry.writes += 1

        # The largest and the smallest seen, never "the one that arrived last".
        # Hook and watcher timestamps are taken by different clocks in different
        # processes, so an event arriving out of order would otherwise put the
        # end of the span before its beginning.
        entry.first_ts = min(entry.first_ts, event.ts)
        entry.last_ts = max(entry.last_ts, event.ts)

        self._count_path(entry, event.path)

    def reset(self) -> None:
        """Forget everything: the work belongs to a project nobody is watching.

        Called from the hub's own ``reset``, so a table that survived a root
        switch would report another project's numbers under this project's name.
        The agent cap goes with it -- it bounds one project's session, not the
        daemon's lifetime.
        """
        self._agents.clear()

    def frame(self) -> dict:
        """The whole table, as the browser receives it.

        Ordered by write count descending and then by agent ascending. The
        tie-break has to exist: without it an unchanged session encodes two ways
        and the dedupe on the encoded string never fires.
        """
        rows = [self._row(entry) for entry in self._agents.values()]
        rows.sort(key=lambda row: (-row["writes"], row["agent"]))
        return {"kind": "stats", "agents": rows}

    # -- internals ---------------------------------------------------------

    def _count_path(self, entry: AgentStats, path: str) -> None:
        """Remember one more visit to `path`, or decline to start tracking it."""
        visits = entry.paths.get(path)
        if visits is None:
            if len(entry.paths) >= MAX_TRACKED_PATHS:
                # A `files` count that stopped growing is a floor, and a floor
                # the reader is not told about is a wrong number.
                entry.truncated = True
                return
            entry.paths[path] = 1
            entry.dirs.add(_parent(path))
            return
        entry.paths[path] = visits + 1

    def _row(self, entry: AgentStats) -> dict:
        top_path, top_count = _favourite(entry.paths)
        return {
            "agent": entry.agent,
            "label": entry.label,
            "writes": entry.writes,
            "reads": entry.reads,
            "files": len(entry.paths),
            "dirs": len(entry.dirs),
            "topPath": top_path,
            "topCount": top_count,
            "firstTs": entry.first_ts,
            "lastTs": entry.last_ts,
            "truncated": entry.truncated,
        }


def _parent(path: str) -> str:
    """The directory a path sits in, the observed root spelled as ``""``.

    An agent that only edited `README.md` worked in exactly one place, and it is
    the root: reporting no directory at all there would read as "worked
    nowhere". Split here rather than through `os.path`, which this module has no
    other reason to name -- the paths are relative to the root and always use
    the wire's separator.
    """
    head, sep, _ = path.rpartition("/")
    return head if sep else ""


def _favourite(paths: dict[str, int]) -> tuple[str, int]:
    """The most visited path and its count, or ``("", 0)`` if nobody returned.

    A count of one is not a favourite, and naming one would name an arbitrary
    file. Ties go to the path that sorts first, because a table that encodes two
    ways defeats the dedupe on the encoded frame.
    """
    best_path = ""
    best_count = 0
    for candidate, count in paths.items():
        if count > best_count or (count == best_count and candidate < best_path):
            best_path = candidate
            best_count = count
    return (best_path, best_count) if best_count > 1 else ("", 0)
