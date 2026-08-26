"""Contract tests (RED) for measuring how big the observed files are.

Motivation: nothing in `rhizome_graph/` asks the filesystem for metadata at all.
`tree.scan_tree` answers "which files", `file_view` answers "what is inside
*this* file", `status.py` and `checkouts.py` answer about git, and
`normalize.py` is pure by contract and sits on the hook's hot path. No module
calls `os.stat` on an observed file, so the size mode (F7) has no question to
ask -- and the two places it would be tempting to grow one are the two that must
not carry it: `tree.py` runs on every root switch and promises to stay cheap,
and `file_view.py` owns the click path's security ordering.

So a new module, `rhizome_graph/sizes.py`, and this file specifies it:

  * **The set measured is the set drawn, by identity.** `MAX_FILES` *is*
    `tree.DEFAULT_MAX_FILES`, the same object, following the
    `content_search.MAX_FILE_BYTES is file_view.DEFAULT_MAX_BYTES` precedent.
    Two constants that happen to both be 20 000 is the bug waiting to happen,
    and it would surface as a tail of grey dots nobody could explain.
  * **The walk is `scan_tree`'s**, so the ignore rules, the symlink drop, the
    sort and the cap are the graph's own rather than a second opinion.
  * **`os.lstat`, not `os.stat`.** `scan_tree` already drops symlinked files, so
    under normal operation the two agree -- but there is a window between the
    walk and the stat, and `lstat` is the reading in which a path that became a
    symlink inside that window reports the link's own size instead of the size
    of whatever it now points at, inside or outside the root.
  * **It never raises.** A file that vanished between the walk and the stat
    drops its entry; an unreadable directory costs entries, never an exception.
    A partial answer is a partial colouring; an exception is a dead command.
  * **The module opens nothing**, asserted over its parsed source the way
    `tests/test_checkouts.py` asserts "starts no process" and
    `tests/test_content_search.py` asserts "imports no `re`". A walk over a whole
    home directory that never opens a descriptor cannot be parked on a
    writerless FIFO -- which is exactly the failure `safe_read.py` exists for --
    so `sizes.py` needs `safe_read` only for as long as nobody adds "and let us
    also sniff whether it is binary". This test is what stops that line.
  * **The frame carries JSON types only**, and the walk runs off the event loop,
    for the reason `scan_tree` and `search_tree` do.

Expected to FAIL until `rhizome_graph/sizes.py` exists.

Style: Arrange-Act-Assert, one failure reason per test.
"""

from __future__ import annotations

import ast
import asyncio
import contextlib
import dataclasses
import json
import os
import threading
from pathlib import Path

import pytest

from rhizome_graph import tree


# --- The module under specification, imported where it is used --------------
#
# Not at module scope: a top-level import of a module that does not exist yet
# fails at collection and reddens the whole file with one error instead of
# telling each test what it was asking for. `tests/test_content_search.py` and
# `tests/test_safe_read.py` import inside a helper for the same reason.


def _module():
    import rhizome_graph.sizes as sizes

    return sizes


def _measure_tree(root: str, **caps):
    return _module().measure_tree(root, **caps)


def _sizes_frame(files, truncated: bool, error: str) -> dict:
    return _module().sizes_frame(files, truncated, error)


def _file_size(path: str, size: int):
    return _module().FileSize(path, size)


def _measure_sizes(root: str, timeout: float = 30.0) -> dict:
    async def attempt() -> dict:
        return await asyncio.wait_for(_module().measure_sizes(root), timeout)

    return asyncio.run(attempt())


def _write(root: Path, relative: str, size: int) -> Path:
    """One file of exactly `size` bytes, parents created."""
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"x" * size)
    return target


def _measured(root: Path) -> dict[str, int]:
    files, _truncated = _measure_tree(str(root))
    return {entry.path: entry.bytes for entry in files}


