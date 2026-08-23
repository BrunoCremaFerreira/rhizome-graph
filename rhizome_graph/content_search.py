"""Which files under the observed root contain this literal string.

`scan_tree` answers "which files exist", `file_view` answers "what is in *this*
file", `status.py` answers "what is dirty". Nothing read many files to answer one
question, and the content search (ctrl+shift+F) is exactly that question: a
literal, case-insensitive substring matched against the contents of every file
the graph draws.

**Why this is its own module.** Not `file_view.py`: that module's whole docstring
is the ordering of one file's three renderings and the containment chokepoint the
click path goes through, and it imports the git machinery to do it. Not `tree.py`:
that is the boot snapshot, it must stay cheap enough to run on every root switch,
and it deliberately knows nothing about the contents of what it lists. Not a
`grep.py`: the name promises a process, and this module's entire contract is that
it starts none. The next change is what settles it -- someone will want the search
to skip binaries differently, to cap differently, or to answer for a workspace of
checkouts, and in a module of its own that is one function's signature rather than
an edit to the module that owns the click path's security ordering.

**It starts no process and compiles no pattern**, and both halves are asserted
over the parsed source the way `tests/test_checkouts.py` asserts it for
`checkouts.py`. The query arrives over a WebSocket, so "no regex" is a defence
before it is a preference -- and it is also the fast answer: a regex engine
measured 5.6x slower than `bytes.lower().count` over the same corpus, which would
be a denial-of-service surface bought at a loss. `gitcmd` stays the one place in
this project where a process is started.

Design notes:
  * **The fold is ASCII-only, and that is what keeps offsets honest.** The daemon
    counts occurrences and the browser recomputes their ranges from the text it is
    later handed, so the two agree only if the fold cannot change the length of the
    text. `str.lower()` is not such a rule: the capital I that carries a dot above
    it lowercases to *two* characters, in Python and in JavaScript alike, so every
    offset computed past one is shifted and the panel underlines the wrong columns.
    Folding `A-Z` and nothing else also makes the byte pass and the character pass
    the *same* rule, because an ASCII byte can never occur inside a UTF-8
    continuation. The price is stated rather than hidden: a capital letter carrying
    an accent does not match its lowercase spelling.
  * **Two passes, one file's bytes in memory at a time.** Decoding costs five times
    what byte matching costs (98 MB/s against 514 MB/s), so every file gets the
    cheap byte-level filter and only the files that hit are decoded and counted.
    The decoded pass is the authority: it is the text the panel will receive
    (`file_view` decodes with ``errors="replace"``), so where malformed UTF-8 makes
    the two disagree, the decoded one wins.
  * **Every read goes through `safe_read.read_capped`.** The search opens thousands
    of files it did not choose, and `scan_tree` filters symlinks but not named
    pipes. A bare `open()` here would park a worker thread permanently on the first
    build system's pipe under the root -- the thread cannot be cancelled and
    shutdown joins it.
  * **Binaries are skipped on the head**, by `hexdump.looks_binary`'s 8 KiB sniff.
    A consequence worth stating: the content search can never open the hex branch
    of the panel, because it never matches a binary.
  * **The caps, and what each one protects against.** `MAX_FILE_BYTES` is the
    panel's own constant, imported rather than repeated, so the browser's recount
    of the text it is shown equals the daemon's count of the bytes it read.
    `MAX_TOTAL_BYTES` is the bound that actually binds, because 20 000 files at
    256 KiB is 5 GiB and a cold page cache reads at 32 MB/s -- what has to be
    bounded is bytes read, not files walked. `MAX_MATCH_FILES` and
    `MAX_TOTAL_MATCHES` bound the answer rather than the work: a query of ``e``
    over a large tree would otherwise send a frame nobody can walk. When a cap
    bites, the list is cut alphabetically -- `scan_tree` is already sorted, so the
    cut is deterministic and `F3` walks the same sequence twice -- and the frame
    says `truncated`.
  * **An empty query walks nothing.** There is no needle, and walking 20 000 files
    to find none of it is a round trip the user gets for pressing Enter on an empty
    box.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass

from rhizome_graph.file_view import DEFAULT_MAX_BYTES
from rhizome_graph.hexdump import looks_binary
from rhizome_graph.safe_read import read_capped
from rhizome_graph.tree import scan_tree

#: How much of one file is read and counted over. Identical to what the panel
#: shows, by identity rather than by coincidence: two constants that happen to be
#: equal is the bug waiting to happen, and it would surface as a counter that
#: disagrees with the highlights on every large file.
MAX_FILE_BYTES = DEFAULT_MAX_BYTES

#: How many bytes one run may read in total. The ceiling that binds.
MAX_TOTAL_BYTES = 64 * 1024 * 1024

#: How many matching files one answer may name.
MAX_MATCH_FILES = 500

#: How many occurrences one answer may account for.
MAX_TOTAL_MATCHES = 5000

#: The ASCII fold, and nothing else. Built once: `str.translate` over a table of
#: 26 entries is length-preserving by construction, which `str.lower()` is not.
_ASCII_FOLD = str.maketrans(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "abcdefghijklmnopqrstuvwxyz",
)


@dataclass(frozen=True)
class FileMatches:
    """One file that contains the query, and how many times.

    No content and no offsets: the panel gets its text from the existing file
    round trip and recomputes the ranges from it with the same rule, so there is
    never a second definition of where the matches are.
    """

    path: str
    count: int


def fold_ascii(text: str) -> str:
    """`text` with `A-Z` lowercased and every other character left alone.

    Length-preserving, which is the whole reason it exists -- see the module
    docstring on the capital I that carries a dot above it.
    """
    return text.translate(_ASCII_FOLD)


def match_ranges(text: str, query: str) -> list[tuple[int, int]]:
    """The non-overlapping occurrences of `query` in `text`, left to right.

    Offsets are into `text` as it was given, because the fold changes no length.
    The scan advances by the query's length, so ``"aa"`` occurs once in ``"aaa"``
    -- pinned in both suites rather than inherited from `str.count`.
    """
    if not query or not text:
        return []
    folded_text = fold_ascii(text)
    folded_query = fold_ascii(query)
    width = len(folded_query)
    ranges: list[tuple[int, int]] = []
    start = folded_text.find(folded_query)
    while start != -1:
        ranges.append((start, start + width))
        start = folded_text.find(folded_query, start + width)
    return ranges


def count_matches(text: str, query: str) -> int:
    """How many non-overlapping occurrences of `query` are in `text`.

    Built on :func:`match_ranges` on purpose: one rule, one implementation. A
    count that disagreed with the ranges would read "7 / 213" over a panel that
    can only underline 212.
    """
    return len(match_ranges(text, query))


def search_frame(
    query: str,
    files: "list[FileMatches] | tuple[FileMatches, ...]",
    truncated: bool,
    error: str,
) -> dict:
    """The result frame, in JSON types only.

    A `FileMatches` smuggled through whole would raise inside the daemon's send,
    on the loop, long after this function returned.
    """
    return {
        "kind": "searchResult",
        "query": query,
        "files": [{"path": match.path, "count": match.count} for match in files],
        "truncated": bool(truncated),
        "error": error,
    }


def search_tree(
    root: str,
    query: str,
    max_total_bytes: int = MAX_TOTAL_BYTES,
    max_match_files: int = MAX_MATCH_FILES,
    max_total_matches: int = MAX_TOTAL_MATCHES,
) -> tuple[list[FileMatches], bool]:
    """The files under `root` containing `query`, and whether a cap bit.

    Blocking: it reads the disk. The caller puts it on a thread.
    """
    if not query:
        return [], False

    needle = _folded_bytes(query)
    budget = max_total_bytes
    matches: list[FileMatches] = []
    total = 0
    truncated = False

    for relative in scan_tree(root):
        try:
            data, _more = read_capped(os.path.join(root, relative), MAX_FILE_BYTES)
        except OSError:
            # An unreadable path, a named pipe, a file that vanished between the
            # walk and the read: a file with nothing to say, never the run's answer.
            continue

        budget -= len(data)
        if budget < 0:
            truncated = True
            break

        if looks_binary(data):
            continue
        if needle is not None and needle not in data.lower():
            continue

        count = count_matches(data.decode("utf-8", "replace"), query)
        if count == 0:
            continue

        matches.append(FileMatches(relative, count))
        total += count
        if len(matches) > max_match_files:
            matches.pop()
            truncated = True
            break
        if total > max_total_matches:
            truncated = True
            break

    return matches, truncated


def _folded_bytes(query: str) -> "bytes | None":
    """The folded query as UTF-8, or `None` when it cannot be spelled as bytes.

    `bytes.lower()` folds `A-Z` and nothing else, which is `fold_ascii`'s rule
    exactly, so the byte pass is the same rule made cheaper rather than a
    heuristic. A query carrying an unpaired surrogate has no UTF-8 spelling; the
    filter is then skipped and every file takes the decoded pass, which is slower
    and still exact. Under-reporting is the one thing a filter may not do.
    """
    try:
        return fold_ascii(query).encode("utf-8")
    except UnicodeEncodeError:
        return None


async def content_search(root: str, query: str) -> dict:
    """Search `root` for `query` off the event loop, and frame the answer.

    Through `asyncio.to_thread` for the reason `scan_tree` is: a run of 64 MiB is
    about three seconds, and three seconds on the loop is three seconds of frozen
    viewers.
    """
    files, truncated = await asyncio.to_thread(search_tree, root, query)
    return search_frame(query, files, truncated, "")
