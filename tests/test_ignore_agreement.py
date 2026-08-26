"""The walk and the watcher answer one rule with two implementations -- step G6.

The defect this file exists for has no symptom of its own. `ignored_child` is
the walk's entry point (leaf only, every ancestor already pruned and never
descended into) and `ignored` is the watcher's (the whole ancestor chain, tested
in order, stopping at the first exclusion). They are two implementations of
git's exclusion rule, kept apart for a measured reason, and until this file
nothing made them agree. When they drift, the graph looks fine: a path the seed
drew stops flashing and is never updated again, or a path the seed pruned is
added back one write at a time and stays on screen forever. That is the failure
this repository has already paid hours for -- it looks alive and it is lying.

G6 writes no production code. **If a test here is red, one of G2, G4 or G5 is
wrong, and the answer is to fix that step rather than to weaken this file.**

Four properties carry it.

  * **What the walk kept, the per-path answer keeps.** Written as a one-way
    implication and nothing more: `scan_tree`-kept implies
    `not rules.ignored(p, False)`. The converse is false *by design* --
    `gitignore.py` knows nothing about `.git`, `node_modules` or the dotted
    fallback, all of which are rules of this application rather than of git's
    syntax, and it answers `False` for every path they prune. Asserting the
    biconditional would demand that `gitignore.py` learn the caller's policy,
    which is the separation its own docstring is built on.
  * **The fixture has to contain a negation under an excluded directory, or the
    property above proves nothing.** That is the *one* place the two entry
    points genuinely diverge: with `out/` then `!out/keep.txt`,
    `ignored_child("out", "keep.txt", False)` is `False` while
    `ignored("out/keep.txt", False)` is `True`. Measured against git 2.43 over
    this exact tree, `git check-ignore -v out/keep.txt` names `.gitignore:1:out/`
    as the deciding rule -- git stops at the directory and never reads the
    negation. A walk that descended and filtered afterwards with the leaf-only
    answer would keep `out/keep.txt`, and only then does the implication above
    have anything to catch.
  * **Three categories of pruned path, not two.** Pattern-pruned (`out/gen.txt`,
    `src/a.log`) answers `True`; structurally pruned (`node_modules/a.js`,
    `.git/config`) answers `False`; and fallback-pruned (`.cache/junk.txt`,
    `c/.hidden/x.txt` under an ungoverned root) also answers `False`, for a
    third reason `gitignore.py` knows nothing about. The asymmetry is pinned
    here rather than left as a surprise to whoever next reads `ignored` and
    assumes it is the whole rule.
  * **The strongest statement is the walk against the watcher itself**, not
    against `IgnoreRules`: for every path `scan_tree(root)` returned,
    `relative_to_root(join(root, p), root, IgnoreRules(root))` is `p`, and for
    the pruned paths it is `None`. That is the seed-versus-live-events
    disagreement expressed directly, over one fixture, and it is the assertion
    with teeth: it alone refuses the naive `is_ignored`-first watcher, a watcher
    that drops the dotted fallback whenever rules exist, a tree-wide `governs`,
    and matching on a basename instead of on the path.

**What this file deliberately does not cover.** `REPO_ROOT` is used as a second
fixture because nobody wrote it by hand, but this checkout has a root
`.gitignore`, so `governs` is true everywhere in it and every one of its 244
paths is pattern-clean -- the ungoverned branch is exercised by the `tmp_path`
workspace below and by nothing else here.

Note the watcher composes `_refused_by_name` *then* `rules.ignored`, so it is
asked through `relative_to_root` alone; the private half is never imported.
Note too that it passes `os.path.isdir(normalized)` as `is_dir`, so every path
asserted here is a path that really exists on disk.

Style: Arrange-Act-Assert, one property per test, real `tmp_path` trees with
real `.gitignore` files in them. Everything asserted as git's own behaviour was
checked against `git check-ignore -v` (git 2.43), never with a trailing slash --
git disagrees with itself about one.
"""

from __future__ import annotations

import os
from pathlib import Path

from daemon.watcher import relative_to_root
from rhizome_graph.gitignore import IgnoreRules
from rhizome_graph.tree import scan_tree

