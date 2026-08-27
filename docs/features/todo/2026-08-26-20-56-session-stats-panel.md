# Plan: Session statistics panel -- what did this session actually do?

- **Status:** todo
- **Created:** 2026-08-26 20:56
- **Implemented:** -- (date, and the branch it landed on)
- **PR/commit:** --
- **Consultations (mandatory):**
  - `software-architect` (2026-08-26) -- this document is its assessment and staged plan, and
    it names the owner of every RED/GREEN step below.
  - `security-auditor` (2026-08-26) -- consulted. This feature adds no command kind and turns
    no string from the network into anything (decision 4); the audit calls it "nearly a
    non-event if kept in the browser" and disagrees with decision 2 about where the counters
    belong -- see M6. Its findings are appended at the end of this document; the full report is
    `docs/security/2026-08-26-audit-five-planned-features.md`.
  - `developer-tester` (2026-08-27) -- consulted on the step table below, and it wrote **no**
    test code: every row carries a verdict of `OK`, `NEEDS SHARPENING` or `NOT WRITABLE AS
    SPECIFIED`, appended at the end of this document. The full review is
    `docs/features/2026-08-26-tester-review-five-plans.md`. No implementation step here may
    start before the RED test it names exists.

Written 2026-08-26 against `fd0f34e`, with the frontend suite green at the numbers in section 0
and the backend suite **unrunnable on this host** (see section 0). Every line number below is
from that commit.

Scope: a panel listing, per agent, what it did this session -- distinct files touched, reads
against writes, the file it returned to most, how many directories it worked in, and the first
and last moment it was seen. Everything else on the page keeps working unchanged.

Per `CLAUDE.md` rule 3, **nothing in this document is committed**. It is a plan; the tree is
untouched by it and stays that way until the user asks otherwise.

---

## 0. Baseline, measured on this host

| Measurement | Command | Result |
|---|---|---|
| Frontend suite before any change | `cd web && node node_modules/vitest/vitest.mjs run` | **1403 passed (1403)**, 51 files, **19.16 s** |
| Backend suite before any change | `.venv/bin/pytest -q` | **could not be run.** `pytest` is installed in neither `/usr/bin/python3` nor `.venv`, and installing it is forbidden to this role. Static count instead: **1343 `def test_` across 79 files in `tests/`**. `CLAUDE.md` claims 1498 passing; that number is **quoted, not verified here**. |
| `CLAUDE.md`'s recorded frontend count | -- | says **1287/1287**; the tree says 1403. Stale by 116 tests. Noted, not a finding of this plan. |
| Replay buffer | `daemon/server.py:105` | `REPLAY_BUFFER_SIZE = 200` |
| Attribution window | `daemon/server.py:110` | `ATTRIBUTION_WINDOW_SECONDS = 5.0` |
| Status poll interval | `daemon/server.py:137` | 3 s, or `RHIZOME_STATUS_INTERVAL`; <= 0 disables it and creates no task |
| Recent-changes list cap | `web/src/eventLog.ts:24` | `DEFAULT_MAX_ENTRIES = 200` |
| `scan_tree`, this checkout / `~/projects` / `$HOME` | `rhizome_graph.tree.scan_tree` | **247 / 829 / 12 524 files**, **10.0 / 64.5 / 623.7 ms** |
| Browser-side accumulation of 20 000 events across 6 agents (distinct-path Set, per-path Map, directory Set, two counters) | Node 18, `--expose-gc`, warm | **43.3 ms total, 2.17 us per event, 2.4 MiB heap** |
| Shortcut legend today | `web/index.html:26-27` | **162 characters**, ~988 px at `bottomRow.MAX_GLYPH_PX` |
| Same legend with `" - F8: session stats"` appended | arithmetic | **182 characters**, ~1110 px |
| Bottom-row constants | `web/src/bottomRow.ts:26, 37, 46` | `CONTEXT_WIDTH_FRACTION = 0.34`, `MIN_SIDE_WIDTH_PX = 231`, `MAX_GLYPH_PX = 6.1` |
| Entry chunk, built | `ls -la web/dist/assets/index-*.js` | **551 195 bytes** |
| Node | `node --version` | v18.19.1 |

Four of these decide the design.

- **`REPLAY_BUFFER_SIZE` is 200, and it is what makes browser-side counting wrong.** A client that
  reconnects is handed `reset`, `meta`, `status`, the whole seed and the **last 200** events
  (`server.py:207-221`). Everything before that is gone. A browser-side counter therefore
  under-reports silently after any reconnect, and two tabs opened at different moments report
  different numbers for the same session. Decision 2 turns on this.
- **2.17 us per event and 2.4 MiB of heap for 20 000 events** is the cost of the accumulation
  itself, wherever it runs. It is cheap; what is not cheap is *publishing* it, which is decision 5.
- **The legend is already 162 characters and `bottomRow.ts`'s three constants were measured in a
  browser against exactly that string.** `CONTEXT_WIDTH_FRACTION`'s comment (`bottomRow.ts:20-25`)
  says 0.34 keeps the legend at two lines at 1280 and 1600 where 0.40 wraps it to three, and that
  "the legend is the widest thing in the row, so it is what pays for a greedy centre". Adding 20
  characters is a 12% growth in the thing that constant was tuned against. Decision 10.
- **`scan_tree` on `$HOME` is 12 524 files.** That is the seed size, and every one of those is an
  event on the wire. Decision 3 is that none of them is work.

---

## 1. Assessment: what the page and the daemon already know about who did what

### The seams, and which are load-bearing

**`EventHub` already owns everything a counter would need, and already fans out through exactly
three sites.** `seed_paths` (`server.py:312-326`) encodes and broadcasts its own; `_publish`
(`:403-407`) is the write path for both hook and watcher; `_broadcast_transient` (`:383-401`) is
the read path. Every activity event on the wire leaves through one of those three, and **the seed
leaves through its own** -- so "the boot snapshot is not work" is a consequence of the existing
shape rather than a filter anyone has to write. **Load-bearing, and it is the same seam
`docs/features/todo/2026-08-26-20-56-attention-rules.md` needs**; see decision 6.

**`_meta` and `_status` are the pattern for a republished frame** (`server.py:193-194`, `:235-269`).
Each is one replaceable slot holding the encoded message; each deduplicates on the **encoded
string, not the dict**, "because that is exactly what a client would receive" (`:262-263`); each is
placed by `replay_messages()` in a documented order -- `reset`, then `meta`, then `status`, then
the seed, then `_recent` (`:207-221`) -- and the docstring says why each position is where it is.
**Load-bearing, and decision 5 copies it exactly.**

**`poll_status` is the pattern for a task of its own** (`server.py:740-760`). Its interval is a
parameter, `<= 0` disables it and creates no task at all, a round is skipped while one is in
flight, and `publish_status` (`:652-684`) re-reads `self.root` after its await and **drops** an
answer about a root the daemon has left. **Load-bearing, and decision 5 borrows the shape while
decision 7 deliberately does not borrow the drop.**

