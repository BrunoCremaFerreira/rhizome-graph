"""Contract tests (RED) for `relative_to_root` under `.gitignore` -- step G5.

The defect this file exists for is a graph whose seed and whose live events
describe two different projects, which is the failure mode this repository has
already paid real hours for: it looks alive and it is lying.

G4 taught the walk to read a `.gitignore`. `relative_to_root`
(`daemon/watcher.py:55-72`) still calls the root-free `tree.is_ignored`, so the
two halves now disagree in both directions at once:

  * the seed draws `.claude/agents/a.md` and every later edit to it is dropped
    -- a file on the graph that flashes once at boot and never again; and
  * a `.gitignore` naming `build/` has its files pruned from the seed and then
    **added back** by the watcher, one node per write, permanently, because a
    wrong node stays on screen forever.

The second is the worse one, and neither is visible from the daemon's logs.

**The composite must mirror G4's exactly, and reading it as "`is_ignored`
first, patterns second" ships the first bug.** `tree.is_ignored` carries the
dotted-directory fallback *unconditionally* -- it has no root, so it cannot ask
whether a `.gitignore` speaks for the directory -- and consulting it first
refuses `.claude/agents/a.md` before a pattern is ever reached. The rule is:

    refuse when, for any directory segment:
        tree.is_structural_noise(segment)                      # always
     or (not rules.governs(parent) and segment.startswith("."))  # the fallback
    or when:
        rules.ignored(relative, ...)                           # the patterns

With `rules=None` the answer stays `tree.is_ignored(relative)`, today's, which
is what the default is for and what section 5.1 below is the jaw for.

Five properties carry this file, and each rules out a *plausible* wrong
implementation rather than an implausible one:

  * **A governed dotted directory reaches the watcher too.** The naive
    `is_ignored`-then-patterns reading is refused by 5.2, and by nothing else
    here.
  * **The dotted fallback survives where no `.gitignore` speaks.** Dropping it
    the moment an `IgnoreRules` is in hand is the variant measured to take
    `$HOME` from 12 500 files to 20 000 on the walk; on the watcher's path it
    puts `.cache/`, `.local/` and `.npm/` on the graph one write at a time.
    5.2a is that jaw.
  * **`ignored`, never `ignored_child`.** The walk gets "nothing under an
    excluded directory can be re-included" for free from its in-place
    `dirnames` prune. The watcher holds one bare path and has no walk, so it
    has to pay for the ancestor traversal. Measured against git 2.43 over 5.4's
    fixture: with `build/` and then `!build/keep.txt`, `git check-ignore -v
    build/keep.txt` names `.gitignore:1:build/` -- git stops at the directory
    and never reaches the negation. `ignored_child("build", "keep.txt", False)`
    answers `False` for that same path, so the two entry points are not
    interchangeable and 5.4 is where that is nailed down.
  * **`is_dir` is load-bearing on this path too.** A constant is the shape that
    passes almost everything and is still wrong: measured against git 2.43,
    `logs/` ignores `deeper/logs/a.txt` and leaves a top-level *file* named
    `logs` alone. Constant `True` refuses the file; constant `False` accepts the
    path under the directory. Only the pair in 5.4 catches both.
  * **`.git` is a name, not a position.** `a/.git/index` and `b/.git/index` are
    refused in a workspace of checkouts, and `is_structural_noise` -- never a
    pattern -- is what refuses them. This is a deliberate divergence from git
    and is asserted as one: measured against git 2.43, `git check-ignore
    .git/config` reports *not ignored* even with `!.git` in the file, because
    git never submits `.git` to its ignore machinery at all.

**On the trailing slash.** Nothing here was ever compared against
`git check-ignore` with one: measured, it disagrees with itself there -- under
`a/**` it calls `a/` ignored and `a` not.

**On watchdog versions, and a cost the plan did not price.** Measured on
watchdog 6.0.0 (this checkout; Debian noble ships 3.0.0): reading a `.gitignore`
is itself watched, and emits `opened` and `closed_no_write` events whose
basename is `.gitignore`. So "invalidate whenever an event's basename is
`.gitignore`", taken literally, fires on the watcher's **own reads** and throws
away the memoization those reads exist to fill -- every later event re-reads and
re-compiles the whole ancestor chain, at a measured 173.6 us per file against
the 12.43 us the plan budgeted for a whole event. It does not run away: an
`opened` event classifies to `None`, never reaches `_report` and so triggers no
read of its own. The fix belongs to the implementation and not to a test here --
invalidate on `created`, `modified`, `deleted` and `moved`, which is what
"changed" means -- and the only test in this file whose verdict depends on it is
the last one, which says so itself.

Style: Arrange-Act-Assert, one property per test. Every fixture is a real
`tmp_path` tree with real `.gitignore` files in it; nothing here mocks the disk.
Only 5.5 and 5.6 start an observer.
"""