def _patch_scan_tree(monkeypatch: pytest.MonkeyPatch, fake) -> None:
    """Replace the walk, whichever way `sizes.py` reached for it.

    `from rhizome_graph.tree import scan_tree` and `tree.scan_tree(...)` are both
    legitimate spellings of "the walk is `scan_tree`'s", and which one is chosen
    is the implementation's business, not this test's.
    """
    monkeypatch.setattr(tree, "scan_tree", fake)
    module = _module()
    if hasattr(module, "scan_tree"):
        monkeypatch.setattr(module, "scan_tree", fake)


# --- 1.1 the set measured is the set drawn, by identity ---------------------

def test_the_file_cap_is_the_trees_own_constant_and_not_a_copy_of_it():
    """Identity, not equality: `is`, so a retyped 20 000 fails this test.

    It is the property a later "optimisation" is most likely to break, and the
    breakage is invisible -- the mode simply stops colouring the tail of a big
    tree, with every node still on screen wearing the unmeasured grey.
    """
    assert _module().MAX_FILES is tree.DEFAULT_MAX_FILES


# --- 1.2 the walk, and the bytes -------------------------------------------

def test_every_file_the_walk_returns_is_measured(tmp_path: Path):
    _write(tmp_path, "a.txt", 3)
    _write(tmp_path, "sub/b.txt", 11)
    _write(tmp_path, "c.bin", 0)

    files, _truncated = _measure_tree(str(tmp_path))

    assert [entry.path for entry in files] == tree.scan_tree(str(tmp_path))


def test_each_entry_carries_the_byte_count_the_filesystem_reports(tmp_path: Path):
    _write(tmp_path, "a.txt", 3)
    _write(tmp_path, "sub/b.txt", 11)

    measured = _measured(tmp_path)

    assert measured == {
        "a.txt": os.stat(tmp_path / "a.txt").st_size,
        os.path.join("sub", "b.txt"): os.stat(tmp_path / "sub" / "b.txt").st_size,
    }


def test_the_entries_are_sorted_by_path(tmp_path: Path):
    # `scan_tree` sorts so the seed order is stable across runs; a measurement
    # in a different order would be a second opinion about the same tree.
    for name in ("zeta.txt", "alpha.txt", "middle.txt"):
        _write(tmp_path, name, 1)

    files, _truncated = _measure_tree(str(tmp_path))

    assert [entry.path for entry in files] == sorted(
        entry.path for entry in files
    )


def test_a_file_under_an_ignored_directory_is_not_measured(tmp_path: Path):
    # The ignore rules are the graph's: a node that is not drawn must not be
    # stat'ed, or the scale is hinged on files nobody can see.
    _write(tmp_path, "a.txt", 3)
    _write(tmp_path, "node_modules/pkg/index.js", 500)

    measured = _measured(tmp_path)

    assert list(measured) == ["a.txt"]


def test_an_empty_project_measures_nothing_and_is_not_truncated(tmp_path: Path):
    files, truncated = _measure_tree(str(tmp_path))

    assert (files, truncated) == ([], False)


def test_a_file_size_is_a_frozen_pair_of_path_and_bytes():
    entry = _file_size("a.txt", 17)

    assert dataclasses.is_dataclass(entry)
    assert (entry.path, entry.bytes) == ("a.txt", 17)
    with pytest.raises(dataclasses.FrozenInstanceError):
        entry.bytes = 18


# --- 1.3 it never raises ----------------------------------------------------

