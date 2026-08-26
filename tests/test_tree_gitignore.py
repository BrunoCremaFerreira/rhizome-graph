"""Contract tests (RED) for `tree.scan_tree` under `.gitignore` -- step G4.

Motivation, and it is a defect in this very checkout: `_scan` prunes every
directory whose name begins with a dot, so `.claude/` and `.github/` -- six
agent definitions, a settings file and a CI workflow, all committed, authored,
English-policed source -- can never reach the graph. Measured: 7 files and
33 274 bytes missing from a 231-file picture, and **nothing is gained by their
absence**, because everything a `.gitignore` would have hidden here (`.venv/`,
`.pytest_cache/`, `.npm-bootstrap/`) it does hide. The same walk feeds the
content search and the F7 size pass, so a file the graph will not draw is also a
file `ctrl+shift+F` cannot find.

G4 replaces the blanket dot rule with the composite rule from the plan:

    skip a directory when:
        tree.is_structural_noise(name)                            # always
     or (not rules.governs(dir_rel) and name.startswith("."))     # the fallback
     or rules.ignored_child(dir_rel, name, True)
    skip a file when:
        rules.ignored_child(dir_rel, name, False)

Five properties carry this file, and each rules out a *plausible* wrong
implementation rather than an implausible one:

  * **The presence of a `.gitignore` is what turns the dotted fallback off.**
    Not the absence of one somewhere, not a flag: the file existing at or above
    a directory. Dropping the dot rule outright instead is the variant measured
    to take `$HOME` from 12 500 files to 20 000, which is `DEFAULT_MAX_FILES` --
    the seed silently truncated and the graph no longer the tree. Steps 4.1 and
    4.5b are the two jaws that rule it out.
  * **`governs` is answered per directory, never once for the tree.** A
    workspace root over a folder of checkouts has `governs("") is False` while
    `governs("a") is True`, so `a/.claude/` is drawn and the root's own `.cache/`
    is not, in one walk. A single tree-wide decision is wrong in both
    directions and 4.5b catches both.
  * **`is_dir` is load-bearing on `ignored_child`.** A walk that passes a
    constant flag looks right on `*.log` and is wrong on `logs/`, which hides
    the directory and not a file of the same name (measured). 4.4 and 4.4b are
    that pair.
  * **`.git` is hidden by `is_structural_noise` and by nothing else.** Measured
    against git 2.43: `git check-ignore .git/config` answers *not ignored* even
    with `!.git` in the file -- git never considers `.git` a candidate at all,
    so the ignore rules alone would put it on the graph. 4.5, 4.5a and 4.5b pin
    it on a governed root, on a root with no `.gitignore` at all, and on every
    checkout of a workspace, so it stays a name and not a position.
  * **Files are filtered now, not only directories.** `*.pyc` and `.DS_Store`
    are file patterns. `is_ignored` itself keeps its old directory-segments-only
    contract -- it is the structural-noise answer for a caller with no root --
    and that is G5's business, not this file's.

**Where this deliberately diverges from git, and why.** Two structural rules of
this application are not git's and are asserted here as divergences rather than
smuggled in as agreements: `node_modules/`, `dist/`, `__pycache__` and `vendor/`
are hidden even where no pattern names them (measured: git shows all four), and
`.git/` is hidden where git's own answer is "not ignored". Everything else in
this file was checked against `git check-ignore` before it was asserted. Note
the trap that check cost: `git check-ignore` disagrees with itself about a
trailing slash -- under `a/**` it calls `a/` ignored and `a` not -- so nothing
here was ever compared with one.

Style: Arrange-Act-Assert, one property per test. Every fixture is a real
`tmp_path` tree with real `.gitignore` files in it; nothing here mocks the disk.
"""

from __future__ import annotations

import os
from pathlib import Path

from rhizome_graph.tree import scan_tree


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


# --- 4.1 The fallback, pinned before it can be lost -------------------------
#
# Green today and it must stay green: this is the half of decision 2 that keeps
# a home directory usable. `$HOME` is not a repository and no `.gitignore`
# anywhere will ever mention `.cache`, `.local`, `.config`, `.npm` or
# `.vscode-server` -- 13 044 files on the host this was measured on.