from __future__ import annotations

import os
from pathlib import Path

from daemon.watcher import FsWatcher, relative_to_root
from rhizome_graph.gitignore import IgnoreRules


def _touch(root: Path, rel: str) -> None:
    """Create an empty file at `rel` under `root`, with its parent dirs."""
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("")


def _write(root: Path, rel: str, text: str) -> None:
    """Create a file at `rel` under `root` holding `text`."""
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


def _event(root: Path, rel: str) -> str:
    """The absolute path a watchdog event would carry for `rel` under `root`."""
    return os.path.join(str(root), *rel.split("/"))


class _SpyRules(IgnoreRules):
    """An `IgnoreRules` that records every pattern question asked of it.

    Both entry points are recorded, so "no pattern was consulted" means exactly
    that and cannot be satisfied by asking the other one instead.
    """

    def __init__(self, root: str) -> None:
        super().__init__(root)
        self.pattern_questions: list[str] = []

    def ignored(self, relative: str, is_dir: bool = False) -> bool:
        self.pattern_questions.append(relative)
        return super().ignored(relative, is_dir)

    def ignored_child(self, directory_relative: str, name: str, is_dir: bool) -> bool:
        self.pattern_questions.append("/".join(p for p in (directory_relative, name) if p))
        return super().ignored_child(directory_relative, name, is_dir)


# --- 5.1 The jaw: the two-argument call answers exactly as it does today -----
#
# `tests/test_watcher.py` calls `relative_to_root` with two arguments in four
# tests and must keep passing **verbatim** -- it is a live behavioural
# dependency on `tree.is_ignored` that an import-based search does not find,
# because it reaches it through `daemon/watcher.py`. That is what the `rules`
# parameter's default is for, and these five assertions are the same contract
# stated where a reader of G5 will see it.


def test_the_two_argument_call_still_strips_the_root():
    assert relative_to_root("/proj/src/app.py", "/proj") == "src/app.py"


def test_the_two_argument_call_still_refuses_a_path_outside_the_root():
    assert relative_to_root("/elsewhere/app.py", "/proj") is None


def test_the_two_argument_call_still_refuses_structural_noise():
    assert relative_to_root("/proj/node_modules/three/x.js", "/proj") is None
    assert relative_to_root("/proj/.git/HEAD", "/proj") is None


def test_the_two_argument_call_still_refuses_the_root_itself():
    assert relative_to_root("/proj", "/proj") is None


def test_without_rules_a_dotted_directory_keeps_todays_answer():
    """No rules means no root, and no root means the blanket fallback.

    A caller with no `IgnoreRules` cannot know whether a `.gitignore` speaks for
    `.claude/`, so it must keep answering what it answers today. This is the
    assertion that stops the third parameter from being "fixed" by deleting the
    fallback from the two-argument path as well.
    """
    assert relative_to_root("/proj/.claude/agents/a.md", "/proj") is None


# --- 5.2 The two halves of the disagreement ---------------------------------