**`eventLog.ts` is the precedent for a pure model with a dumb painter** (`eventLog.ts:1-19`,
`eventHud.ts`). It drops seeds at `:82`, drops reads at `:90`, folds against the top entry at
`:92-98`, caps at `:107`, and its `reset()` docstring (`:50-59`) spells out why a root switch must
empty it. `splitPath` (`:129-133`) is exported from the same module and reused by the status
panel. **Load-bearing, and three of its four rules are reused here with one deliberately
inverted** (decision 3).

**`attribution.ts` is the precedent for "seed never counts"** (`attribution.ts:14-16`): "The
connect-time snapshot is backdrop, not activity; an agent id riding on a seed frame proves nothing
about capture." Same sentence, same reason, applied to counters. **Load-bearing.**

**`agent` is identity and `label` is text, and the renderer keys the actor on `agent`.**
`CLAUDE.md` states it; `renderer.ts:1240` is `hashColor("actor:" + agent)`. **Load-bearing, and
decision 8 is nothing but this rule applied to rows.**

**`main.ts`'s keydown chain is ordered by contested keys, and F7 sits above the argument because it
contests nothing** (`main.ts:362-378`, `sizeKeys.ts:1-23`). `interpretRootKey` claims `Tab` **only
while the root bar is open** (`rootKeys.ts:40`). **Load-bearing, and it is what makes decision 9
refuse `Tab`.**

**`#bottom-bar` is one grid with two measured side reserves, and `CLAUDE.md` and
`web/index.html:79-85` both say a fourth box may not join it.** The size legend is the precedent
for what to do instead: an element of its own, top-right, `pointer-events: none`, accepting that
the docked file panel paints over it (`style.css:300-316`). **Load-bearing, and decision 10 copies
it into the one free corner.**

### The five things that are actually in the way

1. **Nobody counts anything.** `EventHub` holds `_known_paths`, `_seed`, `_recent`, `_meta`,
   `_status`, `_reset`, `_last_hook`, `_hook_paths`, `_fs_paths` -- a set, two buffers, three
   slots and three dedupe maps. Not one of them is per agent, and `_last_hook` is a single
   `(agent, label, timestamp)` triple that is *overwritten*, not accumulated (`:201`, `:426-437`).
2. **The browser's view of history is bounded at 200 events plus the seed** (`server.py:105`,
   `:207-221`). It is not a truncation the browser can detect: nothing in the replay says "there
   were more".
3. **`Tab` already means something, conditionally.** `rootKeys.ts:40` claims it while the root bar
   is open, and the browser claims it the rest of the time for focus traversal -- across two search
   inputs, the root input and the file viewer's close button (`index.html:40, 56, 68, 95`).
4. **There is no free row in the bottom bar**, and the one constant that shares it out was measured
   against today's legend (`bottomRow.ts:26`).
5. **"Time active" has no definition.** `last - first` calls an agent that worked ten seconds and
   idled an hour "active for an hour". Any better answer needs a gap threshold, which is a constant
   with no measurement behind it. Decision 11.

### Two defects this feature exposes rather than creates

- **The `actor:` colour prefix is a literal inside `renderer.ts`** (`:1240`), while `hashColor` is
  pure and exported (`colors.ts:69`). This panel wants an agent's colour for its row swatch, and
  so do the alarm rows in `2026-08-26-20-56-attention-rules.md` and the per-agent timbre in
  `2026-08-26-20-56-ambient-sound.md`. Three respellings of one prefix. **R8, next**, and shared:
  whichever plan lands first does it.
- **`CLAUDE.md`'s Status section is stale on the frontend count** -- 1287 against a measured 1403.
  Not this feature's problem, recorded so the next reader does not treat the document as a
  measurement.

---

## 2. Decisions before step 1

Twelve decisions. Numbers 2, 5, 9 and 11 are the ones I would most want argued with, and 9 and 11
are places where I did **not** ratify the brief.

**1. This is a summary, not a live channel.** It answers "what happened this session", a question
whose answer is interesting at the end of a task and boring in the middle. Everything below --
the poll rather than the push, the tolerance for a few seconds of staleness, the refusal to give
it a live counter in the corner -- follows from that sentence, and if it is the wrong sentence the
rest of the plan is wrong with it.

**2. Accumulate DAEMON-side.** The browser cannot count what it was never shown. A client that
reconnects sees `reset`, `meta`, `status`, the seed and the last **200** events
(`server.py:207-221`); everything before is gone, and nothing in the replay marks the loss. So a
browser-side counter is not merely approximate, it is **silently** approximate, and two tabs
opened five minutes apart disagree about the same session with no way for either to know. A panel
whose numbers depend on when you opened the tab is not a summary. *The price of daemon-side:* one
more piece of mutable state in `EventHub`, a new frame on the wire, and a memory bound that has to
be real (decision 12). *The price rejected:* a browser-side counter is free, needs no protocol
change, and would ship in a day -- and would be wrong in exactly the situation a long session
produces, which is the only situation this panel is for.

**3. Seed events are not work, and the exemption is structural.** `seed_paths` never touches
`_publish` or `_broadcast_transient` (`server.py:312-326`), so a counter placed in those two is
never offered a seed event at all. Same rule `eventLog.ts:82` and `attribution.ts:14-16` state in
prose; here it costs nothing to make it a property of the wiring. **12 524 phantom "files touched"
on this host's home directory is what it buys.**

**4. Reads and writes are counted APART, and neither is dropped.** `eventLog.ts:90` drops `R`
outright, because that list is a list of *changes* and an agent reads ten times more than it
writes. This panel inverts that: "it read 340 files and wrote 12" is the single most informative
line it can produce, and dropping the reads would throw it away. **The inversion is deliberate and
must be in the module docstring**, or the next reader "fixes" it into `eventLog`'s rule. `D` counts
as a write; `A` and `M` count as writes and are **not** separated -- a third counter for "created"
against "modified" is a column nobody reads, and `A` versus `M` is already the graph's own colour.

**5. Published by a POLL, in a slot, deduped -- not on every event.** The counters update per
event; the *frame* does not. `set_status`'s dedupe (`server.py:252-269`) works because a working
tree rarely changes between polls; a stats frame changes on **every single event**, so dedupe
would never fire and a per-event publish would be a fresh `json.dumps` and a broadcast to every
client for every keystroke of an agent's work. So: a task of its own, modelled on `poll_status`
(`:740-760`), with its own interval constant, `<= 0` disabling it and creating no task. Proposed
interval **5 s**, slower than status's 3 s because this is a summary (decision 1) and because
nothing in it is clickable, so staleness costs nothing. Deduped in a replaceable slot `_stats`,
on the encoded string, exactly as `_status` is. *The price:* the panel is up to 5 s behind. Say so
in the panel, or do not -- but decide it here rather than discovering it as a bug report.
*What is deliberately not done:* publishing only while a client has the panel open. The daemon
does not know that, and telling it would need a sixth command kind, which decision 4 of
`2026-08-26-20-56-attention-rules.md` argues against on a stronger ground and this one does not
need at all.

**6. The per-event hook is ONE call site, shared.** `_publish` and `_broadcast_transient` both need
to offer the event to the counters, and they must do it through a single private `_observe(event)`
rather than each calling the accumulator. `2026-08-26-20-56-attention-rules.md` needs the same seam
for its verdict. **If both features are built, `_observe` is written once and both hang off it;
whichever lands first creates it and the second must not add a parallel hook.** Two hook points for
one "here is an event" moment is how a later change lands in one of them.

