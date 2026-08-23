"""Contract tests (RED) for rhizome_graph.content_search.

Motivation: nothing in this tree can answer "which files contain this string".
`scan_tree` answers "which files", `file_view` answers "what is in *this* file",
`status.py` answers "what is dirty". Nothing reads many files to answer one
question, and the content search (ctrl+shift+F) is exactly that question.

Four defects are pinned here, and each is the reason a rule exists rather than a
preference:

* **An off-by-N highlight.** The daemon counts occurrences and the browser
  RECOMPUTES their ranges from the text it is later handed, so the two sides
  agree only if both fold case with a rule that cannot change the length of the
  text. `str.lower()` is not such a rule: `"I"` with a dot above it lowercases
  to TWO characters in Python *and* in JavaScript, so every offset computed
  against a Unicode fold of a text containing one is shifted and the panel
  underlines the wrong columns. Folding `A-Z` and nothing else also makes the
  byte pass and the character pass the SAME rule, because an ASCII byte can
  never occur inside a UTF-8 continuation. The stated price is pinned too: an
  accented capital does not match its accented lowercase query.
* **Two constants that happen to be equal.** The panel shows the first 256 KiB
  and the search counts over the first 256 KiB, so `MAX_FILE_BYTES` must *be*
  `file_view.DEFAULT_MAX_BYTES`, not a second literal beside it.
* **A regex reaching the search.** No pattern from the network is ever compiled,
  and that is asserted over the parsed source rather than promised in a
  docstring -- the same jaw `tests/test_checkouts.py` closes on `checkouts.py`.
  It is also the fast answer: a regex measured 5.6x slower than
  `bytes.lower().count` on the same corpus.
* **A parked worker.** The search opens thousands of files it did not choose,
  so one named pipe under the observed root must neither hang it nor appear in
  its results. A thread wedged in `open(2)` cannot be cancelled and shutdown
  joins it, which is why the read goes through `safe_read.read_capped` and why
  a future "optimisation" back to a bare `open()` has to fail here.

MATCH_FIXTURES and FOLD_FIXTURES below are the shared fixture table of decision
14, transcribed from `web/tests/matchRanges.test.ts` in the same order with no
code shared between the two languages. Every character in them is in the Basic
Multilingual Plane on purpose: JavaScript offsets are UTF-16 code units and
Python's are code points, and outside the BMP the two would disagree about the
same match. A disagreement between the two files means a transcription slip,
not a difference of opinion.

Two shapes are asserted here that the plan states as prose rather than as a
signature, because a test cannot drive a cap it cannot set: `search_tree` takes
the three ceilings as keyword arguments named after the constants
(`max_total_bytes`, `max_match_files`, `max_total_matches`), and the paths it
reports are relative to the root, as `scan_tree` returns them and as the graph
keys its nodes.

Expected to FAIL until `rhizome_graph/content_search.py` exists.

Style: Arrange-Act-Assert, one failure reason per test.
"""

from __future__ import annotations

import asyncio
import ast
import contextlib
import dataclasses
import json
import os
import threading
import time
from pathlib import Path

import pytest


# --- The module under specification, imported where it is used --------------
#
# Not at module scope: a top-level import of a module that does not exist yet
# fails at collection and reddens the whole file with one error instead of
# telling each test what it was asking for. `tests/test_safe_read.py` imports
# `read_capped` inside a helper for the same reason.


def _module():
    import rhizome_graph.content_search as content_search

    return content_search


def _fold_ascii(text: str) -> str:
    return _module().fold_ascii(text)


def _match_ranges(text: str, query: str) -> list[tuple[int, int]]:
    return _module().match_ranges(text, query)


def _count_matches(text: str, query: str) -> int:
    return _module().count_matches(text, query)


def _search_tree(root: str, query: str, **caps):
    return _module().search_tree(root, query, **caps)


def _search_frame(query: str, files, truncated: bool, error: str) -> dict:
    return _module().search_frame(query, files, truncated, error)


def _file_matches(path: str, count: int):
    return _module().FileMatches(path, count)