def test_a_governed_dotted_directory_reaches_the_watcher_too(tmp_path: Path):
    """The seed draws this file; the watcher has to let its edits through.

    This is the test to write first. The naive reading of the plan -- ask
    `tree.is_ignored` first and consult the patterns only afterwards -- gives
    `None` here, because `is_ignored` carries the dotted rule unconditionally.
    The file would then be seeded at boot and never flash again for the rest of
    the session, which is indistinguishable from an agent that stopped working
    on it.

    Measured against git 2.43 over this exact tree: `.claude/agents/a.md` is
    *not ignored*.
    """
    _write(tmp_path, ".gitignore", "build/\n")
    _touch(tmp_path, ".claude/agents/a.md")
    rules = IgnoreRules(str(tmp_path))

    relative = relative_to_root(
        _event(tmp_path, ".claude/agents/a.md"), str(tmp_path), rules
    )

    assert relative == ".claude/agents/a.md"


def test_a_pattern_refuses_a_path_the_seed_already_pruned(tmp_path: Path):
    """The mirror failure, and the worse one of the two.

    The seed prunes `build/` and the watcher, knowing nothing of the file, adds
    each write back as a node of its own. Nothing removes it afterwards: a wrong
    node stays on screen forever.

    `build` is in `IGNORED_DIRS`, so this fixture uses `out/` -- a name the
    structural set says nothing about, which is what makes the pattern the only
    thing that can refuse it.
    """
    _write(tmp_path, ".gitignore", "out/\n")
    _touch(tmp_path, "out/gen.txt")
    rules = IgnoreRules(str(tmp_path))

    relative = relative_to_root(_event(tmp_path, "out/gen.txt"), str(tmp_path), rules)

    assert relative is None


def test_an_ordinary_path_is_still_relativized_when_rules_are_in_hand(
    tmp_path: Path,
):
    """The overwhelmingly common event must survive the new machinery."""
    _write(tmp_path, ".gitignore", "out/\n")
    _touch(tmp_path, "src/app.py")
    rules = IgnoreRules(str(tmp_path))

    relative = relative_to_root(_event(tmp_path, "src/app.py"), str(tmp_path), rules)

    assert relative == "src/app.py"


# --- 5.2a The fallback survives where no `.gitignore` speaks ----------------


def test_an_ungoverned_dotted_directory_is_still_refused_with_rules_in_hand(
    tmp_path: Path,
):
    """Having an `IgnoreRules` is not the switch; a `.gitignore` existing is.

    The workspace root here carries no `.gitignore` of its own, so `governs("")`
    is False and today's rule applies to its `.cache/` unchanged -- while `a/`,
    which has one, is governed. An implementation that drops the dotted
    fallback wherever `rules is not None` passes every other test in this file
    and puts `.cache/`, `.local/`, `.npm/` and `.vscode-server/` on the graph
    one write at a time, which is the seed truncation of decision 2 arriving
    through the other door.
    """
    _touch(tmp_path, ".cache/junk.txt")
    _write(tmp_path, "a/.gitignore", "out/\n")
    rules = IgnoreRules(str(tmp_path))

    relative = relative_to_root(_event(tmp_path, ".cache/junk.txt"), str(tmp_path), rules)

    assert relative is None


# --- 5.3 `.git` is refused before any pattern is consulted ------------------


def test_git_is_refused_even_when_the_gitignore_re_includes_it(tmp_path: Path):
    """Decision 1 on the second path, on a root where the fallback is off.

    Measured against git 2.43 over this exact tree: `git check-ignore
    .git/HEAD` reports *not ignored*, because git never submits `.git` to its
    ignore machinery at all -- so the patterns alone would put every index
    rewrite of every `git status` on the graph. The branch poll and the status
    poll both exist *because* `.git/` is invisible to the watcher.
    """
    _write(tmp_path, ".gitignore", "!.git\n")
    _touch(tmp_path, ".git/HEAD")
    rules = IgnoreRules(str(tmp_path))

    relative = relative_to_root(_event(tmp_path, ".git/HEAD"), str(tmp_path), rules)

    assert relative is None