**7. A late answer is not a problem here, because there is no answer.** `publish_status` re-reads
`self.root` after its await and **drops** a frame about an abandoned root (`server.py:652-684`), and
`handle_command`'s `search` and `sizes` branches deliberately do the opposite -- they answer anyway,
empty and with a reason, because "a dropped reply leaves the browser's `pending` flag set forever"
(`server.py:779-789`). This feature is neither: nothing awaits, nothing is requested, and the poll
holds no in-flight state. **What it must do instead is reset the counters on a root switch**
(decision 8's other half), and that is a synchronous call inside `EventHub.reset` (`:271-310`), in
the same list as `_known_paths.clear()` and `_last_hook = None`.

**8. The key is `agent`; the text is `label`; an empty agent gets a row.** Two subagents of the same
type are two rows with two swatches, because `agent` is identity (`CLAUDE.md`). `CLAUDE.md`'s other
rule -- "An event with `agent: ""` must never create an **actor**" -- is about a figure and a beam
on the graph, and a stats row is neither: an unattributed change is real work by nobody on camera,
and hiding it would make the totals not add up. So the empty agent gets **one** row, labelled as
unattributed, sorted **last**, and carrying **no colour swatch** -- the swatch is the actor's
identity and there is no actor. Getting this distinction wrong in either direction is the most
likely misreading of `CLAUDE.md` this feature invites, so it is a test (R5 step 5.6), not a comment.

**9. The binding is F8, NOT Tab.** The brief proposes `Tab`; I am refusing it, with three costs.
(i) `Tab` is focus traversal, and the page has four focusable things -- two search inputs, the root
input, the viewer's close button (`index.html:40, 56, 68, 95`). A binding that `preventDefault`s
`Tab` takes keyboard navigation off the page, and vitest here is `environment: "node"`
(`web/vitest.config.ts`) with no jsdom, so **no test on this host could catch it**. (ii) `Tab` is
already claimed conditionally by `interpretRootKey` (`rootKeys.ts:40`), so a stats binding would
have to sit *below* the root bar in the chain and be conditional on the root bar's state -- a
binding whose meaning depends on another box's state is exactly what `sizeKeys.ts:5-11` earns its
first position by *not* being. (iii) To be unconditional it would have to consult
`document.activeElement`, putting a raw DOM read into the composition root and a `typing` argument
into a binding that is supposed to be a table of keys. **F8 costs none of that**: unmodified,
unclaimed by the browser on a page, contested by nothing, and `interpretSizeKey`'s exact shape
(`sizeKeys.ts:39-45`) declining every modified and every repeating press. It sits beside F7 at the
top of the chain, for `sizeKeys.ts`'s own stated reason: "the chain below is ordered by CONTESTED
keys, and a binding that contests nothing takes no part in that argument". *The price:* F8 is less
discoverable than Tab, which is what decision 10's legend entry is for; and F-keys are a finite
row that F7 has already started spending.

**10. Escape does NOT close it, and the panel is not a modal.** Escape is contested three ways
already -- the file viewer claims it first (`main.ts:384`), the root bar next (`:392`), then either
search bar. A fourth claimant would have to be placed in that argument, and the placement would be
wrong in some state. The panel is a corner overlay, not a cover: it does not read as a page that
has hung, so it does not need the escape hatch a modal needs (`CLAUDE.md`, on the viewer's close
button). A second F8 closes it. *The price:* someone who presses Escape closes the file viewer or a
search bar instead. Confusing once, never destructive.

**11. Report FIRST and LAST; refuse "time active".** `last - first` is a lie for any agent that
idled, and the honest version needs a gap threshold -- "activity separated by more than N seconds
is two sessions" -- which is a constant with nothing behind it. `ATTRIBUTION_WINDOW_SECONDS = 5.0`
(`server.py:110`) is the only interval in this codebase that resembles it, and it means something
else entirely (how long a hook's authorship survives for the watcher). Borrowing it would be a
number chosen because it existed. So the panel prints the two timestamps and the elapsed span
between them, **labelled as a span and not as activity**, and R9 records the trigger for the
sessionization. *The price:* the reader does the arithmetic, and the span over-reports for an idle
agent. Stated on screen, not hidden.

**12. Every counter is capped, and "most-visited" degrades rather than lying.** Distinct paths,
distinct directories and the per-path visit counts are all unbounded in a long session, and the
per-path Map is the expensive one -- 2.4 MiB for 20 000 paths across six agents, measured, and that
is the *browser's* representation; the daemon's dict of the same strings is comparable. So:
`MAX_AGENTS` (32), and per agent `MAX_TRACKED_PATHS` (2 000). **The rule when the per-path cap is
reached is: stop adding new keys, keep incrementing existing ones**, and set `truncated`. Under it
the most-visited answer is exact whenever the winner appeared among the first 2 000 distinct paths
-- which for a file an agent returns to is overwhelmingly likely and **not** guaranteed. That is a
stated degradation, the same shape as the content search's "the walk clamps to the last range
actually found" (`CLAUDE.md`). *The alternative rejected:* an LRU eviction, which can evict the
winner and would make the answer wrong without saying so.

---

## 3. The plan

Ranked, ordered, every step one RED test plus one GREEN implementation, both suites green between
any two steps. R1-R3 are backend and land before the front end has anything to show. R6 is a
frontend step that depends on nothing and can land at any point.

New test files throughout, so no existing assertion moves: `tests/test_session_stats.py`,
`tests/test_hub_stats.py`, `web/tests/statsProtocol.test.ts`, `web/tests/statsPanel.test.ts`,
`web/tests/statsKeys.test.ts`.

---

### R1 -- Nothing counts anything. **Rank: now, and it can land first**

**What is missing.** `EventHub` (`server.py:151-457`) holds no per-agent state at all;
`_last_hook` is a single overwritten triple (`:201`, `:426-437`).

**Where.** New module `rhizome_graph/session_stats.py`. Not in `server.py`: that file is 1 285
lines and already owns the hub, the session, the command parser, the two gates, the HTTP handler
and `main`; a counter model in it is untestable without constructing a hub. Not in `normalize.py`:
pure by contract and on the hook's hot path. Not in `status.py`: nothing about a counter is the
porcelain format.

**Why it costs to put it elsewhere.** The predictable next change is a new counter -- bytes
written, tool kinds, a per-directory breakdown. In its own module that is one field and one test.
Inside `EventHub` it is a change to a class every hook event, every watcher event and every client
registration goes through.

**Target shape.**

```
MAX_AGENTS = 32
MAX_TRACKED_PATHS = 2000

@dataclass
class AgentStats:
    agent: str
    label: str
    writes: int
    reads: int
    paths: dict[str, int]      # visit counts, capped; len() IS the distinct count
    dirs: set[str]             # capped alongside
    first_ts: float
    last_ts: float
    truncated: bool

class SessionStats:
    def observe(self, event: Event) -> None: ...
    def reset(self) -> None: ...
    def frame(self) -> dict: ...      # pure JSON types only
```

Six properties hold it up, and each is a test.

- **`observe` is never offered a seed event**, and the module does not filter for one. Decision 3:
  the exemption is the caller's wiring, and R2 step 2.4 is the test that pins it. Adding a filter
  here would be a second guard that hides a wiring mistake instead of failing on it.
- **Reads and writes are separate fields**, never summed into a "total" the frame carries -- a
  total invites a reader to compare it with the recent-changes list, which drops reads.
- **The per-path map is `dict[str, int]` and its length IS the distinct-path count.** Two counters
  that must agree is two counters that can drift; one structure answering both is the
  `sizes.MAX_FILES is tree.DEFAULT_MAX_FILES` reflex applied to a data structure.
- **The cap stops new keys and keeps incrementing old ones**, and sets `truncated`. Decision 12.
- **`frame()` emits only JSON types.** A `dataclass` or a `set` smuggled through whole raises
  inside `_send` (`server.py:831-833`), on the loop, long after the function returned -- the exact
  hazard `sizes_frame` and `completion_response` (`server.py:585-596`) each carry a comment about.
- **The frame is deterministic**, ordered by write count then by agent, so `set_status`-style
  dedupe on the encoded string actually fires when nothing changed.

**Worst case, in the units that matter.** 32 agents x 2 000 paths of ~40 bytes plus dict overhead
is a few megabytes, once, for the life of the daemon. Per event it is a dict lookup and two
increments; the browser-side equivalent measured 2.17 us and Python is slower but in the same
order -- **an estimate, not a measurement**, and the ceiling that would make it matter is a burst
above roughly 20 000 events per second, which nothing here produces.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-backend`) |
|---|---|---|
| 1.1 | `tests/test_session_stats.py`: two events from one agent on two paths give `writes: 2` and two distinct paths; a third event on the first path leaves the distinct count at 2 and the visit count at 2. | `SessionStats`, `observe`. |
| 1.2 | RED: an `R` increments `reads` and not `writes`; a `D` increments `writes`. `A` and `M` both increment `writes` and are not distinguished. | The branch. |
| 1.3 | RED: two events with the same `label` but different `agent` produce **two** entries; two with the same `agent` and different `label` produce one, carrying the latest label. | Keying on `agent`. |
| 1.4 | RED: an event with `agent: ""` produces an entry with an empty agent -- it is not dropped and it is not merged into another. | No special case. |
| 1.5 | RED: past `MAX_TRACKED_PATHS` a new path is not added, an existing path still increments, and `truncated` is true. | The cap. |
| 1.6 | RED: past `MAX_AGENTS` a new agent is refused and the existing ones are untouched. | The cap. |
| 1.7 | RED: `frame()` round-trips through `json.dumps` without a custom encoder, and the entry order is by write count then agent. | `frame`. |
| 1.8 | RED: `reset()` empties everything, and `frame()` afterwards is the frame of a fresh instance. | `reset`. |
| 1.9 | RED, over the parsed source: `session_stats.py` names no `open`, no `subprocess` and imports nothing from `daemon`. | Nothing; the contract. |

**Test to write first.** 1.3 -- property: *`agent` is identity and `label` is only text*. Input that
trips it today: the module does not exist, and once it does, keying on `label` is the natural
mistake -- it is the readable one, so it is the one an implementer reaches for.

**Owner.** `developer-tester` -> `developer-backend`.

---

### R2 -- The hub does not offer events to anything. **Rank: now**

**What is missing.** `_publish` (`server.py:403-407`) and `_broadcast_transient` (`:383-401`) each
encode and broadcast directly, with no seam between them.

**Where.** `EventHub`: one field, one private `_observe(event)` called from both, one line in
`reset` (`:271-310`).

**Target shape.** `_observe(event) -> str` does the counting and returns the encoded message, so
each of the two call sites is one line and neither can be changed without the other. This is the
same seam `docs/features/todo/2026-08-26-20-56-attention-rules.md` R3 needs; decision 6.

**Why it costs to do it twice.** Two hook points for one "here is an event" moment means the next
change -- "reads should not count", "deletions count double" -- lands in one of them, and the
symptom is a total that is right for hook events and wrong for watcher events, or right for writes
and wrong for reads. That is a bug nobody would find by reading either site.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-backend`) |
|---|---|---|
| 2.1 | `tests/test_hub_stats.py`: a hook event reaches the counters; the hub's stats show one write for that agent. | The field and `_observe`, called from `_publish`. |
| 2.2 | RED: a **read** reaches the counters too, and still does not enter `_known_paths` or `_recent`. | `_broadcast_transient` calls `_observe`. |
| 2.3 | RED: a **watcher** event reaches them with whatever agent `_active_agent` supplied, including the empty one. | Nothing extra. |
| 2.4 | RED: `seed_paths` over 500 paths leaves the counters **empty**. | Nothing; `seed_paths` must stay off `_observe`. The test is the guard on the "consistency" refactor. |
| 2.5 | RED: `EventHub.reset` empties the counters, in the same call that clears `_known_paths`. | One line in `reset`. |
| 2.6 | RED, over the parsed source of `server.py`: the counters are reached from exactly one call site. | `_observe`. |

**Test to write first.** 2.4 -- property: *the boot snapshot is not work*. Input that trips it
today: nothing counts, so the test does not construct; and once it does, the implementation most
likely to be written is one that hangs the counter off `broadcast`, which would count all 12 524
seed events on this host's home directory.

**Owner.** `developer-tester` -> `developer-backend`.

---

### R3 -- The counters never reach a browser. **Rank: now**

**What is missing.** There is no `stats` frame, no slot, no poll and no place in `replay_messages`.

**Where.** `EventHub`: `_stats` slot plus `set_stats(frame)`, modelled on `set_status`
(`:252-269`), and one insertion in `replay_messages` (`:207-221`). `Session`: `publish_stats` and
`poll_stats`, modelled on `publish_status` / `poll_status` (`:652-684`, `:740-760`). `cli.py`: the
interval, as a `Settings` field with an environment override, exactly as the status interval is.

**Target shape and the two orderings that matter.**

- **In `replay_messages`, `stats` goes AFTER `status` and BEFORE the seed.** `reset` first (an
  order to empty the canvas), `meta` next (the caption naming the project), `status` next
  ("painted first it would be a list of changes with no project attached to them" -- `:216-220`),
  then this, then the tree. The reason is the same sentence one step further: a per-agent summary
  before the caption is a table about a project the reader has not been told the name of.
- **The dedupe is on the encoded string**, `set_status`'s exact rule and for its stated reason.
  Here it fires often: an idle session republishes an identical frame every 5 s forever.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-backend`) |
|---|---|---|
| 3.1 | `tests/test_hub_stats.py`: `set_stats` broadcasts once; called again with an identical frame it broadcasts **nothing**. | `_stats`, `set_stats`. |
| 3.2 | RED: `replay_messages()` yields `reset`, `meta`, `status`, `stats`, seed, recent -- in that order, asserted as a sequence and not as a set. | The insertion. |
| 3.3 | RED: `EventHub.reset` clears `_stats`, so a client connecting after a switch is not replayed the old project's table. | One line in `reset`. |
| 3.4 | RED: `poll_stats` with an interval of `0` creates **no task** -- `poll_status`'s own rule. | The guard. |
| 3.5 | RED: a round is skipped while one is in flight. | The busy flag. |
| 3.6 | RED, `tests/test_cli_settings.py`-shaped: the interval is a `Settings` field with a flag, an environment override and a default; `tests/test_daemon_environment_boundary.py` still passes. | `cli.py`. |

**Test to write first.** 3.2 -- property: *a summary of a project arrives after the project is
named and before its tree*. Input that trips it today: `replay_messages` has four elements and no
fifth; the assertion on the exact sequence fails to even find a `stats` frame.

**Owner.** `developer-tester` -> `developer-backend`.

---

### R4 -- The browser cannot parse a frame it has never seen. **Rank: now**

**What is missing.** `protocol.ts` has nine parsers (`parseEvent`, `parseMeta`, `parseCompletion`,
`parseReset`, `parseRootError`, `parseFileView`, `parseSearchResult`, `parseSizes`, `parseStatus`)
and no tenth. `wsClient.handleMessage` (`wsClient.ts:203-250`) routes every answer frame **before**
`parseEvent`, "consumed with or without a sink", because "`parseEvent` ignores `kind`, so **only
the ordering** keeps such a frame out of the simulation".

**Where.** `protocol.ts`: `AgentStatsEntry`, `SessionStatsFrame`, `parseStats`. `wsClient.ts`: one
routing branch, placed with the others and **before** `parseEvent`.

**Target shape.** `parseSearchResult`'s degradation doctrine verbatim
(`protocol.ts:370-419`): one hard field whose absence costs the frame, every other field degraded,
junk array items dropped **one at a time** rather than costing the whole array, and never throws.
A row with a non-string `agent` is dropped; a row with a non-numeric `reads` degrades to `0`; the
frame survives either way.

**Why the routing position is load-bearing.** A `stats` frame routed as an event would grow a node
called `stats` in the graph -- `wsClient.ts:236-243` says exactly this about a status frame, and
adds the sharper half: "the poll repeats every couple of seconds, keeping it there forever."

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-frontend`) |
|---|---|---|
| 4.1 | `web/tests/statsProtocol.test.ts`: a well-formed frame parses with its rows in order. | `parseStats`. |
| 4.2 | RED: a frame with no `kind` or the wrong `kind` parses to `null`; a frame whose `agents` is not an array parses to `null`. | The hard fields. |
| 4.3 | RED: one junk row in an otherwise good array is dropped and the rest survive. | The per-item drop. |
| 4.4 | RED: a mistyped `reads` degrades to `0` and does not drop the row; a mistyped `label` degrades to `""`. | The degradation. |
| 4.5 | RED, in `web/tests/wsClient*.test.ts`'s existing shape: a `stats` frame is routed to `onStats2` (name it whatever it ends up being) and **never** reaches the event sink, with or without a handler. | The branch, before `parseEvent`. |

