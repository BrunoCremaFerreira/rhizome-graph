"""Contract tests (RED) for rhizome_graph.tree.

`scan_tree` is what lets the graph start as a *tree* instead of a blank field:
the daemon walks the observed project once at boot and seeds every existing file
before a single agent event arrives. Gource shows the whole repository from
frame 1; without this the page shows only the two or three files an agent
happened to touch.

Style: Arrange-Act-Assert, one failure reason per test.
"""

from __future__ import annotations

import ast
import os
from pathlib import Path

from rhizome_graph import tree
from rhizome_graph.tree import is_ignored, scan_tree


def _touch(root: Path, rel: str) -> None:
    """Create an empty file at `rel` under `root`, with its parent dirs."""
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("")


def _tree_source() -> str:
    return Path(tree.__file__).read_text(encoding="utf-8")


def _identifiers(module: ast.Module) -> set[str]:
    """Every name the code *defines* or *uses*: functions, bare names, attributes.

    Identifiers rather than raw text, for the reason `tests/test_checkouts.py`
    gives: a docstring is allowed -- expected, even -- to name what a refactor
    replaced, and a substring search would then fail on the explanation instead
    of on a breach.
    """
    names: set[str] = set()
    for node in ast.walk(module):
        if isinstance(node, ast.FunctionDef):
            names.add(node.name)
        elif isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.Attribute):
            names.add(node.attr)
    return names


# --- 1. Basic walk ----------------------------------------------------------

def test_returns_paths_relative_to_root(tmp_path: Path):
    _touch(tmp_path, "src/app.py")
    _touch(tmp_path, "README.md")

    paths = scan_tree(str(tmp_path))

    assert set(paths) == {"src/app.py", "README.md"}


def test_result_is_sorted_for_a_stable_seed_order(tmp_path: Path):
    _touch(tmp_path, "z.py")
    _touch(tmp_path, "a.py")
    _touch(tmp_path, "m/inner.py")

    paths = scan_tree(str(tmp_path))

    assert paths == sorted(paths)


def test_empty_project_yields_no_paths(tmp_path: Path):
    assert scan_tree(str(tmp_path)) == []


# --- 2. Noise the graph must never show ------------------------------------

def test_skips_vcs_and_build_directories(tmp_path: Path):
    _touch(tmp_path, "src/app.py")
    for noisy in (
        ".git/config",
        "node_modules/three/index.js",
        "__pycache__/app.cpython-312.pyc",
        ".venv/bin/python",
        "dist/bundle.js",
        ".pytest_cache/CACHEDIR.TAG",
    ):
        _touch(tmp_path, noisy)

    paths = scan_tree(str(tmp_path))

    assert paths == ["src/app.py"]


def test_skips_packaging_metadata_directories(tmp_path: Path):
    _touch(tmp_path, "rhizome_graph/__init__.py")
    _touch(tmp_path, "rhizome_graph.egg-info/PKG-INFO")

    assert scan_tree(str(tmp_path)) == ["rhizome_graph/__init__.py"]


def test_is_ignored_matches_any_segment_of_the_path():
    assert is_ignored("node_modules/three/build/three.js")
    assert is_ignored(".git/HEAD")
    assert is_ignored("web/node_modules/vite/bin.js")
    assert not is_ignored("src/app.py")
    assert not is_ignored("web/src/renderer.ts")


# --- 3. Guard rails: never raise, never flood ------------------------------

def test_missing_root_returns_empty_instead_of_raising(tmp_path: Path):
    assert scan_tree(str(tmp_path / "does-not-exist")) == []


def test_respects_max_files_cap(tmp_path: Path):
    for i in range(20):
        _touch(tmp_path, f"f{i:02d}.txt")

    paths = scan_tree(str(tmp_path), max_files=5)

    assert len(paths) == 5


def test_symlinked_directories_are_not_followed(tmp_path: Path):
    _touch(tmp_path, "real/app.py")
    os.symlink(tmp_path / "real", tmp_path / "link", target_is_directory=True)

    paths = scan_tree(str(tmp_path))

    assert paths == ["real/app.py"]


# --- 4. G3: one predicate per audience, and an answer that does not move ----
#
# The defect this section exists for: `tree._is_ignored_dir` answered two
# different questions through one private name. `tree._scan` and `tree.is_ignored`
# ask "would the graph draw this?"; `checkouts._child_directories` -- reaching
# through the underscore, from another module -- asks "is this worth walking into
# looking for a `.git`?". They are not the same question, and G4 is about to
# change the first one: the walk will consult a `.gitignore` and stop hiding every
# dotted directory. Discovery must not follow it there, because it is 50-100x
# cheaper than the forks it decides on (0.2-0.4 ms against ~20 ms) and would
# spend `MAX_SCANNED_DIRS` inside `.git/objects`.
#
# G3 itself is a refactor whose whole purpose is that the suite does not move.
# Everything below the `is_structural_noise` block is therefore a *jaw*: it
# passes today, it must still pass after the split, and it is what makes G4
# provably additive rather than hopefully additive.


