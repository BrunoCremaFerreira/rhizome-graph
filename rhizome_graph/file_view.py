"""What the panel shows when a node in the graph is clicked.

The graph says *that* a file changed and nothing about *what* is in it. This
module builds the one frame that answers the click, deciding in a fixed order:

  1. the path is refused (it escapes the observed root) -> ``error``;
  2. it is a directory -> ``error``;
  3. it has an uncommitted change -> ``mode: "diff"``;
  4. it is not on disk and git had nothing either -> ``error: no such file``;
  5. it is text -> ``mode: "text"``;
  6. it is binary -> ``mode: "hex"``.

The order is the point, twice over.

A binary that was just modified is shown as its diff ("Binary files ... differ",
which is all git has to say about it) rather than as a hex dump of the new bytes:
the question the viewer clicked to ask was "what did the agent just do to this
file".

Step 3 has an opt-out, and only one caller uses it. ``allow_diff=False`` skips
the diff entirely -- the chain becomes refused -> directory -> not on disk ->
text -> hex -- because the content search asks a different question. A match is
at a *line of the file on disk*, while ``git diff`` prints hunks with three
lines of context, so a file with one small edit shows perhaps ten of its four
hundred lines and a match at line 220 is simply not in the answer. Opening that
diff under a counter reading ``7 / 213`` would show none of the 7, and it would
do so on exactly the files an agent has just touched, which are the files anyone
is searching for. The status-panel click keeps the default and keeps its diff.

The branch sits **before** the fork, not around its result: a walk opens a file
per keystroke, and ~20 ms of ``git`` per step that is then discarded is the
difference between a responsive walk and a stuttering one.

Under the opt-out a **deleted** file reaches "no such file" one step earlier,
and that is correct rather than unfortunate: nothing is on disk for a content
search to have matched, so it never asks about such a path.

And existence is asked about *after* git, not before. A **deleted** file -- the
single entry the status panel most wants to offer for a click -- is not on disk
by definition, and the old order answered "no such file" while ``git diff HEAD``
had the whole removed content ready to show. The directory check stays ahead of
git regardless: ``git diff HEAD -- src`` happily produces the combined diff of
everything under a folder, and clicking a folder must not open that.

:func:`resolve_inside` is the security half. The path arrives over a WebSocket,
as text, and unlike the completion commands it is used to **read file contents**.
``../../etc/passwd``, ``/etc/passwd`` and a symlink planted inside the project
pointing at ``/etc`` are the same attack, and the defense is the one
``_resolve_static_file`` already uses on the HTTP side: resolve first, then
require the result to sit under the root -- so a path that wanders through ``..``
and comes back is fine, while banning ``..`` textually would refuse it and still
miss the symlink.

Which working tree ``git`` is run in is **derived**, not assumed: the observed
root when it is the checkout, otherwise the checkout under it that owns the
clicked file (:func:`_diff_location`). A workspace of repositories --
``~/projects/{a,b,c}`` -- is a container that is not a checkout at all, so
running ``git`` there exits 128 and the diff route dies for every file in every
sub-repository: an existing file quietly falls through to its text, and a
deleted one reaches the existence check and answers "no such file", undoing the
ordering above on the single row the status panel most wants to offer.

That derivation happens **strictly after** :func:`resolve_inside`, from its
output. This is the security property, not a style choice: naming the checkout
from the incoming string would be a second place a path is interpreted, upstream
of the only containment check -- and ``a/../../secret.txt`` reads there as a
plausible sub-repository ``a`` plus a remainder, which is exactly how a
chokepoint becomes bypassable. The resolved target is paid for first and
everything is derived from it.

The cost is one asymmetry, stated rather than hidden. In the sub-repo branch the
path handed to ``git`` is relative to a checkout only knowable from the resolved
target, so a clicked symlink is diffed as its destination; in the single-repo
branch the string that arrived is passed through untouched, so the link itself
is diffed, as it always was. Unavoidable on one side, avoidable on the other,
therefore avoided there.

``max_bytes`` exists because this frame goes down a WebSocket: a 400 MB core dump
would be read into the daemon's memory, hex-expanded to four times its size and
pushed to a browser. On the text and hex routes the cap applies to the bytes
*read*; on the diff route the text arrives already decoded from ``git``, so
:func:`cap_text` applies the same ceiling to what is *sent*. The two are kept
apart on purpose -- a binary has no lines, and the read must not become
line-aware.

The read itself goes to a thread. Blocking the loop freezes every connected
viewer, for the same reason :func:`rhizome_graph.tree.scan_tree` is off it. The
open is not written here: a clicked path is a path this module did not
construct, so it goes through :mod:`rhizome_graph.safe_read`, whose docstring
carries the reason a thread parked in ``open(2)`` on a named pipe is lost for
good. :func:`is_readable_regular` and :func:`read_capped` are re-exported from
there, because that is where callers of this module have always found them.
Nothing here raises.
"""

from __future__ import annotations

import asyncio
import os

from rhizome_graph.checkouts import owning_checkout
from rhizome_graph.diff import git_diff
from rhizome_graph.hexdump import looks_binary, xxd_dump
from rhizome_graph.safe_read import is_readable_regular, read_capped

#: Re-exported so that a caller who has always found the FIFO-safe read here
#: keeps finding it, now that it lives in its own module.
__all__ = [
    "DEFAULT_MAX_BYTES",
    "cap_text",
    "file_view",
    "is_readable_regular",
    "read_capped",
    "resolve_inside",
]

