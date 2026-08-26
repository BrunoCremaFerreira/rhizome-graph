# File-size colour mode (F7) -- assessment and staged plan

**Status:** not started. Written 2026-08-25 against `3a0bd01`, with both suites green at the
numbers in section 0. Every line number below is from that commit.

Scope: **F7** arms a colour mode in which every file dot and every directory dot is painted from
its size in bytes -- small is blue, large is red, along a cold-to-warm ramp that **never passes
through green** -- and **F7 again restores today's extension colours**. Search, the content
search, the file viewer, the git status panel and the live write/read channels keep working
unchanged while the mode is armed.

One new command kind, one new result frame, one new backend module, three new pure frontend
modules, one new renderer channel. No new runtime dependency on either side, nothing new forks a
process, and nothing new opens a file descriptor.

Per `CLAUDE.md` rule 3, **nothing in this document is committed**. It is a plan; the tree is
untouched by it and stays that way until the user asks otherwise.

---

## 0. Baseline, measured on this host

| Measurement | Command | Result |
|---|---|---|
| Backend suite before any change | `.venv/bin/pytest -q` | `1317 passed, 20 skipped in 32.51s` |
| Frontend suite before any change | `cd web && node node_modules/vitest/vitest.mjs run` | `1299 passed (1299)`, 45 files, 11.88 s |
| `scan_tree` + `os.stat`, this checkout | `rhizome_graph.tree.scan_tree` then `os.stat` per path | 211 files, scan **3.2 ms**, stat **0.8 ms** |
| `scan_tree` + `os.stat`, `~/projects` | as above | 795 files, scan **13.4 ms**, stat **3.3 ms** |
| `scan_tree` + `os.stat`, `$HOME` | as above | 12 054 files, scan **290 ms** warm (806 ms cold), stat **58-91 ms** |
| `os.stat` unit cost | 12 054 stats | **4.8-7.5 us per file**, run to run |
| `json.dumps` of the answer frame, `$HOME` | `json.dumps(frame, separators=(",",":"))` | **12.2 ms**, 1 252 433 bytes, **104 B per entry** |
| `json.loads` of the same | round trip | **14.2 ms** |
| Same frame as `[[path, bytes]]` pairs | comparison only, not proposed | 1 071 594 bytes, 89 B per entry |
| Inbound WebSocket frame cap, already in force | `websockets.asyncio.server.serve` | `max_size = 1048576` (**inbound only**) |
| Directory count materialised from those paths | `ancestorDirs` rule, in Node | 15 / 116 / 3 498 for the three roots |
| Browser-side directory aggregation, `$HOME` set | Node 18, warm | **28.5 ms** for 12 054 files -> 3 498 directories |
| Browser-side ramp evaluation + colour map build | same run | **6.1 ms** for 15 552 nodes |
| `fileColor(path)` per frame, **today** | 1 500 paths, Node 18 | **774 us per frame** |
| `Map<string, number>.get(path)` per frame | same 1 500 paths | **157 us per frame** |
| `searchMatches.has(path)` per frame, **today** | same 1 500 paths, 50-entry Set | **96 us per frame** |

Six of these decide the design.

- **The walk dominates and the stat is noise.** `os.stat` costs 4.8-7.5 us per file against a
  `scan_tree` that already costs 290 ms warm on this host's home directory. Measuring sizes is
  therefore not a new cost, it is the *same* cost paid twice -- which is what makes "re-request on
  every F7, cache nothing" affordable, and it is the `checkouts.py` argument repeated: discovery
  cheap enough to redo needs no invalidation logic to get wrong.
- **The answer frame is ~1.2 MB on this host's home directory and ~2 MB at the 20 000-file cap.**
  That is legal today only because `max_size` bounds what the daemon *receives*. **Write it down
  as the first casualty of any outbound cap.** The `[[path, bytes]]` form would save 14%, which is
  not enough to buy back the per-entry degradation rule `parseSearchResult` established
  (`protocol.ts:397-419`), so it is rejected here and recorded as the lever to pull if an outbound
  cap ever arrives.
- **Serialising that frame costs 12.2 ms on the event loop**, extrapolating to ~20 ms at the cap,
  because `_send` (`daemon/server.py:803`) does its `json.dumps` on the loop. Once per F7 press it
  is nothing; **once per key auto-repeat it is a stall**, which is decision 13.
- **`fileColor(path)` already costs 774 us per 1 500-node frame** -- a `lastIndexOf`, a `slice`, a
  `toLowerCase` and either a record lookup or an FNV hash, per node, per frame, over a path that
  never changes (`renderer.ts:892`, `colors.ts:68-72`). A `Map.get` is **5x cheaper** at 157 us.
  So handing the renderer a *precomputed colour map* is not a cost this feature pays, it is a cost
  it removes -- and it exposes R10.
- **Browser-side directory aggregation is 28.5 ms at 12 054 files**, ~47 ms extrapolated to the
  cap. Once per answer, never per frame, and it is the price of decision 8. Bigger than I expected
  and worth stating rather than waving through.
- **A naive ramp collapses.** Scale distributions, as the percentage of files landing in each
  fifth of the ramp from cold to hot, over the three roots:

| scale | this checkout | `~/projects` | `$HOME` |
|---|---|---|---|
| `log1p` over `[min, max]` | `[0, 1, 4, 52, 43]` | `[7, 57, 36, 0, 0]` | `[55, 21, 23, 1, 0]` |
| p10..p90 linear in log | `[18, 15, 18, 23, 27]` | `[18, 10, 21, 23, 27]` | `[35, 19, 12, 8, 25]` |
| median-centred, symmetric spread | `[21, 19, 23, 24, 13]` | `[20, 14, 31, 23, 11]` | `[0, 35, 23, 12, 30]` |
| **median-hinged (recommended)** | `[21, 19, 19, 17, 24]` | `[20, 14, 26, 17, 23]` | `[34, 8, 16, 12, 30]` |

  The naive scale answers differently on every root and collapses into two bands, because a single
  3.83 GB file is present in two of the three. The symmetric median-centred scale is good on two
  roots and **empties its coldest fifth entirely on `$HOME`** (`[0, ...]`), for a reason that is
  structural rather than accidental -- see decision 6. The median-hinged variant fixes that at a
  stated cost.

- **Directories and files cannot share a scale.** Placed on one median-hinged scale together,
  directories land as `[20, 7, 0, 7, 67]` on this checkout and `[6, 8, 15, 16, 56]` on
  `~/projects`: two thirds of every directory in the hottest fifth, which is the "every directory
  is red" failure, measured rather than feared. On their own scale they spread:
  `[27, 13, 27, 7, 27]` and `[28, 16, 21, 16, 20]`.

---

## 1. Assessment: how colour and the graph are shaped today

### The seams, and which are load-bearing

**`renderer.setSearch(matches, active, frame)` (`renderer.ts:694-703`) is the precedent this whole
feature is built on, and it is not being touched.** It takes a list of paths and a path to ring;
nothing in it knows the paths came from a query. `content-search.md` reused it for a second search
at zero renderer cost, and the lesson generalises: **the renderer takes an answer, never a
question.** `setSizeColors` is the same shape one step further -- it takes *colours*, keyed by
path, and knows nothing about bytes, ramps, medians or F7. **Load-bearing, unchanged, and the
model for the new channel.**

**`updateNodeAttributes` (`renderer.ts:852-916`) has exactly one line that decides a node's base
colour**, `const base = fileColor(node.path)` at `:892`, and everything after it -- the flash lerp
against `node.color` and `node.highlight`, the violet read tint at `:899-902`, the idle-fade
multiply at `:903`, and the point size at `:904` -- operates on whatever that line produced. That
is why the feature is a one-expression change in the renderer rather than a second draw path, and
it is why live activity keeps showing through the mode for free. **Load-bearing.**

**The three-way branch in the same loop is a precedence chain, in this order: matched, directory,
file** (`:880-905`). "A match is painted by the search, not by its own kind" is already its
documented rule, and the open file rides the same branch. The user's clause "all search and other
functionality keeps working normally" is satisfied by **not touching that branch at all**: the
size colour goes into the two branches below it. **Load-bearing.**

**`tree.scan_tree` (`tree.py:64`) is the definition of "which files the graph draws", and its
docstring says directories are deliberately not among them** (`tree.py:14-17`): "The frontend
materializes them from the paths of their children." That sentence decides section 2's decision 8
on its own -- the daemon does not own the directory set and must not start summing over one.
**Load-bearing.**

**`parse_command` (`server.py:462-535`) is already per-kind and already conditional.** `search`
parses with `path: ""` and adds a `query`; `file` adds a `prefer` only when it says exactly
`"text"`. The rule -- "always `kind`, `path` and `token`; a fourth key only when this daemon
understood it" -- is what keeps five pinned exact-equality assertions byte-identical
(`tests/test_ws_commands.py:105, 113, 277`, `tests/test_ws_control_token.py:156`). A fifth kind
that needs **no** field at all is the easiest case this parser has ever been asked for.
**Load-bearing, extended additively.**

**The two gates (`server.py:843-866`) are kind-indifferent** -- `control_allowed` then
`token_matches`, both in front of `handle_command`, both echoing `command["path"]`. A fifth kind
inherits both, and `WsClient.send` (`wsClient.ts:165-176`) stamps its token for free.
**Load-bearing, unchanged; the plan must not add a dispatch in front of them, and R2 step 2.4 pins
it.**