def test_always_ignored_dirs_names_git_and_nothing_else():
    """Decision 1, as a constant: `.git` is hidden by name, never by its dot.

    The dot rule is about to become conditional on a `.gitignore` being present
    (G4); `.git` is not. Folding it back into `IGNORED_DIRS` -- which is about
    generated build output -- would lose the distinction the moment someone asks
    why `dist/` is configurable and `.git/` is not.
    """
    assert tree.ALWAYS_IGNORED_DIRS == frozenset({".git"})
    assert ".git" not in tree.IGNORED_DIRS


def test_is_structural_noise_covers_vcs_build_output_and_packaging_metadata():
    """The graph's "never, whatever any file says" list, in one predicate."""
    assert tree.is_structural_noise(".git")
    assert tree.is_structural_noise("node_modules")
    assert tree.is_structural_noise("__pycache__")
    assert tree.is_structural_noise("dist")
    assert tree.is_structural_noise("a.egg-info")


def test_is_structural_noise_says_nothing_about_dotted_directories():
    """The dot rule is a *fallback*, and it must live outside this predicate.

    `.claude/` and `.github/` are committed, authored source in this repository;
    `.venv/` and `.pytest_cache/` are hidden today only because nothing consults
    a `.gitignore` yet. If either group answered `True` here, G4 could never show
    the first and G5's watcher could never agree with the walk about the second.
    """
    assert not tree.is_structural_noise(".claude")
    assert not tree.is_structural_noise(".github")
    assert not tree.is_structural_noise(".venv")
    assert not tree.is_structural_noise(".pytest_cache")


def test_tree_no_longer_carries_the_private_two_audience_predicate():
    """`_is_ignored_dir` does not survive G3, under that name or any caller.

    It is the defect itself: a private name two audiences shared. Keeping it as
    an internal alias would leave the next reader with three predicates and no
    way to tell which one their new call site belongs to.

    Asserted over identifiers rather than raw text, so a docstring that explains
    what the split replaced fails on a breach and not on the explanation.
    """
    names = _identifiers(ast.parse(_tree_source()))

    assert "_is_ignored_dir" not in names, (
        "rhizome_graph/tree.py still names _is_ignored_dir. G3 replaces it with "
        "is_structural_noise (the graph's rule, shared with discovery) plus the "
        "dotted fallback at each call site, which is the line G4 changes."
    )


def test_is_ignored_answers_exactly_what_it_answered_before_the_split():
    """The jaw. `is_ignored` is the watcher's rule and it does not move at G3.

    Every entry is a case some caller already depends on: `.git/HEAD` is what
    keeps the branch poll's index churn off the graph, `.gitignore` is the dotted
    *file* the docstring promises to keep, and `.claude/agents/a.md` is the file
    G4 makes visible to the walk -- so seeing it answer `True` here, unchanged,
    is what proves G3 changed nothing.
    """
    hidden = (
        "node_modules/three/build/three.js",
        ".git/HEAD",
        "web/node_modules/vite/bin.js",
        ".venv/bin/python",
        ".pytest_cache/CACHEDIR.TAG",
        ".claude/agents/a.md",
        "rhizome_graph.egg-info/PKG-INFO",
        "__pycache__/app.cpython-312.pyc",
        "dist/bundle.js",
    )
    shown = (
        "src/app.py",
        "web/src/renderer.ts",
        ".gitignore",
        "README.md",
    )

    assert [p for p in hidden if not is_ignored(p)] == []
    assert [p for p in shown if is_ignored(p)] == []


def test_scan_tree_over_a_root_with_no_gitignore_hides_what_it_hides_today(
    tmp_path: Path,
):
    """The jaw, for the walk. No `.gitignore` anywhere: G4 changes none of this.

    Deliberately without a `.gitignore` in the fixture, because that file is the
    switch G4 hangs the dotted fallback on -- pinning a tree that has one would
    pin an answer this step is not entitled to promise.
    """
    _touch(tmp_path, "src/app.py")
    _touch(tmp_path, "README.md")
    for noisy in (
        ".git/config",
        "node_modules/three/index.js",
        "__pycache__/app.cpython-312.pyc",
        ".venv/bin/python",
        ".pytest_cache/CACHEDIR.TAG",
        ".claude/agents/a.md",
        "dist/bundle.js",
        "rhizome_graph.egg-info/PKG-INFO",
    ):
        _touch(tmp_path, noisy)

    assert scan_tree(str(tmp_path)) == ["README.md", "src/app.py"]