#: Ceiling on the bytes read for one panel.
DEFAULT_MAX_BYTES = 256 * 1024


def resolve_inside(root: str, relative_path: str) -> str | None:
    """`relative_path` as an absolute path under `root`, or ``None`` if it escapes.

    Resolution comes first and containment second, so symlinks are followed
    before the question is asked -- the textual path of a link planted inside the
    project looks perfectly innocent. Returns ``None`` for anything that lands
    outside, for an absolute path (``os.path.join(root, "/etc/passwd")`` *is*
    ``/etc/passwd``, so the join alone is no check), and for anything the OS
    refuses to look at at all, such as a path carrying a NUL byte.
    """
    try:
        if not relative_path or "\x00" in relative_path:
            return None
        if os.path.isabs(relative_path):
            return None
        base = os.path.realpath(root)
        candidate = os.path.realpath(os.path.join(base, relative_path))
        if candidate != base and not candidate.startswith(base + os.sep):
            return None
        return candidate
    except Exception:
        return None


async def file_view(
    root: str,
    relative_path: str,
    max_bytes: int = DEFAULT_MAX_BYTES,
    allow_diff: bool = True,
) -> dict:
    """The ``fileView`` frame for `relative_path`, ready to be sent as JSON.

    Only plain JSON types leave here: a ``Path`` or raw ``bytes`` smuggled in
    would raise inside the send, on the daemon's loop. ``path`` is echoed intact
    because the page keys the panel by it -- a second click while the first answer
    is still travelling must not paint the wrong file's content.

    `allow_diff` is the content search's opt-out from step 3 of the chain (see
    the module docstring). It is read strictly *after* :func:`resolve_inside`
    and changes no path handling at all, and it gates the fork itself rather
    than its result: asking for text must not run ``git`` and throw the answer
    away.
    """
    target = resolve_inside(root, relative_path)
    if target is None:
        return _frame(relative_path, error="refused: outside the observed project")
    if os.path.isdir(target):
        return _frame(relative_path, error="that is a directory")

    if allow_diff:
        cwd, diff_path = _diff_location(root, relative_path, target)
        diff = await git_diff(cwd, diff_path)
        if diff is not None:
            content, truncated = cap_text(diff, max_bytes)
            return _frame(
                relative_path, mode="diff", content=content, truncated=truncated
            )

    if not os.path.exists(target):
        # Reached only once git has said it knows nothing about the path either,
        # so a deletion opens its diff instead of an error -- unless the caller
        # opted out of the diff, which is a caller that only wants what is on
        # disk.
        return _frame(relative_path, error="no such file")

    try:
        data, truncated = await asyncio.to_thread(read_capped, target, max_bytes)
    except Exception:
        return _frame(relative_path, error="unreadable")

    if looks_binary(data):
        return _frame(
            relative_path, mode="hex", content=xxd_dump(data), truncated=truncated
        )
    return _frame(
        relative_path,
        mode="text",
        content=data.decode("utf-8", errors="replace"),
        truncated=truncated,
    )


def _diff_location(
    root: str, relative_path: str, target: str
) -> tuple[str, str]:
    """Where `git` is run for `target`, and what it is asked about there.

    Called only with the chokepoint's output, never with the string that arrived
    over the socket -- see the module docstring for why that ordering is the
    security property here.

    The observed root when it owns the file itself (or when nothing under it
    does), the checkout that owns it otherwise. The compat branch hands back
    `relative_path` untouched rather than a path rebuilt from `target`: the
    resolved target is a `realpath`, so rebuilding would diff a symlink's
    destination instead of the link that was clicked.

    `os.path.relpath` cannot climb out of `checkout` here: the checkout was found
    by walking *up from* `target`, so `target` sits inside it by construction.
    """
    checkout = owning_checkout(root, target)
    if checkout is None or checkout == os.path.realpath(root):
        return root, relative_path
    return checkout, os.path.relpath(target, checkout)


def cap_text(text: str, max_bytes: int) -> tuple[str, bool]:
    """The first `max_bytes` of UTF-8 in `text`, and whether there was more.

    The unit is bytes because the cap exists for what crosses the socket, not
    for how many characters a diff happens to spell.

    The cut lands on a line boundary whenever there is one to land on: the panel
    parses this text back into hunks and rows, and half a hunk header is a worse
    failure than the size being avoided. When a single line is longer than the
    whole cap -- a minified bundle is one line and megabytes long, precisely the
    file most likely to hit this -- trimming back to the last newline would leave
    nothing at all, so that case is cut mid-line rather than emptied.

    What comes back is always a prefix of `text`: no ellipsis and no "... N more
    lines" marker, because the browser reads this as a diff and would parse the
    marker as content.
    """
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text, False
    head = raw[:max_bytes] if max_bytes > 0 else b""
    boundary = head.rfind(b"\n")
    if boundary >= 0:
        head = head[: boundary + 1]
    # A slice at an arbitrary byte can split a character; dropping the orphan
    # keeps the answer a true prefix instead of ending it in U+FFFD.
    return head.decode("utf-8", errors="ignore"), True


def _frame(
    relative_path: str,
    *,
    mode: str = "error",
    content: str = "",
    truncated: bool = False,
    error: str = "",
) -> dict:
    return {
        "kind": "fileView",
        "path": relative_path,
        "mode": mode,
        "content": content,
        "truncated": truncated,
        "error": error,
    }