**`protocol.ts`'s degradation doctrine** -- one hard field whose absence costs the frame, every
other field degraded, junk array items dropped one at a time, never throws
(`protocol.ts:374-419`) -- and `wsClient.handleMessage`'s "route every answer frame **before**
`parseEvent`, consumed with or without a sink" (`wsClient.ts:191-250`). `parseEvent` ignores
`kind`, so **only the ordering** keeps an answer out of the simulation; a `sizes` frame routed as
an event would grow a node called `sizes` in the graph. **Load-bearing, copied exactly.**

**`main.ts`'s keydown chain (`main.ts:323-458`) is ordered by contested keys, not by importance.**
File view first because a modal owns Escape; the root bar next because an open bar owns Enter,
Tab and Escape; content search next; name search last. Every one of those bindings answers `null`
while its own box is closed, which is what makes the chain safe. **Load-bearing, and the reason
decision 14 puts F7 outside the chain's argument rather than inside it.**

### The six things that are actually in the way

1. **Nothing in the tree knows a file's size.** `normalize.py` is pure and on the hook's hot path
   and must never `stat`; `tree.py` returns paths only; `file_view` reads one file's *contents*;
   `status.py` and `checkouts.py` answer about git. There is no metadata question anywhere.
2. **`parse_command` demands a string `path` for every kind that is not `search`**
   (`server.py:532-534`). A `sizes` command names nothing at all, so today it parses to `None`.
3. **`fileColor` is called from inside the per-frame loop and cannot be told a different answer**
   (`renderer.ts:892`). There is no channel, no cache, and no seam: the colour of a dot is a pure
   function of its path, evaluated 1 500 times a frame, and the mode has to override exactly that.
4. **The obvious ramp is wrong.** Sweeping HSL hue from 240 (blue) to 0 (red) passes straight
   through 120 (green) -- which is precisely the shape the user ruled out with "there is no green
   star". Worse, `hslToInt` (`colors.ts:73-90`) already exists in this file, so the wrong answer is
   the one nearest to hand.
5. **Green is not a free colour here: it is the write channel.** `normalize.py:32-35` paints an
   `A` (a file just created) as `33FF33`, pure green, and `updateNodeAttributes` lerps that flash
   over the base colour. A ramp with green in it would make a large static file indistinguishable
   from a file being born. The user's aesthetic constraint and the graph's semantics agree, which
   is rare enough to write down.
6. **The bottom row is a closed arithmetic.** `bottomRow.ts`'s `contextCharBudget` assumes exactly
   **two** side reserves of `MIN_SIDE_WIDTH_PX = 231` around the centre caption, measured in a
   browser. A fourth box in `#bottom-bar` would silently invalidate a constant nobody would think
   to re-derive. The legend (R9) therefore cannot live in that row.

### Two defects this feature exposes rather than creates

- **`fileColor` is recomputed per node per frame** at a measured 774 us per 1 500-node frame --
  4.6% of a 16.7 ms budget spent re-deriving a pure function of an immutable string. Pre-existing,
  and this plan makes it *visible* by shipping a `Map.get` that is 5x cheaper on the same data.
  R10, **next**.
- **A refused command is reported as a `rootError` painted in the observed-root bar.**
  `server.py:847-865` and `main.ts:275`. `content-search.md` filed this as R11 (noted) when a
  fourth command kind made it a fourth silent case; a `sizes` refused for a bad token becomes the
  fifth, and its symptom -- F7 does nothing at all, forever -- is the worst-reading one yet,
  because unlike a search there is no bar left on screen holding an empty result. R12, still
  **noted**, with a sharper trigger.

---

## 2. Decisions before step 1

Decisions 1-3 are the user's and are recorded because the steps encode them, not because they are
open. Decisions 4-16 are mine; say so if you would have chosen otherwise. Four of them (6, 8, 12,
13) are places where I did **not** simply ratify the brief this plan was commissioned from.

1. **F7 toggles a colour mode. It recolours file *and* directory nodes by size, and F7 again
   restores today's extension colours.** Nothing else about the graph changes.
2. **Cold to warm, proportional to size**, in the spirit of stellar colour: near is blue, far is
   red.
3. **Green never appears.** A hard constraint on the ramp, not a flourish -- and see finding 5
   above for the second, independent reason.

4. **Sizes are a round trip, not a field on the event.** `normalize.py` runs inside
   `hooks/emit_event.py` on every tool call and blocks the agent's loop; a `stat` there is a
   syscall per event on the hot path, for a mode that may never be armed. And the watcher's events
   would carry sizes while the seed's would not, so the graph would be half-coloured. The daemon
   answers a question instead: **a fifth command kind, `sizes`.** `COMMAND_KINDS` becomes five.
5. **`sizes` carries no argument at all** -- no path, no query. It parses with `path: ""`, the
   echo field both gates put into their refusal, exactly as `search` does. It is therefore the
   only command in this protocol that **turns no string from the network into anything**, which
   is the whole of its security story: there is no containment check to add because there is
   nothing to contain. `resolve_inside` is not involved and must not be made to look as if it is.
6. **The scale is median-hinged in log space, clamped at p10 and p90** -- and this is a
   correction, not a ratification.

   ```
   lb   = log1p(bytes)
   med  = p50(lb),  lo = med - p10(lb),  hi = p90(lb) - med     # each guarded to > 0
   t    = 0.5 + (lb - med) / (2 * hi)   when lb >= med
   t    = 0.5 - (med - lb) / (2 * lo)   when lb <  med
   t    = clamp(t, 0, 1)
   ```

   The brief proposed a single symmetric spread, `max(hi, lo)`. Measured, that empties `$HOME`'s
   coldest fifth completely (`[0, 35, 23, 12, 30]`), and the reason is structural: `$HOME`'s file
   median is **41 bytes** while its p90 is hundreds of kilobytes, so `hi` is roughly three times
   `lo`, and using the larger of the two compresses the entire lower half of the data into two
   fifths of the ramp. Hinging the two halves independently gives `[34, 8, 16, 12, 30]` and costs
   nothing on the other two roots.

   **The stated price:** the ramp is no longer a ratio scale. Below the median a factor of ten
   moves the colour a different distance than a factor of ten above it, so "twice as red" does not
   mean "twice as big" -- it means "further up this project's own distribution". That is exactly
   why R9's legend, which prints the byte value at both ends *and at the median*, is ranked
   **next** rather than **noted**: the scale states its own meaning only when its three anchors
   are on screen. The symmetric variant stays documented here as the one-line fallback if a real
   screen says the hinge reads oddly.

   Two degenerate cases and their answers, both tests: `lo` or `hi` equal to zero (more than half
   the files identical in size) guards to a spread of 1.0 rather than dividing by zero; an empty
   file set produces **no scale at all**, and every node is unmeasured (decision 12).
7. **The ramp is an explicit stop table interpolated in sRGB, not a hue sweep.** Five stops:

   | t | hex | rgb |
   |---|---|---|
   | 0.00 | `#3b6dff` | 59, 109, 255 |
   | 0.25 | `#8fb8ff` | 143, 184, 255 |
   | 0.50 | `#fff4e8` | 255, 244, 232 |
   | 0.75 | `#ffb64d` | 255, 182, 77 |
   | 1.00 | `#ff3b21` | 255, 59, 33 |

   **The invariant is the user's own sentence, pinned as an inequality: for every sampled `t`,
   `g < max(r, b)`.** I checked these stops over 10 001 samples and they satisfy it, with the
   tightest margin **2.14/255 at t = 0.457**. Three things follow and each belongs in the test:

   - **The thin margin is inherent, not a flaw in these stops.** Any ramp that runs from a blue to
     a red through a light neutral must pass a point where all three channels are nearly equal. A
     test demanding a *margin* (`g <= max(r, b) - 8`, say) would reject every white-crossing ramp,
     including the correct one. So the assertion is the strict inequality **plus** a second one
     that distinguishes "passes through white" from "passes through green": wherever the margin is
     under 8/255, `max(r,g,b) - min(r,g,b) <= 24`, i.e. the colour there is neutral.
   - **The invariant is transfer-independent.** The sRGB transfer function is monotone and applied
     per channel, so a channel ordering in sRGB is the same ordering in linear light. Interpolating
     the same stops in linear space instead also satisfies it (margin -4.04/255, checked), so
     three.js's colour-space handling cannot break the rule.
   - **A hue sweep would fail it grossly**, and `hslToInt` is already in `colors.ts` -- so the test
     exists as much to stop the future simplification as to check today's table.
8. **Directories are summed in the browser, and they get their own scale.** Two decisions, one
   bullet, because they stand or fall together.

   *Summed in the browser*, because `tree.py:14-17` says in as many words that the daemon does not
   list directories and the frontend materialises them from their children's paths
   (`simulation.ts:115-125`). A daemon that summed would be re-deriving a structure it deliberately
   does not own -- a second definition of "which directories exist", drifting the first time
   `ancestorDirs` changes -- and would grow the frame by 29%. The sum is pure, testable and costs
   28.5 ms once per answer.

   *Their own scale*, because on one shared scale 67% of this checkout's directories and 56% of
   `~/projects`' land in the hottest fifth (section 0). A directory is the sum of its files, so on
   a file scale nearly every directory is off the top; the mode would say "directories are big",
   which is not information.

   **The cost, stated out loud: a directory and a file painted the same colour are not the same
   size.** The alternative -- one scale -- makes the directory colour carry no information at all,
   and the other alternative -- leave directories grey, as they are today -- is smaller and
   cleaner but was explicitly ruled out by the user, who asked for "directory and file nodes". So
   two scales, and R9's legend gets two rows.
