# Plan: hook/watcher reconciliation -- one change, one event

- **Status:** done
- **Created:** 2026-08-29 20:59
- **Implemented:** 2026-08-30, on `development` (uncommitted in the working tree)
- **PR/commit:** -- (not committed; the user decides what becomes history)
- **Consultations (mandatory):** `software-architect` (2026-08-29, shaped the whole plan and
  rejected two of the four shapes); `developer-tester` before step 1; `developer-backend` for
  every GREEN.

## The defect, as measured

`CLAUDE.md` records this under "One edit, two events -- a pre-existing defect the session-stats
panel makes permanent". It was isolated per case on 2026-08-29 in a real browser against a live
daemon, by a WebSocket client that drains the replay buffer first and then counts only what
arrives afterwards, while a real edit lands on disk and a real payload goes through
`hooks/emit_event.py` into the real ingest socket.

| sequence | events published |
|---|---|
| watcher alone, existing file | 1 (`M docs/readme.md [UNATTRIBUTED]`) -- correct |
| hook stamps first, then disk changes | 1 (`M docs/readme.md [agt-d2]`) -- correct |
| **disk first, hook ~40 ms later** (how `PostToolUse` really fires) | **2**: `M ... [UNATTRIBUTED]` then `M ... [agt-d1]` |
| **new file, disk first** | **2**: `A docs/fresh1.md [UNATTRIBUTED]` then `M docs/fresh1.md [agt-d3]` |

The new-file row is the worse one: the creation is credited to nobody, and the agent is recorded
as having *modified* a file it created -- the watcher's `A` put the path into `_known_paths`, so
the hook's event normalized to `M`. One session accumulated a stats row reading
`unattributed / 15 written`, every one of them the watcher half of some agent's own edit.

## Why the existing suppression misses

`ingest_line` stamps `_hook_paths[path]` and calls `_publish` unconditionally; it never consults
`_fs_paths`. `ingest_fs_change` consults `_hook_paths` (forward suppression) and `_fs_paths` (its
own coalesce tail). So `_fs_paths` is written and read by one door while `_hook_paths` is written
by one and read by the other: there is exactly **one** suppression arrow, and it points the way
the race does not go.

The structural statement: the daemon treats two *observations of one change* as two *events*, and
reconciles them by dropping whichever arrives second. Reconciling after publication is the wrong
time, and dropping the more informative observation is the wrong choice of which to keep.

## Shapes rejected, with the argument

- **(a) Reverse suppression, hook event dropped, attribution left as the watcher had it.** Four
  lines, and wrong. `CLAUDE.md` states that "hook events themselves are attributed exactly"; this
  converts every hook-covered write into a time-based guess, so two subagents editing two files
  40 ms apart are both credited to whichever hook landed last. That deletes the exactness the hook
  source exists to provide, in the multi-agent case, which is the tool's entire premise. The
  first-action-of-a-session case is the visible symptom; the concurrent-agent misattribution is
  the invisible one, and worse for it.