def _content_search(root: str, query: str, timeout: float = 30.0) -> dict:
    async def attempt() -> dict:
        return await asyncio.wait_for(_module().content_search(root, query), timeout)

    return asyncio.run(attempt())


# --- The shared fixture table (decision 14) ---------------------------------
#
# Shared with web/tests/matchRanges.test.ts -- keep both in step, same order.
# Each row: a name, the text, the query, and the expected [start, end) pairs.
# TypeScript spells a range as {start, end} and Python as a tuple; the numbers
# are the same numbers.

MATCH_FIXTURES: tuple[tuple[str, str, str, list[tuple[int, int]]], ...] = (
    ("a plain word", "hello world", "world", [(6, 11)]),
    ("overlapping candidates count once", "aaa", "aa", [(0, 2)]),
    ("two disjoint runs", "aaaa", "aa", [(0, 2), (2, 4)]),
    ("the tail is not re-scanned", "abab", "aba", [(0, 3)]),
    ("case folds both ways", "Foo foo", "FOO", [(0, 3), (4, 7)]),
    ("an empty query matches nothing", "anything", "", []),
    ("an empty text matches nothing", "", "a", []),
    ("an empty query in an empty text", "", "", []),
    ("no occurrence", "hello", "zz", []),
    ("a query longer than the text", "ab", "abc", []),
    ("the whole text", "abc", "abc", [(0, 3)]),
    ("across a newline", "line one\nline two", "line", [(0, 4), (9, 13)]),
    ("ascii folds", "CAFE", "cafe", [(0, 4)]),
    ("an accented capital does not fold", "CAFÉ", "café", []),
    ("an accented letter still matches itself", "café", "café", [(0, 4)]),
    ("a dotted capital I costs one offset", "İstanbul", "stanbul", [(1, 8)]),
    ("a dotted capital I shifts nothing after it", "İ file", "file", [(2, 6)]),
    ("a dotted capital I is not an ascii i", "İ", "i", []),
    ("an ascii i is not a dotted capital I", "i", "İ", []),
    ("a sharp s is not ss", "STRASSE", "straße", []),
    ("a sharp s matches itself", "Straße", "straße", [(0, 6)]),
)

#: Shared with web/tests/matchRanges.test.ts -- keep both in step, same order.
#: Each row: a name, the input, and the expected fold.
FOLD_FIXTURES: tuple[tuple[str, str, str], ...] = (
    ("plain ascii letters", "ABC", "abc"),
    ("punctuation and digits are untouched", "Hello, World! 123", "hello, world! 123"),
    ("already folded", "abc", "abc"),
    ("an empty string", "", ""),
    ("a dotted capital I survives an ascii fold", "İ", "İ"),
    ("a dotted capital I among ascii", "İstanbul", "İstanbul"),
    ("a sharp s survives an ascii fold", "Straße", "straße"),
    ("an accented capital survives an ascii fold", "CAFÉ", "cafÉ"),
    ("the ascii boundary at [ and backtick", "[A`a", "[a`a"),
)


# --- 2.1 the fold is ascii-only and length-preserving -----------------------


def test_the_fold_lowercases_ascii_and_leaves_every_other_character_alone():
    for name, text, folded in FOLD_FIXTURES:
        assert _fold_ascii(text) == folded, name


def test_the_fold_never_changes_the_length_of_the_text():
    for name, text, _folded in FOLD_FIXTURES:
        assert len(_fold_ascii(text)) == len(text), name


def test_the_fold_keeps_a_dotted_capital_i_one_character_where_str_lower_does_not():
    # The whole reason the function exists, stated against the alternative a
    # developer reaches for first: a Unicode fold makes this text longer, and
    # every offset computed against it is then wrong.
    dotted_capital_i = "İ"

    assert len(dotted_capital_i.lower()) == 2
    assert len(_fold_ascii(dotted_capital_i)) == 1


def test_the_fold_preserves_the_length_of_every_text_and_query_in_the_table():
    for name, text, query, _ranges in MATCH_FIXTURES:
        assert len(_fold_ascii(text)) == len(text), name
        assert len(_fold_ascii(query)) == len(query), name