9. **The renderer receives colours, never sizes.** `setSizeColors(colors: ReadonlyMap<string,
   number> | null)`, where `null` means the mode is off. The ramp, the scale, the percentiles and
   the aggregation all happen once when the answer is adopted, in pure modules; the per-frame cost
   is one `Map.get`, measured at 157 us per 1 500 nodes against the 774 us `fileColor` already
   costs. **A renderer that evaluated a ramp per node per frame would be the defect**, and it is
   the shape a reviewer should look for.
10. **Precedence: search wins, then the size colour replaces the base colour and nothing else.**
    The matched branch (`renderer.ts:880-888`) is untouched, so a search match and the open file
    stay cyan, ringed and boosted while the mode is armed -- that is how "all search and other
    functionality keeps working normally" is honoured concretely. Below it, the size colour
    replaces `fileColor(node.path)` for a file and `DIR_COLOR` for a directory, and the write
    flash, the read tint, the idle fade and the point size all still apply on top. A file being
    written still flashes amber over its size colour; a file being read still wears its violet
    ring.
11. **Point sizes do not change.** The request is about colour. `sizeArr[idx]` keeps its existing
    expressions in all three branches. Encoding size in the dot's radius as well would double-code
    one variable and collide with the highlight and read boosts that already move it. Written down
    because it is the first thing someone will add.
12. **An unmeasured node wears the grey that is already on screen** -- `DIR_COLOR` (`0x9aa0a6`),
    at whichever multiplier its branch already applies -- rather than a new desaturated grey. The
    brief proposed "a desaturated grey"; the correction is *which* one. A second near-grey beside
    an existing one is the least legible pair this page could contain, and inside the armed mode
    the old meaning of that grey ("this is a directory") is not in use, because directories are
    coloured.

    **Who is unmeasured is a smaller set than it looks:** the answer is re-requested on every F7,
    from the same `scan_tree` the graph seeds from, so it is files created since the measurement
    (a handful in a live session), everything beyond the 20 000-file cap on a huge tree, and
    directories all of whose children are unmeasured. A deleted file has no node.

    **The residual risk, named rather than solved:** the ramp crosses near-white at its median and
    `DIR_COLOR` is a cool near-neutral, so "unmeasured" and "median-sized" are separated by
    brightness alone, through a bloom pass, on a screen nobody here has. If that does not read,
    **the answer is a different channel, not a third grey** -- the read ring's own doctrine, "a
    different shape, not a different shade". The fallback is to draw unmeasured nodes a pixel
    smaller or hollow. The tests pin relations, never colour values, so retuning stays free.
13. **F7 auto-repeat is not a toggle, and no second request is ever sent while one is in flight.**
    Two conditions on one path, which is this project's stated form of depth. Held down, F7
    repeats at roughly 30 Hz; each *entry* into the mode is a `sizes` command, each of which is a
    290 ms walk in the shared default executor -- the same executor that serves `scan_tree`,
    `file_view` and `content_search` -- plus a 12-20 ms `json.dumps` on the daemon's loop. That is
    the brief's one real omission, and it is answered twice: `interpretSizeKey` declines an event
    whose `repeat` is true (the binding, pure), and `sizeMode` only sends on the `closed ->
    pending` transition (the state machine, pure). Either alone would be enough for the common
    case; both is what survives a user mashing the key.

    **Corollary, and it is why the toggle is unconditional:** F7 pressed while `pending` closes the
    mode without sending. So a request that will never be answered -- a refused token, R12 -- is
    escaped by pressing F7 again, and the mode can never wedge.
14. **F7 sits FIRST in `main.ts`'s keydown chain, above `interpretFileViewKey`.** The chain is
    ordered by *contested* keys: each binding below claims a key some other binding also wants,
    and each declines while its own box is closed. F7 is contested by nothing and conditional on
    nothing -- it must work with a modal open, with the root bar focused, and with either search
    bar taking keystrokes, because "all other functionality keeps working normally" cuts both
    ways. Putting an unconditional binding *inside* a precedence argument invites the next reader
    to believe its position is load-bearing when it is not; putting it above the argument says it
    takes no part in one.

    **The counter, and its answer:** first position means a future contested key added to
    `sizeKeys.ts` would silently outrank the modal's Escape. The guard is a test, not a comment --
    `interpretSizeKey` answers `null` for every key that is not an unmodified, non-repeat F7,
    **including Escape, Enter and F3 explicitly**, so widening it later fails that test first.
15. **No cache: every F7 re-requests.** The `checkouts.py` precedent -- discovery cheap enough to
    redo needs no invalidation logic to get wrong -- and here it is measured: the stat pass is
    16-24% of a walk the daemon already knows how to do. A cache would need to be invalidated by
    the watcher, which means a per-event write into a map for a mode that is usually off.
16. **A `reset` closes the mode.** `ctrl+L` repoints the daemon at another project, and the size
    map keys paths of the old one. Closing also settles a request that may be in flight: the state
    it lands on is not pending, so a late answer is refused by the same guard that refuses a
    superseded one. Exactly what `onReset` already does for the content search (`main.ts:304`),
    and for the same reason.

---

## 3. The plan

Ranked, ordered, every step one RED test plus one GREEN implementation, both suites green between
any two steps. R1-R2 are backend and land before the front end has anything to show. **R3 and R6
are frontend steps that depend on nothing and should land early**, because they are the two whose
content is entirely a table.

New test files throughout, so no existing assertion moves:
`tests/test_sizes.py`, `tests/test_ws_sizes_command.py`, `web/tests/sizeColor.test.ts`,
`web/tests/sizeScale.test.ts`, `web/tests/sizeProtocol.test.ts`, `web/tests/sizeMode.test.ts`,
`web/tests/sizeKeys.test.ts`, `web/tests/sizeLegend.test.ts`.

---

### R1 -- Nothing in the tree knows how big a file is. **Rank: now**

**What is missing.** There is no metadata question anywhere in `rhizome_graph/`. `tree.scan_tree`
answers "which files" (`tree.py:64-102`), `file_view` answers "what is inside *this* file",
`status.py` and `checkouts.py` answer about git, and `normalize.py` is pure by contract and on the
hook's hot path. Nothing calls `os.stat` on an observed file at all.

**Where.** New module `rhizome_graph/sizes.py`. Not in `tree.py`: that module is the boot snapshot,
runs on every root switch, and its docstring's promise is that it is cheap and never raises --
growing a stat pass onto it makes every `ctrl+L` pay for a mode that may never be armed. Not in
`file_view.py`: that module owns the click path's security ordering and imports the git machinery.
Not in `status.py`: nothing about a byte count is the porcelain format.

**Why it costs to put it elsewhere.** The next change is predictable: someone will want sizes for
a workspace of checkouts, or a different cap, or `st_blocks` instead of `st_size`. In its own
module that is one signature. Inside `tree.py` it is a change to the function every root switch and
every daemon boot goes through.

**Target shape.**

```
MAX_FILES = tree.DEFAULT_MAX_FILES     # IMPORTED, never a second literal of 20_000

@dataclass(frozen=True)
class FileSize:
    path: str
    bytes: int

sizes_frame(files, truncated, error) -> dict          # pure, JSON types only
measure_tree(root, max_files=MAX_FILES) -> tuple[list[FileSize], bool]   # stats the disk
async def measure_sizes(root: str) -> dict            # to_thread + frame
```

Five properties hold it up, and each is a test.

- **`MAX_FILES` IS `tree.DEFAULT_MAX_FILES`, imported.** The `content_search.MAX_FILE_BYTES IS
  file_view.DEFAULT_MAX_BYTES` precedent (`content_search.py:80-84`), for the same reason: the set
  measured must be the set drawn, by identity rather than by coincidence. Two constants that
  happen to both be 20 000 is the bug waiting to happen, and it would surface as a tail of grey
  dots nobody could explain.
- **The walk is `scan_tree`'s**, so the ignore rules, the symlink drop, the sort and the cap are
  the graph's own, not a second opinion about them.
- **It uses `os.lstat`, not `os.stat`.** `scan_tree` already drops symlinked files
  (`tree.py:94-96`), so under normal operation the two are identical -- but there is a window
  between the walk and the stat, and `lstat` is the reading in which a path that became a symlink
  in that window reports the link's own size rather than the size of whatever it now points at,
  inside or outside the root. It costs nothing and it is the fail-safe direction, which is how
  every other "which spelling do we take" question in this repository has been answered.
- **It never raises, and a file that vanished between the walk and the stat simply drops its
  entry.** A partial answer is a partial colouring; an exception is a dead command.
- **The module opens nothing.** Asserted over its parsed source, the way `checkouts.py`'s "starts
  no process" and `content_search.py`'s "imports no `re`" are. This is the strongest contract in
  the feature and it should be written as one: a walk over a whole home directory that never opens
  a descriptor cannot be parked on a writerless FIFO, which is exactly the failure `safe_read.py`
  exists for -- so `sizes.py` needs `safe_read` only for as long as nobody adds "and let us also
  sniff whether it is binary". The test is what stops that line.

