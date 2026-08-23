"""The one way this project opens a path it did not itself construct.

The rule: **any read of a path this project did not itself construct goes
through this module.** A path that arrived over a WebSocket, was walked out of
the observed root, or came back from ``git`` names a file of unknown *type*, and
the type is what hurts. ``open(2)`` on a named pipe with no writer blocks
forever, and the read runs in a worker thread -- which cannot be cancelled -- so
one such open costs the daemon a worker permanently, a handful take the whole
file layer (and ``switch_root``, which shares the executor) down, and the
process can no longer even exit, because shutdown joins those threads.

That is also why the module is this poor in imports: ``errno``, ``fcntl``,
``os``, ``stat``, and nothing of ours. A caller that opens thousands of files it
did not choose -- a content search -- must be able to reach the defence without
dragging the click path's git machinery in behind it, and a second ``open()``
written to avoid that import is exactly the parked worker described above. A
chokepoint reachable from one caller and duplicated for the other is not a
chokepoint.

Nothing here is asynchronous: the blocking read belongs on a thread, and putting
it there is the caller's business.
"""

from __future__ import annotations

import errno
import fcntl
import os
import stat


def is_readable_regular(st_mode: int) -> bool:
    """May a file of this type be opened for the panel?

    Only a regular file. A named pipe is the one that matters: ``open(2)`` on a
    FIFO with no writer blocks forever, and since the read runs in a worker
    thread -- which cannot be cancelled -- one click on a build system's pipe
    costs the daemon a worker permanently, eight clicks take the whole file
    layer (and ``switch_root``, which shares the executor) down, and the process
    can no longer even exit, because shutdown joins those threads. Sockets and
    devices are refused by the same rule: the errno that happens to refuse a
    socket today is not a rule.

    The mode must come from a **followed** stat -- ``os.stat`` or ``fstat``,
    never ``lstat`` -- so what is judged is the type at the end of a symlink.
    ``S_IFLNK`` therefore answers ``False``: it should never arrive here, and if
    it does the caller is asking about the link rather than about the file.

    This answers "what kind of file is it", not "may this process read it": the
    permission bits are ignored, because permission is not knowable from the
    mode alone (root reads a ``0o000`` file) and a refusal is already reported
    through the ``unreadable`` path.
    """
    return stat.S_ISREG(st_mode)


def read_capped(target: str, max_bytes: int) -> tuple[bytes, bool]:
    """The first `max_bytes` of `target`, and whether there was more.

    One byte past the cap is read so "exactly at the cap" is not reported as
    truncated, and nothing beyond that ever enters the daemon's memory.

    The descriptor is opened first and its type asked of the descriptor itself,
    rather than stat'ing the path and then opening it: the two calls name the
    same path but not necessarily the same file, and the whole point is to never
    be holding a FIFO. ``O_NONBLOCK`` is what makes the open survivable -- it is
    what stops ``open(2)`` from blocking on a writerless pipe -- and it is
    cleared again before a byte is read, so a regular file keeps ordinary
    blocking read semantics and never returns a short read with ``EAGAIN``.
    """
    descriptor = os.open(target, os.O_RDONLY | os.O_NONBLOCK)
    try:
        if not is_readable_regular(os.fstat(descriptor).st_mode):
            raise OSError(errno.EINVAL, "not a regular file", target)
        flags = fcntl.fcntl(descriptor, fcntl.F_GETFL)
        fcntl.fcntl(descriptor, fcntl.F_SETFL, flags & ~os.O_NONBLOCK)
        with open(descriptor, "rb", closefd=False) as handle:
            data = handle.read(max_bytes + 1)
    finally:
        os.close(descriptor)
    return data[:max_bytes], len(data) > max_bytes