#: This checkout: a governed tree with a real `.gitignore`, a `.venv`, a
#: `node_modules` and a committed `.claude/`, which no test author curated.
REPO_ROOT = Path(__file__).resolve().parent.parent


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


def _governed_tree(root: Path) -> None:
    """A governed root: a root file, a nested one, a negation, dots, noise.

    The negation is the point of the fixture. Measured against git 2.43 over
    this exact tree: `out/keep.txt` and `out/gen.txt` are ignored by `out/`,
    `src/a.log` by `*.log`, `.venv/bin/python` by `.venv/`, `sub/x.tmp` by
    `sub`'s own `*.tmp` -- while the identically named `x.tmp` at the root,
    `.claude/agents/a.md`, `src/app.py` and `node_modules/a.js` are *not*
    ignored. The last of those four is this application's own divergence and is
    pruned by the caller, which is exactly what the asymmetry tests below are
    about.
    """
    _write(root, ".gitignore", "out/\n!out/keep.txt\n*.log\n.venv/\n")
    _write(root, "out/.gitignore", "!keep.txt\n")
    _touch(root, "out/keep.txt")
    _touch(root, "out/gen.txt")
    _write(root, "sub/.gitignore", "*.tmp\n")
    _touch(root, "sub/x.tmp")
    _touch(root, "sub/keep.py")
    _touch(root, "x.tmp")
    _touch(root, ".claude/agents/a.md")
    _touch(root, ".venv/bin/python")
    _touch(root, ".git/config")
    _touch(root, "node_modules/a.js")
    _touch(root, "src/app.py")
    _touch(root, "src/a.log")


def _workspace_tree(root: Path) -> None:
    """`rhi ~/projects`: an ungoverned root over two checkouts and a plain dir.

    The tree from `test_a_workspace_of_checkouts_is_governed_per_directory`,
    reused because it is the only fixture here where the dotted fallback is in
    force -- `governs("")` is False, `governs("a")` is True. Measured against
    git 2.43 inside each checkout: `a`'s `out/` ignores `a/out/gen.txt` and says
    nothing about `b/out/gen.txt`, `b`'s `tmpdir/` ignores `b/tmpdir/t.txt` and
    says nothing about `a/tmpdir/t.txt`, and `a/.claude/x.md` is not ignored.
    """
    _touch(root, "README.md")
    _touch(root, ".cache/junk.txt")

    _write(root, "a/.gitignore", "out/\n")
    _touch(root, "a/.git/config")
    _touch(root, "a/.claude/x.md")
    _touch(root, "a/src/a.py")
    _touch(root, "a/out/gen.txt")
    _touch(root, "a/tmpdir/t.txt")

    _write(root, "b/.gitignore", "tmpdir/\n")
    _touch(root, "b/.git/config")
    _touch(root, "b/src/b.py")
    _touch(root, "b/tmpdir/t.txt")
    _touch(root, "b/out/gen.txt")

    _touch(root, "c/src/c.py")
    _touch(root, "c/.hidden/x.txt")


# --- 6.1 What the walk kept, the per-path answer keeps ----------------------


def test_every_path_the_walk_kept_is_not_ignored_by_the_per_path_answer(
    tmp_path: Path,
):
    """One direction only: kept implies not ignored, never the converse.

    The converse is false by design and is pinned as such in 6.3 below:
    `node_modules/a.js` is pruned by the walk and answers `False` here, because
    hiding generated output is this application's rule and not git's syntax.

    The two membership assertions keep the loop from passing vacuously and name
    the case that gives it teeth: `.claude/agents/a.md` is drawn by a governed
    root, and `out/keep.txt` is not drawn even though the root file re-includes
    it by name and `out/.gitignore` re-includes it a second time.
    """
    _governed_tree(tmp_path)
    rules = IgnoreRules(str(tmp_path))

    kept = scan_tree(str(tmp_path))

    assert ".claude/agents/a.md" in kept
    assert "out/keep.txt" not in kept
    assert [path for path in kept if rules.ignored(path, False)] == []