**Worst case, in the units that matter.** 290 ms of `scan_tree` plus 58-91 ms of stat on this
host's 12 054-file home directory, extrapolating to ~500 ms plus ~150 ms at the 20 000 cap, all of
it inside `asyncio.to_thread` for the reason `scan_tree` and `search_tree` are. Cold, the walk is
2.8x slower (806 ms measured), so **~2 s worst case** on a cold or network-backed tree. The
extrapolation is linear from this host's roots and is not an observation; see section 7.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-backend) |
|---|---|---|
| 1.1 | `tests/test_sizes.py`: `sizes.MAX_FILES is tree.DEFAULT_MAX_FILES` -- identity, not equality. Today the module does not exist, so the import fails. | Create `sizes.py` with the imported constant. |
| 1.2 | RED, real files in `tmp_path`: `measure_tree` returns one `FileSize` per file `scan_tree` returns, with the byte counts `os.stat` reports, sorted by path; a file under an ignored directory is absent from both. | The walk plus the stat loop. |
| 1.3 | RED: a path that vanishes between the walk and the stat (a `scan_tree` stub returning a name that is not there) drops its entry and raises nothing; an unreadable directory yields fewer entries, never an exception. | The per-path guard. |
| 1.4 | RED: with `max_files` set below the file count, the result is cut and `truncated` is `True`; a run that fits reports `False`. | The cap, taken from `scan_tree`'s own answer. |
| 1.5 | RED: a symlink to a large file outside `tmp_path` is either absent (today's `scan_tree` behaviour) or reports the **link's** size, never the target's. | `os.lstat`. |
| 1.6 | RED, over the parsed source: `sizes.py` names no `open`, no `subprocess`, no `asyncio.create_subprocess_*`, and imports neither `re` nor `rhizome_graph.safe_read`. | Nothing -- it must already pass. The contract, written down as a test. |
| 1.7 | RED: `sizes_frame` produces `{"kind": "sizes", "files": [{"path", "bytes"}], "truncated", "error"}` with only JSON types -- a `FileSize` smuggled through whole would raise inside `_send`, on the loop, long after the function returned. | `sizes_frame`, modelled on `search_frame` (`content_search.py:155-172`). |
| 1.8 | RED: `measure_sizes` runs the walk off the loop -- a blocking `measure_tree` stub does not stop the loop servicing another task. | `await asyncio.to_thread(measure_tree, root)`. |

**Test to write first.** 1.1 -- property: *the set of files measured is the set of files drawn, by
identity*. Input that trips it today: `import rhizome_graph.sizes` raises `ModuleNotFoundError`.
It is first because it is the one property a later "optimisation" is most likely to break, by
retyping the number.

**Owner.** `developer-tester` -> `developer-backend`.

---

### R2 -- A command cannot be argument-free. **Rank: now**

**What is wrong.** `COMMAND_KINDS` (`server.py:459`) is a closed four-tuple, and `parse_command`
requires a string `path` for every kind except `search`, which requires a string `query`
(`server.py:526-535`). A command that names nothing has no shape here and parses to `None`.

**Where.** `daemon/server.py:459` (the tuple), `:462-535` (the parser and its docstring),
`:747-800` (`handle_command`). The gates at `:843-866` are **not** touched, and that is a property
to test rather than an intention.

**Why it costs.** Without it there is no way to ask, and the alternatives are worse in ways worth
recording: a `sizes` smuggled through the `file` kind would make `resolve_inside` run on a path
that means nothing; a `sizes` pushed unasked at connect time would put a 290 ms walk into every
browser's first paint for a mode almost nobody arms.

**Target shape.**

```
COMMAND_KINDS = ("complete", "setRoot", "file", "search", "sizes")

parse_command:
    kind must be in COMMAND_KINDS
    if kind == "search": query must be a str, else None;  path = ""
    if kind == "sizes":  no field at all;                 path = ""
    else:                path must be a str, else None
```

Concretely one branch, placed beside the `search` one, returning the `command` dict that has
already been built with `path: ""` -- so the parser gains no key, and the five pinned
exact-equality assertions stay byte-identical. No test pins `COMMAND_KINDS` as a literal (checked),
so the tuple widens without moving anything.

`handle_command` gains one branch, **returning from itself and never falling through to the
`setRoot` tail** -- the rule that module's docstring already states at `:753-758`, and the reason
it states it is that a `sizes` carries the empty path, which `resolve_root` would happily turn into
somewhere:

```
if kind == "sizes":
    asked_about = self.root
    frame = await measure_sizes(asked_about)
    if self.root != asked_about:
        frame = sizes_frame([], False, "the observed project changed")
    await _send(websocket, frame)
    return
```

The root re-read is `content_search`'s rule verbatim (`server.py:786-793`), including its one
difference from `publish_status`: **status drops a stale answer, this one answers anyway**, empty
and with the reason, because a dropped reply strands the browser's `pending` flag with no second
reply coming.

**The one thing `sizes` cannot copy from `search` is the echo.** A `searchResult` carries the
`query` it answers, and that string is the supersede guard. A `sizes` answer has nothing to echo,
so a late answer cannot be recognised as late by content. Two conditions cover it instead, and
between them nothing stale is ever adopted: the daemon's root re-read above means an adopted frame
is necessarily about the current root, and the browser's `pending` guard (R5) means an adopted
frame is necessarily one the browser is still waiting for. Adding a `root` echo field would be a
third definition of "which project" for no case either condition misses.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-backend) |
|---|---|---|
| 2.1 | `tests/test_ws_sizes_command.py`: the existing exact-equality assertions for `complete`, `setRoot`, `file` and `search` are **re-asserted verbatim**. | Nothing -- they must already pass. The jaw that makes 2.2 provably additive. |
| 2.2 | RED: `parse_command('{"kind":"sizes"}')` equals exactly `{"kind": "sizes", "path": "", "token": ""}` -- three keys, no fourth. | The `sizes` branch. |
| 2.3 | RED: `{"kind":"sizes","path":42}` and `{"kind":"sizes","query":"x"}` both still parse to the same three-key dict (a field this kind does not use is ignored, not fatal); `{"kind":"sizes","token":42}` yields the empty token. | Nothing beyond 2.2 -- the branch returns before the path check. Pins that the kind names nothing. |
| 2.4 | RED: a `sizes` refused by the token gate answers a refusal and **never reaches** `measure_sizes` (a spy records zero calls); and a right token from a non-loopback peer is still refused. | Nothing -- both must already pass. The pin that the fifth kind grew no path around the two gates. |
| 2.5 | RED: `handle_command` on a `sizes` answers a `kind: "sizes"` frame to the asking client and **does not switch the root** (`session.root` unchanged, no `reset` broadcast). | The branch, with its own `return`. |
| 2.6 | RED: a `Session` whose `measure_sizes` is stubbed to change `session.root` mid-await answers an empty frame carrying the reason, not the abandoned root's file list. | The root comparison after the await. |
| 2.7 | RED: the answer goes to the client that asked and to nobody else. | Nothing -- `_send`, not the hub. |

**Test to write first.** 2.1 -- property: *the four existing command shapes parse exactly as they
do today*. It is a regression jaw, it costs one re-run of assertions that already exist, and it is
what makes widening a security-adjacent parser safe to review.

**Owner.** `developer-tester` -> `developer-backend`.

---

### R3 -- There is no ramp, and the nearest one to hand is the forbidden one. **Rank: now, and it can land first**

**What is missing.** `colors.ts` has an extension palette, an FNV hash and `hslToInt`
(`colors.ts:73-90`). Sweeping hue 240 -> 0 with the function already in the file passes straight
through green at 120, which is the exact shape the user ruled out; and green is separately spoken
for by the `A` flash (`normalize.py:33`).

**Where.** New module `web/src/sizeColor.ts`. Not in `colors.ts`: that module is "the colour of a
thing by what it is", a pure function of a path, and it is imported by the renderer's per-frame
loop -- a scale that has to be built from a whole distribution does not belong behind the same
door. Same split as `statusList.ts` beside `statusHud.ts`, and `bottomRow.ts` beside
`contextHud.ts`.

**Why it costs to skip it.** Every decision in this feature that a human will argue about -- the
stops, the percentiles, the hinge, the clamp -- lives here. In `renderer.ts` none of it could be
tested at all, because that module needs a GL context; that is the same reason `labels.ts`,
`view.ts`, `pick.ts` and `search.ts` exist.

**Target shape.**

```ts
export interface SizeScale {
  readonly medianLog: number;
  readonly lowSpread: number;    // medianLog - p10Log, guarded > 0
  readonly highSpread: number;   // p90Log - medianLog, guarded > 0
  readonly coldBytes: number;    // the p10 byte value, for the legend
  readonly midBytes: number;     // the p50 byte value
  readonly hotBytes: number;     // the p90 byte value
}
export function buildScale(sizes: readonly number[]): SizeScale | null;  // null for an empty set
export function scalePosition(scale: SizeScale, bytes: number): number;  // -> t in [0, 1]
export const RAMP_STOPS: readonly { readonly t: number; readonly rgb: number }[];
export function rampColor(t: number): number;         // 0xRRGGBB, clamps t
export const UNMEASURED_COLOR: number;                // === DIR_COLOR's value
export function formatBytes(bytes: number): string;   // "41 B", "7.7 KiB", "3.6 GiB"
```

`formatBytes` is here rather than in the painter because it is what makes the legend's three
anchors testable, and because there is no byte formatter anywhere in `web/src/` today (checked).

**Steps.**

