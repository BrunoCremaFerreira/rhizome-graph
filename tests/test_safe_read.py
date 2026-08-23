"""Contract tests (RED) for rhizome_graph.safe_read.

Motivation: the capped, FIFO-safe read is the one place in this project that
opens a file named by something other than a hard-coded constant, and it is
currently private to the click path (`file_view._read_capped`, with its
predicate `file_view.is_readable_regular`). A content search has to open
thousands of files it did not choose, and cannot reach any of that.

The two options left by not extracting it are both worse, which is why this
module exists. Importing `file_view._read_capped` from the search would drag
`diff`, `gitcmd` and `checkouts` in behind it, weakening the "this module starts
no process" contract the search wants to assert over its own source. Writing a
second `open()` in the search means one named pipe anywhere under the observed
root parks a worker thread on *every* search, permanently: the executor is
shared with `scan_tree` and `file_view`, a thread wedged in `open(2)` cannot be
cancelled, and shutdown joins it -- so the daemon eventually cannot even exit.
A chokepoint reachable from one caller and duplicated for the other is not a
chokepoint.

So `is_readable_regular(st_mode)` and `read_capped(target, max_bytes)` move to
`rhizome_graph/safe_read.py`, and `file_view` imports and **re-exports** them:
`from rhizome_graph.file_view import is_readable_regular` must keep resolving,
and `file_view` must read through the moved function rather than keeping a copy
of it. Today `import rhizome_graph.safe_read` raises `ModuleNotFoundError`.

What is specified here is only the move: the byte semantics of the cap, the
predicate's answer for a pipe, the FIFO defence surviving the move, and the
re-export. The frame-building behaviour on top of it stays pinned by
`tests/test_file_view.py`, which deliberately does not move.

Style: Arrange-Act-Assert, one failure reason per test.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import stat
import time
from pathlib import Path

import pytest


def _read_capped(target: str, max_bytes: int) -> tuple[bytes, bool]:
    """`safe_read.read_capped`, imported where it is used.

    Not at module scope: a top-level import of a name that does not exist yet
    fails at collection and reddens the whole file with one error instead of
    telling each test what it was asking for. `tests/test_file_view.py` imports
    `is_readable_regular` inside a helper for the same reason.
    """
    from rhizome_graph.safe_read import read_capped

    return read_capped(target, max_bytes)


def _predicate(st_mode: int) -> bool:
    """`safe_read.is_readable_regular`, imported where it is used."""
    from rhizome_graph.safe_read import is_readable_regular

    return is_readable_regular(st_mode)


def _open_write_end(fifo: str, deadline_seconds: float = 2.0) -> bool:
    """Free a worker blocked in `open(2)` on `fifo`, by opening the other end.

    Test *hygiene*, not part of the specification, and lifted from
    `tests/test_file_view.py` where the same wedge is rescued. A thread stuck in
    `open(2)` cannot be cancelled, and the executor is joined when the loop
    closes and again at interpreter exit -- so a single unrescued wedge does not
    merely leak, it hangs the pytest process on the way out.

    `O_NONBLOCK` makes the rescue itself safe: it fails with ENXIO instead of
    blocking when no reader is waiting, which is also how it can be retried.
    """
    ends_at = time.monotonic() + deadline_seconds
    while time.monotonic() < ends_at:
        try:
            handle = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
        except OSError:
            time.sleep(0.02)
            continue
        os.close(handle)
        return True
    return False


def _read_within(
    target: str,
    max_bytes: int,
    timeout: float = 2.0,
    rescue: str | None = None,
) -> tuple[bytes, bool]:
    """`read_capped`, with promptness as part of the contract.

    Answering *eventually* is not the property under test -- a read that never
    comes back is the defect -- so the call is made on a worker thread, the wait
    is bounded, and running out of it is reported as a `TimeoutError` naming the
    path rather than as a run that hangs. The shield and the rescue loop are the
    technique `_view_within` already uses over there: the timeout must not
    cancel the task, because the thread underneath it cannot be cancelled and
    the rescue needs something to wait on.

    Whatever `read_capped` raises is raised here, so a test may state the
    refusal with `pytest.raises`.
    """

    async def attempt() -> tuple[bytes, bool]:
        task = asyncio.ensure_future(
            asyncio.to_thread(_read_capped, target, max_bytes)
        )
        try:
            return await asyncio.wait_for(asyncio.shield(task), timeout)
        except (asyncio.TimeoutError, TimeoutError):
            for _ in range(3):
                if task.done():
                    break
                if rescue is not None:
                    _open_write_end(rescue)
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(asyncio.shield(task), 2.0)
            raise TimeoutError(
                f"read_capped({target!r}) did not answer within {timeout}s"
            ) from None

    return asyncio.run(attempt())


# --- 1.1 the capped read is a module of its own -----------------------------

def test_a_file_longer_than_the_cap_gives_only_its_first_bytes(tmp_path: Path):
    target = tmp_path / "long.txt"
    target.write_bytes(b"0123456789")

    data, _ = _read_capped(str(target), 4)

    assert data == b"0123"


def test_a_file_longer_than_the_cap_reports_truncation(tmp_path: Path):
    target = tmp_path / "long.txt"
    target.write_bytes(b"0123456789")

    _, truncated = _read_capped(str(target), 4)

    assert truncated is True


def test_a_file_exactly_at_the_cap_gives_all_of_it(tmp_path: Path):
    target = tmp_path / "exact.txt"
    target.write_bytes(b"0123")

    data, _ = _read_capped(str(target), 4)

    assert data == b"0123"


def test_a_file_exactly_at_the_cap_is_not_truncated(tmp_path: Path):
    # One byte past the cap is read precisely so that "exactly at the cap" is
    # not reported as more-to-come.
    target = tmp_path / "exact.txt"
    target.write_bytes(b"0123")

    _, truncated = _read_capped(str(target), 4)

    assert truncated is False


def test_a_named_pipe_may_not_be_read():
    # The whole reason the predicate exists: this is the type that blocks in
    # `open(2)` forever, and the answer must survive the move.
    assert _predicate(stat.S_IFIFO | 0o644) is False


def test_a_regular_file_may_be_read():
    assert _predicate(stat.S_IFREG | 0o644) is True


# --- 1.2 the FIFO defence, preserved across the move ------------------------

def test_a_real_named_pipe_with_no_writer_is_refused_instead_of_blocking(
    tmp_path: Path,
):
    # The property, stated on a real pipe rather than on a mode integer: the
    # call comes back, and it comes back by raising. A `read_capped` that
    # blocked here would take the wait's deadline, be rescued by the write end,
    # and fail as a `TimeoutError` -- not as this `OSError`.
    fifo = tmp_path / "pipe"
    os.mkfifo(fifo)

    with pytest.raises(OSError):
        _read_within(str(fifo), 4, rescue=str(fifo))


# --- 1.3 file_view keeps the name, and reads through the moved function -----

def test_the_predicate_is_still_importable_from_file_view():
    # `tests/test_file_view.py` imports it from here and must not have to move.
    from rhizome_graph.file_view import is_readable_regular

    assert is_readable_regular(stat.S_IFIFO | 0o644) is False


def test_file_view_re_exports_the_predicate_rather_than_copying_it():
    import rhizome_graph.file_view as file_view
    import rhizome_graph.safe_read as safe_read

    assert file_view.is_readable_regular is safe_read.is_readable_regular


def test_file_view_reads_a_text_file_through_the_moved_function(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    # A plain directory, so no repository exists and nothing can be a diff: the
    # frame must reach the read.
    #
    # The spy is installed on both modules on purpose. Which one takes effect
    # depends on whether the implementation calls `safe_read.read_capped` or a
    # name bound at import time, and that is not the property under test; what
    # is pinned is that no third copy of the read survives in `file_view`.
    import rhizome_graph.file_view as file_view
    import rhizome_graph.safe_read as safe_read

    calls: list[tuple[str, int]] = []

    def spy(target: str, max_bytes: int) -> tuple[bytes, bool]:
        calls.append((target, max_bytes))
        return b"hello\n", False

    monkeypatch.setattr(safe_read, "read_capped", spy)
    monkeypatch.setattr(file_view, "read_capped", spy, raising=False)

    root = tmp_path / "proj"
    root.mkdir()
    (root / "a.txt").write_bytes(b"hello\n")

    asyncio.run(asyncio.wait_for(file_view.file_view(str(root), "a.txt"), 30))

    assert len(calls) == 1