def test_a_root_with_no_gitignore_still_hides_every_dotted_directory(
    tmp_path: Path,
):
    _touch(tmp_path, "src/app.py")
    _touch(tmp_path, ".venv/bin/python")
    _touch(tmp_path, ".pytest_cache/x")
    _touch(tmp_path, ".git/config")
    _touch(tmp_path, "node_modules/a.js")

    paths = scan_tree(str(tmp_path))

    assert paths == ["src/app.py"]


# --- 4.2 The switch --------------------------------------------------------


def test_an_empty_gitignore_turns_the_dotted_fallback_off(tmp_path: Path):
    """The presence of the file is the switch, not the rules it contributes.

    An empty `.gitignore` is the documented escape hatch of decision 2: a user
    who wants everything under a root drawn writes one. Deriving `governs` from
    whether a file produced a rule would close that hatch without a word.

    This is the test to write first, ahead of 4.3, because 4.3 is satisfiable by
    "drop the dot rule and add a matcher" -- the variant measured to truncate
    `$HOME` at `DEFAULT_MAX_FILES`. This one is not: it demands that the same
    walk answer differently for two trees that differ by one empty file.
    """
    _touch(tmp_path, "src/app.py")
    _touch(tmp_path, ".venv/bin/python")
    _touch(tmp_path, ".pytest_cache/x")
    _touch(tmp_path, ".git/config")
    _touch(tmp_path, "node_modules/a.js")
    _write(tmp_path, ".gitignore", "")

    paths = scan_tree(str(tmp_path))

    assert paths == [
        ".gitignore",
        ".pytest_cache/x",
        ".venv/bin/python",
        "src/app.py",
    ]


# --- 4.3 The request itself ------------------------------------------------


def test_a_governed_root_draws_dotted_directories_its_gitignore_does_not_name(
    tmp_path: Path,
):
    """The user's complaint and its fix, in one assertion.

    Measured against git 2.43 over this exact tree: `.venv/bin/python` is
    ignored, `.claude/agents/a.md` is not.
    """
    _write(tmp_path, ".gitignore", ".venv/\n")
    _touch(tmp_path, ".claude/agents/a.md")
    _touch(tmp_path, ".venv/bin/python")
    _touch(tmp_path, "src/app.py")

    paths = scan_tree(str(tmp_path))

    assert paths == [
        ".claude/agents/a.md",
        ".gitignore",
        "src/app.py",
    ]


def test_nothing_under_an_excluded_directory_can_be_re_included(tmp_path: Path):
    """The prune *is* the rule, so the walk must prune `dirnames` in place.

    Git's "a file cannot be re-included under an excluded directory" comes for
    free on a pruning walk and is lost the moment the walk descends anyway and
    filters afterwards with a leaf-only answer. Measured against git 2.43 over
    this exact tree: `git check-ignore -v out/keep.txt` names `.gitignore:1:out/`
    as the deciding rule, both with the negation in the root file and with it in
    a nested `out/.gitignore` -- which git never even opens.

    G6 compares the walk against `IgnoreRules.ignored` per path and holds only
    if this holds, so it is asserted here rather than assumed there.
    """
    _write(tmp_path, ".gitignore", "out/\n!out/keep.txt\n")
    _write(tmp_path, "out/.gitignore", "!keep.txt\n")
    _touch(tmp_path, "out/keep.txt")
    _touch(tmp_path, "out/gen.txt")
    _touch(tmp_path, "src/app.py")

    paths = scan_tree(str(tmp_path))

    assert paths == [".gitignore", "src/app.py"]


# --- 4.4 Files are filtered now, not only directories -----------------------


def test_a_file_pattern_hides_a_file(tmp_path: Path):
    """`is_ignored` considers directory segments only; the walk no longer can.

    `*.pyc` and `.DS_Store` are file patterns, and a walk that filtered
    directories alone would draw every one of them. This is a documented
    behaviour change of the walk, not of `is_ignored`.
    """
    _write(tmp_path, ".gitignore", "*.log\n")
    _touch(tmp_path, "src/a.log")
    _touch(tmp_path, "src/a.py")

    paths = scan_tree(str(tmp_path))

    assert paths == [".gitignore", "src/a.py"]