**Test to write first.** 4.5 -- property: *an answer frame never becomes a node*. Input that trips
it today: with no routing branch, the frame falls through to `parseEvent`, which rejects it only
because it lacks `ts`/`agent`/`path`/`color`/`type` -- so it happens to be safe **by accident**,
and the accident evaporates the first time the frame gains a `path`-like field. Write it first for
that reason.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R5 -- Nothing on the page models the panel. **Rank: now**

**What is missing.** No module decides row order, formatting, caps or visibility.

**Where.** New pure `web/src/statsPanel.ts`, beside `statusList.ts`, `eventLog.ts` and
`sizeMode.ts`, for the reason all three give: a painter is DOM-bound and therefore untested, "which
is how the one number that shares out the row escaped ever being checked"
(`bottomRow.ts:9-14`).

**Target shape.**

```
interface StatsRow {
  agent: string; label: string; swatch: number | null;
  writes: number; reads: number;
  files: number; dirs: number;
  topPath: string; topCount: number;
  firstTs: number; lastTs: number;
  truncated: boolean;
}
buildStatsPanel(frame: SessionStatsFrame | null, open: boolean): StatsPanel
```

Five properties hold it up.

- **`visible` derives from the row count AND the toggle**, never from a flag on the frame --
  `statusList.ts`'s rule (`CLAUDE.md`: "`visible` derives from the entry count, never from the
  `repo` flag -- a permanent empty strip would report nothing"). Closed, or open with nothing to
  show, is the same absence.