| # | RED (developer-tester) | GREEN (developer-frontend) |
|---|---|---|
| 3.1 | `web/tests/sizeColor.test.ts`: over 1 001 samples of `t` in `[0, 1]`, `g < max(r, b)` for every one -- **the user's sentence, as an inequality**. | `RAMP_STOPS` and `rampColor`, interpolating per channel between the bracketing stops. |
| 3.2 | RED: wherever `max(r,b) - g < 8`, `max(r,g,b) - min(r,g,b) <= 24` -- the near-tie is a *neutral*, not a green. | Nothing beyond 3.1 for the proposed stops. This is the assertion that survives a retune. |
| 3.3 | RED: `rampColor(0)` is `0x3b6dff` and `rampColor(1)` is `0xff3b21`; `t` below 0 and above 1 clamp; `NaN` degrades to one end rather than producing `NaN` channels. | The clamp. |
| 3.4 | `web/tests/sizeScale.test.ts`: `buildScale` over a known list puts the median at `scalePosition === 0.5`, the p10 at `0` and the p90 at `1`; a value between the median and p90 lands strictly between 0.5 and 1. | `buildScale` and `scalePosition`, hinged per decision 6. |
| 3.5 | RED: an asymmetric distribution (median 41, p10 0, p90 262 144 -- `$HOME`'s real shape) puts **more than one fifth** of a representative sample below `t = 0.2`. This is the assertion that fails on the symmetric-spread variant and passes on the hinged one. | The two independent spreads. |
| 3.6 | RED: a list where every value is identical yields a scale on which every value is `0.5`; `buildScale([])` is `null`. | The zero-spread guard and the empty case. |
| 3.7 | RED: `formatBytes` over a table -- `0 -> "0 B"`, `41 -> "41 B"`, `7934 -> "7.7 KiB"`, `3833402552 -> "3.6 GiB"` -- binary units, one decimal above bytes, never a negative. | `formatBytes`. |
| 3.8 | RED: `UNMEASURED_COLOR` is not equal to `rampColor(t)` for any of the 1 001 samples, and is achromatic (`max - min <= 12`). | The constant, and nothing else. Pins decision 12's weak but honest property. |

**Test to write first.** 3.1 -- property: *there is no green star*. Input that trips it today: the
module does not exist, and the implementation nearest to hand -- `hslToInt(240 - 240 * t, ...)`,
using the function already in `colors.ts` -- returns `(51, 255, 51)` at `t = 0.5`, which fails on
the first sample it reaches.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R4 -- Nothing parses or routes a `sizes` frame. **Rank: now**

**What is missing.** `protocol.ts` has six parsers and `wsClient.handleMessage` six routes
(`wsClient.ts:191-250`). A `sizes` frame reaching the browser today falls through every one of
them to `parseEvent`, which **ignores `kind`** -- so it would be read as activity and grow a node
called `sizes` in the graph, in exactly the way `parseStatus` and `parseSearchResult` were written
to prevent.

**Where.** `web/src/protocol.ts` (a new `parseSizes` beside `parseSearchResult` at `:397-419`) and
`web/src/wsClient.ts` (`SizesSink` beside `SearchResultSink` at `:70`, the field at `:121`, the
assignment at `:136`, the route before `parseEvent` at `:248`).

**Why it costs.** The failure is not a missing feature, it is a corrupted graph: one phantom node,
permanently, per F7 press.

**Target shape.**

```ts
export interface FileSizeEntry { path: string; bytes: number }
export interface SizesResult {
  files: FileSizeEntry[];
  truncated: boolean;
  error: string;
}
export function parseSizes(raw: unknown): SizesResult | null;
```

The degradation rules are `parseSearchResult`'s, one for one:

- `kind` must be exactly `"sizes"`. Load-bearing in both directions.
- **There is no hard field beyond `kind`.** `parseSearchResult` requires a string `query` because
  that is its supersede guard; a `sizes` answer echoes nothing (R2), so there is nothing whose
  absence should cost the frame. An answer with an empty `files` is a real answer -- an empty
  project -- and dropping it would leave the mode pending forever.
- `files` degrades to `[]`, and a junk item is dropped **one at a time**. An entry needs a string
  `path` and a `bytes` that is a non-negative integer.
- **`bytes` is validated by the existing `isCount` (`protocol.ts:370-372`), not by a second
  predicate.** It is already exactly "a non-negative integer", it is already in this module, and a
  second copy is the `MAX_FILE_BYTES` mistake in miniature. Rename nothing; reuse it.
- `truncated` and `error` fall back to `false` and `""`.
- Never throws.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-frontend) |
|---|---|---|
| 4.1 | `web/tests/sizeProtocol.test.ts`: a well-formed frame parses with its entries in order; a wrong `kind` is `null`; a non-object is `null`. | `parseSizes`. |
| 4.2 | RED: `files` absent, `null` or a string all yield `[]` and a surviving frame; a junk item is dropped while its neighbours survive; an entry with a non-string `path`, a fractional, negative, `NaN` or string `bytes` drops **only itself**. | The per-item loop over `isCount`. |
| 4.3 | RED: `truncated` and `error` degrade to `false` and `""`; a frame with `files: []` is a frame, not a `null`. | The fallbacks, and the deliberate absence of a hard field. |
| 4.4 | `web/tests/sizeProtocol.test.ts`: a `sizes` frame reaches `onSizes` and **never** `onEvent`, and is consumed even with no sink given. | The route in `handleMessage`, placed before `parseEvent`. |

**Test to write first.** 4.4 -- property: *an answer about files is never mistaken for a change to
them*. Input that trips it today: a `{"kind":"sizes","files":[]}` frame handed to `handleMessage`
reaches `onEvent`, because `parseEvent` does not look at `kind`.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R5 -- There is no state machine for a colour mode that is a round trip. **Rank: now**

**What is missing.** Everything about arming the mode: the three states, the refusal of a late
answer, the aggregation of directories, the two scales, and the map the renderer will be handed.
None of it exists, and none of it may live in `renderer.ts`.

**Where.** New module `web/src/sizeMode.ts`. Not folded into `sizeColor.ts`: that module is a ramp
and a scale, both pure functions of numbers, and `sizeLegend` (R9) will import it without wanting a
state machine. Not folded into `simulation.ts`: the sizes are an *answer about* the tree, not part
of it, and `SimNode` gaining a `bytes` field would put a value with a lifetime of its own next to
four channels the tick decays.

**Why it costs to skip it.** Put this logic in `main.ts` and it is untested by doctrine; put it in
`renderer.ts` and it is untestable in fact. Both failures look identical from outside -- the mode
works when you try it and nobody can say why it stopped.

**Target shape.**

```ts
export type SizeModePhase = "closed" | "pending" | "armed";

export interface SizeModeState {
  readonly phase: SizeModePhase;
  readonly fileScale: SizeScale | null;
  readonly dirScale: SizeScale | null;
  readonly colors: ReadonlyMap<string, number>;   // path -> 0xRRGGBB, empty while not armed
  readonly truncated: boolean;
  readonly error: string;
}

createSizeMode(): SizeModeState
requestSizes(state): SizeModeState        // closed -> pending; any other phase returns SAME reference
applySizes(state, frame: SizesResult): SizeModeState   // pending -> armed, or SAME reference
closeSizeMode(state): SizeModeState       // -> a state equal to createSizeMode()
toggleSizeMode(state): SizeModeState      // closed -> pending, everything else -> closed

// selectors
isArmed(state): boolean
shouldRequest(state, next): boolean       // did this toggle cross closed -> pending?
sizeColors(state): ReadonlyMap<string, number> | null   // null unless armed -- the renderer channel
legend(state): SizeLegend | null          // R9
```

Six rules carry it, each a test.

- **`applySizes` refuses and returns the SAME reference** when the phase is not `pending`. The
  `applyView` / `applyContentResults` idiom (`fileView.ts:134-144`), and the whole late-answer
  defence: closing the mode -- by F7, or by a `reset` -- makes every answer still in flight
  refusable by identity comparison in `main.ts`.
- **`toggleSizeMode` is unconditional; only the transition it produces decides whether anything is
  sent.** `shouldRequest(before, after)` is the pure expression of decision 13's second half, so
  `main.ts` holds a call and not a comparison. A toggle out of `pending` closes and sends nothing,
  which is what un-wedges a mode whose answer was refused.
- **Directories are aggregated here, from the file entries alone**, by the same ancestor rule
  `simulation.ts:115-125` uses -- a path's every proper prefix. It does **not** consult the live
  node list: the answer describes the tree the daemon walked, and a directory the browser has but
  the daemon did not measure gets no colour, which is correct (decision 12).
- **Two scales, built independently**: `buildScale` over the file byte counts, and `buildScale`
  over the directory sums. Decision 8.
- **`colors` is built once, on adoption.** Every path in the answer, plus every aggregated
  directory, mapped to a packed `0xRRGGBB`. This is decision 9, and it is what keeps the renderer's
  per-frame cost at one `Map.get`.
- **`sizeColors` answers `null` unless armed.** One value means "the mode is off", so the renderer
  needs no second boolean and cannot get the two out of step.

**Cost, measured.** The aggregation plus the ramp pass is **34.6 ms** for a 12 054-file answer on
this host in Node, ~57 ms extrapolated to the 20 000 cap -- two to four dropped frames, **once per
F7 press**, never per frame. It is the largest single cost in the feature and it is on the right
side of the per-frame line.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-frontend) |
|---|---|---|
| 5.1 | `web/tests/sizeMode.test.ts`: `createSizeMode()` is `closed`, has `null` scales, an empty `colors`, and `sizeColors` answers `null`. | The state and the two selectors. |
| 5.2 | RED: `toggleSizeMode` takes `closed -> pending`, `pending -> closed` and `armed -> closed`; `shouldRequest` is `true` only for the first of those three. | The toggle and the selector. |
| 5.3 | RED: `applySizes` returns the **same reference** when the phase is `closed` and when it is `armed`; from `pending` it adopts and the phase becomes `armed`. | The guard. |
| 5.4 | RED: after adopting a frame of three files in two directories, `colors` holds five entries -- three files and the two directories, including the implicit intermediate one for `a/b/c.txt`. | The ancestor aggregation. |
| 5.5 | RED: a directory's colour is derived from the **directory** scale, not the file scale -- with a fixture where one file is the largest file and its parent is the smallest directory, the two colours are on opposite sides of the ramp. | The two scales. |
| 5.6 | RED: a frame with `files: []` adopts, arms, and yields an empty `colors` with both scales `null` -- an empty project is an answer, not an error. | The `buildScale([]) === null` path. |
| 5.7 | RED: `truncated` and `error` are carried onto the state; `closeSizeMode` returns a state equal to `createSizeMode()`. | The carry and the close. |
| 5.8 | RED: two files of identical size get identical colours, and a file measured at 0 bytes gets a colour rather than being treated as unmeasured. | The zero-byte case, which is `log1p(0) = 0` and a legitimate cold end -- **not** an absence. |