def test_a_directory_only_pattern_leaves_a_file_of_that_name_alone(
    tmp_path: Path,
):
    """`is_dir` is an argument, so a walk passing a constant is wrong here.

    A trailing slash means directories only. Measured against git 2.43 over this
    exact tree: `deeper/logs/a.txt` is ignored and the top-level *file* named
    `logs` is not. A walk that hands `ignored_child` a constant `True` hides the
    file; one that hands it a constant `False` shows the directory. Only the
    pair of this test and the one above catches both.
    """
    _write(tmp_path, ".gitignore", "logs/\n")
    _touch(tmp_path, "logs")
    _touch(tmp_path, "deeper/logs/a.txt")
    _touch(tmp_path, "src/app.py")

    paths = scan_tree(str(tmp_path))

    assert paths == [".gitignore", "logs", "src/app.py"]


# --- 4.5 `.git` is a rule, not a side effect of the dot ---------------------


def test_git_stays_hidden_even_when_the_gitignore_re_includes_it(
    tmp_path: Path,
):
    """Decision 1, on a root where the dotted fallback is off.

    The `.gitignore` here is what turns that fallback off, so `.git` has to be
    hidden by `is_structural_noise` and by a check that runs *before* any
    pattern. Git's own answer to this tree is the opposite one: measured against
    git 2.43, `git check-ignore .git/config` reports *not ignored*, because git
    never treats `.git` as a candidate for its ignore machinery at all. Our
    walk has no such exemption elsewhere, so the rule has to be written down.

    Two features depend on the invisibility: the branch poll and the status
    poll both exist because a commit typed in a terminal touches only `.git/`.
    """
    _write(tmp_path, ".gitignore", "!.git\n")
    _touch(tmp_path, ".git/config")
    _touch(tmp_path, "src/app.py")

    paths = scan_tree(str(tmp_path))

    assert paths == [".gitignore", "src/app.py"]


def test_git_stays_hidden_over_a_root_with_no_gitignore_at_all(tmp_path: Path):
    """The same rule where the fallback would hide it for the wrong reason.

    `.git` is the only dotted directory in this tree on purpose: with a
    `.gitignore` present the fallback is off and 4.5 answers, and with none the
    dot rule would answer -- so this fixture is the one that would still pass if
    the dot rule were removed everywhere, and would fail if `.git` were ever
    demoted to "just another dotted name".
    """
    _touch(tmp_path, ".git/config")
    _touch(tmp_path, "src/app.py")
    _touch(tmp_path, "README.md")

    paths = scan_tree(str(tmp_path))

    assert paths == ["README.md", "src/app.py"]


def test_a_workspace_of_checkouts_is_governed_per_directory(tmp_path: Path):
    """`rhi ~/projects`: the root ungoverned, each checkout governing itself.

    This is the case a single tree-wide fallback decision gets wrong in both
    directions. `governs("")` is False here -- no `.gitignore` at the workspace
    root -- so the root's own `.cache/` and the plain directory's `.hidden/`
    keep today's rule, while `governs("a")` is True, so `a/.claude/x.md` is
    drawn. Deciding once from the root hides `a/.claude/x.md`; deciding once
    from "is there a `.gitignore` anywhere" shows `.cache/junk.txt`.

    It also pins `.git` as a *name* rather than a position: neither checkout's
    `.git` is at the observed root. And each checkout's patterns stay its own --
    measured against git 2.43 in both checkouts: `a`'s `out/` says nothing about
    `b/out`, and `b`'s `tmpdir/` says nothing about `a/tmpdir`.
    """
    _touch(tmp_path, "README.md")
    _touch(tmp_path, ".cache/junk.txt")

    _write(tmp_path, "a/.gitignore", "out/\n")
    _touch(tmp_path, "a/.git/config")
    _touch(tmp_path, "a/.claude/x.md")
    _touch(tmp_path, "a/src/a.py")
    _touch(tmp_path, "a/out/gen.txt")
    _touch(tmp_path, "a/tmpdir/t.txt")

    _write(tmp_path, "b/.gitignore", "tmpdir/\n")
    _touch(tmp_path, "b/.git/config")
    _touch(tmp_path, "b/src/b.py")
    _touch(tmp_path, "b/tmpdir/t.txt")
    _touch(tmp_path, "b/out/gen.txt")

    _touch(tmp_path, "c/src/c.py")
    _touch(tmp_path, "c/.hidden/x.txt")

    paths = scan_tree(str(tmp_path))

    assert paths == [
        "README.md",
        "a/.claude/x.md",
        "a/.gitignore",
        "a/src/a.py",
        "a/tmpdir/t.txt",
        "b/.gitignore",
        "b/out/gen.txt",
        "b/src/b.py",
        "c/src/c.py",
    ]