- **The unattributed row sorts LAST and carries `swatch: null`.** Decision 8, as a test.
- **`swatch` is `actorColor(agent)`** -- the function R8 extracts, imported and never respelled.
- **`topPath` is `""` when the agent touched nothing twice**, and the row says so rather than
  naming an arbitrary file with a count of 1.
- **The row cap is the panel's, not the frame's**, so a daemon that ever raises `MAX_AGENTS`
  cannot make the panel taller than the corner it lives in.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-frontend`) |
|---|---|---|
| 5.1 | `web/tests/statsPanel.test.ts`: `open: false` gives `visible: false` whatever the frame holds. | The toggle. |
| 5.2 | RED: `open: true` with a `null` frame, and with a frame of zero rows, both give `visible: false`. | The count rule. |
| 5.3 | RED: rows are ordered by writes descending, ties broken by agent, and the empty-agent row is **last regardless of its counts**. | The sort. |
| 5.4 | RED: a row's `swatch` is `actorColor(agent)`; the empty-agent row's is `null`. | The swatch. |
| 5.5 | RED: `topPath` is the highest-count path; with every count at 1 it is `""` and `topCount` is `0`. | The pick. |
| 5.6 | RED: an agent whose events were all reads has `writes: 0` and is still shown -- reading is work. | No filter. |
| 5.7 | RED: `truncated` on any row is surfaced on the panel, so the reader knows a number is a floor. | The flag. |
| 5.8 | RED: `splitPath` from `eventLog.ts` is what splits `topPath` -- imported, not respelled. | The import. |

**Test to write first.** 5.2 -- property: *an empty summary is not on screen at all*. Input that
trips it today: the module does not exist; and once it does, a painter written first shows an empty
box, which is the failure `statusList.ts` exists to prevent.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R6 -- F8 is unbound. **Rank: now, and it can land first**

**What is wrong.** Nothing on the page answers F8, and the brief's `Tab` is refused in decision 9.

**Where.** New `web/src/statsKeys.ts`, modelled line for line on `sizeKeys.ts` (`:26-45`); one
branch in `main.ts`'s keydown chain, immediately after F7's (`main.ts:370-378`).

**Target shape.** `interpretStatsKey(event: StatsKeyEvent): "toggle" | null`, with **all fields
required** -- `sizeKeys.ts:25-33` makes them required and `searchKeys.ts:43-49` makes `shiftKey`
optional, and the difference is that `searchKeys` had a pinned test file to keep compiling. A new
module has no such history, so required is right.

**Two declines and their reasons.** A **modified** F8 belongs to whoever binds it next. A
**repeating** F8 belongs to nobody: held down it repeats at roughly 30 Hz, and while this toggle
sends nothing to the daemon (unlike F7, which is a tree walk per press), a panel flickering at
30 Hz is its own defect. `preventDefault` because some browsers and some window managers claim
F-keys, and because F7's branch sets the precedent for taking the key outright.

**Position, and why it is above the chain rather than in it.** `sizeKeys.ts:5-11`: "the chain below
is ordered by CONTESTED keys, and a binding that contests nothing takes no part in that argument."
This one contests nothing and is conditional on nothing -- the panel must toggle with the viewer
open, with the root bar focused and with either search bar taking keystrokes, for the same reason
F7 must. **The risk of first position is real and the declines are the guard on it**, which is why
R6 step 6.4 exists.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-frontend`) |
|---|---|---|
| 6.1 | `web/tests/statsKeys.test.ts`: a bare, non-repeating F8 answers `"toggle"`. | `interpretStatsKey`. |
| 6.2 | RED: ctrl+F8, shift+F8, alt+F8 and meta+F8 each answer `null`. | The modifier decline. |
| 6.3 | RED: a repeating F8 answers `null`. | The repeat decline. |
| 6.4 | RED: every other key -- `F7`, `Tab`, `Escape`, `Enter`, `f`, `F3` -- answers `null`. This is the guard on first position and it must enumerate. | Nothing; the shape. |
| 6.5 | RED, over the parsed source of `main.ts`: the F8 branch sits between the F7 branch and the file-view branch, and calls `preventDefault`. | The branch. |

