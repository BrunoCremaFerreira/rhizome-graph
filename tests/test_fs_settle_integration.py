"""The hook/watcher race, against wall-clock time rather than a fake scheduler.

`tests/test_hub_fs_settle.py` drives the settle window by hand, which is the
only way to assert *what gets published* without also asserting how fast this
host is. The cost of that is exact: nothing in it can tell whether the window is
long enough. `FS_SETTLE_SECONDS` is not arithmetic -- it is a claim about how
long a real hook takes to reach a real daemon after the tool it observed has
already touched the disk -- and a claim about wall-clock time can only be
checked against wall-clock time.

So this file reproduces the measured defect end to end, exactly as it was
isolated on 2026-08-29:

  * a live daemon over a `tmp_path` root, with its filesystem watcher running;
  * a WebSocket client that **drains the replay buffer first**, so what is
    counted afterwards is only what happened during the test -- the boot seed
    and the caption frames are not evidence about a race;
  * a real file written to disk, which is what `PostToolUse` has already
    happened by the time it fires;
  * then, after a deliberate gap, a real payload through the real
    `hooks/emit_event.py` into the real ingest socket.

Two gaps, both measured in the original probe: **40 ms**, which is roughly the
hook process spawn on this host and therefore the ordinary case, and **150 ms**,
which is a loaded machine. At a 0 ms gap the hook wins the race and the old
forward suppression already handled it; those two are the rows that produced
two events each.

The file is deliberately a **new** file rather than an edit of an existing one,
because that is the worse of the two measured rows: the watcher's `A` was
credited to nobody *and* put the path into `_known_paths`, so the hook's own
event -- the one that knows the author -- normalized to `M`. The agent was
recorded as having modified a file it had just created, and the creation
belonged to a phantom. Asserting the type here is therefore not decoration: `A`
is what proves the watcher never reached `_known_paths` before the hook
normalized.

**This runs in the default suite, deliberately, and it must stay that way.** It
is the slowest file here -- about 4 s of a 40 s suite, nearly all of it spent
listening for a second event that must never come -- so the next person to look
at a slow suite will want to put it behind an environment variable. Do not. It
is the only test in this repository that can catch `FS_SETTLE_SECONDS` set too
*short*: every other assertion about the window drives a fake scheduler by hand
and would pass at a window of one millisecond. A race guard behind an opt-in
switch is a race guard that never fires, which is the exact failure this file
exists to prevent, and the defect it guards was found in production rather than
in a suite. The precedent is already here: `tests/test_ready_callback.py` and
`tests/test_window_lifecycle.py` spin real daemons through the same
`tests/daemon_probe.py` and are not gated either.

The cost that is left is deliberate too. `LISTEN_AFTER_HOOK_SECONDS` may be
lowered only against `FS_SETTLE_SECONDS`, never against the clock: it is the
window in which a *second* event would arrive, and shortening it below the
settle window turns this test into one that passes by having stopped listening.
The 40 ms and 150 ms gaps are not tuning at all -- they are the measured race,
and they are the whole point.

Style: Arrange-Act-Assert, one property per test.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from websockets.asyncio.client import connect

from daemon.server import run
from daemon_probe import STARTUP_TIMEOUT_SECONDS, cancel_and_wait, drive, scrub, settings_for, site

REPO_ROOT = Path(__file__).resolve().parent.parent
HOOK = REPO_ROOT / "hooks" / "emit_event.py"

SESSION = "sess-fs-settle"
SUBAGENT_ID = "a747fec535c143044"
SUBAGENT_TYPE = "developer-backend"

#: The gaps the original probe measured, in seconds. 40 ms is the hook spawn on
#: this host and therefore the ordinary case; 150 ms is a loaded machine. Both
#: produced two events for one change before the settle window existed.
GAP_SECONDS = (0.040, 0.150)

#: How long the client keeps listening after the hook, before it counts. This is
#: the one number here that trades runtime against strength, and it is bounded
#: from below by `FS_SETTLE_SECONDS` rather than by taste: a second event, if the
#: deferral leaked one, arrives at the end of the settle window, so a budget
#: under that window would let this test pass by having stopped listening -- the
#: exact false green the file exists to prevent. At the window's 0.25 s this is
#: four times over, which is the headroom a loaded machine needs. Lower it only
#: by comparing it against that constant again.
LISTEN_AFTER_HOOK_SECONDS = 1.0

#: How long a receive is allowed to block before the client concludes the daemon
#: has nothing more to say right now. Only used for draining, where the traffic
#: being waited out is the replay -- a burst the daemon writes in one go, not
#: something paced by a window -- so this needs only to outlast a scheduling
#: hiccup, and is deliberately not tied to `LISTEN_AFTER_HOOK_SECONDS`.
QUIET_SECONDS = 0.3


def _payload(target: Path) -> bytes:
    """What Claude Code puts on a hook's stdin after a `Write` has run."""
    return json.dumps(
        {
            "session_id": SESSION,
            "hook_event_name": "PostToolUse",
            "tool_name": "Write",
            "tool_input": {"file_path": str(target)},
            "agent_id": SUBAGENT_ID,
            "agent_type": SUBAGENT_TYPE,
        }
    ).encode("utf-8")