def test_no_pattern_is_consulted_for_a_path_under_git(tmp_path: Path):
    """Structural first, patterns second -- shown, not inferred.

    An implementation that asks the patterns and then overrules them gives the
    right answer above and is still wrong twice: it pays a regex run per
    ancestor on the churn of every commit, and it leaves `.git`'s invisibility
    resting on a rule that a later `!` could be argued into changing.
    """
    _write(tmp_path, ".gitignore", "!.git\n")
    _touch(tmp_path, ".git/HEAD")
    rules = _SpyRules(str(tmp_path))

    relative_to_root(_event(tmp_path, ".git/HEAD"), str(tmp_path), rules)

    assert rules.pattern_questions == []


# --- 5.3a `.git` is a name, not a position ---------------------------------


def test_every_checkouts_git_directory_is_refused_in_a_workspace(tmp_path: Path):
    """`rhi ~/projects`: neither `.git` here sits at the observed root.

    An implementation that special-cased the root's own `.git` -- by comparing
    the first segment, or by testing `relative.startswith(".git/")` -- passes
    5.3 and floods the graph with two repositories' index churn.
    """
    _write(tmp_path, "a/.gitignore", "out/\n")
    _touch(tmp_path, "a/.git/index")
    _write(tmp_path, "b/.gitignore", "tmpdir/\n")
    _touch(tmp_path, "b/.git/index")
    rules = IgnoreRules(str(tmp_path))

    answers = [
        relative_to_root(_event(tmp_path, "a/.git/index"), str(tmp_path), rules),
        relative_to_root(_event(tmp_path, "b/.git/index"), str(tmp_path), rules),
    ]

    assert answers == [None, None]


def test_a_checkouts_own_gitignore_governs_its_dotted_directories(tmp_path: Path):
    """`governs` is asked per directory, never once for the tree.

    The workspace root has no `.gitignore`, so a single tree-wide decision
    answers "ungoverned" and hides `a/.claude/x.md` -- the file this whole
    feature exists to show. Measured against git 2.43 inside checkout `a`:
    `a/.claude/x.md` is *not ignored*.
    """
    _write(tmp_path, "a/.gitignore", "out/\n")
    _touch(tmp_path, "a/.claude/x.md")
    rules = IgnoreRules(str(tmp_path))

    relative = relative_to_root(_event(tmp_path, "a/.claude/x.md"), str(tmp_path), rules)

    assert relative == "a/.claude/x.md"


def test_a_checkouts_own_pattern_is_enforced_on_the_watchers_path(
    tmp_path: Path,
):
    """A nested `.gitignore` binds below itself here, as it does on the walk.

    Every checkout of a workspace keeps its ignores at its own top level, which
    is a *nested* file relative to the observed root -- so an implementation
    that consulted the root's file alone would see none of them and add back
    every path the seed pruned in every checkout. Measured against git 2.43
    inside checkout `a`: `a/out/gen.txt` is ignored.
    """
    _write(tmp_path, "a/.gitignore", "out/\n")
    _touch(tmp_path, "a/out/gen.txt")
    rules = IgnoreRules(str(tmp_path))

    relative = relative_to_root(_event(tmp_path, "a/out/gen.txt"), str(tmp_path), rules)

    assert relative is None


def test_a_checkouts_patterns_do_not_reach_its_neighbour(tmp_path: Path):
    """Each checkout's rules stay its own, on the watcher's path as on the walk.

    Measured against git 2.43 in both checkouts: `a`'s `out/` says nothing about
    `b/out`.
    """
    _write(tmp_path, "a/.gitignore", "out/\n")
    _touch(tmp_path, "b/out/gen.txt")
    rules = IgnoreRules(str(tmp_path))

    relative = relative_to_root(_event(tmp_path, "b/out/gen.txt"), str(tmp_path), rules)

    assert relative == "b/out/gen.txt"