**Test to write first.** 6.4 -- property: *a binding at the top of the chain claims exactly one
key*. Input that trips it today: the module does not exist. It is first because first position is
the whole risk, and 6.1 passing without 6.4 is a binding that can silently outrank the modal.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R7 -- There is nowhere to draw it. **Rank: now, and it is the step with the least testable content**

**What is missing.** No element, no painter, no CSS.

**Where.** `web/index.html`: a new `#session-stats` element, **top-left**. `web/src/statsHud.ts`: a
thin painter. `web/src/style.css`: the box.

**Placement, verified rather than assumed.** The four corners today: `#search` and
`#content-search` at `top: 14px; left: 50%` (`style.css:194-197, 246-249`), `#size-legend` at
`top: 14px; right: 14px` (`:313-316`), `#root-bar` at `top: 56px` centred (`:387-389`),
`#bottom-bar` at `bottom: 10px` spanning the width (`:31-35`). **Top-left is the only free
corner.** It may **not** join `#bottom-bar`: that row is one grid whose two side reserves were
measured in a browser, and `web/index.html:79-85` already says a fourth box there "would change
what the centre caption may spend with nothing on screen saying so".

**What it can collide with, stated rather than discovered.**
- `#hud`'s `#log` is bottom-left with `max-height: 30vh` (`style.css:78`). This panel takes
  `max-height: 45vh` and scrolls; 45 + 30 leaves 25vh plus the `.about` block, so at ordinary
  heights they do not meet and at a very short viewport they do. That is the bargain `#size-legend`
  already accepts (`style.css:306-308`) and it is undone by closing the panel.
- The **modal** file view covers it. Same bargain, same undo.
- The **docked** file view is `width: 40vw` on the right (`style.css:679-683`) and cannot reach it.
- `#search` is centred and 32 rows of agent names are not, so at a narrow viewport the two can meet
  horizontally. This panel is the newcomer, so it gives way: a `max-width` in `vw`, the way `#log`
  takes `max-width: 32vw` for the identical reason (`style.css:80-92`, whose comment explains that
  a grid item floors at min-content and only a used-width bound clamps it).

**`pointer-events: none` on the container, `auto` on the list.** The load-bearing line
`#bottom-bar` (`style.css:26-30`) and the docked panel (`:674-677`) both carry: without it a
45vh box swallows every drag and click meant for the canvas underneath, and nothing on screen
explains why the graph went dead.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-frontend`) |
|---|---|---|
| 7.1 | Over the parsed CSS/HTML, the shape `tests/test_bottom_row_containment.py` already uses for this kind of assertion: `#session-stats` exists, is not a child of `#bottom-bar`, and declares `pointer-events: none`. | The element and the rule. |
| 7.2 | RED: it declares a `max-height` and a `max-width`, both in viewport units. | The bounds. |
| 7.3 | RED: `main.ts`'s `onReset` clears the panel -- asserted over its parsed source, the only way `main.ts` can be. | One line in `main.ts:322-348`. |

**Test to write first.** 7.1 -- property: *the fourth box does not join the measured row*. Input
that trips it today: the element does not exist, so the assertion cannot find it; and the natural
first implementation puts it in `#bottom-bar`, because that is where every other caption lives.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R8 -- The agent colour prefix is a literal in an untestable module. **Rank: next. Shared with two other plans**

**What is wrong.** `renderer.ts:1240` is `const color = hashColor("actor:" + agent);`. `hashColor`
is pure and exported (`colors.ts:69`); the prefix is not.

**Why it costs.** This panel's swatch (R5 step 5.4), the alarm rows in
`2026-08-26-20-56-attention-rules.md`, and the per-agent timbre in
`2026-08-26-20-56-ambient-sound.md` all want an agent's identity-derived value. Three respellings
of one prefix, and the first typo is a page where the swatch and the figure on the graph disagree
about which agent is which -- a mismatch nobody would think to compare.

**Target shape.** `export function actorColor(agent: string): number` in `colors.ts`;
`renderer.ts:1240` calls it. `2026-08-26-20-56-ambient-sound.md` R3 wants the same hash exposed
once more as a raw number so a voice and a colour are two projections of one hash rather than two
hashes -- do that in whichever plan lands second, not here.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-frontend`) |
|---|---|---|
| 8.1 | `web/tests/colors.test.ts`: `actorColor("x") === hashColor("actor:x")`. | The export. |
| 8.2 | RED, over the parsed source: `renderer.ts` no longer contains the string `"actor:"`. | The call site. |

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R9 -- The shortcut legend has to grow, and the constant it feeds was measured against today's length. **Rank: next, and it CANNOT be closed on this host**

**What is wrong.** F8 is undiscoverable without a legend entry, and the legend is
`web/index.html:26-27` -- 162 characters, ~988 px at `MAX_GLYPH_PX = 6.1`. Adding
`" - F8: session stats"` makes it 182 characters, ~1110 px, a 12% growth in the widest thing in the
bottom row.

**Why it costs.** `CONTEXT_WIDTH_FRACTION = 0.34` (`bottomRow.ts:26`) is not arithmetic, it is a
browser measurement, and its comment says what it was measured against: "0.34 keeps the shortcut
legend at two lines at both 1280 and 1600, where 0.40 wraps it to three at 1280 and 0.50 to three
at 1600. The legend is the widest thing in the row, so it is what pays for a greedy centre."
Growing the legend by 12% moves the point at which it wraps, and the constant that was tuned to
prevent that wrap has no idea. `MIN_SIDE_WIDTH_PX = 231` is likewise "pinned to that measurement
rather than merely bounded by it".

**Why it is `next` and why it cannot be finished here.** This host is a tty. Nobody here can open
1280 and 1600 and see whether the legend is on two lines or three. The step is therefore: add the
entry, **and re-derive `CONTEXT_WIDTH_FRACTION` in a browser at 1280 and 1600 before it ships**.
If the legend wraps to three lines, the choices are to shorten an existing entry -- `F3: next` is
the least useful without a search open, and `double-click: auto-fit` is discoverable by accident --
or to lower the fraction, which squeezes the centre caption at widths where nothing ever
overlapped. **Decide by measurement, not by taste.** If `2026-08-26-20-56-ambient-sound.md` ships
too, both entries land at once (194 characters, ~1183 px) and the measurement is taken once.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-frontend`) |
|---|---|---|
| 9.1 | Extend the existing `tests/test_bottom_row_width_bounds.py` shape: the legend's character count stays under whatever ceiling the browser measurement establishes. **The ceiling is an input to this test and does not exist yet.** | The legend entry, after the measurement. |