def _fire_hook(target: Path, socket_path: str) -> None:
    """Run the real hook script, exactly as a settings file would."""
    env = dict(os.environ)
    env["RHIZOME_SOCKET"] = socket_path
    subprocess.run(
        [sys.executable, str(HOOK)],
        input=_payload(target),
        capture_output=True,
        env=env,
        timeout=20,
    )


async def _drain(ws) -> None:
    """Swallow the replay, so what is counted afterwards is only new traffic.

    A client is handed the reset slot, the caption, the status panel, the agent
    states, the attention header, the whole seed and the last 200 events. None
    of that is evidence about a race, and counting it would make every assertion
    below a function of how many files happened to be in `tmp_path`.
    """
    while True:
        try:
            await asyncio.wait_for(ws.recv(), timeout=QUIET_SECONDS)
        except asyncio.TimeoutError:
            return


async def _collect(ws, seconds: float) -> list[dict]:
    """Every frame that arrives in the next `seconds`, decoded."""
    frames: list[dict] = []
    loop = asyncio.get_running_loop()
    deadline = loop.time() + seconds
    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            return frames
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except asyncio.TimeoutError:
            return frames
        frames.append(json.loads(raw))


async def _serve(settings) -> asyncio.Task:
    """Start `run()` and return once it says it is serving."""
    ready = asyncio.Event()
    task = asyncio.create_task(run(settings, ready=lambda _value: ready.set()))
    done, _ = await asyncio.wait(
        {asyncio.create_task(ready.wait()), task},
        timeout=STARTUP_TIMEOUT_SECONDS,
        return_when=asyncio.FIRST_COMPLETED,
    )
    if task in done:  # it died on the way up; re-raise with its own message
        await task
    assert ready.is_set(), "the daemon never reported itself ready"
    return task


@pytest.mark.parametrize("gap", GAP_SECONDS, ids=lambda g: f"{int(g * 1000)}ms")
def test_a_new_file_written_before_its_hook_produces_exactly_one_event(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, gap: float
):
    """One change is one event, attributed and typed as the hook describes it.

    This is the whole feature seen from outside the process, and it is the only
    test that can fail because `FS_SETTLE_SECONDS` is too *short*: shorten it
    below the hook spawn and the held change flushes before the hook can claim
    it, restoring the measured defect silently and with today's symptom.

    The single assertion carries three facts because separating them would
    weaken all three: two frames for one write is the defect; an `agent` of `""`
    is the phantom row that appeared in the F8 panel; and a type of `M` on a file
    that was just created is the `_known_paths` pollution the deferral removes.
    """
    pytest.importorskip("watchdog")
    scrub(monkeypatch)
    root = tmp_path / "observed"
    root.mkdir()
    settings = settings_for(
        root,
        web_dist=str(site(tmp_path / "assets")),
        socket_path=str(tmp_path / "ingest.sock"),
    )
    target = root / "fresh.md"

    async def scenario():
        task = await _serve(settings)
        try:
            async with connect(f"ws://127.0.0.1:{settings.port}/ws") as ws:
                await _drain(ws)

                target.write_text("written by an agent\n", encoding="utf-8")
                await asyncio.sleep(gap)
                await asyncio.to_thread(_fire_hook, target, settings.socket_path)

                frames = await _collect(ws, LISTEN_AFTER_HOOK_SECONDS)
        finally:
            await cancel_and_wait(task)

        return [f for f in frames if f.get("path") == "fresh.md"]

    events = drive(scenario())

    assert [(e["type"], e["agent"], e["label"]) for e in events] == [
        ("A", SUBAGENT_ID, SUBAGENT_TYPE)
    ]