def test_the_fold_is_idempotent():
    for name, text, _folded in FOLD_FIXTURES:
        once = _fold_ascii(text)
        assert _fold_ascii(once) == once, name


# --- 2.2 the ranges ---------------------------------------------------------


def test_overlapping_candidates_count_once():
    # The advance is the query's length, not one character: "aa" occurs once in
    # "aaa" for both this suite and the browser's.
    assert _match_ranges("aaa", "aa") == [(0, 2)]


def test_an_occurrence_is_found_whatever_the_case_on_either_side():
    assert _match_ranges("Foo foo", "FOO") == [(0, 3), (4, 7)]


def test_an_empty_query_matches_nothing():
    assert _match_ranges("anything", "") == []


def test_an_accented_capital_does_not_match_an_accented_query():
    # The documented price of an ascii-only fold, pinned so nobody "fixes" it
    # with str.lower() and silently shifts every offset in the panel.
    assert _match_ranges("CAFÉ", "café") == []


def test_an_ascii_capital_does_match_its_lowercase_query():
    # The other half of the pair above: the fold is not simply absent.
    assert _match_ranges("CAFE", "cafe") == [(0, 4)]


def test_offsets_stay_exact_after_a_dotted_capital_i():
    assert _match_ranges("İ file", "file") == [(2, 6)]


def test_match_ranges_agrees_with_the_shared_fixture_table():
    for name, text, query, ranges in MATCH_FIXTURES:
        assert _match_ranges(text, query) == ranges, name


# --- 2.3 the count is the ranges, counted -----------------------------------


def test_count_matches_equals_the_number_of_ranges_for_every_row():
    # One rule, one implementation: a count that disagrees with the ranges is a
    # counter reading "7 / 213" over a panel that can only underline 212.
    for name, text, query, _ranges in MATCH_FIXTURES:
        assert _count_matches(text, query) == len(_match_ranges(text, query)), name


def test_count_matches_equals_the_expected_range_count_for_every_row():
    for name, text, query, ranges in MATCH_FIXTURES:
        assert _count_matches(text, query) == len(ranges), name


# --- The constants ----------------------------------------------------------


def test_the_file_cap_is_the_panel_s_own_constant_rather_than_a_second_literal():
    # Identity, not equality: the panel shows the first 256 KiB and the search
    # counts over the first 256 KiB, so the browser's recount of the panel's
    # text equals the daemon's count. Two constants that happen to be equal is
    # the bug waiting to happen, and `256 * 1024` written twice would pass an
    # equality assertion while being exactly that bug.
    import rhizome_graph.file_view as file_view

    assert _module().MAX_FILE_BYTES is file_view.DEFAULT_MAX_BYTES


def test_the_whole_run_is_capped_at_sixty_four_mebibytes():
    assert _module().MAX_TOTAL_BYTES == 64 * 1024 * 1024


def test_at_most_five_hundred_files_are_reported():
    assert _module().MAX_MATCH_FILES == 500


def test_at_most_five_thousand_occurrences_are_counted():
    assert _module().MAX_TOTAL_MATCHES == 5000


def test_a_file_match_is_a_frozen_pair_of_path_and_count():
    match = _file_matches("a.txt", 3)

    assert dataclasses.is_dataclass(match)
    assert (match.path, match.count) == ("a.txt", 3)
    with pytest.raises(dataclasses.FrozenInstanceError):
        match.count = 4


# --- Helpers for the disk-reading half --------------------------------------


def _write(root: Path, relative: str, data: bytes) -> Path:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return target


def _reported(files) -> list[tuple[str, int]]:
    return [(match.path, match.count) for match in files]


# --- 2.4 the walk finds what contains the string ----------------------------