**Owner.** `developer-tester` -> `developer-frontend`, gated on a human with a browser.

---

### R10 -- "Time active" is not defined. **Rank: noted, with a trigger**

**What is missing.** The panel reports first, last and the span between them (decision 11), and the
span over-reports for any agent that idled.

**Why it is not built.** A real answer sessionizes: "gaps longer than N seconds split the work into
sessions, and active time is the sum of the sessions." N is a constant with nothing behind it. The
only interval in this codebase that resembles it is `ATTRIBUTION_WINDOW_SECONDS = 5.0`
(`server.py:110`), which means something entirely different -- how long a hook's authorship survives
for the watcher to inherit -- and borrowing it would be a number chosen because it existed.

**Trigger.** The first time someone compares two agents' spans and draws a wrong conclusion, or the
first time a real session is long enough that the span and the work visibly disagree. At that point
N is chosen by looking at a real event stream, which is a measurement nobody has taken.

---

### R11 -- The panel is a snapshot of the running daemon and nothing else. **Rank: noted**

**What is missing.** The counters die with the daemon, are not exported, and cannot be compared
across sessions. There is also no way to click a row and see only that agent's work on the graph.

**Why neither is built.** Persistence means a file the daemon writes -- a new write surface, a
format to version, and a question about where it lives that the packaging already answers three
different ways for three different things. Filtering the graph by agent means a new renderer
channel and a decision about what "only this agent" means for a directory two agents both worked
in. Both are features, not steps, and each deserves its own plan.

**Trigger.** Persistence: the first time someone wants yesterday's numbers. Filtering: the first
time a session has enough agents that the graph is unreadable without it -- which is a real
prospect, since the whole point of the tool is many agents at once.

---

## 4. What conflicts with what

- **Decision 2 (daemon-side) and decision 5 (a poll) pull against each other.** Daemon-side is
  chosen because the browser's history is bounded; a poll is chosen because publishing per event is
  wasteful. Together they mean the panel is authoritative but up to 5 s stale, which is the
  opposite trade from the recent-changes list beside it -- that one is instant and lossy. **Two
  panels on one page with opposite freshness guarantees is a real inconsistency**, and the mitigation
  is decision 1: this one is labelled a summary, and if it ever grows a live counter the trade has
  to be reopened.
- **Decision 9 (F8) conflicts with discoverability.** `Tab` is the key a user would guess; F8 is the
  key that is safe. R9 is the whole cost of that choice, and R9 cannot be closed on this host.
- **Decision 12 (caps) conflicts with the panel's own claim.** "Files touched: 2 000" with
  `truncated` set is a floor, not a count, and a reader who misses the flag has a wrong number.
  R5 step 5.7 surfaces it; whether the surfacing reads as a caveat or as noise is a judgement
  nobody here can make.
- **This plan and `2026-08-26-20-56-attention-rules.md` both need `_observe`, and both need
  `actorColor`.** Neither is a conflict if they are built in either order and the second one
  reuses; both become conflicts the moment the second one adds a parallel seam. Decision 6 and R8
  say so; whoever orchestrates the two should say it again.

---

## 5. What cannot be verified on this host

This host is a tty. No `DISPLAY`, no browser, and `pytest` is installed nowhere.

- **The backend suite was never run.** Every "both suites green between any two steps" above is a
  requirement, not an observation.
- **Nothing in this feature has been seen on a screen.** Whether 32 rows in the top-left corner is a
  panel or a wall; whether the swatch is legible at row height; whether the panel and `#log` meet at
  a short viewport; whether the top-left position collides with the centred search bar at a narrow
  one; whether a `truncated` caveat reads as informative or as clutter.
- **R9's whole content is a browser measurement nobody here can take.** The 162/182/194-character
  figures and the ~988/1110/1183 px numbers derived from them are arithmetic at
  `MAX_GLYPH_PX = 6.1`, which is itself documented as "deliberately an over-estimate". Where the
  legend actually wraps is unknown.
- **The daemon-side per-event cost is an estimate.** 2.17 us is the *browser's* accumulator measured
  in Node 18 on this host; the Python equivalent was not measured, and I am asserting it is in the
  same order rather than showing it.
- **No real session has been long enough to reach `MAX_TRACKED_PATHS`.** 2 000 is a pinned guess,
  not an observed ceiling, exactly as `MAX_SCANNED_DIRS` is recorded to be in
  `docs/features/done/2026-08-17-16-21-multi-repo-git-status.md`.
- **The 5 s poll interval is a guess.** Nothing measured it against how often a reader looks.

---

## 6. What I examined and found sound

- **The three fan-out sites and the seed's separation** (`server.py:312`, `:383`, `:403`). The
  structural seed exemption is real and it is this feature's cheapest property.
- **`_meta` / `_status` as replaceable slots, deduped on the encoded string, ordered in
  `replay_messages`** (`server.py:193-194`, `:207-221`, `:235-269`). A fifth slot fits without
  argument, and the docstrings explain each position well enough to place a new one.
- **`poll_status`'s task shape** (`:740-760`): parameterised interval, `<= 0` creates no task, a
  round skipped while one is in flight. Copyable as-is.
- **`eventLog.ts`'s model/painter split and its `resolveMax` guard** (`:62-67`). The degenerate-cap
  fallback is worth copying literally.
- **`attribution.ts`'s "seed never counts"** (`:14-16`). Same rule, same reason, one more caller.
- **`protocol.ts`'s degradation doctrine and `wsClient`'s "route before `parseEvent`"**
  (`protocol.ts:370-419`, `wsClient.ts:203-250`). A tenth parser and a tenth branch fit exactly.
- **`sizeKeys.ts` as a binding template** (`:26-45`). Required fields, two declines, one command.
  The comment explaining why first position is earned is the part to copy, not just the code.
- **`bottomRow.ts` as a place where a browser measurement was written down instead of being
  forgotten** (`:17-46`). It is why R9 is a real step rather than a one-line HTML edit, and the
  module doing its job is the reason this plan could find the cost at all.

---

## 7. Where I stopped

- I read `eventHud.ts`, `statusHud.ts` and `sizeHud.ts` only as line counts and names; I am
  assuming they are thin painters because `CLAUDE.md` and the modules beside them say so, not
  because I read them.
