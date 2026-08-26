"""How big is every file the graph draws.

`scan_tree` answers "which files exist", `file_view` answers "what is inside
*this* file", `content_search` answers "which files hold this string", and
`status.py` answers "what is dirty". Nothing anywhere asked the filesystem for
metadata at all, so the size colour mode (F7) had no question to ask.

**Why this is its own module.** Not `tree.py`: that is the boot snapshot, it runs
again on every root switch, and its promise is to stay cheap -- growing a stat
pass onto it makes every ctrl+L pay for a mode that may never be armed. Not
`file_view.py`: that module owns the click path's security ordering and imports
the git machinery to do it. Not `status.py`: nothing about a byte count is the
porcelain format. The next change settles it -- someone will want sizes for a
workspace of checkouts, a different cap, or `st_blocks` instead of `st_size` --
and in a module of its own that is one signature rather than an edit to the
function every daemon boot goes through.

**It opens nothing**, and that is asserted over the parsed source the way
`checkouts.py`'s "starts no process" and `content_search.py`'s "compiles no
pattern" are. A walk over a whole home directory that never holds a descriptor
cannot be parked on a writerless FIFO -- the failure `safe_read.py` exists for --
so this module needs `safe_read` only for as long as nobody adds "and let us also
sniff whether it is binary". It starts no process and matches no pattern either.

Design notes:
  * **The set measured is the set drawn, by identity.** `MAX_FILES` *is*
    `tree.DEFAULT_MAX_FILES`, the same object, following the
    `content_search.MAX_FILE_BYTES is file_view.DEFAULT_MAX_BYTES` precedent. Two
    constants that happen to both be 20 000 is the bug waiting to happen, and it
    would surface as a tail of grey dots nobody could explain.
  * **The walk is `scan_tree`'s.** The ignore rules, the symlink drop, the sort
    and the cap are the graph's own rather than a second opinion about the same
    tree. The cap is asked for one entry above the one that is served, which is
    the only way `scan_tree`'s own answer can say whether it was cut.
  * **`os.lstat`, not `os.stat`.** `scan_tree` already drops symlinked files, so
    the two agree under ordinary operation. What `lstat` buys is the window
    between the walk and the stat: a path that became a link inside it reports the
    link's own size rather than the size of whatever it now points at, inside or
    outside the observed root. It costs nothing and it is the fail-safe reading.
  * **It never raises.** A file that vanished between the walk and the stat drops
    its entry, and an unreadable directory costs entries. A partial answer is a
    partial colouring; an exception is a dead command, with the browser holding a
    pending flag nothing will clear.
  * **The frame carries JSON types only.** A `FileSize` smuggled through whole
    would raise inside the daemon's send, on the loop, long after this function
    returned -- so the failure would land nowhere near the code that caused it.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass

from rhizome_graph.tree import DEFAULT_MAX_FILES, scan_tree

#: How many files one measurement may cover. The graph's own cap, by identity
#: rather than by coincidence: the set measured is the set drawn.
MAX_FILES = DEFAULT_MAX_FILES


@dataclass(frozen=True)
class FileSize:
    """One file the graph draws, and how many bytes it holds.

    No mode, no owner and no timestamp: the colour scale is the browser's to
    build, and everything else about the file is somebody else's question.
    """

    path: str
    bytes: int


def sizes_frame(
    files: "list[FileSize] | tuple[FileSize, ...]",
    truncated: bool,
    error: str,
) -> dict:
    """The answer frame, in JSON types only.

    Modelled on :func:`rhizome_graph.content_search.search_frame`, minus the echo:
    a measurement has no query to quote back, so a late answer is recognized as
    late by the daemon's root re-read instead.
    """
    return {
        "kind": "sizes",
        "files": [{"path": entry.path, "bytes": entry.bytes} for entry in files],
        "truncated": bool(truncated),
        "error": error,
    }


def measure_tree(root: str, max_files: int = MAX_FILES) -> tuple[list[FileSize], bool]:
    """The sizes of the files under `root`, and whether the cap bit.

    Blocking: it walks the disk and stats every path it finds. The caller puts it
    on a thread.

    One entry beyond `max_files` is asked of the walk so that "there was more"
    is `scan_tree`'s own answer rather than a second count of the same tree --
    the `DEFAULT_MAX_ENTRIES + 1` trick the multi-repository status panel uses,
    for the same reason: at exactly the cap a walk that fits and a walk that was
    cut are indistinguishable.
    """
    if max_files <= 0:
        return [], False

    walked = scan_tree(root, max_files + 1)
    truncated = len(walked) > max_files

    files: list[FileSize] = []
    for relative in walked[:max_files]:
        try:
            info = os.lstat(os.path.join(root, relative))
        except OSError:
            # Vanished between the walk and the stat, or never readable: a file
            # with no size to report, never the measurement's answer.
            continue
        files.append(FileSize(relative, info.st_size))

    return files, truncated


async def measure_sizes(root: str) -> dict:
    """Measure `root` off the event loop, and frame the answer.

    Through `asyncio.to_thread` for the reason `scan_tree` and `search_tree` are:
    the walk dominates and is measured in hundreds of milliseconds on a large
    tree, which on the loop is exactly that long with every viewer frozen.
    """
    files, truncated = await asyncio.to_thread(measure_tree, root)
    return sizes_frame(files, truncated, "")