def _tree_of_four(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    root.mkdir()
    _write(root, "a.txt", b"needle and needle\n")
    _write(root, "c.txt", b"one needle here\n")
    _write(root, os.path.join("sub", "b.txt"), b"NEEDLE\n")
    _write(root, "z_none.txt", b"nothing to see here\n")
    return root


def test_a_file_containing_the_string_is_reported_with_its_count(tmp_path: Path):
    root = _tree_of_four(tmp_path)

    files, _truncated = _search_tree(str(root), "needle")

    assert ("a.txt", 2) in _reported(files)


def test_a_file_that_does_not_contain_the_string_is_absent(tmp_path: Path):
    root = _tree_of_four(tmp_path)

    files, _truncated = _search_tree(str(root), "needle")

    assert "z_none.txt" not in [match.path for match in files]


def test_the_matching_files_come_back_sorted_by_path(tmp_path: Path):
    # `scan_tree` is already sorted and the cut is alphabetical, so the order is
    # deterministic across runs -- which is what lets `F3` walk the same
    # sequence twice.
    root = _tree_of_four(tmp_path)

    files, _truncated = _search_tree(str(root), "needle")

    assert _reported(files) == [
        ("a.txt", 2),
        ("c.txt", 1),
        (os.path.join("sub", "b.txt"), 1),
    ]


def test_the_reported_paths_are_relative_to_the_root(tmp_path: Path):
    # The graph keys its nodes by the path `scan_tree` produced; an absolute
    # path here highlights nothing at all.
    root = _tree_of_four(tmp_path)

    files, _truncated = _search_tree(str(root), "needle")

    assert [match.path for match in files if os.path.isabs(match.path)] == []


def test_a_run_that_hits_no_cap_is_not_truncated(tmp_path: Path):
    root = _tree_of_four(tmp_path)

    _files, truncated = _search_tree(str(root), "needle")

    assert truncated is False


# --- 2.5 binaries are skipped on the head -----------------------------------


def test_a_file_with_a_nul_in_its_head_is_skipped_even_when_the_needle_follows(
    tmp_path: Path,
):
    # `looks_binary` sniffs the first 8 KiB, so the NUL is what decides, not the
    # needle. A consequence worth stating: the content search can never open the
    # hex branch of the panel, because it never matches a binary.
    root = tmp_path / "proj"
    root.mkdir()
    _write(root, "blob.dat", b"\x00\x01\x02" + b"x" * 64 + b"needle\n")
    _write(root, "text.txt", b"a needle in text\n")

    files, _truncated = _search_tree(str(root), "needle")

    assert _reported(files) == [("text.txt", 1)]


# --- 2.6 the byte budget ----------------------------------------------------


def _spy_on_read_capped(monkeypatch: pytest.MonkeyPatch, root: Path) -> list[str]:
    """Record every path the search actually opens, and let the read happen.

    Installed on both modules on purpose. Which one takes effect depends on
    whether the implementation calls `safe_read.read_capped` or a name bound at
    import time, and that is not the property under test; what is pinned is that
    the search reads through the FIFO-safe function and stops reading when the
    budget is gone.
    """
    import rhizome_graph.safe_read as safe_read

    real = safe_read.read_capped
    seen: list[str] = []

    def spy(target: str, max_bytes: int) -> tuple[bytes, bool]:
        seen.append(os.path.relpath(target, str(root)))
        return real(target, max_bytes)

    monkeypatch.setattr(safe_read, "read_capped", spy)
    monkeypatch.setattr(_module(), "read_capped", spy, raising=False)
    return seen


def _three_files_of_a_thousand_bytes(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    root.mkdir()
    for name in ("a.txt", "b.txt", "c.txt"):
        _write(root, name, b"needle" + b"x" * 994)
    return root


def test_every_file_is_read_when_the_budget_is_generous(tmp_path: Path, monkeypatch):
    # The control for the two tests below: without it, "the third file is never
    # read" would also pass over a search that read nothing at all.
    root = _three_files_of_a_thousand_bytes(tmp_path)
    seen = _spy_on_read_capped(monkeypatch, root)

    _search_tree(str(root), "needle", max_total_bytes=64 * 1024)

    assert seen == ["a.txt", "b.txt", "c.txt"]


def test_the_third_file_is_never_opened_once_the_byte_budget_is_spent(
    tmp_path: Path, monkeypatch
):
    # The ceiling that has to be bounded is bytes read, not files walked: a cold
    # page cache is 6x slower than a warm one, so the cost of a search is in the
    # I/O and nowhere else.
    root = _three_files_of_a_thousand_bytes(tmp_path)
    seen = _spy_on_read_capped(monkeypatch, root)

    _search_tree(str(root), "needle", max_total_bytes=1999)

    assert seen == ["a.txt", "b.txt"]


def test_a_run_that_spends_its_byte_budget_says_so(tmp_path: Path):
    root = _three_files_of_a_thousand_bytes(tmp_path)

    _files, truncated = _search_tree(str(root), "needle", max_total_bytes=1999)

    assert truncated is True


# --- 2.7 the two counters ---------------------------------------------------


def _five_matching_files(tmp_path: Path, occurrences: int = 1) -> Path:
    root = tmp_path / "proj"
    root.mkdir()
    for name in ("a.txt", "b.txt", "c.txt", "d.txt", "e.txt"):
        _write(root, name, b"needle " * occurrences)
    return root


def test_the_file_cap_cuts_the_list_alphabetically(tmp_path: Path):
    root = _five_matching_files(tmp_path)

    files, _truncated = _search_tree(str(root), "needle", max_match_files=2)

    assert [match.path for match in files] == ["a.txt", "b.txt"]


def test_a_run_that_hits_the_file_cap_says_so(tmp_path: Path):
    root = _five_matching_files(tmp_path)

    _files, truncated = _search_tree(str(root), "needle", max_match_files=2)

    assert truncated is True


def test_the_occurrence_cap_cuts_the_list(tmp_path: Path):
    # Where exactly the cut falls -- whether the file that crosses the ceiling is
    # kept or dropped -- is the implementation's to choose; that the list is
    # shorter than the tree and every count in it is exact is not.
    root = _five_matching_files(tmp_path, occurrences=2)

    files, _truncated = _search_tree(str(root), "needle", max_total_matches=3)

    reported = _reported(files)
    assert len(reported) < 5
    assert reported == [("a.txt", 2), ("b.txt", 2)][: len(reported)]


def test_a_run_that_hits_the_occurrence_cap_says_so(tmp_path: Path):
    root = _five_matching_files(tmp_path, occurrences=2)

    _files, truncated = _search_tree(str(root), "needle", max_total_matches=3)

    assert truncated is True


def test_a_run_under_every_cap_is_not_truncated(tmp_path: Path):
    root = _five_matching_files(tmp_path, occurrences=2)

    _files, truncated = _search_tree(
        str(root),
        "needle",
        max_total_bytes=64 * 1024,
        max_match_files=500,
        max_total_matches=5000,
    )

    assert truncated is False


# --- 2.8 a named pipe under the root ----------------------------------------


def _open_write_end(fifo: str, deadline_seconds: float = 2.0) -> bool:
    """Free a worker blocked in `open(2)` on `fifo`, by opening the other end.

    Test *hygiene*, not part of the specification, and the same rescue
    `tests/test_safe_read.py` uses. A thread stuck in `open(2)` cannot be
    cancelled, and the executor is joined when the loop closes and again at
    interpreter exit -- so a single unrescued wedge does not merely leak, it
    hangs the pytest process on the way out.
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


def _search_within(
    root: str,
    query: str,
    timeout: float = 5.0,
    rescue: str | None = None,
):
    """`search_tree`, with promptness as part of the contract.

    Answering *eventually* is not the property under test -- a search that never
    comes back is the defect -- so the call is made on a worker thread, the wait
    is bounded, and running out of it is reported as a `TimeoutError` naming the
    root rather than as a run that hangs. The shield and the rescue loop are the
    technique `tests/test_safe_read.py` uses: the timeout must not cancel the
    task, because the thread underneath it cannot be cancelled and the rescue
    needs something to wait on.
    """

    async def attempt():
        task = asyncio.ensure_future(asyncio.to_thread(_search_tree, root, query))
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
                f"search_tree({root!r}) did not answer within {timeout}s"
            ) from None

    return asyncio.run(attempt())


def _root_holding_a_named_pipe(tmp_path: Path) -> tuple[Path, Path]:
    root = tmp_path / "proj"
    root.mkdir()
    fifo = root / "0-pipe"
    os.mkfifo(fifo)
    _write(root, "text.txt", b"a needle in text\n")
    return root, fifo


def test_a_named_pipe_under_the_root_does_not_hang_the_search(tmp_path: Path):
    # The pipe sorts first, so it is reached before any real file. A search that
    # opened it without O_NONBLOCK would park a worker forever: the executor is
    # shared with `scan_tree` and `file_view`, and shutdown joins it. This is the
    # pin that stops a future "optimisation" from replacing `read_capped` with a
    # bare `open()`.
    root, fifo = _root_holding_a_named_pipe(tmp_path)

    files, _truncated = _search_within(str(root), "needle", rescue=str(fifo))

    assert [match.path for match in files] == ["text.txt"]


def test_a_named_pipe_under_the_root_is_never_reported_as_a_match(tmp_path: Path):
    root, fifo = _root_holding_a_named_pipe(tmp_path)

    files, _truncated = _search_within(str(root), "needle", rescue=str(fifo))

    assert "0-pipe" not in [match.path for match in files]


# --- 2.9 the contract, over the parsed source -------------------------------

#: The packages that are ours; anything else is the standard library.
OUR_PACKAGES = frozenset({"rhizome_graph", "daemon", "hooks"})

#: Modules this one may not import at all. `subprocess` because the whole
#: contract is that the search starts no process, and `re` because "no regex
#: from the network" has to be structural: the query arrives over a WebSocket,
#: and a regex engine measured 5.6x slower than `bytes.lower().count` on the
#: same corpus would be a ReDoS surface bought at a loss.
FORBIDDEN_IMPORTS = frozenset({"subprocess", "multiprocessing", "re"})

#: Every spelling of "start a process", including the asyncio ones -- the module
#: legitimately imports `asyncio` for `to_thread`, so the forbidden names there
#: have to be named one by one.
FORKING_NAMES = (
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
    smuggle in `subprocess`, and `from concurrent import futures` names both.
    Relative imports contribute their own package, which is ours by definition.
    """
    names: set[str] = set()
    for node in ast.walk(module):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.update(alias.name.split("."))
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            names.update(part for part in base.split(".") if part)
            if base.split(".")[0] in OUR_PACKAGES or node.level:
                continue
            names.update(alias.name for alias in node.names)
    return names


def _identifiers(module: ast.Module) -> set[str]:
    """Every name the code *uses*: bare names, attributes and imported modules.

    Identifiers rather than raw text on purpose. The module's own docstring is
    expected to say that it forks nothing and compiles no pattern -- and a
    substring search over the source would then fail on the promise instead of
    on a breach of it.
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


def test_content_search_imports_neither_subprocess_nor_a_regex_engine():
    """No regex from the network, by construction rather than by convention."""
    imported = _imported_modules(ast.parse(_source()))

    offenders = sorted(imported & FORBIDDEN_IMPORTS)

    assert offenders == [], (
        f"rhizome_graph/content_search.py imports {offenders}. The query arrives "
        "over a WebSocket and is matched as a literal substring: no pattern is "
        "ever compiled, and no process is ever started."
    )


def test_content_search_names_no_way_of_starting_a_process():
    """Asserted over every identifier, so a late import inside a function counts.

    That is the form this leaks back in, because it changes no import block a
    reviewer skims.
    """
    used = _identifiers(ast.parse(_source()))

    offenders = sorted(used & set(FORKING_NAMES))

    assert offenders == [], (
        f"rhizome_graph/content_search.py names {offenders}. The search reads "
        "files and forks nothing; gitcmd stays the one place in this project "
        "where a process is started."
    )


# --- 2.10 the frame ---------------------------------------------------------


def test_the_frame_is_exactly_the_shape_the_browser_parses():
    frame = _search_frame(
        "needle", [_file_matches("a.txt", 2), _file_matches("sub/b.txt", 1)], False, ""
    )

    assert frame == {
        "kind": "searchResult",
        "query": "needle",
        "files": [{"path": "a.txt", "count": 2}, {"path": "sub/b.txt", "count": 1}],
        "truncated": False,
        "error": "",
    }


def test_the_frame_carries_its_truncation_and_its_error_text():
    frame = _search_frame("needle", [], True, "the observed project changed")

    assert (frame["truncated"], frame["error"]) == (
        True,
        "the observed project changed",
    )


def test_the_frame_holds_only_json_types():
    # A `FileMatches` smuggled through whole raises inside the daemon's send, on
    # the loop, long after this function returned.
    frame = _search_frame("needle", [_file_matches("a.txt", 2)], False, "")

    assert json.loads(json.dumps(frame)) == frame


def _spy_on_scan_tree(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Record every walk of the tree, and answer nothing.

    Installed on both modules, for the reason `_spy_on_read_capped` gives.
    """
    import rhizome_graph.tree as tree

    seen: list[str] = []

    def spy(root: str, *args, **kwargs) -> list[str]:
        seen.append(root)
        return []

    monkeypatch.setattr(tree, "scan_tree", spy)
    monkeypatch.setattr(_module(), "scan_tree", spy, raising=False)
    return seen


def test_a_real_query_does_walk_the_tree(tmp_path: Path, monkeypatch):
    # The control for the two tests below: without it, "an empty query walks
    # nothing" would also pass over a spy that was never wired to anything.
    root = _tree_of_four(tmp_path)
    seen = _spy_on_scan_tree(monkeypatch)

    _search_tree(str(root), "needle")

    assert seen == [str(root)]


def test_an_empty_query_walks_nothing(tmp_path: Path, monkeypatch):
    # There is nothing to look for, and walking 20 000 files to find none of it
    # is a round trip the user gets for pressing Enter on an empty box.
    root = _tree_of_four(tmp_path)
    seen = _spy_on_scan_tree(monkeypatch)

    _search_tree(str(root), "")

    assert seen == []


def test_an_empty_query_answers_no_files_and_no_truncation(tmp_path: Path):
    root = _tree_of_four(tmp_path)

    files, truncated = _search_tree(str(root), "")

    assert (list(files), truncated) == ([], False)


def test_an_empty_query_answers_an_empty_frame(tmp_path: Path):
    root = _tree_of_four(tmp_path)

    frame = _content_search(str(root), "")

    assert frame == {
        "kind": "searchResult",
        "query": "",
        "files": [],
        "truncated": False,
        "error": "",
    }


def test_the_frame_a_search_answers_names_the_files_it_found(tmp_path: Path):
    root = _tree_of_four(tmp_path)

    frame = _content_search(str(root), "needle")

    assert frame["files"] == [
        {"path": "a.txt", "count": 2},
        {"path": "c.txt", "count": 1},
        {"path": os.path.join("sub", "b.txt"), "count": 1},
    ]


# --- 2.11 the walk runs off the event loop ----------------------------------


def test_the_walk_does_not_stop_the_loop_servicing_another_task(
    tmp_path: Path, monkeypatch
):
    """A search of 64 MiB is ~3 s; on the loop that is 3 s of frozen viewers.

    The stub blocks until a task *on the loop* releases it, so the only way this
    test can finish at all is if the loop kept running while the walk was in
    progress. A `search_tree` called inline never sees the release and reports
    the block itself, rather than timing the suite out.
    """
    released = threading.Event()
    blocked_out = threading.Event()

    def blocking_search_tree(root: str, query: str, **caps):
        if not released.wait(5.0):
            blocked_out.set()
            raise RuntimeError(
                "search_tree ran on the event loop: nothing could release it"
            )
        return ([_file_matches("a.txt", 1)], False)

    monkeypatch.setattr(_module(), "search_tree", blocking_search_tree)

    async def scenario() -> dict:
        async def releaser() -> None:
            await asyncio.sleep(0.05)
            released.set()

        task = asyncio.ensure_future(releaser())
        try:
            return await asyncio.wait_for(_module().content_search(str(tmp_path), "needle"), 10)
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    frame = asyncio.run(scenario())

    assert blocked_out.is_set() is False
    assert frame["files"] == [{"path": "a.txt", "count": 1}]