def test_the_two_entry_points_disagree_under_an_excluded_directory(
    tmp_path: Path,
):
    """The one divergence, stated outright, because it is what 6.1 rests on.

    If these two answers were ever equal, `ignored` would be a slower spelling
    of `ignored_child` and the property above would hold for a tree with no
    negation in it -- which is to say, for the wrong reason. Measured against
    git 2.43 over this exact tree: `git check-ignore -v out/keep.txt` names
    `.gitignore:1:out/`, so the chain answer is git's and the leaf-only answer
    is not an answer to this question at all.

    The walk is entitled to the leaf-only one because it prunes `dirnames` in
    place and never descends into `out`; the watcher, holding one bare path off
    an inotify event, is not.
    """
    _governed_tree(tmp_path)
    rules = IgnoreRules(str(tmp_path))

    leaf_only = rules.ignored_child("out", "keep.txt", False)
    whole_chain = rules.ignored("out/keep.txt", False)

    assert leaf_only is False
    assert whole_chain is True


# --- 6.2 The same over a fixture nobody wrote by hand -----------------------


def test_every_path_the_walk_kept_in_this_checkout_is_not_ignored() -> None:
    """This repository, walked for real: 244 paths, none of them pattern-dirty.

    Its value is that no test author chose its contents -- a `.venv`, a
    `node_modules`, a `web/dist`, a committed `.claude/` and whatever is
    uncommitted in the tree right now all take part. Its limit is stated in the
    module docstring and is worth repeating here: this checkout has a root
    `.gitignore`, so `governs` is true for every directory in it and the
    ungoverned branch is not exercised at all. The `tmp_path` workspace is what
    covers that.
    """
    root = str(REPO_ROOT)
    rules = IgnoreRules(root)

    kept = scan_tree(root)

    assert "CLAUDE.md" in kept
    assert ".claude/agents/developer-tester.md" in kept
    assert [path for path in kept if rules.ignored(path, False)] == []


# --- 6.3 Three reasons a path is pruned, and only one of them is git's ------


def test_a_path_pruned_for_a_pattern_reason_is_ignored_by_the_per_path_answer(
    tmp_path: Path,
):
    """The category where the two halves genuinely agree.

    Every one of these was measured as ignored by git 2.43 over this exact
    tree, and `out/keep.txt` is here on purpose: it is pattern-pruned through
    its *ancestor*, which is the half of the rule a leaf-only answer loses.
    """
    _governed_tree(tmp_path)
    rules = IgnoreRules(str(tmp_path))

    answers = {
        path: rules.ignored(path, False)
        for path in (
            "out/gen.txt",
            "out/keep.txt",
            "src/a.log",
            "sub/x.tmp",
            ".venv/bin/python",
        )
    }

    assert answers == {
        "out/gen.txt": True,
        "out/keep.txt": True,
        "src/a.log": True,
        "sub/x.tmp": True,
        ".venv/bin/python": True,
    }


def test_a_path_pruned_for_a_structural_reason_is_not_ignored_by_the_answer(
    tmp_path: Path,
):
    """The asymmetry, pinned rather than left as a surprise.

    `gitignore.py` answers git's question and no rhizome policy: which
    directories are generated noise, and which single directory is excluded
    whatever any pattern says, live in the caller. So the module says `False`
    for both of these, and git 2.43 says *not ignored* for both of them too --
    the walk hides them anyway, which is the divergence `tree.py` owns.

    Reading `ignored` as the whole rule and filtering a live event through it
    alone would put `.git/config` on the graph, and every `git status` would
    then draw the index rewrite.
    """
    _governed_tree(tmp_path)
    rules = IgnoreRules(str(tmp_path))

    answers = {
        path: rules.ignored(path, False)
        for path in ("node_modules/a.js", ".git/config")
    }

    assert answers == {"node_modules/a.js": False, ".git/config": False}


def test_a_path_pruned_by_the_dotted_fallback_is_not_ignored_by_the_answer(
    tmp_path: Path,
):
    """The third category, which is neither a pattern nor structural noise.

    The dotted fallback belongs to the caller as well -- `gitignore.py` never
    learns what `governs` is *for* -- so an ungoverned `.cache/` and an
    ungoverned `.hidden/` are pruned by the walk while the per-path answer here
    is `False`, for a third reason the module knows nothing about.

    Two categories would have been an easy story to tell and it would have been
    wrong: whoever next tries to derive the walk's answer from `ignored` alone
    needs all three of these tests to stop them, not two.
    """
    _workspace_tree(tmp_path)
    rules = IgnoreRules(str(tmp_path))

    answers = {
        path: rules.ignored(path, False)
        for path in (".cache/junk.txt", "c/.hidden/x.txt")
    }

    assert answers == {".cache/junk.txt": False, "c/.hidden/x.txt": False}