# --- 4.6 The structural half of decision 2 ----------------------------------


def test_structural_noise_stays_hidden_under_a_gitignore_that_does_not_name_it(
    tmp_path: Path,
):
    """Generated output is not git's subject, so a governed root keeps hiding it.

    Measured against git 2.43 over this exact tree: all four of these are *not
    ignored*, so this is a deliberate divergence and not an agreement. Without
    it, a repository whose `.gitignore` happens not to name `node_modules`
    floods the graph with ten thousand nodes -- and the daemon has to stay
    usable on a project with no repository at all, which is the argument
    `tree.py`'s own docstring has always made.

    The mirror price is real and filed as G8: a project that deliberately
    commits its `dist/` never sees it. One nameable case against an unbounded
    one.
    """
    _write(tmp_path, ".gitignore", "*.log\n")
    _touch(tmp_path, "node_modules/a.js")
    _touch(tmp_path, "dist/bundle.js")
    _touch(tmp_path, "__pycache__/a.pyc")
    _touch(tmp_path, "vendor/lib.py")
    _touch(tmp_path, "src/app.py")

    paths = scan_tree(str(tmp_path))

    assert paths == [".gitignore", "src/app.py"]


# --- 4.7 The walk consults nested files as it descends ----------------------


def test_a_nested_gitignore_binds_below_itself_and_nowhere_else(tmp_path: Path):
    """The workspace case, in miniature: rules do not leak upward.

    Measured against git 2.43 over this exact tree: `sub/x.tmp` is ignored and
    the identically named `x.tmp` at the root is not. There is deliberately no
    root `.gitignore`, so this also shows `governs` answering True for `sub`
    while it answers False for the root -- one walk, two answers.
    """
    _write(tmp_path, "sub/.gitignore", "*.tmp\n")
    _touch(tmp_path, "x.tmp")
    _touch(tmp_path, "sub/x.tmp")
    _touch(tmp_path, "sub/keep.py")

    paths = scan_tree(str(tmp_path))

    assert paths == ["sub/.gitignore", "sub/keep.py", "x.tmp"]


# --- 4.8 The guard rails, re-asserted over a governed tree ------------------
#
# Every one of these is pinned in `tests/test_tree.py` over a tree with no
# `.gitignore` in it. Re-asserted here because G4 puts a file read, a cache and
# a matcher inside the walk, and each of the four is a way that goes wrong
# quietly: an exception swallowed into an empty seed, a cap applied before the
# sort, a symlink loop, an unstable order that lays the graph out differently
# every boot.


def test_a_missing_root_is_empty_even_when_a_gitignore_sits_beside_it(
    tmp_path: Path,
):
    _write(tmp_path, ".gitignore", "*.log\n")

    assert scan_tree(str(tmp_path / "does-not-exist")) == []


def test_max_files_still_caps_a_governed_tree(tmp_path: Path):
    _write(tmp_path, ".gitignore", "*.log\n")
    for i in range(20):
        _touch(tmp_path, f"f{i:02d}.txt")

    paths = scan_tree(str(tmp_path), max_files=5)

    assert len(paths) == 5


def test_symlinked_directories_are_still_not_followed_in_a_governed_tree(
    tmp_path: Path,
):
    _write(tmp_path, ".gitignore", "*.log\n")
    _touch(tmp_path, "real/app.py")
    os.symlink(tmp_path / "real", tmp_path / "link", target_is_directory=True)

    paths = scan_tree(str(tmp_path))

    assert paths == [".gitignore", "real/app.py"]


def test_the_result_is_still_sorted_over_a_governed_tree(tmp_path: Path):
    _write(tmp_path, ".gitignore", "*.log\n")
    for rel in ("z/last.py", "a/first.py", "m/middle.py"):
        _touch(tmp_path, rel)

    paths = scan_tree(str(tmp_path))

    assert paths == [
        ".gitignore",
        "a/first.py",
        "m/middle.py",
        "z/last.py",
    ]