# --- 5.4 The ancestor chain, and the `is_dir` it carries --------------------


def test_a_file_deep_under_an_ignored_directory_is_refused(tmp_path: Path):
    """The leaf matches nothing; the directory above it matches everything.

    `out/` names a directory, and `deep/x` is neither. Only a traversal that
    tests each ancestor *as a directory* refuses this path, which is the whole
    reason the watcher cannot reuse the walk's leaf-only answer.
    """
    _write(tmp_path, ".gitignore", "out/\n")
    _touch(tmp_path, "out/deep/x")
    rules = IgnoreRules(str(tmp_path))

    relative = relative_to_root(_event(tmp_path, "out/deep/x"), str(tmp_path), rules)

    assert relative is None


def test_a_negation_under_an_excluded_directory_does_not_re_include(
    tmp_path: Path,
):
    """`ignored`, never `ignored_child` -- the one path where they differ.

    Measured against git 2.43 over this exact tree: `git check-ignore -v
    out/keep.txt` names `.gitignore:1:out/` as the deciding rule. Git stops at
    the excluded directory and the negation on the next line is never reached.
    `ignored_child("out", "keep.txt", False)` answers `False` for this same
    path, so an implementation that reached for the walk's entry point puts a
    node on the graph that the seed refused -- and puts it there permanently.
    """
    _write(tmp_path, ".gitignore", "out/\n!out/keep.txt\n")
    _touch(tmp_path, "out/keep.txt")
    rules = IgnoreRules(str(tmp_path))

    relative = relative_to_root(_event(tmp_path, "out/keep.txt"), str(tmp_path), rules)

    assert relative is None


def test_a_directory_only_pattern_refuses_a_path_under_that_directory(
    tmp_path: Path,
):
    """Half of the `is_dir` pair: a constant `False` accepts this and is wrong.

    Measured against git 2.43: `deeper/logs/a.txt` is ignored by `logs/`, at any
    depth, because the pattern carries no slash and is therefore unanchored.
    """
    _write(tmp_path, ".gitignore", "logs/\n")
    _touch(tmp_path, "deeper/logs/a.txt")
    rules = IgnoreRules(str(tmp_path))

    relative = relative_to_root(_event(tmp_path, "deeper/logs/a.txt"), str(tmp_path), rules)

    assert relative is None


def test_a_directory_only_pattern_leaves_a_file_of_that_name_alone(
    tmp_path: Path,
):
    """The other half: a constant `True` refuses this and is wrong.

    Measured against git 2.43 over this exact tree: the top-level *file* named
    `logs` is *not ignored*. Neither assertion alone catches both constants,
    which is why they are written as a pair.
    """
    _write(tmp_path, ".gitignore", "logs/\n")
    _touch(tmp_path, "logs")
    rules = IgnoreRules(str(tmp_path))

    relative = relative_to_root(_event(tmp_path, "logs"), str(tmp_path), rules)

    assert relative == "logs"


# --- 5.4a Containment stays `relative_to_root`'s own, ahead of the rules ----
#
# `IgnoreRules` deliberately resolves nothing: `_segments` drops empty pieces
# and a bare `.` and hands `..` straight through, because keeping the daemon
# inside its root is another module's job. On this path that job belongs to the
# prefix check these two tests pin, and it has to stay in front.


def test_a_path_outside_the_root_is_refused_before_the_rules_are_asked(
    tmp_path: Path,
):
    outside = tmp_path.parent / "elsewhere" / "app.py"
    _write(tmp_path, ".gitignore", "out/\n")
    rules = _SpyRules(str(tmp_path))

    relative = relative_to_root(str(outside), str(tmp_path), rules)

    assert (relative, rules.pattern_questions) == (None, [])


