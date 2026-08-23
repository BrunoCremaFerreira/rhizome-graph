"""Contract tests (RED) for asking `file_view` for text rather than a diff.

Motivation: `file_view` tries `git diff HEAD --` first and returns it whenever
it is non-empty, so a file with one small edit opens as three lines of context
around that edit. That is the right answer for the click it was written for --
the status panel asks "what did the agent just do to this file" -- and the wrong
answer for the click the content search is about to add: an `F3` step onto a
match at line 220 of a dirty file would open a document that does not contain
line 220, under a counter claiming `7 / 213`. The feature would be wrong on
exactly the files an agent has just touched, which are the files anyone is
searching for.

So the caller says which question it is asking:
`file_view(root, path, max_bytes=..., allow_diff=True)`. With `allow_diff=False`
the diff step is skipped and the chain becomes refused -> directory ->
not-on-disk -> text -> hex.

Three things are pinned here beyond "it answers text":

  * **`resolve_inside` stays first, alone and unconditional** (section 3). The
    new parameter is read strictly *after* it and changes no path handling
    whatsoever. A refused path is refused before anything asks whether it
    exists, and nothing reads its bytes.
  * **The branch sits before the fork, not around its result** (section 2). An
    implementation that runs `git diff` and then discards the answer passes
    every assertion about the frame and still pays ~20 ms of `git` per keystroke
    of a walk. A spy records the calls; a positive control in the same section
    keeps the zero-call assertions from passing vacuously.
  * **A deleted file is where the two callers part** (section 4). Under
    `allow_diff=False` a deleted file reaches `no such file`, and that is
    correct: it has no content on disk, so the search never matched it and never
    asks. The status-panel click keeps `allow_diff=True` and keeps the removal
    diff that is the single row it most wants to offer.

Real repositories under `tmp_path`, not a mocked `subprocess`: what is specified
is the behaviour against real `git`, and a mock would happily agree with a wrong
argv. Commits carry `-c user.email`/`-c user.name` so the suite does not depend
on the machine's git config, and signing is off so it cannot hang on a prompt.

Style: Arrange-Act-Assert, one failure reason per test.
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
from pathlib import Path

import pytest

from rhizome_graph import file_view as file_view_module
from rhizome_graph.file_view import file_view

PNG_MAGIC = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"


def _run(coro):
    return asyncio.run(asyncio.wait_for(coro, timeout=30))


def _git(root: Path, *args: str) -> None:
    subprocess.run(
        [
            "git",
            "-c",
            "user.email=tester@example.invalid",
            "-c",
            "user.name=Tester",
            "-c",
            "commit.gpgsign=false",
            *args,
        ],
        cwd=root,
        check=True,
        capture_output=True,
    )


def _repo(root: Path, files: dict[str, bytes]) -> Path:
    """A real repository with `files` committed on HEAD."""
    if shutil.which("git") is None:  # pragma: no cover - depends on the machine
        pytest.skip("git is not installed")
    root.mkdir(parents=True, exist_ok=True)
    _git(root, "init", "-q")
    for name, blob in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "initial")
    return root


def _long_text(marker_line: int = 220, marker: str = "needle") -> str:
    """400 numbered lines, one of them carrying the word a search would find."""
    lines = []
    for number in range(1, 401):
        word = marker if number == marker_line else "filler"
        lines.append(f"line {number} {word}")
    return "\n".join(lines) + "\n"


def _dirty_repo(tmp_path: Path) -> tuple[Path, str]:
    """A checkout whose committed `a.txt` has had its FIRST line edited.

    The edit is deliberately at the top: `git diff` prints three lines of
    context, so line 220 -- the one a content search would have matched -- is
    nowhere in the diff, while it is the whole reason the panel was opened.
    """
    original = _long_text()
    root = _repo(tmp_path / "proj", {"a.txt": original.encode("utf-8")})
    edited = original.replace("line 1 filler", "line 1 edited", 1)
    (root / "a.txt").write_text(edited, encoding="utf-8")
    return root, edited


def _recording_git_diff(calls: list, answer: str | None = None):
    """A stand-in for `git_diff` that records every call it receives."""

    async def spy(cwd, relative_path, *args, **kwargs):
        calls.append((cwd, relative_path))
        return answer

    return spy


def _recording_read(calls: list, data: bytes = b"read\n"):
    """A stand-in for `read_capped` that records every path it is handed."""

    def spy(target, max_bytes, *args, **kwargs):
        calls.append(target)
        return data, False

    return spy


# --- 1. a dirty file can be asked for as text -------------------------------

def test_a_dirty_file_answers_its_diff_by_default(tmp_path: Path):
    # The behaviour the status panel depends on, restated here so that adding
    # the parameter cannot quietly become changing the default.
    root, _ = _dirty_repo(tmp_path)

    frame = _run(file_view(str(root), "a.txt"))

    assert frame["mode"] == "diff"


def test_the_default_diff_of_a_dirty_file_omits_the_line_a_search_matched(
    tmp_path: Path,
):
    # The defect itself, stated as a fact about today's answer rather than as a
    # complaint: this is what an `F3` step onto line 220 would open.
    root, _ = _dirty_repo(tmp_path)

    frame = _run(file_view(str(root), "a.txt"))

    assert "line 220 needle" not in frame["content"]


def test_a_dirty_file_can_be_asked_for_as_text(tmp_path: Path):
    root, _ = _dirty_repo(tmp_path)

    frame = _run(file_view(str(root), "a.txt", allow_diff=False))

    assert frame["mode"] == "text"


def test_the_text_of_a_dirty_file_is_the_whole_file_and_not_the_hunks(
    tmp_path: Path,
):
    # Exact equality with what is on disk: "contains line 220" would also pass
    # for a diff with enough context, and the property is that no selection was
    # made at all.
    root, edited = _dirty_repo(tmp_path)

    frame = _run(file_view(str(root), "a.txt", allow_diff=False))

    assert frame["content"] == edited


def test_the_text_of_a_dirty_file_carries_no_diff_markers(tmp_path: Path):
    # A diff returned under `mode: "text"` would still be the wrong document,
    # and the header is the cheapest thing to name.
    root, _ = _dirty_repo(tmp_path)

    frame = _run(file_view(str(root), "a.txt", allow_diff=False))

    assert not frame["content"].startswith("diff --git")


def test_a_clean_file_asked_for_as_text_is_unaffected(tmp_path: Path):
    # Nothing about the parameter is specific to a dirty tree; the file that was
    # never touched must read exactly as it always did.
    root = _repo(tmp_path / "proj", {"a.txt": b"hello\n"})

    frame = _run(file_view(str(root), "a.txt", allow_diff=False))

    assert frame["mode"] == "text" and frame["content"] == "hello\n"


def test_a_modified_binary_asked_for_as_text_falls_through_to_its_hex_dump(
    tmp_path: Path,
):
    # The tail of the chain: skipping the diff hands a binary to `looks_binary`,
    # which is the only remaining answer. It must not be decoded as text.
    root = _repo(tmp_path / "proj", {"logo.png": PNG_MAGIC})
    (root / "logo.png").write_bytes(PNG_MAGIC + b"\x00\x01\x02changed")

    frame = _run(file_view(str(root), "logo.png", allow_diff=False))

    assert frame["mode"] == "hex"


def test_a_dirty_file_in_a_sub_checkout_can_also_be_asked_for_as_text(
    tmp_path: Path,
):
    # The workspace shape: the observed root is not a checkout at all. The diff
    # route derives a working directory there, and the text route must not need
    # one.
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _repo(workspace / "proj", {"a.txt": b"one\n"})
    (workspace / "proj" / "a.txt").write_text("two\n", encoding="utf-8")

    frame = _run(file_view(str(workspace), "proj/a.txt", allow_diff=False))

    assert frame["mode"] == "text" and frame["content"] == "two\n"


# --- 2. the branch sits before the fork, not around its result --------------

def test_asking_for_text_does_not_fork_git_at_all(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    # `git diff` is ~20 ms of fork, index read and zlib. A walk through matches
    # opens a file per keystroke, so paying for an answer that is discarded is
    # the difference between a responsive walk and a stuttering one.
    root, _ = _dirty_repo(tmp_path)
    calls: list = []
    monkeypatch.setattr(file_view_module, "git_diff", _recording_git_diff(calls))

    _run(file_view(str(root), "a.txt", allow_diff=False))

    assert calls == []


def test_the_default_route_still_forks_git_exactly_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    # The positive control for the zero-call assertion above: without it, that
    # one would pass for an implementation that never consults `git` for
    # anything, and a spy nobody reaches records nothing whatever the branch
    # does.
    root, _ = _dirty_repo(tmp_path)
    calls: list = []
    monkeypatch.setattr(file_view_module, "git_diff", _recording_git_diff(calls))

    _run(file_view(str(root), "a.txt"))

    assert len(calls) == 1


def test_asking_for_text_ignores_a_diff_git_would_have_produced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    # Belt to the zero-call assertion's braces, and the one that survives if the
    # spy is ever loosened: even handed a diff on a plate, the text route must
    # not serve it.
    root = _repo(tmp_path / "proj", {"a.txt": b"hello\n"})
    monkeypatch.setattr(
        file_view_module,
        "git_diff",
        _recording_git_diff([], answer="diff --git a/a.txt b/a.txt\n"),
    )

    frame = _run(file_view(str(root), "a.txt", allow_diff=False))

    assert frame["mode"] == "text" and frame["content"] == "hello\n"


# --- 3. resolve_inside stays first, alone and unconditional -----------------

def test_a_refused_path_is_still_refused_when_text_is_preferred(tmp_path: Path):
    root = _repo(tmp_path / "proj", {"a.txt": b"hello\n"})
    (tmp_path / "secret.txt").write_text("private\n", encoding="utf-8")

    frame = _run(file_view(str(root), "../secret.txt", allow_diff=False))

    assert frame["error"].startswith("refused:")


def test_a_refused_path_is_refused_before_anything_asks_whether_it_exists(
    tmp_path: Path,
):
    # The ordering, made observable: a path that both escapes the root and names
    # nothing must answer the refusal, never "no such file". A "no such file"
    # here would mean the existence check now runs first, which is the check
    # that leaks whether a path outside the project is there.
    root = _repo(tmp_path / "proj", {"a.txt": b"hello\n"})

    frame = _run(file_view(str(root), "../../nowhere/at/all.txt", allow_diff=False))

    assert frame["error"].startswith("refused:")


def test_a_refused_path_has_none_of_its_bytes_read_when_text_is_preferred(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    # The refusal message alone would still hold for an implementation that read
    # the file and then thought better of sending it.
    root = _repo(tmp_path / "proj", {"a.txt": b"hello\n"})
    (tmp_path / "secret.txt").write_text("private\n", encoding="utf-8")
    reads: list = []
    monkeypatch.setattr(file_view_module, "read_capped", _recording_read(reads))

    _run(file_view(str(root), "../secret.txt", allow_diff=False))

    assert reads == []


def test_a_permitted_path_does_reach_the_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    # The positive control for the read spy: it is the same monkeypatch, and an
    # unreached spy records nothing for reasons that have nothing to do with the
    # refusal.
    root = _repo(tmp_path / "proj", {"a.txt": b"hello\n"})
    reads: list = []
    monkeypatch.setattr(file_view_module, "read_capped", _recording_read(reads))

    _run(file_view(str(root), "a.txt", allow_diff=False))

    assert len(reads) == 1


def test_an_absolute_path_is_still_refused_when_text_is_preferred(tmp_path: Path):
    # `os.path.join(root, "/etc/passwd")` is `/etc/passwd`; the join is not a
    # containment check, and the new parameter must not become a second route
    # that forgets it.
    root = _repo(tmp_path / "proj", {"a.txt": b"hello\n"})

    frame = _run(file_view(str(root), "/etc/passwd", allow_diff=False))

    assert frame["error"].startswith("refused:")


def test_a_directory_asked_for_as_text_is_still_a_directory(tmp_path: Path):
    # The directory check sits between the refusal and the diff, so skipping the
    # diff must not promote a folder into "no such file" -- or, worse, into a
    # read of a directory.
    root = _repo(tmp_path / "proj", {"src/app.ts": b"x\n"})

    frame = _run(file_view(str(root), "src", allow_diff=False))

    assert frame["error"] == "that is a directory"


# --- 4. a deleted file is where the two callers part ------------------------

def test_a_deleted_file_asked_for_as_text_answers_no_such_file(tmp_path: Path):
    # Correct rather than unfortunate: a deleted file has no content on disk, so
    # a content search never matched it and never asks for it. Reaching the
    # existence check earlier is the whole difference.
    root = _repo(tmp_path / "proj", {"gone.txt": b"was here\n"})
    (root / "gone.txt").unlink()

    frame = _run(file_view(str(root), "gone.txt", allow_diff=False))

    assert frame["error"] == "no such file"


def test_a_deleted_file_asked_for_as_text_is_not_answered_with_content(
    tmp_path: Path,
):
    # The error branch carries the empty content by construction; asserting it
    # keeps a future "answer the diff anyway, but label it text" from passing.
    root = _repo(tmp_path / "proj", {"gone.txt": b"was here\n"})
    (root / "gone.txt").unlink()

    frame = _run(file_view(str(root), "gone.txt", allow_diff=False))

    assert frame["mode"] == "error" and frame["content"] == ""


def test_the_status_panel_click_still_opens_a_deleted_files_removal_diff(
    tmp_path: Path,
):
    # The other caller, pinned in the same file so the two cannot be conflated
    # later: the row the status panel most wants to offer is the one whose
    # content is gone, and `allow_diff=True` is what keeps it openable.
    root = _repo(tmp_path / "proj", {"gone.txt": b"was here\n"})
    (root / "gone.txt").unlink()

    frame = _run(file_view(str(root), "gone.txt"))

    assert frame["mode"] == "diff" and "was here" in frame["content"]
