"""A hand-driven stand-in for `loop.call_later`, for the deferred watcher path.

Not a test file (the name keeps pytest from collecting it), and a sibling of
`tests/daemon_probe.py` for the same reason that one exists: several modules --
`test_hub_fs_settle.py`, `test_hub_reset.py` and `test_hub_stats.py` -- all need
to watch an `EventHub` hold a filesystem change and then release it, and a
second copy of that machinery is how the copies would drift apart.

**Why a fake at all.** `EventHub` defers the watcher's publish for
`FS_SETTLE_SECONDS` so that a hook arriving a moment later can supersede it
instead of adding a second event for one change. A test that proved that by
sleeping would be a test whose failure mode is "this machine was busy": the
window is a quarter of a second, pytest runs the suite in one process, and a
scheduler driven by wall-clock time makes every assertion about *what was
published* also an assertion about *how fast the host is*. So the hub takes its
scheduler the way it already takes its clock -- injected -- and the tests here
drive it by hand.

The one test that must not use this is the wall-clock race itself
(`tests/test_fs_settle_integration.py`): the constant is a fact about how long a
real hook process takes to start, and no fake can measure that.

What this deliberately does **not** do is model time. It records what was
scheduled, in order, and runs it when a test says so; there is no virtual clock
and no ordering by delay, because a hub that schedules two callbacks at
different delays and depends on their relative order would be a hub with a
design nobody has asked for. `delays` is exposed so a test can assert *which*
window was used without asserting when it fired.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


@dataclass
class Scheduled:
    """One `call_later` that was asked for, and what became of it."""

    delay: float
    callback: Callable[[], None]
    cancelled: bool = False
    ran: bool = False

    def cancel(self) -> None:
        """The half of `asyncio.TimerHandle` the hub actually uses.

        Idempotent, like the real one: cancelling a handle twice, or cancelling
        one that has already fired, is not an error -- `EventHub` cancels a
        pending change whenever a hook claims its path, and it must not have to
        know whether that path's callback already ran.
        """
        self.cancelled = True


@dataclass
class FakeScheduler:
    """A collecting `(delay, callback) -> handle` with a `.cancel()`.

    Callable, so it can be passed straight in as `schedule=`: the seam is a
    signature, not a class, and pinning a class here would specify the shape of
    the daemon's own lambda rather than what it must do.
    """

    calls: list[Scheduled] = field(default_factory=list)

    def __call__(self, delay: float, callback: Callable[[], None]) -> Scheduled:
        entry = Scheduled(delay=delay, callback=callback)
        self.calls.append(entry)
        return entry

    # -- what a test asks it ------------------------------------------------

    @property
    def pending(self) -> list[Scheduled]:
        """Everything scheduled that has neither been cancelled nor run."""
        return [c for c in self.calls if not c.cancelled and not c.ran]

    @property
    def delays(self) -> list[float]:
        """Every delay asked for, in the order it was asked for."""
        return [c.delay for c in self.calls]

    def drain(self) -> int:
        """Fire every pending callback, in the order it was scheduled.

        Returns how many ran, so a test can say "and draining added nothing"
        without reaching into the list. A callback that schedules another one --
        which nothing does today, and which a later coalescing rule might --
        is picked up by the loop rather than silently deferred to the next
        `drain`, because a caller who asked for "run what is outstanding" means
        all of it.
        """
        fired = 0
        while True:
            outstanding = self.pending
            if not outstanding:
                return fired
            for entry in outstanding:
                if entry.cancelled or entry.ran:
                    continue
                entry.ran = True
                entry.callback()
                fired += 1
