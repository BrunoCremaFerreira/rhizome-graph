"""Filesystem watcher: completeness where the hooks only give authorship.

Hooks see exactly what Claude's file tools report. They miss everything else:
a glob (``cp src/*.md docs/``) reports one destination directory instead of the
files actually copied, a compound command (``cd x && rm y``) parses to nothing,
and a change made outside the agent is invisible. That gap is why a busy session
could produce two dots on screen.

This watcher reports what really happened on disk. It carries no attribution --
:class:`~daemon.server.EventHub` pairs each change with the agent whose hook
fired moments earlier, so hooks stay the source of *who* and the watcher becomes
the source of *what*.

The mapping from a filesystem event to our A/M/D vocabulary is a pure function
(:func:`classify`) so it can be tested without an observer running.

**What the watcher hides is what the walk hides, and the two are one rule in two
places.** A graph whose seed and whose live events disagree about what exists is
worse than either alone: the file the seed drew never flashes again, and the file
the seed pruned is added back one write at a time, permanently, because a wrong
node stays on screen forever. So :func:`relative_to_root` answers the composite
:mod:`rhizome_graph.tree`'s walk answers -- `is_structural_noise` on every
directory segment, then the blanket dotted-directory fallback only where no
`.gitignore` speaks for that segment's parent, then the patterns themselves.

Two entry points, one rule. The walk asks `ignored_child` about a leaf, because
pruning `dirnames` in place has already excluded every ancestor and is itself
git's "nothing under an excluded directory can be re-included". The watcher holds
one bare path off an inotify event and has no walk, so it asks `ignored`, which
tests each ancestor as a directory and stops at the first exclusion. They are not
interchangeable, and `tests/test_tree_gitignore.py` is what keeps them agreeing.

The rules are built once per :class:`FsWatcher`, never shared with a walk's, and
dropped when a `.gitignore` is created, modified, deleted or renamed into place
-- see :meth:`_Handler._invalidate_if_ignore_file` for the two measured traps in
that sentence. Cost, measured over this checkout: 2.9 us per event without rules
against 30.3 us with them, of which 22.0 us is the ancestor chain and 2.7 us the
one `isdir`. That is watchdog's own thread; the hook's hot path imports nothing
from here.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Callable

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from rhizome_graph.gitignore import IGNORE_FILE_NAME, IgnoreRules
from rhizome_graph.tree import is_ignored, is_structural_noise

#: The event types that can change what a `.gitignore` says. Deliberately not
#: "any event": reading the file is itself watched, and on watchdog 6.0.0 the
#: daemon's own read emits `opened` and `closed_no_write` with that basename, so
#: invalidating on every event would throw away the memoization those reads
#: exist to fill -- a measured 173.6 us of reloading per file against the
#: 12.43 us budgeted for a whole event.
_INVALIDATING_EVENTS = frozenset({"created", "modified", "deleted", "moved"})

LOGGER = logging.getLogger("rhizome_graph.watcher")

#: (relative_path, op_type) -> None
ChangeSink = Callable[[str, str], None]


def classify(event_type: str, is_directory: bool) -> str | None:
    """Map a watchdog event to ``"A"``/``"M"``/``"D"``, or ``None`` to ignore.

    Directory creations and modifications carry nothing the graph can use: the
    frontend derives directory nodes from their children's paths. A directory
    *deletion* is kept, because the subtree under it has to be pruned.
    """
    if event_type == "deleted":
        return "D"
    if is_directory:
        return None
    if event_type == "created":
        return "A"
    if event_type == "modified":
        return "M"
    return None


def relative_to_root(
    path: str, root: str, rules: IgnoreRules | None = None
) -> str | None:
    """Return `path` relative to `root`, or ``None`` if it must not be shown.

    Containment comes first and is this function's own job: anything outside the
    root and the root itself are refused before a rule is compiled or a segment
    is inspected. :class:`~rhizome_graph.gitignore.IgnoreRules` deliberately
    resolves nothing -- it hands a ``..`` segment straight through, because
    keeping the daemon inside its root belongs elsewhere -- so the prefix test
    below is what stands in for `resolve_inside` on this path, and it stays in
    front.

    **With `rules`, the answer mirrors the walk's, segment by segment**, because
    a graph whose seed and whose live events disagree about what exists is the
    failure this repository has already paid hours for: it looks alive and it is
    lying. For every directory segment, :func:`~rhizome_graph.tree.is_structural_noise`
    always, then the blanket dotted rule *only* where no `.gitignore` speaks for
    that segment's parent; then the patterns, over the whole path.

    Two details are load-bearing and each rules out a plausible shortcut:

      * **Not `tree.is_ignored` first.** That predicate has no root, so it
        carries the dotted-directory fallback unconditionally -- consulting it
        ahead of the patterns refuses a governed `.claude/agents/a.md` before a
        pattern is ever reached, and the file the seed just drew would never
        flash again.
      * **`ignored`, never `ignored_child`.** The walk gets git's "nothing under
        an excluded directory can be re-included" free from pruning `dirnames`
        in place; a caller holding one bare path off an inotify event has to pay
        for the ancestor traversal. Measured against git 2.43: with `out/` and
        then `!out/keep.txt`, `out/keep.txt` is ignored, and the leaf-only
        question answers otherwise.

    With ``rules=None`` the answer is :func:`~rhizome_graph.tree.is_ignored`,
    exactly today's: a caller with no root cannot know whether a `.gitignore`
    speaks for `.claude/`, so it keeps the blanket fallback.
    """
    normalized = os.path.normpath(path)
    base = os.path.normpath(root)
    if normalized == base:
        return None
    prefix = base.rstrip("/") + "/"
    if not normalized.startswith(prefix):
        return None
    relative = normalized[len(prefix):]
    if not relative:
        return None
    if rules is None:
        return None if is_ignored(relative) else relative
    if _refused_by_name(relative, rules):
        return None
    # `is_dir` is asked of the filesystem rather than assumed: a constant `True`
    # would refuse a plain file named `logs` under a `logs/` rule, and the
    # answer for a path that is already gone is `False`, which is the direction
    # that shows more. Ancestors are tested as directories inside `ignored`.
    if rules.ignored(relative, os.path.isdir(normalized)):
        return None
    return relative


def _refused_by_name(relative: str, rules: IgnoreRules) -> bool:
    """The structural rule, and the dotted fallback where nothing governs.

    Checked **before** any pattern, so `.git` never reaches the matcher: git
    itself never submits `.git` to its ignore machinery, so a `!.git` line
    cannot re-include it here either, and every `git status` would otherwise
    put the index rewrite on the graph. It is a name, not a position -- each
    checkout of a workspace has its own.

    Only directory segments are inspected, as :func:`~rhizome_graph.tree.is_ignored`
    does, so a dotted file such as `.gitignore` itself stays on the graph and
    keeps flashing when it is edited.
    """
    segments = relative.split("/")
    for index, segment in enumerate(segments[:-1]):
        if not segment:
            continue
        if is_structural_noise(segment):
            return True
        if segment.startswith(".") and not rules.governs("/".join(segments[:index])):
            return True
    return False


class _Handler(FileSystemEventHandler):
    """Translates watchdog callbacks into ``(relative_path, op)`` pairs."""

    def __init__(
        self, root: str, on_change: ChangeSink, rules: IgnoreRules | None = None
    ) -> None:
        self._root = root
        self._on_change = on_change
        self._rules = rules

    def on_any_event(self, event: FileSystemEvent) -> None:
        try:
            self._invalidate_if_ignore_file(event)
            if event.event_type == "moved":
                # A rename is a deletion at the source and an addition at the
                # destination; reporting only one would leave a ghost node.
                self._report(getattr(event, "src_path", ""), "D", event.is_directory)
                self._report(getattr(event, "dest_path", ""), "A", event.is_directory)
                return
            op = classify(event.event_type, event.is_directory)
            if op is not None:
                self._report(event.src_path, op, event.is_directory)
        except Exception as exc:  # a bad event must never kill the observer
            LOGGER.debug("watcher event error: %s", exc)

    def _invalidate_if_ignore_file(self, event: FileSystemEvent) -> None:
        """Drop the compiled rules when the file that produced them changes.

        Two measured traps, both on watchdog 6.0.0 (this checkout; Debian noble
        ships 3.0.0, so neither is safe to assume):

          * **Only the event types that change a file count.** Reading a
            `.gitignore` is itself watched -- the rules' own load emits `opened`
            and `closed_no_write` with that basename -- so invalidating on any
            event would discard the memoization those reads exist to fill.
          * **Both ends of a `moved` event are checked.** The commonest rewrite
            there is -- an atomic editor save, `git checkout`, `git stash` -- is
            a rename, and there the source is a temporary name and only the
            *destination* is `.gitignore`. A source-only check appears to work
            on this watchdog version, by way of the self-read `opened` event
            that the narrowing above correctly discards.

        Creation counts too: a project's first `.gitignore` is created, not
        edited, and `IgnoreRules.invalidate` forgets the negative answers, which
        is what lets that switch the dotted fallback off for a tree already
        cached as ungoverned.
        """
        if self._rules is None or event.event_type not in _INVALIDATING_EVENTS:
            return
        for attribute in ("src_path", "dest_path"):
            path = _decode(getattr(event, attribute, "") or "")
            if path and os.path.basename(path) == IGNORE_FILE_NAME:
                self._rules.invalidate()
                return

    def _report(self, path: str, op: str, is_directory: bool) -> None:
        if not path:
            return
        if is_directory and op == "A":
            return
        relative = relative_to_root(_decode(path), self._root, self._rules)
        if relative is None:
            return
        self._on_change(relative, op)


def _decode(path: str | bytes) -> str:
    return path.decode("utf-8", errors="replace") if isinstance(path, bytes) else path


class FsWatcher:
    """Recursive observer over the project root, reporting relative changes.

    Robustness rule, same as the rest of the daemon: an unwatchable root or a
    failing observer degrades to "no filesystem events", never to a crash. The
    hooks keep working on their own in that case.
    """

    def __init__(self, root: str, on_change: ChangeSink) -> None:
        self._root = os.path.normpath(root)
        self._on_change = on_change
        self._observer: Observer | None = None
        self._lock = threading.Lock()
        # One rule set per watcher, built from the root it already holds and
        # kept for its lifetime, because a per-event rebuild would cost 173.6 us
        # against the 12.43 us an answer costs. It is never the walk's: every
        # `scan_tree` builds its own, so nothing mutable crosses between
        # watchdog's thread and an `asyncio.to_thread` worker, and a root switch
        # gets a fresh object because it stops and restarts the watcher.
        self._rules = IgnoreRules(self._root)

    def start(self) -> None:
        with self._lock:
            if self._observer is not None:
                return
            if not os.path.isdir(self._root):
                LOGGER.warning("watcher root %s does not exist; not watching", self._root)
                return
            try:
                observer = Observer()
                handler = _Handler(self._root, self._on_change, self._rules)
                observer.schedule(handler, self._root, recursive=True)
                observer.start()
                self._observer = observer
            except Exception as exc:
                LOGGER.warning("could not start the filesystem watcher: %s", exc)
                self._observer = None

    def stop(self) -> None:
        with self._lock:
            observer, self._observer = self._observer, None
        if observer is None:
            return
        try:
            observer.stop()
            observer.join(timeout=2.0)
        except Exception as exc:
            LOGGER.debug("watcher stop error: %s", exc)

    @staticmethod
    def wait_for(predicate: Callable[[], bool], timeout: float = 5.0) -> bool:
        """Poll `predicate` until true or `timeout` elapses (test helper).

        Filesystem notifications are inherently asynchronous, so tests need a
        bounded wait rather than a fixed sleep.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.02)
        return predicate()