**Test to write first.** 5.3 -- property: *an answer that arrives after the mode was closed changes
nothing*. Input that trips it today: the module does not exist; and the implementation a developer
would reach for -- adopt whatever arrives -- repaints the whole graph from an answer about a
project the user left, which is the failure `publish_status`'s root re-read
(`server.py:598-628`) and `applyView`'s guard were both written for.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R6 -- F7 is unbound, and an auto-repeating F7 is not a toggle. **Rank: now, and it can land first**

**What is missing.** No binding claims F7 anywhere (checked across `searchKeys.ts`,
`contentSearchKeys.ts`, `rootKeys.ts`, `fileViewKeys.ts`). That is the easy half. The hard half is
that a held F7 repeats at roughly 30 Hz, and every second repeat re-enters the mode -- so holding
the key sends ~15 `sizes` commands a second, each a ~290 ms walk in the executor shared with
`scan_tree`, `file_view` and `content_search`, each answered by a 12-20 ms `json.dumps` on the
daemon's loop.

**Where.** New module `web/src/sizeKeys.ts`, mirroring `contentSearchKeys.ts:41-74`.

**Why it costs.** Holding a key is not hostile use; it is what happens when someone rests a finger
while reading. The result is a daemon whose executor is saturated and whose other viewers' file
clicks go unanswered -- and the cause is invisible from every log this project writes.

**Target shape.**

```ts
export interface SizeKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly repeat: boolean;
}
export type SizeCommand = "toggle";
export function interpretSizeKey(event: SizeKeyEvent): SizeCommand | null;
```

It takes **no** `open` parameter, and that absence is the point: this is the only binding in the
page that is unconditional, which is decision 14's justification for its position. Every modifier
is required rather than optional -- unlike `SearchKeyEvent.shiftKey`, which was left optional to
avoid a compile error across a pinned test file -- because this module turns on all of them and a
new test file has nothing to preserve.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-frontend) |
|---|---|---|
| 6.1 | `web/tests/sizeKeys.test.ts`: a bare `F7` answers `"toggle"`. | The one branch. |
| 6.2 | RED: `ctrl+F7`, `shift+F7`, `alt+F7` and `meta+F7` each answer `null`. A modified F7 belongs to whoever binds it next. | The modifier check. |
| 6.3 | RED: `F7` with `repeat: true` answers `null`. | The repeat check. |
| 6.4 | RED: `Escape`, `Enter`, `F3`, `f`, `ctrl+f` and `ctrl+shift+f` all answer `null` -- **named explicitly**, because this binding sits above the modal's Escape and this test is what stops it widening. | Nothing beyond 6.1-6.3. The guard that makes decision 14 safe. |

**Test to write first.** 6.4 -- property: *the only unconditional binding on the page claims exactly
one key*. It reads oddly to write the guard before the feature, and it is the right order here:
the position in the chain is only defensible while this test passes, so it should exist before
anything is placed above `interpretFileViewKey`.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R7 -- The renderer derives a node's base colour from its path and cannot be told another. **Rank: now**

**What is wrong.** `renderer.ts:892` is `const base = fileColor(node.path)`, and the directory
branch at `:889` is a hard-coded `DIR_COLOR`. There is no channel by which either could be
overridden, and both sit inside a loop that runs 1 500 times a frame.

**Where.** `web/src/renderer.ts:349` (the field, beside `occludedRight`), a new setter beside
`setOpenFile` (`:633`) and `setOccludedRight` (`:646`), and `updateNodeAttributes` `:889` and
`:892`.

**Why it costs.** This is the only renderer change in the feature, and getting its shape wrong is
what would make the mode expensive: a renderer handed *sizes* would evaluate percentiles and a
five-stop interpolation per node per frame -- 90 000 ramp evaluations a second at 1 500 nodes -- to
recompute a value that changes only when an answer arrives.

**Target shape.**

```ts
/**
 * The colour every node wears while the size mode is armed, or null when it is
 * not. A MAP OF ANSWERS, like `setSearch`'s list of paths: nothing in here
 * learns what a byte is, what a median is, or which key armed it.
 */
setSizeColors(colors: ReadonlyMap<string, number> | null): void
```

and in `updateNodeAttributes`, two expressions, both below the matched branch:

```ts
} else if (node.kind === "dir") {
  const base = this.sizeColors?.get(node.path) ?? (this.sizeColors ? UNMEASURED_COLOR : DIR_COLOR);
  this.scratchColor.setHex(base).multiplyScalar(0.5);
  sizeArr[idx] = 3.5 * dpr;                                  // UNCHANGED
} else {
  const base = this.sizeColors
    ? (this.sizeColors.get(node.path) ?? UNMEASURED_COLOR)
    : fileColor(node.path);
  // everything from here down is UNCHANGED: the flash lerp, the read tint,
  // the idle-fade multiply and the point size.
```

Four things are deliberately **not** done, and each is the first thing someone will propose:

- **The matched branch is not touched.** A search match, and the open file, stay cyan and boosted.
  That is the user's "search keeps working normally", implemented by absence.
- **No point size changes.** Decision 11.
- **`resetScene` (`:727`) does not clear the map.** The state machine owns the mode and `main.ts`
  closes it on `reset` (decision 16), so clearing it here too would be a second path to the same
  fact -- and the two would drift the first time one of them grew a condition. The content search
  is handled the same way today.
- **File label textures keep their extension colours** (`renderer.ts:1461`). See R14.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-frontend) |
|---|---|---|
| 7.1 | None possible: `renderer.ts` needs a GL context and carries no unit test by doctrine. | The setter and the two expressions. |

**This step has no RED test, and that is a statement rather than an omission.** It is acceptable
only because every decision it needs was pinned first: the ramp in R3, the map in R5, the
`null`-means-off contract in R5's `sizeColors` selector. **If a reviewer finds arithmetic here
that is not a `Map.get` and a `setHex`, that is the finding.** The same rule
`content-search.md` applies to its own R10.

**Owner.** `developer-frontend`.

---

### R8 -- Wiring. **Rank: now, and it has no test of its own**

`main.ts` is the composition root and is not unit-tested, by doctrine. Listed separately and
**explicitly carrying no RED test**, acceptable only because R3-R7 pinned every decision it needs.

What it adds:

- a state variable and a `showSizeMode(next)` beside `showSearch`, `showContentSearch` and
  `showFileView`, which calls `renderer.setSizeColors(sizeColors(next))` and, once R9 lands, paints
  the legend;
- the binding at the **top** of the keydown listener, above `interpretFileViewKey`
  (`main.ts:328`), with a comment saying it is orthogonal to the precedence argument below and
  takes no part in one:

  ```ts
  if (interpretSizeKey(event)) {
    event.preventDefault();          // Firefox binds F7 to caret browsing.
    const next = toggleSizeMode(sizeMode);
    if (shouldRequest(sizeMode, next)) client.send({ kind: "sizes" });
    showSizeMode(next);
    return;
  }
  ```

- `onSizes: (frame) => showSizeMode(applySizes(sizeMode, frame))` in the client options;
- `showSizeMode(closeSizeMode(sizeMode))` inside the existing `onReset` (`main.ts:288-309`),
  alongside the content search's close and for the same stated reason;
- one entry in the keys legend, `web/index.html:24-27`. **That file IS scanned by the language
  policy** (`tests/test_language_policy.py:57-62` names it, and `:189-201` explains why), so the
  new string is English-checked automatically -- the gap `content-search.md` filed as its R13 has
  since been closed and does not recur here.

**Owner.** `developer-frontend`.

---

### R9 -- A spectrum with no scale cannot be read. **Rank: next**

**What is missing.** Nothing on screen says what red means. And because the scale is
**root-relative and hinged** (decision 6), the colours have no absolute meaning at all: the same
file is blue in one project and red in another. Without a legend the mode is decorative.

**Why it is `next` and not `now`.** The mode is complete, testable and shippable without it, and
the legend's placement is the one part of this feature that genuinely needs a browser to settle.
It should land immediately after R8, not "eventually".

**Where.** A new `#size-legend` element in `web/index.html`, `web/src/style.css`, a thin
`sizeHud.ts` painter, and a pure `sizeLegend(state)` in `sizeMode.ts` built on `formatBytes` from
R3.

**Where it may NOT live.** `#bottom-bar` is a three-track grid whose sharing arithmetic
(`bottomRow.ts`) assumes exactly two side reserves of 231 px around the centre caption, both
measured in a browser. A fourth box there invalidates `contextCharBudget` silently. **Top-right,
`position: fixed; top: 14px; right: 14px`, its own element, `pointer-events: none`, shown only
while armed.** That collides with the two search bars (centred at `top: 14px`) only at very narrow
widths, and with the docked file panel (`40vw`, right, full height) by being painted over -- the
same "covering costs nothing and is undone by closing" bargain `#status` already accepts.

**Target shape.**

```ts
export interface SizeLegendRow { readonly label: string; readonly cold: string; readonly mid: string; readonly hot: string }
export interface SizeLegend { readonly files: SizeLegendRow; readonly dirs: SizeLegendRow | null }
export function sizeLegend(state: SizeModeState): SizeLegend | null;   // null unless armed
```