# --- 6.4 The walk against the watcher, which is the property G6 is named for -


def test_every_path_the_walk_kept_the_watcher_still_reports(tmp_path: Path):
    """The seed and the live events describe one project, over one tree.

    This is the strongest and the cheapest statement of G6 now that G5 has
    landed: it compares the two entry points *as their callers use them*,
    composite rule included, rather than comparing one of them with a piece of
    the other. A path the walk drew and the watcher refuses is a node that
    flashes once at boot and never again.

    One `IgnoreRules` is shared across the loop on purpose: that is the
    watcher's own shape -- built once per `FsWatcher` and kept for its lifetime
    -- while the walk builds a fresh one per pass. Two objects, one answer.
    """
    _governed_tree(tmp_path)
    root = str(tmp_path)
    rules = IgnoreRules(root)

    kept = scan_tree(root)

    assert ".claude/agents/a.md" in kept
    assert [
        path
        for path in kept
        if relative_to_root(os.path.join(root, path), root, rules) != path
    ] == []


def test_every_path_the_walk_kept_the_watcher_still_reports_in_a_workspace(
    tmp_path: Path,
):
    """The same over a root where `governs` answers differently per directory.

    This is the fixture that refuses a tree-wide `governs`: decided once from
    the root, `a/.claude/x.md` is refused by the watcher though the walk drew
    it; decided once from "is there a `.gitignore` anywhere below", the root's
    own `.cache/junk.txt` is accepted though the walk pruned it. Both failures
    land on this assertion or on the next one.
    """
    _workspace_tree(tmp_path)
    root = str(tmp_path)
    rules = IgnoreRules(root)

    kept = scan_tree(root)

    assert "a/.claude/x.md" in kept
    assert [
        path
        for path in kept
        if relative_to_root(os.path.join(root, path), root, rules) != path
    ] == []


def test_every_path_the_walk_pruned_the_watcher_refuses(tmp_path: Path):
    """The mirror, and the worse failure of the two.

    A path the seed pruned and the watcher accepts is added back to the graph
    one write at a time, permanently, because a wrong node stays on screen
    forever. All three categories are here, because each is refused for a
    different reason and a watcher that lost any one of them still passes the
    other two: pattern, structural noise, and -- in the workspace test below --
    the dotted fallback.

    Every path listed exists on disk, which matters: the watcher asks
    `os.path.isdir` for the `is_dir` flag, so a path that was never created
    would be answered as a file and the fixture would lean towards passing.
    """
    _governed_tree(tmp_path)
    root = str(tmp_path)
    rules = IgnoreRules(root)

    answers = {
        path: relative_to_root(os.path.join(root, path), root, rules)
        for path in (
            "out/gen.txt",
            "out/keep.txt",
            "src/a.log",
            "sub/x.tmp",
            ".venv/bin/python",
            "node_modules/a.js",
            ".git/config",
        )
    }

    assert all(os.path.exists(tmp_path / path) for path in answers)
    assert set(answers.values()) == {None}


def test_every_path_the_walk_pruned_the_watcher_refuses_in_a_workspace(
    tmp_path: Path,
):
    """The fallback-pruned category, plus `.git` as a name rather than a place.

    Neither checkout's `.git` sits at the observed root, and each checkout's
    patterns are its own: `a`'s `out/` must refuse `a/out/gen.txt` and leave
    `b/out/gen.txt` alone, which the kept-path test above is the other half of.
    """
    _workspace_tree(tmp_path)
    root = str(tmp_path)
    rules = IgnoreRules(root)

    answers = {
        path: relative_to_root(os.path.join(root, path), root, rules)
        for path in (
            ".cache/junk.txt",
            "c/.hidden/x.txt",
            "a/out/gen.txt",
            "b/tmpdir/t.txt",
            "a/.git/config",
            "b/.git/config",
        )
    }

    assert all(os.path.exists(tmp_path / path) for path in answers)
    assert set(answers.values()) == {None}
