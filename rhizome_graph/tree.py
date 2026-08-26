"""Initial snapshot of the observed project tree.

The graph used to open on an empty field and only ever grew nodes an agent had
touched -- two or three lonely dots, nothing like Gource, which shows the whole
repository from the first frame. This module produces that first frame: one walk
of the project root at daemon boot, turned into seed events.

Design notes:
  * **Never raises.** An unreadable directory or a vanished root yields fewer
    paths, never an exception -- the daemon must still come up.
  * **Noise is structural, not configurable.** Build output and VCS internals
    would swamp the picture, so they are skipped by name, whatever any
    configuration file says. Measured against git 2.43: `node_modules`, `dist`,
    `__pycache__` and `vendor` are *not* ignored by git unless a pattern names
    them, so this is a deliberate divergence -- a repository whose `.gitignore`
    happens not to name `node_modules` would otherwise flood the graph with ten
    thousand nodes, and the daemon must stay usable on a project that is not a
    repository at all.
  * **What a `.gitignore` says is honoured, where one exists.** The walk asks
    `gitignore.IgnoreRules` about every directory and every file it meets, so a
    project's committed `.claude/` and `.github/` reach the graph while its
    `.venv/` does not. Three things shape that rule and none of them is an
    implementation detail:
      - **`is_structural_noise` is checked first**, before any pattern, so no
        negation can re-include `.git`. Git does not *refuse* a `!.git` line --
        it never submits `.git` to its ignore machinery at all, so a rule of
        ours has to say it out loud. It is a name here, never a position.
      - **The blanket dotted-directory rule survives, scoped to where no
        `.gitignore` speaks.** Dropping it everywhere was measured and it costs
        the seed: `$HOME` goes from 12 500 files to 20 000, which is
        `DEFAULT_MAX_FILES`, so the walk is truncated and the picture stops
        being the tree. On this host 13 044 of the files gained are
        `.vscode-server`, `.cache`, `.local`, `.config` and `.npm` -- noise no
        `.gitignore` anywhere will ever name, because a home directory is not a
        repository. `IgnoreRules.governs` is therefore asked **per directory**,
        so a workspace of checkouts keeps the fallback at its own root and
        drops it inside each checkout, in one walk.
      - **An empty `.gitignore` is a `.gitignore`.** `governs` turns on the file
        existing, not on a rule being produced, which is the documented way to
        say "draw everything under here".
    Files are filtered now too, not only directories: `*.pyc` and `.DS_Store`
    are file patterns, and a walk that pruned directories alone would draw every
    one of them.
  * **Two named predicates, one per audience.** `is_structural_noise` is the
    "never, whatever any configuration file says" rule -- VCS internals, build
    output, packaging metadata -- and it is shared with `checkouts`, whose walk
    looks for `.git` directories and must skip the same rubble. `is_ignored` is
    the root-free rule, asked of a whole relative path: structural noise plus
    the dotted-directory fallback, for a caller holding no root and therefore no
    ignore file. It is the *fallback* the watcher keeps when it has no rules in
    hand, not the answer the watcher gives: that composite lives in
    `daemon/watcher.py`, which has the root and asks `gitignore.IgnoreRules` the
    ancestor-chain question. The fallback lives at each call site rather than
    inside the shared predicate, so the two audiences can be told apart.
  * Directories are not listed. The frontend materializes them from the paths of
    their children, so emitting them separately would only duplicate nodes.
"""

from __future__ import annotations

import os

from . import gitignore

#: The one directory hidden by name rather than by its leading dot, and never
#: shown under any circumstances. Git itself never lists `.git` in a
#: `.gitignore`, so no configuration file can be relied on to hide it; the
#: watcher would flood the graph with index churn on every `git status` and
#: every commit; and the branch and status polls in `daemon/server.py` exist
#: precisely because `.git/HEAD` is invisible to the watcher. Kept apart from
#: `IGNORED_DIRS`, which is about generated build output, so the difference
#: between "configurable noise" and "never" stays legible.
ALWAYS_IGNORED_DIRS = frozenset({".git"})

#: Generated output that never carries anything worth visualizing. Together with
#: `ALWAYS_IGNORED_DIRS` and the packaging suffixes below, this is what
#: `is_structural_noise` answers for -- the rule the graph's walk and the
#: checkout discovery walk share. The dotted-directory rule is *not* part of it:
#: it belongs to `is_ignored` and to `checkouts._is_uninteresting`, one per
#: audience.
IGNORED_DIRS = frozenset(
    {
        "node_modules",
        "__pycache__",
        "dist",
        "build",
        "target",
        "coverage",
        "htmlcov",
        "vendor",
        "venv",
    }
)

#: Directory name suffixes that mark generated packaging metadata.
_IGNORED_SUFFIXES = (".egg-info",)