def test_the_root_itself_is_refused_without_asking_the_rules(tmp_path: Path):
    """`ignored("")` answers `False` by design, so the root must never reach it.

    A root `*` must not blank the graph, which is why the empty relative path is
    never ignored -- and that is exactly why handing it over expecting a verdict
    would return the root itself as a change.
    """
    _write(tmp_path, ".gitignore", "*\n")
    rules = _SpyRules(str(tmp_path))

    relative = relative_to_root(str(tmp_path), str(tmp_path), rules)

    assert (relative, rules.pattern_questions) == (None, [])


# --- 5.5 A real watcher over a real tree ------------------------------------
#
# The only tests here that start an observer. `relative_to_root` can be perfect
# and the watcher still ignore it: `FsWatcher` has to build the `IgnoreRules`
# from the root it already holds and hand it down to `_Handler`.


def test_the_watcher_drops_a_write_the_root_gitignore_names(tmp_path: Path):
    """The end of the mirror failure: no node for a file the seed pruned.

    The ignored write happens first and the visible one second, so the visible
    one arriving proves the ignored one was already dispatched -- inotify
    preserves order, and the assertion needs no sleep.
    """
    _write(tmp_path, ".gitignore", "out/\n")
    (tmp_path / "out").mkdir()
    seen: list[tuple[str, str]] = []
    watcher = FsWatcher(str(tmp_path), lambda path, op: seen.append((path, op)))

    watcher.start()
    try:
        (tmp_path / "out" / "gen.txt").write_text("x")
        (tmp_path / "real.py").write_text("x")
        watcher.wait_for(lambda: any(p == "real.py" for p, _ in seen), timeout=5.0)
    finally:
        watcher.stop()

    assert not any(p.startswith("out/") for p, _ in seen)


def test_the_watcher_reports_a_write_to_a_governed_dotted_directory(
    tmp_path: Path,
):
    """The file the seed drew, flashing when it changes -- the whole of G5."""
    _write(tmp_path, ".gitignore", "out/\n")
    (tmp_path / ".claude").mkdir()
    seen: list[tuple[str, str]] = []
    watcher = FsWatcher(str(tmp_path), lambda path, op: seen.append((path, op)))

    watcher.start()
    try:
        (tmp_path / ".claude" / "a.md").write_text("x")
        watcher.wait_for(lambda: any(p == ".claude/a.md" for p, _ in seen), timeout=5.0)
    finally:
        watcher.stop()

    assert any(p == ".claude/a.md" for p, _ in seen)


# --- 5.6 The invalidation, end to end ---------------------------------------


def test_creating_the_first_gitignore_makes_dotted_files_visible(
    tmp_path: Path,
):
    """Invalidation fires on *creation*, and forgets the negative answers.

    A project's first `.gitignore` is created, not edited, and that creation is
    what switches the dotted fallback off for the whole tree. A cache that
    remembers only the files it has read latches `governs` on `False` for every
    directory it was asked about before the file existed, and the tree stays
    half-hidden until the daemon is restarted -- with the seed of the *next*
    boot disagreeing with the events of this one.

    The first write is the arrangement, not decoration: it is what puts the
    negative answer in the cache that has to be forgotten.
    """
    (tmp_path / ".claude").mkdir()
    seen: list[tuple[str, str]] = []
    watcher = FsWatcher(str(tmp_path), lambda path, op: seen.append((path, op)))

    watcher.start()
    try:
        (tmp_path / ".claude" / "before.md").write_text("x")
        (tmp_path / "fence1.py").write_text("x")
        watcher.wait_for(lambda: any(p == "fence1.py" for p, _ in seen), timeout=5.0)
        assert not any(p == ".claude/before.md" for p, _ in seen)

        (tmp_path / ".gitignore").write_text("")
        (tmp_path / "fence2.py").write_text("x")
        watcher.wait_for(lambda: any(p == "fence2.py" for p, _ in seen), timeout=5.0)

        (tmp_path / ".claude" / "after.md").write_text("x")
        watcher.wait_for(
            lambda: any(p == ".claude/after.md" for p, _ in seen), timeout=5.0
        )
    finally:
        watcher.stop()

    assert any(p == ".claude/after.md" for p, _ in seen)