Two rows, because there are two scales (decision 8) and a single strip would be a lie about half
the dots on screen. `dirs` is `null` when there is no directory scale (a flat project).

**Correction, made while building this step: `files` is `SizeLegendRow | null`, not
`SizeLegendRow`.** The shape above was written before 9.4's own rule was worked through. 9.4 says
an `error` REPLACES the rows rather than showing stale ones -- so on that path there is no file
row, and the two statements contradict each other. The first implementation reconciled them with a
`null as unknown as SizeLegendRow`, which is a type lie of exactly the kind this repository refuses
elsewhere: a caller writing `legend.files.cold` on an error legend gets a runtime `TypeError` while
`tsc` reports the code safe. The honest declaration costs three narrowings in the test file and
asserts nothing new. Same precedent as the `DEFAULT_MAX_ENTRIES + 1` correction written back into
`multi-repo-git-status.md`: the plan carries the divergence, rather than the code carrying a cast
nobody would find again.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-frontend) |
|---|---|---|
| 9.1 | `web/tests/sizeLegend.test.ts`: `sizeLegend` is `null` while `closed` and while `pending`. | The selector's guard. |
| 9.2 | RED: armed over a known fixture, the file row's three labels are `formatBytes` of the scale's p10, median and p90, in that order. | The row. |
| 9.3 | RED: a project with no directories yields `dirs: null`; a project with them yields a second row from the directory scale, whose values differ from the file row's. | The second row. |
| 9.4 | RED: `truncated` is reported in the legend (the colouring is over a cut tree and the user must be told), and an `error` replaces the rows rather than showing stale ones. | The two carried fields. |

The painter and the CSS carry no unit test, by doctrine, and land with 9.2.

**Test to write first.** 9.1 -- property: *a legend for a mode that is not armed describes nothing*.
Input that trips it today: the function does not exist; and the obvious implementation, formatting
whatever scale is on the state, produces a strip of stale numbers over a graph in extension
colours.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R10 -- `fileColor` is recomputed for every node on every frame. **Rank: next**

**What is wrong.** `renderer.ts:892` calls `fileColor(node.path)` inside the per-frame loop.
`fileColor` (`colors.ts:68-72`) does a `lastIndexOf`, a `slice`, a `toLowerCase`, a record lookup
and, on a miss, an FNV-1a hash over the whole extension or the whole path -- for a value that is a
pure function of a string that never changes.

**Where.** `renderer.ts:892`, and the same function again at `:1461` for label textures (that one
is *not* per frame -- it runs when a label slot rebinds -- and is not part of this finding).

**Why it costs.** **774 us per 1 500-node frame, measured** on this host in Node 18 against the
same 1 500 paths -- 4.6% of a 16.7 ms budget, in a frame that also runs a force layout, a bloom
composer, `updateLabels` and `updateReadMarkers`. A `Map.get` over the same keys is **157 us**, 5x
cheaper, which is exactly what this feature is about to ship for the armed case. Leaving the
unarmed case as it is means the mode is *faster than not using it*, which is an odd thing to have
to explain.

**Target shape.** The renderer already keys a `Map<string, number>` by path (`nodeIndex`,
`renderer.ts:300`) and already rebuilds it on topology change. A parallel `baseColors:
Map<string, number>` filled in the same place makes the per-frame line a lookup with the same
lifetime rules as `nodeIndex`, and `colors.ts` stays exactly as it is -- the memoisation belongs to
the caller that has a frame budget, not to the pure function.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-frontend) |
|---|---|---|
| 10.1 | `web/tests/colors.test.ts` (existing): `fileColor` still answers what it answers today for every fixture. The jaw -- the memo must change no value. | Nothing. |
| 10.2 | No unit test is possible for the renderer's cache itself (GL context). The measurement is the evidence: re-run the 1 500-path microbenchmark before and after. | The map, filled beside `nodeIndex`. |

**Rank: next**, not now. It is a real 4.6% of a frame, it is not this feature's job, and it should
not be smuggled into a step whose subject is something else -- but it was found by this work and
would be dishonest to leave unrecorded.

**Owner.** `developer-frontend`.

---

### R11 -- Sizes go stale while the mode is armed. **Rank: noted, with a trigger**

The answer describes the tree at the moment F7 was pressed. While armed, a file written by an
agent keeps its old colour, and a file created after the measurement is unmeasured grey forever --
until F7 is pressed twice.

This is the `R12` of `content-search.md` in a new place, and the same reasoning applies: the name
search has `refreshMatches` because it recomputes from an in-memory node list, and neither the
content search nor this mode can re-read the disk on every event. Re-walking on each event is
absurd; a debounced re-walk would repaint the whole graph under a user who is looking at it.

What happens instead is tolerable and worth stating: a *deleted* file leaves the graph by itself,
so its colour goes with it; a *changed* file keeps a colour that is stale only in degree; a *new*
file is unmeasured grey, which is honest. The only genuinely misleading case is a file that grew
by orders of magnitude while armed.

**Trigger to build it:** a report that the colours drift during a long session. The shape would be
a staleness marker on the legend -- an asterisk once an event has touched a measured path -- not a
re-walk, and certainly not a size on the event.

---

### R12 -- A refused `sizes` is the fifth silent `rootError`. **Rank: noted**

`server.py:847-865` answers both gate failures with `kind: "rootError"`, and `main.ts:275` paints
every `rootError` in the observed-root bar. `content-search.md` filed this as its R11 when a fourth
command made it a fourth silent case; `sizes` makes it the fifth, and **the worst-reading one so
far**: a refused search at least leaves a bar on screen with an empty count, while a refused
`sizes` looks exactly like a key that does nothing.