#: Safety valve: stop walking a pathological tree rather than hang the boot.
_MAX_WALK_ENTRIES = 200_000

DEFAULT_MAX_FILES = 20_000


def is_structural_noise(name: str) -> bool:
    """Whether a directory named `name` is rubble, whatever any file says.

    VCS internals, generated build output and packaging metadata. This is the
    rule the graph's walk and `checkouts`' discovery walk agree on, which is why
    it is public: a checkout discovery row always points at a part of the tree
    the graph would draw.

    It says nothing about dotted directories. That is a *fallback*, and each
    audience owns its own: `is_ignored` below for the graph, and
    `checkouts._is_uninteresting` for discovery, which keeps it permanently.
    """
    return (
        name in ALWAYS_IGNORED_DIRS
        or name in IGNORED_DIRS
        or name.endswith(_IGNORED_SUFFIXES)
    )


def is_ignored(relative_path: str) -> bool:
    """Whether `relative_path` sits inside a directory the graph should skip.

    Only *directory* segments are considered, so a dotted file at the top level
    (``.gitignore``) is kept while anything under ``.git/`` is dropped.

    Structural noise plus the dotted-directory fallback: the answer for a caller
    that has no root in hand, and so cannot open an ignore file or know which
    directory a nested one governs.

    **It is deliberately weaker than both callers that matter, in both
    directions.** `_scan` and `daemon.watcher.relative_to_root` apply the same
    two rules and then a `.gitignore`, so this predicate shows paths they hide
    (a file matching a pattern) and hides paths they draw (a governed dotted
    directory such as a committed ``.claude/``). That is why it is not what
    either of them filters through: a caller answering live filesystem events
    from this alone would disagree with the tree the seed published, which is a
    graph whose seed and whose events describe different projects. It is the
    answer for a caller that genuinely has no root -- `relative_to_root` falls
    back to it when no rules are passed, and nothing else may.
    """
    return any(
        is_structural_noise(seg) or seg.startswith(".")
        for seg in relative_path.split("/")[:-1]
        if seg
    )


def scan_tree(root: str, max_files: int = DEFAULT_MAX_FILES) -> list[str]:
    """Return the project's file paths, relative to `root` and sorted.

    Sorted so the seed order is stable across runs (the frontend lays the tree
    out in arrival order, and a shuffled tree would look different every boot).
    Symlinked directories are not followed, so a link back into the tree cannot
    duplicate the graph or loop forever.
    """
    try:
        return _scan(root, max_files)
    except Exception:
        # Seeding is a nicety; failing it must never stop the daemon booting.
        return []


def _scan(root: str, max_files: int) -> list[str]:
    if max_files <= 0 or not os.path.isdir(root):
        return []

    paths: list[str] = []
    seen = 0
    # One rule set per walk, built here rather than passed in: the walk is then
    # always fresh, so an edited `.gitignore` is in force on the next boot, root
    # switch, content search or size pass with no invalidation logic to get
    # wrong, and no mutable object crosses between threads. It costs one read
    # and one compile per ignore file found, memoized per directory.
    rules = gitignore.IgnoreRules(root)
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        directory = _relative_directory(dirpath, root)
        # Asked once per directory, not once per tree: a workspace root answers
        # `False` while each checkout under it answers `True`, in this one walk.
        governed = rules.governs(directory)
        # Pruning in place is what keeps os.walk out of node_modules entirely,
        # instead of walking it and discarding the results afterwards -- and it
        # is also how git's "nothing under an excluded directory can be
        # re-included" comes for free: an excluded directory is never descended
        # into, so no negation inside it is ever reached.
        dirnames[:] = [
            name
            for name in dirnames
            if not (
                # First, and before any pattern: `.git` and generated output are
                # ours to hide whatever the ignore file says.
                is_structural_noise(name)
                or (not governed and name.startswith("."))
                or rules.ignored_child(directory, name, True)
            )
        ]
        for name in filenames:
            seen += 1
            if seen > _MAX_WALK_ENTRIES:
                break
            if rules.ignored_child(directory, name, False):
                continue
            full = os.path.join(dirpath, name)
            if os.path.islink(full):
                continue
            paths.append(os.path.relpath(full, root))
        if seen > _MAX_WALK_ENTRIES:
            break

    paths.sort()
    return paths[:max_files]


def _relative_directory(dirpath: str, root: str) -> str:
    """The walk's current directory, relative to the root, with `/` separators.

    The root itself is the empty string rather than `os.walk`'s own `.`, so the
    ignore rules are asked about a path spelled the way every other relative
    path in this project is spelled.
    """
    relative = os.path.relpath(dirpath, root)
    if relative == os.curdir:
        return ""
    return relative.replace(os.sep, "/")