- I read `wsClient.ts` from line 150 to 260 only. The reconnect and backoff halves I did not read.
- I read `cli.py` only around `Settings` and `build_parser`; the ~800 remaining lines, including
  `--doctor` and `--install-hooks`, I did not open.
- I ran the frontend suite once and did not run it again after any measurement. I ran no backend
  suite at all.
- The 2.17 us / 2.4 MiB accumulation figure is Node 18 on this host with `--expose-gc`, warm,
  over synthetic paths of a uniform shape. Real paths vary in length and real agent distributions
  are not uniform; neither was modelled.
- I did not look at whether any existing test asserts the exact contents of `replay_messages()` as
  a fixed-length sequence. R3 step 3.2 assumes such assertions exist or can be added; if one exists
  and is pinned, inserting a fifth frame moves it, and that is a cost this plan has not priced.

---

## Consultation: `security-auditor` (2026-08-26)

Appended by the orchestrator. The audit covered all five plans of this batch **together** and
ranked one critical, five high and seven medium findings; the full report is
`docs/security/2026-08-26-audit-five-planned-features.md` and it is the authority. This section is a pointer into it, never a second
copy of it. It was written against the feature descriptions, **not** against this document --
the auditor states so itself -- so where the two disagree the disagreement is real and unresolved,
not an editing slip.

### Findings that land on this plan

- **M6 (medium).** If the panel is answered by the daemon it is a sixth `COMMAND_KIND`, and it inherits both
  gates for free **provided** it is added to `COMMAND_KINDS` and returns from its own branch --
  parsing with `path: ""` like `sizes`, never reusing `path` for a filter (both gates echo
  `command["path"]` in their refusal), answering a late reply rather than dropping it, and
  becoming the sixth silent `rootError`. The audit's own recommendation is the browser-side
  accumulation instead, capped at 32 actors and 512 paths per actor. This plan chose the daemon
  side for a different and stated reason -- see the tester's note below.
- **M1 (medium).** A `stats` frame must be routed above `parseEvent`.
- **M3 (medium).** Counters keyed on a network-supplied agent string are an unbounded map either way; cap at the
  same 32 actors as the actor pool.
- **H3 (high).** One forged ingest line buys a fabricated "most-visited file" naming any path the attacker
  chooses.

### The auditor's own summary of this feature

**4. Session stats -- nearly a non-event if kept in the browser.** Every input is already on the
wire. Daemon-side it becomes a sixth command with a refusal path and an echo field to get right
(M6); browser-side it is two bounded maps and a pure reducer. The one real risk either way is
unbounded counters keyed on network-supplied strings.

---

## Consultation: `developer-tester` (2026-08-27)

Appended by the orchestrator. The tester reviewed the step tables of all five plans and the
audit's per-finding RED tests -- 210 rows, verdicts `OK` / `NEEDS SHARPENING` /
`NOT WRITABLE AS SPECIFIED` -- and wrote **no test code**. The full review is
`docs/features/2026-08-26-tester-review-five-plans.md`. It ran the frontend suite (**1403 passed, 51 files, 17.58 s** -- `CLAUDE.md`
still says 1287, stale by 116) and could **not** run the backend suite: there is no `pytest` in
`.venv` or in the system Python on this host. Where a backend claim below is grounded, it is
grounded in a live probe against the real `EventHub`, and the review says which is which.

### Cross-cutting findings that name this plan's rows

- **2.1** -- rows 6.5, 7.3 and 8.2 assume a TypeScript source-level test harness that does not
  exist in this repository.
- **2.2** -- step 3.2 asserts `reset, meta, status, stats, seed, recent` as an **exact sequence**.
  There is no exact-sequence assertion on `replay_messages()` anywhere in the suite today, and this
  one would pin three other plans' freedom for no additional safety. Corrected specification:
  `kinds.index("status") < kinds.index("stats") < kinds.index("event")`, matching
  `tests/test_hub_status.py`.
- **2.3** -- decisions 2 and 5 answer by poll and slot rather than by command, so the five pinned
  `parse_command` assertions are untouched.
- **2.5** -- row 4.5 (part) is green today.

### Row by row

### A.3 Session stats panel -- 39 OK / 4 NEEDS SHARPENING / 2 NOT WRITABLE

**R1 -- 9 OK.** The best-specified backend section in the five plans. 1.3's property ("`agent` is
identity and `label` is only text") is the right first test and the reason given -- "keying on
`label` is the natural mistake, it is the readable one" -- is correct.

**R2 -- 6 OK.** 2.4's "the boot snapshot is not work" is a genuine RED: today nothing counts, and
I confirmed `seed_paths` (`server.py:312-326`) never touches `_publish`, so the structural
exemption the plan claims is real.

**R3 -- 1 NEEDS SHARPENING, 5 OK.** 3.2 -- see §2.2 for the corrected index-based form.

**R4 -- 5 OK.** 4.5 is handled honestly: the plan states that the "never reaches `onEvent`" half is
green by accident and that the RED is the sink call. Keep that sentence in the test's header.

**R5 -- 1 NEEDS SHARPENING, 7 OK.** 5.4 depends on `actorColor` from R8, which the plan ranks
`next` while R5 is `now`. Same inversion as attention 6.3 -- promote the shared step (§C).

**R6 -- 1 NEEDS SHARPENING, 4 OK.** 6.5 ("the F8 branch sits between the F7 branch and the
file-view branch") -- writable as a text scan with index comparisons once §2.1's helper exists;
not writable as "parsed source" today. 6.1-6.4 are exemplary: `sizeKeys.ts` is the template, it
exists, and 6.4's enumeration is the right guard on first position.

**R7 -- 1 NEEDS SHARPENING, 2 OK.** 7.1 and 7.2 are writable -- `tests/test_bottom_row_containment.py`
already parses HTML and CSS by hand and is the stated precedent, and it really does what the plan
says it does. 7.3 is the `main.ts` text scan again.

**R8 -- 1 OK, 1 NOT WRITABLE.** 8.2 is the nominated defect (§1); 8.1 is fine and is the same test
as attention 10.1 and sound 3.1 -- **write it once**.

**R9 -- 1 NOT WRITABLE AS SPECIFIED, and correctly declared as such.** "the legend's character
count stays under whatever ceiling the browser measurement establishes. **The ceiling is an input
to this test and does not exist yet.**" A test whose threshold is unknown cannot be written. The
plan is honest about it; I am recording the verdict rather than criticising the plan.

> **Corrected specification, and it is writable today:** pin the *current* length as a regression
> floor rather than the *future* length as a ceiling.
> - `tests/test_bottom_row_width_bounds.py::test_the_shortcut_legend_has_not_grown_since_it_was_measured_in_a_browser`
> - Assert: the legend text in `web/index.html` is **exactly 162 characters**, with a header
>   saying that `CONTEXT_WIDTH_FRACTION = 0.34` was measured against this string at 1280 and 1600,
>   that growing it invalidates that measurement, and that the way to change this number is to
>   re-measure in a browser and write the new number here with the date.
> - Fails today: **no**, it passes -- so it is a jaw, not a RED. That is correct: there is no
>   behaviour to specify yet. It converts "somebody will remember to re-measure" into "the suite
>   stops you". Same for ambient-sound R6.1.

---