def test_a_new_pattern_binds_on_the_very_next_write(tmp_path: Path):
    """Editing the file has to take effect without restarting the daemon.

    The fence between the two writes is what makes this a statement about
    invalidation rather than about timing: `fence.py` arriving proves the
    `.gitignore` event was dispatched and its handler returned, so `later.tmp`
    is written into a watcher that has already been told.
    """
    _write(tmp_path, ".gitignore", "# nothing yet\n")
    seen: list[tuple[str, str]] = []
    watcher = FsWatcher(str(tmp_path), lambda path, op: seen.append((path, op)))

    watcher.start()
    try:
        (tmp_path / "early.tmp").write_text("x")
        watcher.wait_for(lambda: any(p == "early.tmp" for p, _ in seen), timeout=5.0)
        assert any(p == "early.tmp" for p, _ in seen)

        (tmp_path / ".gitignore").write_text("*.tmp\n")
        (tmp_path / "fence.py").write_text("x")
        watcher.wait_for(lambda: any(p == "fence.py" for p, _ in seen), timeout=5.0)

        (tmp_path / "later.tmp").write_text("x")
        (tmp_path / "fence2.py").write_text("x")
        watcher.wait_for(lambda: any(p == "fence2.py" for p, _ in seen), timeout=5.0)
    finally:
        watcher.stop()

    assert not any(p == "later.tmp" for p, _ in seen)


def test_a_gitignore_renamed_into_place_binds_too(tmp_path: Path):
    """The commonest way that file is ever rewritten, and the plan is ambiguous.

    "Whenever an event's basename is `.gitignore`" reads as
    `os.path.basename(event.src_path)`, and on a rename that is the *source*
    name. Measured with watchdog on this host: `os.replace(".gitignore.tmp",
    ".gitignore")` produces one `moved` event whose `src_path` ends in
    `.gitignore.tmp` and whose `dest_path` ends in `.gitignore` -- so an
    implementation reading the source alone never invalidates, and the rules go
    stale for the rest of the session.

    This is not an exotic path: `vim`, `git checkout`, `git stash` and every
    editor that saves atomically write the file exactly this way. `_report`
    already looks at both ends of a `moved` event, because a rename is a
    deletion here and an addition there; the invalidation has to look at both
    for the same reason.

    **Read the note on watchdog versions in this module's docstring before
    trusting a pass here.** On watchdog 6.0.0, which is what this checkout has,
    a source-only implementation passes this test by accident -- the daemon's
    own read of the file emits `opened`, whose basename is `.gitignore` -- and
    it stops doing so the moment the invalidation is narrowed to the event types
    that actually change a file, which it must be. Measured: with that narrowing
    and a source-only check, this is the one test in the file that fails.
    """
    _write(tmp_path, ".gitignore", "# nothing yet\n")
    seen: list[tuple[str, str]] = []
    watcher = FsWatcher(str(tmp_path), lambda path, op: seen.append((path, op)))

    watcher.start()
    try:
        (tmp_path / "early.tmp").write_text("x")
        watcher.wait_for(lambda: any(p == "early.tmp" for p, _ in seen), timeout=5.0)
        assert any(p == "early.tmp" for p, _ in seen)

        staged = tmp_path / ".gitignore.staged"
        staged.write_text("*.tmp\n")
        os.replace(staged, tmp_path / ".gitignore")
        (tmp_path / "fence.py").write_text("x")
        watcher.wait_for(lambda: any(p == "fence.py" for p, _ in seen), timeout=5.0)

        (tmp_path / "later.tmp").write_text("x")
        (tmp_path / "fence2.py").write_text("x")
        watcher.wait_for(lambda: any(p == "fence2.py" for p, _ in seen), timeout=5.0)
    finally:
        watcher.stop()

    assert not any(p == "later.tmp" for p, _ in seen)