Two things soften it and neither fixes it. Decision 13's unconditional toggle means the mode never
wedges -- a second F7 closes it and a third retries. And `CLAUDE.md` already documents the symptom
family ("a viewer that draws the graph but refuses every ctrl+L, completion and file click is the
control token failing").

**Trigger to build it:** the first time someone reports that F7 "does nothing" and the cause turns
out to be the token. The fix is a refusal frame carrying a `for` field naming the command, plus a
router in the browser -- a change to what the security gate emits, so **hand the design to
`security-auditor`** rather than folding it into a colour feature.

---

### R13 -- One client's `sizes` blocks that client's other commands. **Rank: noted, with a trigger**

`_handle_ws_client` awaits `handle_command` inside `async for raw in websocket`
(`server.py:838-870`), so one browser's commands are serialised. That is a **good** property here
-- it is a third condition, after the binding's repeat check and the state machine's pending guard,
that stops one client having two walks in flight -- but a ~500 ms walk at the cap leaves that
browser's file clicks and `ctrl+L` unanswered for half a second. N clients pressing F7 put N walks
into the shared default executor, which also serves `scan_tree`, `file_view` and `content_search`.

This is `content-search.md`'s R14 with a smaller constant (~500 ms against ~3 s), and it inherits
that entry's warning verbatim: if a limit is ever built, **not** a module-level
`asyncio.Semaphore`, for the reason `status.py:395-400` records -- one built at import time binds
to the first loop that waits on it and raises on every loop after, which passes every single-loop
test.

**Trigger to build it:** a measured `sizes` above ~1 s on a real root, or a report of clicks
ignored right after F7.

---

### R14 -- File labels keep their extension colours while the mode is armed. **Rank: noted**

`renderer.ts:1461` tints each file label texture with `fileColor(path)`. In the armed mode the dot
is blue-to-red and its name is still `.ts` blue, which someone will read as a bug.

It is deliberate, and the reason is the label doctrine: textures are rasterised once when a slot
binds to a path and are never repainted, precisely so a new event does not re-canvas every label.
Recolouring on a mode toggle means re-rasterising up to 48 canvases inside one frame, twice per
F7. The label's job is to say *which* file, not how big it is, and the dot beside it already
carries the colour.

**Trigger to revisit:** a real screen showing that the two colours next to each other read as a
contradiction rather than as two different facts. The cheap answer then is not to recolour the text
but to drop it to a neutral while armed, which still costs one re-rasterisation per slot.

---

## 4. What conflicts with what

The three terms do not align here, and the plan resolves them in this order.

- **Maintainability vs performance, at the colour map.** The maintainable shape is
  `setSizes(Map<path, bytes>)` -- the renderer receives the data and one function turns bytes into
  a colour wherever it is needed. The measurement says that is 90 000 five-stop interpolations a
  second at 1 500 nodes, to recompute values that change only when an answer arrives. Performance
  wins, and the maintainability cost is paid down by the fact that the conversion still lives in
  exactly one place (`sizeMode.ts`) -- it just runs once instead of per frame. Same trade
  `labels.ts` already made by rasterising label textures at bind time.
- **Maintainability vs correctness, at the two scales.** One scale is one constant, one legend, one
  explanation. Two scales are two of each, and a colour that means different things on two kinds of
  dot. The measurement forces it: on one scale, 67% of this checkout's directories are in the
  hottest fifth, so the directory colour would carry no information at all. Correctness wins, and
  the cost is paid in R9's second legend row rather than hidden.
- **Simplicity vs honesty, at the scale's shape.** The symmetric median-centred spread is one
  number and one formula; the hinge is two of each and gives up the property that equal log-ratios
  are equal colour distances. `$HOME`'s empty coldest fifth is what decides it: a scale that leaves
  a fifth of the ramp unused on a real root is not simpler, it is wrong in a way that is hard to
  see. Honesty wins, and the price -- the ramp is not a ratio scale -- is stated in decision 6 and
  is what promotes the legend from "noted" to "next".
- **Completeness vs frame budget, at the answer's size.** A 2 MB frame at the cap is legal only
  because nothing bounds outbound messages. The alternative -- paginating, or capping below
  `tree.DEFAULT_MAX_FILES` -- would break the identity that makes the measured set the drawn set
  (R1), which is the property the whole feature's correctness rests on. Completeness wins, and the
  exposure is written into section 0 as the first casualty of any outbound cap.
- **Security vs surface, at the command shape.** There is no conflict to resolve here and that is
  worth saying explicitly rather than leaving as an absence: `sizes` names no path and no string of
  any kind, so it is the only command in this protocol that turns nothing from the network into
  anything. No `resolve_inside`, no `safe_read`, no `gitcmd`. **The one place a reviewer should
  look is R1 step 1.6** -- the moment `sizes.py` learns to `open()` a file, all of that changes at
  once, and the test is there because the change would look like an improvement.
- **Convenience vs the executor, at the key.** The convenient binding is "F7 toggles, and entering
  sends". Held down, that is 15 walks a second in the executor that also serves every file click
  in every browser. Two conditions on one path -- the binding declines repeats, the state machine
  declines to send while pending -- rather than two paths that each half-cover it.

Nothing here adds a path around a chokepoint: `resolve_inside` stays the only containment check and
is not involved; `gitcmd` stays the only fork and is not involved; `WsClient.send` stays the only
token stamp and gains a fifth caller for free; the two gates stay in front of every command,
including the new one, and R2 step 2.4 pins it.

---

## 5. What cannot be verified on this host

No browser, no `DISPLAY`, no Chrome, no playwright -- the same gap `CLAUDE.md` records for the read
ring, the file viewer and the content search. Everything below is a judgement a human has to make
on a real screen, and none of it is settled by either suite being green.

1. **Whether the ramp reads as a spectrum through the bloom.** Every glyph and every dot passes
   through `UnrealBloomPass` with a 0.05 threshold. A bloomed blue and a bloomed red are easy; the
   near-white middle of the ramp is the case to watch, because bloom is where a near-white becomes
   *white* and the middle third of the scale collapses into one colour.
2. **Whether the idle fade leaves the cold end visible at all.** The file branch multiplies by
   `0.35 + 0.65 * opacity`, so a long-idle file at the cold end is `(21, 38, 89)` -- barely above
   the bloom threshold on a black background. That may read as "small files disappear", which is
   not what the mode is for. If so, the fix is a higher floor **while armed only**, and it is a
   renderer constant, not a design change.
3. **Whether the unmeasured grey reads as "not measured" rather than as "median-sized"**
   (decision 12). This is the one I am least sure of, and the fallback -- a shape channel rather
   than a third shade -- is written down so nobody has to re-derive it.
4. **Whether the cold end is confusable with the search's cyan.** `SEARCH_COLOR` is `0x00e5ff` and
   the ramp's coldest stop is `0x3b6dff`. Precedence keeps a match cyan, ringed, boosted and
   pulsing, so they should read apart -- but "should" is doing work there, and a graph of small
   files is a field of blue with cyan in it.
5. **Whether directories on their own scale read as informative or as noise.** They are drawn at
   3.5 px and multiplied by 0.5; a full-range ramp squeezed into that brightness may be
   indistinguishable from today's flat grey, in which case decision 8's cost was paid for nothing
   and dropping the second scale becomes attractive.
6. **Whether F7 is actually available in the browser.** Firefox binds F7 to caret browsing and
   prompts with a dialog. `event.preventDefault()` is the mitigation and it is what the chain
   already does for every claimed key, but that it suppresses *that particular* prompt is
   asserted from documentation, not measured -- and this host cannot measure it. Chrome and
   WebKit are believed free of an F7 binding, also unmeasured.
7. **Whether the legend fits at narrow widths** (R9), and how it sits against the two search bars
   at `top: 14px` and the docked file panel at `40vw`. `CLAUDE.md` already flags the bottom row's
   behaviour at narrow widths as unverified; this adds a top-right box to a top row that has two
   centred ones.
8. **Whether 34.6 ms of aggregation is felt.** It is one hitch on one keystroke, and a force layout
   that never settles will keep moving through it. Whether that reads as "thinking" or as "stuck"
   is a judgement, not a number.
9. **Whether a real root feels instant.** Every walk number here is from this host's trees; the
   20 000-file cap on a cold or network-backed filesystem is the case the caps exist for and it has
   not been observed.

---

## 6. What I examined and found sound

- **`renderer.setSearch` / the matched branch of `updateNodeAttributes`** (`renderer.ts:694-703`,
  `:880-888`). I expected to have to widen the precedence chain so a size colour could coexist with
  a search highlight, and I do not: the matched branch already wins outright and already covers the
  open file. The user's "search keeps working normally" is satisfied by touching nothing.
- **`tree.scan_tree`'s ignore rules, symlink drop, sort and 20 000 cap** (`tree.py:64-102`).
  Reusing them is what makes "every dot the graph draws has a size" true by construction rather
  than by coincidence, and its "directories are not listed, the frontend materializes them"
  docstring settles decision 8 without further argument. No change proposed.
- **The two gates and `WsClient.send`** (`server.py:843-866`, `wsClient.ts:165-176`).
  Kind-indifferent, so a fifth kind inherits both with zero new token code. The plan's only
  obligation is not to grow a dispatch in front of them, and step 2.4 pins it.
- **`parse_command`'s per-kind required field and conditional extra key** (`server.py:462-535`).
  Designed for exactly this: the fifth kind is the first that needs no field at all, and it fits
  by *returning earlier* rather than by widening anything.
- **`handle_command`'s "every kind returns from its own branch"** (`server.py:753-758`). The rule
  exists because a fall-through would reach the `setRoot` tail; a `sizes` carries the empty path,
  which is precisely the string that rule was written about.
- **`content_search.py`'s module shape** (`:155-172`, `:245-253`) -- a pure frame builder, a
  blocking tree function, and a thin `to_thread` wrapper. R1 copies it exactly, including the
  "a dataclass smuggled through whole would raise inside the send, on the loop" comment, which is a
  real failure mode and not a stylistic note.
- **`protocol.ts`'s `isCount`** (`:370-372`). Already exactly "a non-negative integer", already in
  the module, and reusing it is what stops this feature adding a second definition of a validated
  number.
- **`fileView.ts`'s late-answer guards** (`:107-120`, `:134-144`) and `applyContentResults`'s three
  refusals. `applySizes` is the same shape for the same reason, and the "refusal returns the same
  reference" idiom carries over intact.
- **`bottomRow.ts`** (all of it). I went looking for somewhere to put the legend and found a
  module that documents, with browser measurements, exactly why its arithmetic assumes two side
  reserves. That is the module doing its job: it stopped a change before it was made, which is what
  section 1's finding 6 is.
- **`simulation.ts`'s `ancestorDirs`** (`:115-125`). The directory materialisation rule is small,
  pure and in one place, which is what makes decision 8's browser-side aggregation a copy of a rule
  rather than an invention of one. No change proposed -- and R5 step 5.4 pins that the copy agrees
  with it on the implicit intermediate directory.

---

## 7. Where I stopped

- **Not read:** `daemon/watcher.py`, `web/src/labels.ts` beyond confirming that label colours are
  bound at rasterisation and not per frame, `web/src/highlight.ts`, `web/src/layout.ts`,
  `web/src/view.ts`, and `web/src/style.css` outside the `#search`, `#content-search` and `#status`
  blocks. R9's CSS needs a real read of the stacking context around the two centred search bars
  before it is written.
- **Not measured, extrapolated:** the ~500 ms walk and ~150 ms stat at the 20 000-file cap, the
  ~57 ms browser aggregation at the same cap, and the ~2 MB frame. All are linear extrapolations
  from this host's 12 054-file home directory. The ceiling that would make them matter is a root
  above ~20 000 files on a cold or network-backed filesystem, which nothing here has seen.
- **Measured in Node, not in a browser.** The 774 us / 157 us / 96 us per-frame figures and the
  28.5 ms aggregation come from Node 18 on this host, single-purpose loops with no rendering around
  them. V8 is V8, and the 5x ratio between `fileColor` and `Map.get` is large enough to act on --
  but the absolute numbers are microbenchmarks and should be re-taken in a real frame before
  anyone quotes them as a frame budget.
- **The `$HOME` walk numbers are unstable.** 290 ms warm against 806 ms cold, and the stat pass
  moved between 58 ms and 91 ms across runs on the same tree. Both figures are in section 0 rather
  than an average of them, because the cold one is what a user pressing F7 for the first time in a
  session will meet.
- **Not run:** the opt-in packaging tests (`RHIZOME_PACKAGE_TESTS=1`). Nothing here touches
  packaging -- no new dependency on either side, and `sizes.py` is an ordinary file in a source
  tree `packaging/build-deb.sh` already installs and `compileall` already byte-compiles -- so I
  judged them irrelevant rather than checking.
- **Not settled here:** the exact five stops. They satisfy the invariant with a 2.14/255 margin at
  the white crossing, which is enough for the rule and thin enough that a retune is plausible on a
  real screen. The tests in R3 pin the *rule*, never the values, so retuning is free -- the same
  bargain the read marker's radii already take.
- **Not attempted:** any ranking of R12's severity as a security matter. The structure -- one
  refusal frame kind now serving five commands, routed into one bar about directories -- is what I
  am reporting; ranking it belongs to `security-auditor`.
- **Not verified:** that F7 is unclaimed by the browser. I checked every binding in this
  repository and found none; what Firefox, Chrome and WebKit do with the key is asserted from
  documentation and is item 6 of section 5.