- **(b) Reverse suppression plus retro-attribution of the already published event.** The correct
  *description* of the problem -- the hook is late-arriving authorship -- and the wrong
  implementation, because publication fans out to four sinks and one cannot be undone.
  `_recent` is replaceable and `eventLog.ts` and `attentionState.ts` are routable, but
  `SessionStats.observe` is **not invertible**: a reassignment must decrement a specific path
  counter and delete the key at zero (the dict's length *is* the distinct-file count), and once
  `MAX_TRACKED_PATHS` has bitten there is nothing to decrement, so the correction silently
  under-corrects. And a 1.2 s beam already drawn from the wrong figure cannot be un-drawn.
- **(c/d) Defer the watcher's publish -- adopted.** See below.

## The adopted shape

> A change the watcher sees is held for `FS_SETTLE_SECONDS`. A hook event for the same path
> within that window is not a second event -- it is the same change, better described, and it
> **supersedes** the pending one. A pending change nobody claims is published at the end of the
> window, attributed by `_active_agent()` evaluated **at flush time**.

Afterwards: `ingest_fs_change` knows completeness and a guess at authorship, and never publishes
on sight. `ingest_line` knows authorship exactly, and its normalization runs against a
`_known_paths` the watcher has not yet touched. `_publish`/`_observe` see exactly one event per
change, so `eventLog`, `SessionStats`, the attention latch and the replay buffer are all correct
with **no change to any of them** and **no change to the wire or the browser**.

**The `A`-then-`M` inversion is not fixed by a mechanism; it is fixed by the absence of the
pollution.** Under deferral the watcher never reaches `_known_paths` before the hook normalizes,
so `normalize_event` computes `A` for a genuine creation with no new rule at all. That is the
strongest sign this is the right shape.

Two objections answered. *Timers make the hub loop-aware*: no -- `EventHub` already injects its
clock, and injecting the scheduler beside it is the same idiom, making deferral **more** testable
(a test drains a list of pending callbacks by hand). *It adds a second place that decides "here is
an event"*: no -- `ingest_fs_change` still decides, it decides later; the flush is a private
method whose body calls `_publish`, which keeps one call site for the write path.

The browser needs nothing: `origin` is read behaviourally in exactly three files
(`eventLog.ts`, `attribution.ts`, `attentionState.ts`) and every one compares only against
`"seed"`. `hook` versus `watch` is invisible to it.

## Costs, stated

- **Latency.** A disk change no hook claims -- a human's editor save, a build step -- appears
  `FS_SETTLE_SECONDS` late. At 0.25 s that is invisible on an ambient visualiser; at 1 s it
  would read as lag.
- **Burst.** A `git checkout` touching 20 000 paths becomes 20 000 `call_later` heap pushes
  (~1 us each, ~20 ms spread across the burst) and a pending dict bounded by the distinct paths
  in the burst -- the same order as `_known_paths`, which already holds `DEFAULT_MAX_FILES`.
  **This is arithmetic, not a measurement.** The ceiling that would make it matter is roughly
  50 000 distinct paths in one burst, where the flush clump becomes a visible loop stall.
- **A window is a guess about a race.** Where the hook spawn exceeds `FS_SETTLE_SECONDS` the
  defect returns *silently*, with today's symptom. Ranked `noted` below.
- **Unchanged, and said so the next reader does not think otherwise:** watcher events nobody
  claims are still attributed by time, so two agents at once can still credit one to the other;
  and a Bash-driven `cp` of 40 files is still 40 `writes`.

## The regression the deferral introduces

A pending `M` for `src/a.py`, then a hook `D` for `src` (`rm -rf src/`): the hook publishes
immediately and `_expand` prunes the subtree, then 250 ms later the pending `M` flushes and the
deleted file reappears as a modification. So the supersede rule is **path, plus the subtree when
the superseding event is a deletion** -- step 6, which must land with the deferral.

## The constant

`FS_SETTLE_SECONDS = 0.25`, a module constant in `daemon/server.py` beside
`DEDUPE_WINDOW_SECONDS`. **Not** a `Settings` field: it is a correctness parameter tied to hook
spawn latency, not a preference, and routing it through `cli.py` would move
`tests/test_cli_settings.py`, `tests/test_run_settings.py` and `start.sh` for nothing.
`tests/test_daemon_environment_boundary.py` is untouched.

Its docstring says why the number: the hook is a measured 37-56 ms process spawn plus a
Unix-socket connect, and the race was probed at 0 / 40 / 150 ms gaps; 0.25 s is roughly four
times the measured spawn, which is the headroom a loaded machine needs. **The values are not
pinned; the relation is:** `FS_SETTLE_SECONDS < COALESCE_WINDOW_SECONDS < DEDUPE_WINDOW_SECONDS`,
or the post-flush tail rule and the forward suppression stop meaning what their docstrings say.
Same idiom as `STALE_WAIT_SECONDS > LONGEST_HUMAN_ABSENCE_SECONDS`, and it makes retuning free.

## Steps

New test file throughout: `tests/test_hub_fs_settle.py`. Production file throughout:
`daemon/server.py`, plus `rhizome_graph/normalize.py` at step 7.

Baseline over the eight files expected to move (`test_hub_seed_and_attribution.py`,
`test_hub_reset.py`, `test_hub_stats.py`, `test_hub_read_events.py`, `test_hub_attention.py`,
`test_hub_agent_labels.py`, `test_hub_agent_state.py`, `test_session_stats.py`): **178 passed**.
Full suite baseline: **1745 passed, 20 skipped**.

### Step 1 -- a watcher change is held, not published on sight
`EventHub.__init__` gains `settle_window: float = FS_SETTLE_SECONDS` and
`schedule: Scheduler | None = None`, where `Scheduler` is `call_later`'s signature --
`(delay, callback) -> handle with .cancel()`. A private `_pending: dict[str, _PendingChange]`
holds `(op, handle)`. `_defer(path, op)` schedules; `_flush(path)` pops and runs today's publish
body. **`schedule=None` keeps today's immediate publish**, which is what leaves all existing
`ingest_fs_change` call sites green -- an honest default rather than a silent fork: a hub given
no way to wake itself up cannot defer, and step 12 is the jaw that stops the daemon ever being
one.
RED: with a fake collecting scheduler, `ingest_fs_change("src/new.py", "M")` puts nothing on the
wire; running the single collected callback then publishes exactly the frame today's code
publishes immediately.
Owner: RED `developer-tester` (`tests/test_hub_fs_settle.py`) -> GREEN `developer-backend`.

### Step 2 -- the relation between the three windows is asserted
RED: `FS_SETTLE_SECONDS < COALESCE_WINDOW_SECONDS < DEDUPE_WINDOW_SECONDS`, with an
anti-degeneracy jaw putting `FS_SETTLE_SECONDS` strictly above the measured hook spawn.
Owner: RED `developer-tester` -> GREEN `developer-backend` (docstrings only if step 1 chose 0.25).

### Step 3 -- the hook supersedes the pending change, and the agent is right
Immediately before `self._hook_paths[event.path] = self._clock()`, call
`self._cancel_pending(event.path)`. **After** the `R` branch returns, never before it.
RED: fake scheduler; `ingest_fs_change("docs/readme.md", "M")`, then the hook for the same path.
Assert exactly one frame, `agent == SESSION`, and that draining the scheduler adds nothing.
Owner: RED `developer-tester` -> GREEN `developer-backend`.

### Step 4 -- a read never cancels a pending change (jaw)
Pins step 3's placement. Read-then-Edit is the commonest thing an agent does; cancelling at the
top of `ingest_line` would have a read of a path with a pending write swallow the write -- a
change that happened on disk and was never drawn, with no watcher correction coming.
Test: `ingest_fs_change("src/app.py", "M")`, then a `Read` of it, then drain. The `R` arrived as a
transient (absent from `replay_messages()`) and the `M` still arrives at flush.
This is a jaw, not a RED: it passes the moment step 3's GREEN is placed correctly. Say so in its
docstring, in the register of `tests/test_bottom_row_width_bounds.py`.
Owner: `developer-tester` only.

### Step 5 -- op transitions inside the window
An `M` arriving for a pending `A` folds into it (no reschedule, no second frame). Any other
transition flushes the pending entry immediately, in order, then handles the new one -- so
create-then-delete inside the window publishes `A` then `D` and never deletes a node the browser
was never handed.
RED: two tests, one failure reason each -- `A` then `M` drains to `["A"]`; `A` then `D` drains to
`["A", "D"]` in that order.
Owner: RED `developer-tester` -> GREEN `developer-backend`.

### Step 6 -- a hook deletion cancels the pending subtree AND expands over it
`_cancel_pending(path, subtree=event.type == "D")`, dropping `path` and everything under
`path.rstrip("/") + "/"`. This regression is introduced by the deferral, so it lands with it.
RED: pending `M` for `src/a.py`; `seed_paths(["src/a.py"])`; a Bash `rm -rf src` hook; drain.
No `M` for `src/a.py` arrives after the `D`s.
Owner: RED `developer-tester` -> GREEN `developer-backend`.

**Correction, written after the step shipped incomplete and the browser caught it.** As stated
above this step is only half a rule, and shipping that half put orphaned nodes on the graph
permanently. Measured on a live daemon: an agent's `rm -rf gone` published `D gone` alone, and
`gone/a.txt` / `gone/b.txt` stayed in `_known_paths` and were replayed to every client that
connected afterwards -- `CLAUDE.md`'s "a wrong node stays on screen forever", which is the failure
this project ranks worst. Cancelling the watcher's held per-child deletions is only safe **because
the hook's own `D` carries them**, so the step is *cancel the subtree **and** expand the hook's
deletion through `_expand`, children first*. Before the deferral the watcher's expanded `D`s did
that work and the hook's `D` was the redundant duplicate; the deferral cancels the watcher's half
and must therefore take over its job.

Two lessons, both worth more than the fix:

- **An absence assertion needs the matching presence beside it.** The RED above pins that no `M`
  arrives after the `D`s -- true, and it passes over a hub that has stopped saying anything about
  the path at all, which *is* the defect. It is now `== ["D"]`, and the new
  `test_an_agents_directory_deletion_still_prunes_the_subtree` asserts the node set a later client
  would draw is empty.
- **The unit suite was green and the product was broken.** Only the browser measurement found
  this, which is the argument for step 14 and for the re-measurement list below.

The GREEN also stamps `_hook_paths` for **every** path the expansion published, not only
`event.path`: after this the hook really has reported the children, so the watcher's echo of them
must be suppressed like any other, or the hook-first ordering would publish each child twice --
this same defect, one level down. No test binds that either way.

### Step 7 -- `retype` in `normalize.py`
`retype(event, op_type) -> Event`, a `dataclasses.replace` of type and colour **together**,
returning the event unchanged for an unknown type. Doing it inline in `daemon/server.py` would
put a second spelling of the type-to-colour table in an untestable place, and the frame would
carry an `A` with the amber `FFAA00`.
RED, in `tests/test_normalize.py`: `retype(<an M event>, "A")` carries `type == "A"` and
`color == "33FF33"`, everything else identical.
Owner: RED `developer-tester` -> GREEN `developer-backend`.

### Step 8 -- the watcher's creation evidence survives the supersede
An `Edit`/`MultiEdit` hook normalizes to `M` regardless of `_known_paths`. Cancel a pending
watcher `A` with it and the creation of that node is never announced. `_cancel_pending` returns
the op it cancelled; when that op was `A` and the hook's event is `M`, the published event is
`retype(event, "A")`. This is reconciliation, not a second A/M authority: `known_paths` still
decides, and the pending `A` is the kernel's evidence of prior non-existence that the hook's
normalization ran too early to see. Agent, label and `ts` all come from the hook.
RED: `ingest_fs_change("docs/fresh.md", "A")`, then an `Edit` hook for it, drain. One frame,
`type == "A"`, `color == "33FF33"`, and the agent.
Owner: RED `developer-tester` -> GREEN `developer-backend`.

### Step 9 -- `reset` cancels the pending buffer
A callback flushing after a `ctrl+L` publishes a path of the abandoned project into a hub whose
`_known_paths` was just emptied -- so it draws as an **add**, in a project where it does not
exist, and it is clickable, which `resolve_inside` then refuses. Cancel every handle, clear the
dict, and add a paragraph to `reset`'s docstring in the register of the ones already there.
RED, in `tests/test_hub_reset.py`: pending fs change, `hub.reset(other_root)`, drain, nothing
about the old project reached the wire.
**Pinned assertion moves:** that file's module docstring enumerates the cleared state and gains a
bullet. Tester's edit.
Owner: RED `developer-tester` -> GREEN `developer-backend`.

### Step 10 -- attribution is resolved at flush, not at arrival
The glob `cp` case: the hook fires, `_parse_bash` stays silent so nothing is published, but
`_last_hook` is stamped -- 40 ms *after* the copies hit disk. Reading the actor at arrival leaves
them anonymous; reading it at flush credits them. A strict improvement, and free. `_flush` calls
`self._active_agent()`; `_defer` stores only `(op, handle)`.
RED: `ingest_fs_change("docs/copied.md", "A")`, then a Bash hook that yields no event, then
drain. The published frame carries the agent.
Owner: RED `developer-tester` -> GREEN `developer-backend`.

### Step 11 -- the hook-first path is unchanged (jaw)
`ingest_line` then `ingest_fs_change` for the same path still yields exactly one frame, and
`EventHub(dedupe_window=0.0)` still yields two -- `tests/test_hub_seed_and_attribution.py:127`
and `:137`. Add a `_pending`-is-empty assertion so the forward path is proven not to leave a
scheduled callback behind.
Owner: `developer-tester` only.

### Step 12 -- the daemon hands its hub a real scheduler, and the suite pins it
`Session` passes a **lazy** scheduler --
`lambda delay, cb: asyncio.get_running_loop().call_later(delay, cb)` -- so construction stays
loop-free (many tests build a `Session` at module scope) and only `ingest_fs_change` needs the
loop, which it always has via `call_soon_threadsafe`.
RED: inside a running loop, build a `Session`, `session.hub.ingest_fs_change(...)`, assert
nothing is published; advance the loop past `FS_SETTLE_SECONDS`, assert it is.
**Pinned assertions move, and this is the step where they do.** Re-grep
`session.hub.ingest_fs_change` across `tests/` before starting; the sites found were
`tests/test_hub_attention.py` (~658-661, `WATCHED` and `key.pem` inside `async def scenario()`),
`tests/test_hub_stats.py` (~613-660, the `Session` fixture and the two tests using it), and an
audit of `tests/test_root_switch.py` and `tests/test_ws_commands.py`. Direct
`EventHub(project_root=ROOT)` construction is unaffected -- which is the whole reason step 1
chose that default. End-to-end tests that wait for a frame now wait ~250 ms longer;
`tests/daemon_probe.py` allows 20 s, so that is headroom, but any test asserting "N frames
arrived" without a `wait_for` is a flake candidate.
Owner: RED `developer-tester` -> GREEN `developer-backend`.

### Step 13 -- the acceptance guard: the measured session (jaw)
In `tests/test_hub_stats.py`: three disk-first edits by one agent, each followed by its hook,
yields `writes: 3` for that agent and **no `agent: ""` row at all**. Expected to pass once 1-12
land; it is what stops the defect returning, and where the number 15 from the measured session
belongs as a docstring.
Owner: `developer-tester` only.

### Step 14 -- the race, against wall-clock time
Every step above uses a fake scheduler, so nothing has proven the window is long enough. The
defect is a race and its constant is a wall-clock fact. New `tests/test_fs_settle_integration.py`
in the register of `tests/daemon_probe.py`, marked slow: a live daemon over a `tmp_path` root, a
client that drains the replay first, a real disk write, and a real payload through the real
`hooks/emit_event.py` at a 40 ms and a 150 ms gap. One event, correctly attributed, correct type,
in both. The only step that would catch `FS_SETTLE_SECONDS` set too low.
Owner: RED `developer-tester` -> GREEN `developer-backend` (likely no code; if it fails the
constant moves, and step 2's relation jaw keeps the move honest).

## Noted, not built

- **The window is a fixed guess.** Where the hook spawn exceeds 0.25 s the defect returns
  silently, with today's symptom. The daemon could measure the gap between a pending change and
  the hook that superseded it and report it, but that is a diagnostic feature, not a step.
  **Trigger:** the first time an unattributed writer row reappears in the F8 panel on a machine
  with hooks installed.
- **Watcher events nobody claims are still attributed by time**, so two agents working at once
  can still credit one to the other. Unchanged; stated so the next reader does not think this
  plan fixed it.
- **`writes` still counts events, not edits, for Bash-driven changes.** A `cp` of 40 files is 40
  writes. Correct, and what the panel means.

## The CLAUDE.md re-wording this forces

1. "a Write flashes once across both channels **when the hook wins the race, ...**" -- the whole
   parenthetical is **deleted**; it becomes unconditional again, and step 14 re-earns it.
2. "`cp *.md docs/` reports each file actually copied, credited to the agent" -- still true, and
   for a *better* reason after step 10. Worth one clause saying so.
3. "a non-agent edit appears with no actor" -- still true, but one settle window later. Name the
   latency, or the next reader measuring it will think something is wrong.
4. "a Read raises reads and not writes, while the same path is still an A when written
   afterwards" -- stays true, and step 4 is what keeps it true.

Three whole passages are rewritten rather than adjusted: **"One edit, two events"** moves into
the past tense (it is the record of the measurement, so it is not deleted); **"This is not a
regression, and the counters are faithful"** loses "the panel's `writes` is a count of events,
not of edits, and the first row of a session may be a phantom"; and the **"Two capture sources,
both required"** gotcha gains the reverse half of its dedupe sentence. Mechanically, the backend
test count moves and the session-stats "not yet verified" paragraph loses its phantom-row caveat.

## What to re-measure in a browser afterwards

Nothing on the wire changes, so this is about feel, and three of the five are new questions this
fix creates.

1. **Does a 250 ms hold read as lag?** An external editor's save against a hook-covered edit:
   agent edits should feel unchanged, human edits a quarter-second slower. If they feel different
   from each other, the window is too long.
2. **Does one write now flash once?** The defect's visible half, never watched. A new file must
   flash **green** and stay green, never green-then-amber.
3. **A burst** -- `git checkout` of a branch touching a few hundred files. Watch for the flush
   clump. If the graph hitches, the pending buffer needs a spread flush, and that is a new plan.
4. **`rm -rf` of a directory an agent was mid-edit in** -- step 6 is a rule nobody has watched.
   Two behaviours, not one: the held edit must not resurrect, **and** the subtree must actually
   leave the graph. Both were measured on 2026-08-30 and both hold.
5. **F8 after a real multi-agent session** -- the `unattributed` row gone or holding only
   genuinely non-agent work, and per-agent `writes` matching the edits you can count.