def test_a_path_that_vanished_between_the_walk_and_the_stat_drops_its_entry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The window is real: an agent deletes files while the walk is running.

    A partial answer is a partial colouring; an exception is a dead command, and
    the browser is holding a `pending` flag with nothing coming to clear it.
    """
    _write(tmp_path, "here.txt", 4)
    _patch_scan_tree(
        monkeypatch, lambda root, *args, **kwargs: ["here.txt", "gone.txt"]
    )

    measured = _measured(tmp_path)

    assert measured == {"here.txt": 4}


def test_an_unreadable_directory_costs_entries_but_never_an_exception(
    tmp_path: Path,
):
    if os.geteuid() == 0:
        pytest.skip("root reads through any permission bits")
    _write(tmp_path, "visible.txt", 4)
    locked = tmp_path / "locked"
    _write(locked, "hidden.txt", 4)
    locked.chmod(0o000)

    try:
        measured = _measured(tmp_path)
    finally:
        locked.chmod(0o700)

    assert list(measured) == ["visible.txt"]


# --- 1.4 the cap ------------------------------------------------------------

def test_a_tree_larger_than_the_cap_is_cut_and_says_so(tmp_path: Path):
    for name in ("a.txt", "b.txt", "c.txt", "d.txt"):
        _write(tmp_path, name, 1)

    files, truncated = _measure_tree(str(tmp_path), max_files=2)

    assert ([entry.path for entry in files], truncated) == (["a.txt", "b.txt"], True)


def test_a_tree_that_fits_under_the_cap_is_not_truncated(tmp_path: Path):
    # Deliberately two files under a cap of four rather than exactly at it: the
    # boundary is `scan_tree`'s to decide, and pinning it here would be this test
    # inventing a rule the plan does not state.
    _write(tmp_path, "a.txt", 1)
    _write(tmp_path, "b.txt", 1)

    files, truncated = _measure_tree(str(tmp_path), max_files=4)

    assert (len(files), truncated) == (2, False)


# --- 1.5 lstat, never stat --------------------------------------------------

def test_a_symlink_never_reports_the_size_of_what_it_points_at(tmp_path: Path):
    """Either absent (today's `scan_tree`) or the link's own size, never the target's.

    `scan_tree` drops symlinked files, so the two spellings agree under ordinary
    operation. What `lstat` buys is the window between the walk and the stat: a
    path that became a link in it must not report the size of a file that may
    sit outside the observed root entirely.
    """
    root = tmp_path / "root"
    root.mkdir()
    outside = _write(tmp_path / "outside", "big.bin", 5000)
    link = root / "link.bin"
    link.symlink_to(outside)

    measured = _measured(root)

    reported = measured.get("link.bin")
    assert reported in (None, os.lstat(link).st_size), (
        f"link.bin reported {reported} bytes; the target is "
        f"{os.stat(outside).st_size} and the link itself is "
        f"{os.lstat(link).st_size}"
    )


# --- 1.6 the contract, over the parsed source -------------------------------

#: The packages that are ours; anything else is the standard library.
OUR_PACKAGES = frozenset({"rhizome_graph", "daemon", "hooks"})

#: Modules this one may not import at all. `subprocess` because nothing here
#: starts a process, `re` because nothing here matches a pattern, and
#: `rhizome_graph.safe_read` because it is the tell that somebody has started
#: *opening* the files -- which is the one thing this module must not do.
FORBIDDEN_IMPORTS = frozenset({"subprocess", "multiprocessing", "re", "safe_read"})

#: Every spelling of "open a descriptor" or "start a process". `asyncio` is
#: legitimately imported for `to_thread`, so its forbidden names are listed one
#: by one rather than banning the module.
FORBIDDEN_NAMES = (
    "open",
    "read_capped",
    "read_bytes",
    "read_text",
    "safe_read",
    "looks_binary",
    "subprocess",
    "multiprocessing",
    "popen",
    "system",
    "fork",
    "execv",
    "execvp",
    "spawnv",
    "spawnl",
    "create_subprocess_exec",
    "create_subprocess_shell",
    "gitcmd",
)


def _source() -> str:
    return Path(_module().__file__).read_text(encoding="utf-8")


def _imported_modules(module: ast.Module) -> set[str]:
    """Every module name reached for, however the import is spelled.

    The head of a dotted name and the tail both count: `import os.path` may not
    smuggle in `subprocess`, and `from rhizome_graph import safe_read` names it
    as an alias rather than as a module.
    """
    names: set[str] = set()
    for node in ast.walk(module):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.update(alias.name.split("."))
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            names.update(part for part in base.split(".") if part)
            names.update(alias.name for alias in node.names)
    return names


def _identifiers(module: ast.Module) -> set[str]:
    """Every name the code *uses*: bare names, attributes and imported modules.

    Identifiers rather than raw text on purpose. The module's own docstring is
    expected to say that it opens nothing -- and a substring search over the
    source would then fail on the promise instead of on a breach of it.
    """
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


def test_sizes_imports_neither_a_process_a_pattern_nor_the_capped_reader():
    imported = _imported_modules(ast.parse(_source()))

    offenders = sorted(imported & FORBIDDEN_IMPORTS)

    assert offenders == [], (
        f"rhizome_graph/sizes.py imports {offenders}. It asks the filesystem how "
        "big a file is and never looks inside one: no pattern is compiled, no "
        "process is started, and `safe_read` is needed only by a module that "
        "opens files."
    )


def test_sizes_names_no_way_of_opening_a_file_or_starting_a_process():
    """Over every identifier, so a late import inside a function counts too.

    That is the form this leaks back in, because it changes no import block a
    reviewer skims: one line that sniffs whether the file is binary, and the
    walk over a home directory can be parked forever on a writerless FIFO --
    the failure `safe_read.py` exists for, in a module that has no reason to
    hold a descriptor at all.
    """
    used = _identifiers(ast.parse(_source()))

    offenders = sorted(used & set(FORBIDDEN_NAMES))

    assert offenders == [], (
        f"rhizome_graph/sizes.py names {offenders}. This module stats paths; it "
        "opens none of them, and `gitcmd` stays the one place in this project "
        "where a process is started."
    )


# --- 1.7 the frame ----------------------------------------------------------

def test_the_frame_is_exactly_the_shape_the_browser_parses():
    frame = _sizes_frame([_file_size("a.txt", 3), _file_size("sub/b.txt", 11)], False, "")

    assert frame == {
        "kind": "sizes",
        "files": [
            {"path": "a.txt", "bytes": 3},
            {"path": "sub/b.txt", "bytes": 11},
        ],
        "truncated": False,
        "error": "",
    }


def test_the_frame_carries_the_truncation_flag_and_the_reason():
    frame = _sizes_frame([], True, "the observed project changed")

    assert (frame["files"], frame["truncated"], frame["error"]) == (
        [],
        True,
        "the observed project changed",
    )


def test_the_frame_holds_json_types_only():
    # A `FileSize` smuggled through whole raises inside `_send`, on the loop,
    # long after `sizes_frame` returned -- so the failure lands nowhere near the
    # code that caused it.
    frame = _sizes_frame([_file_size("a.txt", 3)], False, "")

    assert json.loads(json.dumps(frame)) == frame


# --- 1.8 the walk runs off the event loop -----------------------------------

def test_the_measurement_does_not_stop_the_loop_servicing_another_task(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """~500 ms of walk plus ~150 ms of stat at the cap; on the loop that is
    frozen viewers for exactly that long, and ~2 s on a cold tree.

    The stub blocks until a task *on the loop* releases it, so the only way this
    test finishes at all is if the loop kept running while the walk was in
    progress. A `measure_tree` called inline never sees the release and reports
    the block itself, rather than timing the suite out.
    """
    released = threading.Event()
    blocked_out = threading.Event()

    def blocking_measure_tree(root: str, *args, **kwargs):
        if not released.wait(5.0):
            blocked_out.set()
            raise RuntimeError(
                "measure_tree ran on the event loop: nothing could release it"
            )
        return ([_file_size("a.txt", 3)], False)

    monkeypatch.setattr(_module(), "measure_tree", blocking_measure_tree)

    async def scenario() -> dict:
        async def releaser() -> None:
            await asyncio.sleep(0.05)
            released.set()

        task = asyncio.ensure_future(releaser())
        try:
            return await asyncio.wait_for(_module().measure_sizes(str(tmp_path)), 10)
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    frame = asyncio.run(scenario())

    assert blocked_out.is_set() is False
    assert frame["files"] == [{"path": "a.txt", "bytes": 3}]


def test_the_measurement_answers_a_frame_about_the_real_tree(tmp_path: Path):
    # The positive control for the stub above: without it, that test would pass
    # for a `measure_sizes` that never measures anything at all.
    _write(tmp_path, "a.txt", 3)

    frame = _measure_sizes(str(tmp_path))

    assert frame == {
        "kind": "sizes",
        "files": [{"path": "a.txt", "bytes": 3}],
        "truncated": False,
        "error": "",
    }
