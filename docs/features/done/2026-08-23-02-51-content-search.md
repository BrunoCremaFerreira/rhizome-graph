# Plan: Content search (ctrl+shift+F) -- assessment and staged plan

- **Status:** done -- R1-R10 and R13 implemented; R11, R12 and R14 noted and not built, each
  with its trigger in section 3
- **Created:** 2026-08-23 02:51 (the commit that recorded it; the text below was written on
  2026-08-22)
- **Implemented:** 2026-08-23 (branch `development`, fast-forwarded into `main`)
- **PR/commit:** `fc6e182`, the same commit that recorded this plan; `812d9c9` for the
  `CLAUDE.md` write-up
- **Consultations (mandatory):** `software-architect` (2026-08-22) -- this document is its
  assessment and staged plan, and it names the owner of every RED/GREEN step below.
  `security-auditor` is referred to three times inside the plan; it was not consulted.

Written 2026-08-22 against `b3ae29b`, with both suites green at the numbers in section 0. Every
line number below is from that commit.

Scope: a second search that matches a literal, case-insensitive string against the **contents**
of every file the graph draws, lights the matching nodes with the same renderer channel the name
search already uses, and walks occurrence by occurrence with `F3` -- each step moving the camera
to the node and showing that file's text in the existing viewer, **docked to the right** so the
graph stays visible and interactive, with the matches highlighted in the text.

One new command kind, one new result frame, one new backend module, three new pure frontend
modules. No new runtime dependency on either side, and nothing new forks a process.

---

## 0. Baseline, measured on this host

| Measurement | Command | Result |
|---|---|---|
| Backend suite before any change | `.venv/bin/pytest -q` | `1195 passed, 20 skipped in 30.80s` |
| Frontend suite before any change | `cd web && node node_modules/vitest/vitest.mjs run` | `1002 passed (1002)`, 37 files, 9.06 s |
| Backend area this plan touches | `pytest tests/test_file_view.py tests/test_ws_commands.py tests/test_ws_control_token.py tests/test_tree.py tests/test_hexdump.py` | `170 passed in 1.89s` |
| Frontend area this plan touches | `vitest run tests/search*.test.ts tests/fileDoc.test.ts tests/fileView.test.ts tests/fileViewProtocol.test.ts` | `219 passed (219)` in 1.76 s |
| `scan_tree` over this checkout | `rhizome_graph.tree.scan_tree` | 189 files, **2.8 ms** warm |
| `scan_tree` over `~/projects` | as above | 773 files, **14.5 ms** warm, 19.6 ms cold |
| `scan_tree` over `$HOME` | as above | 789 files, **14 ms** warm (this host's home is small; see section 7) |
| Read + byte-level match, `~/projects` | open, `read(256 KiB + 1)`, `bytes.lower().count` | 773 files, **7.71 MB**, **37.5 ms** warm / **239.8 ms** cold |
| Byte match alone, corpus in memory | `bytes.lower().count(b"the")` | **15.0 ms** for 7.71 MB = **514 MB/s** |
| Same, as a regex | `re.compile(re.escape(n), re.I).findall` | **84.0 ms** = **92 MB/s**, **5.6x slower** |
| Decode + fold + count | `b.decode("utf-8","replace").lower().count` | **78.5 ms** = **98 MB/s** |
| Exact per-line extraction, hit files only | 11 files, 335 kB, 43 occurrences | **5.6 ms** |
| Inbound WebSocket frame cap, already in force | `inspect.signature(websockets.asyncio.server.serve)` | `max_size = 1048576` |

Four of these decide the design.

- **A regex engine is 5.6x slower than `bytes.lower().count` on the same corpus.** "No regex" was
  already the user's decision on ReDoS grounds; the measurement says it is also the fast answer,
  so there is no trade to argue about and no toggle worth adding later.
- **Decoding costs 5x what byte matching costs** (98 MB/s against 514 MB/s). That is what makes
  the search two passes: a byte pass over everything, an exact decoded pass over the files that
  hit. On this corpus the second pass touched 335 kB out of 7.71 MB.
- **A cold page cache is 6x slower than a warm one** (32 MB/s against ~205 MB/s end to end). The
  ceiling that has to be bounded is therefore bytes read, not files walked.
- **The transport already bounds the query.** A hostile 10 MB query cannot arrive; the frame is
  refused at 1 MiB by `websockets` before `parse_command` ever sees it. No new bound is needed
  for the inbound side, and this is worth writing down so nobody adds one.

---

## 1. Assessment: how search and the viewer are shaped today

### The seams, and which are load-bearing

**`search.ts` / `searchKeys.ts` / `searchHud.ts` is the shape to copy, not to extend.** The split
is state machine (pure) / key binding (pure) / DOM painter (thin), and every one of the 219
assertions in the area lives in the first two. Content search gets the same three parts. It does
**not** get folded into `SearchState`: the two searches have different lifecycles -- the name
search recomputes from the live node list on every event (`main.ts:187`), the content search is a
round trip that cannot be re-run per event -- and a single state with a `mode` field would put a
mode check in front of every selector `search.ts` exports. Two states, one precedence chain.
**Load-bearing.**

**`renderer.setSearch(matches, active, frame)` (`renderer.ts:675-682`) is a channel, not a
feature.** It takes a list of paths, a path to ring, and whether to fit all or approach one. It
looks each path up in the layout and **silently skips the ones it has no node for**
(`renderer.ts:1032-1035`, and `renderer.ts:859` for the tint). Nothing in it knows the paths came
from a name query. Feeding it from the content search is therefore **zero renderer change** for
the whole highlight-and-frame half of this feature, and that is the single biggest reason the
plan is as small as it is. The precondition is that only one search is armed at a time, which is
decision 4 below. **Load-bearing, unchanged.**

**`file_view.resolve_inside` (`file_view.py:91-112`) is the containment chokepoint and this
feature adds no path around it.** Content search reads files, but it reads the files
`tree.scan_tree` enumerates under the root -- it never resolves a string that arrived from the
network. The one string that does arrive, the query, is never used as a path. The click that
follows an `F3` goes through the existing `{"kind":"file"}` route and therefore through
`resolve_inside`, first and alone, exactly as it does today. **Load-bearing, unchanged, and the
plan must not grow a second read route that takes a path from a frame.**

**`fileDoc.buildDoc` is the only entry point and a pure read of the state**
(`fileDoc.ts:200-251`). Its docstring says why: a second exported "attach" step would let a caller
paint a document it forgot to attach something to, and the bug just looks like a missing feature.
Match highlighting is a decision of exactly that kind -- which characters of which row are inside
a match, and which of them is *the* match -- so it belongs inside `buildDoc`, not in the painter.
**Load-bearing.**

**`fileViewHud` is a painter and `codeCell` (`fileViewHud.ts:95-111`) is its whole token loop.**
It emits one `<span>` per `CodeToken`, sets `textContent` and `style.color`, and decides nothing.
Highlighting a match inside a coloured line means *splitting* those spans at match boundaries.
If that splitting happens in `codeCell`, it happens in the one module doctrine says is never
tested. **This is the seam most at risk in this feature.**

**`WsClient.send` (`wsClient.ts:154-163`) is the single place the control token is stamped.** A
fourth command kind inherits it for free. **Load-bearing, unchanged.**

**`_handle_ws_client`'s two gates (`server.py:778-800`)** -- `control_allowed` then
`token_matches` -- sit in front of `handle_command` and are indifferent to kind. A fourth kind
inherits both. **Load-bearing, unchanged; the plan must not add a dispatch that runs before
them.**

### The seven things that are actually in the way

1. **`ctrl+shift+F` already opens the name search.** `searchKeys.ts:54-58` claims *any*
   `ctrl`/`meta` plus `f`, deliberately lowercasing the key so a stray shift does not disable the
   shortcut. `SearchKeyEvent` (`searchKeys.ts:31-35`) does not even carry `shiftKey`, so the
   binding cannot tell the two apart. The key is not free; it is taken.
2. **`parse_command` requires a string `path` on every command** (`server.py:491`). A search
   command carries a query. Five tests assert exact dict equality over `{kind, path, token}`
   (`tests/test_ws_commands.py:102, 110, 274`, `tests/test_ws_control_token.py:143, 153`), and
   one of them says in a comment that the exactness is the point.
3. **`file_view` returns a diff whenever the file is dirty** (`file_view.py:133-139`), and the
   ordering is documented as deliberate. A content match is at a line of the file *on disk*;
   `git diff HEAD` shows hunks with three lines of context, so **most matched lines are not in
   the diff at all**. Opening the panel on an `F3` step would routinely show a document that does
   not contain the match the step was about. This is the sharpest conflict in the feature.
4. **The capped, FIFO-safe read is private to `file_view`** (`_read_capped`,
   `file_view.py:212-236`). A content search must open thousands of files. `scan_tree` filters
   symlinks (`tree.py:95-96`) but **not** FIFOs -- `os.path.islink` is false for a named pipe --
   so a project holding a build system's pipe is a tree in which a plain `open()` parks a worker
   thread forever. The defence exists and is well argued; it is just not reachable from a second
   module.
5. **The panel has one placement, and it is modal.** `#file-view` is `position: fixed; inset: 0;
   pointer-events: auto` with a 0.72-alpha backdrop (`style.css:408-432`). Nothing about it is
   parameterised, and while it is open the graph underneath receives no clicks at all.
6. **`frameMatches` assumes the whole viewport is visible** (`search.ts:248-277`). With 40% of
   the width covered by a docked panel, the node it frames is centred at 50% of the window --
   which is behind the panel.
7. **Nothing walks occurrences.** `search.ts`'s walk is over `matches: readonly string[]`, one
   step per *path*. The user's specification is one step per *occurrence*, across files, with a
   `7 / 213` counter. That is a different index space and it cannot be derived from a path list.

### Two defects this feature exposes rather than creates

- **A refusal for any command is reported as a `rootError`.** `server.py:779-800` answers both
  gate failures with `{"kind":"rootError", ...}`, and `main.ts:201` routes every `rootError` into
  `failPrompt`, which paints it in the **observed-root bar**. So a `file` command refused for a
  bad token today reports the failure in a bar about directories -- and a refused `search` will
  do the same. This is pre-existing, it is not made worse in kind by a fourth command, and it is
  filed as R11 (noted) rather than fixed here.
- **`web/index.html` is outside the language policy's scan.** `tests/test_language_policy.py:43-52`
  scans `web/src` recursively; `web/index.html` sits one level above it, and `.html` is in
  `SCANNED_SUFFIXES` only for files found under a scanned directory. This feature adds two
  user-visible strings to that file (a placeholder and a keys-legend entry). R13, next.

### What the caps must be, and why they are not the existing ones

`tree.DEFAULT_MAX_FILES` (20 000) and `file_view.DEFAULT_MAX_BYTES` (256 KiB) are both reused, and
the second reuse is **load-bearing**: the panel receives the same 256 KiB prefix the search
counted over, so the browser's own recount of the same file agrees with the daemon's count. If
the two caps ever diverge, the counter and the highlights disagree on every large file.

But 20 000 x 256 KiB is 5 GiB, so `MAX_TOTAL_BYTES` is new and is the bound that actually binds.

---

## 2. Decisions before step 1

Decisions 1-3 are the user's and are recorded here because the steps encode them, not because
they are open. Decisions 4-14 are mine; say so if you would have chosen otherwise.

1. **The docked panel is a MODE of the existing viewer.** `fileView.ts` / `fileDoc.ts` /
   `fileViewHud.ts` stay one state machine, one model, one painter. A graph click and a git-status
   row keep today's centred modal, byte for byte.
2. **`F3` walks occurrence by occurrence across files.** Crossing into another file moves the
   camera and loads that file; staying inside one must not re-request it. The counter reads
   `7 / 213`.
3. **Literal substring, case-insensitive. No regex, no toggles.**
4. **Only one search is armed at a time.** Opening either closes the other. This is what lets
   `renderer.setSearch` stay a single channel with no mode, and it is why `interpretSearchKey`
   can keep answering `null` for `F3`/`Enter`/`Escape` while its own box is closed.
5. **The content search is submitted with `Enter`, not typed live.** The name search recomputes
   from an in-memory node list; this one reads the disk. Searching per keystroke means a round
   trip per keystroke over up to 64 MiB, which is a debounce, a supersede rule and an in-flight
   cancellation -- three mechanisms to get right -- to save one key press. `Enter` is already the
   submit idiom of the root bar (`rootKeys.ts:112`). **Consequence: there is no debounce in this
   plan at all**, and the "abandoned root" family of races shrinks to one case (R3 step 3.5).
6. **Case folding is ASCII-only and length-preserving, on both sides.** Not `str.lower()`:
   `"İ".lower()` is **two** characters in Python and in JavaScript, so a Unicode fold changes
   offsets and every match range computed against it is wrong. Folding only `A-Z` also makes the
   byte-level pass and the character-level pass **the same rule** -- an ASCII byte cannot occur
   inside a UTF-8 multi-byte sequence -- which is what lets the fast pass be exact rather than
   merely a filter. Measured consequence, stated plainly: `"CAFÉ"` does **not** match a
   query of `"café"`. That is the price of length-preserving offsets and it is worth it.
7. **The result frame carries no file content and no line numbers** -- only
   `[{path, count}]`. The panel gets its text from the existing `{"kind":"file"}` round trip and
   **recomputes** the ranges from that text with the same rule. This removes three problems at
   once: byte offsets versus UTF-16 code units, escaping preview text into a frame the language
   policy would then have opinions about, and a second definition of "where the matches are".
   The cost is a disagreement window when the file changes between the grep and the click; the
   degradation rule is in R6 (the walk clamps, the counter stays the daemon's).
8. **The search reads the file set `scan_tree` returns.** Same ignore rules, same 20 000 cap,
   same sort order as the graph. Grepping a file the graph does not draw produces a highlight
   for a node that does not exist; grepping fewer produces a match the user cannot walk to.
9. **Occurrences are non-overlapping, left to right.** `"aa"` in `"aaa"` is one match. Python's
   `str.count` and a JavaScript `indexOf` loop advancing by `query.length` already agree on this;
   the point is that it is pinned in both suites rather than inherited.
10. **Files are cut alphabetically when the caps bite, and the frame says `truncated`.** No
    round-robin here: unlike the multi-repo status panel there are no groups to be unfair
    between, and `scan_tree` is already sorted, so the cut is deterministic.
11. **The `file` command grows an optional `prefer: "text"` rather than a new command kind.** A
    second read route would be a second place a path from the network is turned into an open file
    descriptor. Only the exact string `"text"` has an effect; anything else -- absent, junk,
    non-string -- means today's diff-first chain. Fail-safe: the worst case is a diff where text
    was wanted.
12. **`parse_command` returns `kind`, `path` and `token` always; any fourth key appears only when
    the frame carried it in a form this daemon understands.** This is the R5 rule of
    `2026-08-17-16-21-multi-repo-git-status.md` (the conditional `repo` key) applied to the command side, and it
    is what keeps the five pinned exact-equality assertions byte-identical. A `search` command
    parses with `path: ""` -- the gates echo `command["path"]` and must not learn a new shape.
13. **Walking opens the file, inverting `searchKeys.ts`'s own rule -- on purpose.** That module's
    docstring says walking must never become opening, because a modal over the graph on every
    `F3` step buries the thing being stepped through. The docked placement is precisely the
    condition that made the rule necessary being removed: the graph stays visible and clickable,
    and a content match is meaningless without its text. Both halves have to ship together; a
    content `F3` that opened the **modal** would reproduce the exact failure the old rule exists
    to prevent.
14. **The two implementations of the matching rule (Python and TypeScript) are kept in step by a
    shared fixture table**, not by shared code. There is no code path between the two languages
    here. The same `(text, query, expected ranges)` triples are asserted in `tests/` and in
    `web/tests/`, and the table includes the dotted capital I from decision 6. Precedent: `xxd`'s
    format is pinned against the installed binary rather than against a written spec.

---

## 3. The plan

Ranked, ordered, every step one RED test plus one GREEN implementation, both suites green between
any two steps. R1-R4 are backend and land before the front end has anything to show; R5 is a
frontend step that can land at any time and should land early, because it frees the key.

New test files throughout, so no existing assertion moves:
`tests/test_safe_read.py`, `tests/test_content_search.py`, `tests/test_ws_search_command.py`,
`tests/test_file_view_prefer_text.py`, `web/tests/matchRanges.test.ts`,
`web/tests/contentSearch.test.ts`, `web/tests/contentSearchKeys.test.ts`,
`web/tests/searchProtocol.test.ts`, `web/tests/fileDocMarks.test.ts`,
`web/tests/fileViewPlacement.test.ts`.

---

### R1 -- The FIFO-safe capped read is private, and the search needs it. **Rank: now**

**What is wrong.** `_read_capped` (`rhizome_graph/file_view.py:212-236`) and its rationale live
inside the click path. It is the one place in this project that may open a file named by
something other than a hard-coded constant, and it earns that with `O_NONBLOCK`, `fstat` on the
descriptor rather than `stat` on the path, and `is_readable_regular` (`file_view.py:187-209`).
A content search opens thousands of files and cannot reach any of it.

**Where.** `rhizome_graph/file_view.py:187-236` (the two functions and the docstring paragraph at
`:68-72`), consumed at `file_view.py:147`. The only external reference is
`tests/test_file_view.py:855`, which imports `is_readable_regular` from `rhizome_graph.file_view`
inside a helper.

**Why it costs.** Not doing this leaves exactly two options, and both are worse. Importing
`file_view._read_capped` from the search module makes the search transitively import `diff`,
`gitcmd` and `checkouts` -- weakening the "this module starts no process" contract R2 wants to
assert over its own source. Writing a second `open()` in the search module means one FIFO
anywhere under the observed root parks a worker thread on **every search**, permanently: the
executor is shared with `scan_tree` and `file_view`, workers cannot be cancelled, and shutdown
joins them, so the daemon eventually cannot even exit. A chokepoint reachable from one caller and
duplicated for the other is not a chokepoint.

**Target shape.** New `rhizome_graph/safe_read.py` holding `is_readable_regular(st_mode)` and
`read_capped(target, max_bytes) -> tuple[bytes, bool]`, with the FIFO paragraph of `file_view`'s
docstring moved onto it. `file_view.py` imports both and **re-exports** them, so
`from rhizome_graph.file_view import is_readable_regular` keeps working and
`tests/test_file_view.py` does not move. What stops the boundary being crossed later: the module
imports `errno`, `fcntl`, `os` and `stat` and nothing of ours, and its docstring says that any
read of a path this project did not itself construct goes through it.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-backend) |
|---|---|---|
| 1.1 | `tests/test_safe_read.py`: `safe_read.read_capped` returns the first N bytes and `True` for a longer file, `False` at exactly N; `safe_read.is_readable_regular` answers `False` for `S_IFIFO`. Today the module does not exist, so the import fails. | Create `safe_read.py` with the two functions moved verbatim, `_read_capped` renamed `read_capped`. |
| 1.2 | RED: `read_capped` on a real FIFO with no writer raises rather than blocking (`pytest.raises(OSError)` under a short `faulthandler` timeout, or the existing test's technique). | Nothing new -- it must already pass. This is the property being preserved across the move. |
| 1.3 | RED: `from rhizome_graph.file_view import is_readable_regular` still resolves, and `file_view` still reads through the moved function (a spy on `safe_read.read_capped` records one call for a text file). | The re-export and the call site at `file_view.py:147`. |

**Test to write first.** 1.1 -- property: *the capped read is reachable as a module of its own*.
Input that trips it today: `import rhizome_graph.safe_read` raises `ModuleNotFoundError`.

**Owner.** `developer-tester` -> `developer-backend`.

---

### R2 -- Nothing can answer "which files contain this string". **Rank: now**

**What is missing.** There is no content-reading question in the tree at all. `scan_tree` answers
"which files"; `file_view` answers "what is in *this* file"; `status.py` answers "what is dirty".
Nothing reads many files to answer one question.

**Where.** New module `rhizome_graph/content_search.py`. Not in `file_view.py` (whose whole
docstring is the ordering of one file's three renderings, and which imports the git machinery),
not in `tree.py` (which is the boot snapshot and must stay cheap enough to run on every root
switch), not in a `grep.py` (the name promises a fork, and this module's entire contract is that
it does not fork).

**Why it costs to put it elsewhere.** The next change is the one that matters: someone will want
the search to skip binaries differently, or to cap differently, or to answer for a workspace of
checkouts. In its own module that is one function's signature. Inside `file_view` it is a change
to the module that owns the click path's security ordering.

**Target shape.**

```
MAX_FILE_BYTES   = file_view.DEFAULT_MAX_BYTES   # 256 KiB, REUSED -- see below
MAX_TOTAL_BYTES  = 64 * 1024 * 1024              # new
MAX_MATCH_FILES  = 500                           # new
MAX_TOTAL_MATCHES = 5000                         # new

fold_ascii(text: str) -> str                     # pure, length-preserving, A-Z only
match_ranges(text: str, query: str) -> list[tuple[int, int]]   # pure, non-overlapping
count_matches(text: str, query: str) -> int                    # pure
search_frame(query, files, truncated, error) -> dict           # pure

search_tree(root, query, ...) -> tuple[list[FileMatches], bool]  # reads the disk, forks nothing
async def content_search(root, query) -> dict                    # to_thread + frame
```

`FileMatches` is a frozen dataclass of `path: str` and `count: int`.

The loop, per file from `scan_tree(root)`, holding **one file's bytes at a time**:

```
data, _ = safe_read.read_capped(full, MAX_FILE_BYTES)   # R1
budget -= len(data);  if budget < 0: truncated = True; break
if hexdump.looks_binary(data): continue                 # head only, 8 KiB, already written
if data.lower().count(folded_query_utf8) == 0: continue # 514 MB/s
count = count_matches(data.decode("utf-8", "replace"), query)   # 98 MB/s, hit files only
```

Five properties hold this up, and each is a test:

- **`MAX_FILE_BYTES` is `file_view.DEFAULT_MAX_BYTES`, imported, not repeated.** The panel shows
  the first 256 KiB and the search counts over the first 256 KiB, so the browser's recount of the
  panel's text equals the daemon's count. Two separate constants that happen to be equal is the
  bug waiting to happen.
- **The byte pass is a filter that cannot under-report**, because the fold is ASCII-only and an
  ASCII byte never occurs inside a UTF-8 continuation. It is not merely an optimisation; it is
  the same rule, cheaper.
- **The decoded pass is the authority**, because it is the text the panel will receive
  (`file_view.py:158` decodes with `errors="replace"`). On malformed UTF-8 the two passes can
  disagree and the decoded one wins.
- **Binaries are skipped on the head**, reusing `hexdump.looks_binary` (8 KiB sniff). A
  consequence worth stating: content search can never open the hex branch of the panel, because
  it never matches a binary.
- **The module starts no process and imports no `re`**, asserted over its parsed source the way
  `tests/test_checkouts.py` asserts it for `checkouts.py`. The `re` half is what makes "no regex
  from the network" structural rather than a promise in a docstring.

**Worst case, in the units that matter.** `MAX_TOTAL_BYTES` at the measured throughputs:
125 ms for the byte pass (514 MB/s), 650 ms if *every* file hits and takes the decoded pass
(98 MB/s), ~2.0 s of I/O on a cold cache (32 MB/s), plus a `scan_tree` of 20 000 files
extrapolated at ~375 ms. **About 3 s worst case, all of it inside `asyncio.to_thread`.** The
375 ms and the 2.0 s are extrapolations from this host's small trees, not observations; see
section 7.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-backend) |
|---|---|---|
| 2.1 | `tests/test_content_search.py`: `fold_ascii` lowercases `A-Z` and **preserves length** for the dotted capital I; `fold_ascii(s)` and `s` always have equal length, over a table including that character, a sharp s and an accented capital. | `fold_ascii` via `str.translate` with an ASCII-only table. |
| 2.2 | RED: `match_ranges("aaa", "aa") == [(0, 2)]` (non-overlapping); `match_ranges("Foo foo", "FOO")` gives both; an empty query gives `[]`; the shared fixture table of decision 14 is asserted here. | `match_ranges` over the folded copies. |
| 2.3 | RED: `count_matches` agrees with `len(match_ranges(...))` for every row of the table. | `count_matches` built on `match_ranges` -- one rule, one implementation. |
| 2.4 | RED, real files in `tmp_path`: `search_tree` finds the file containing the string, reports its count, and does **not** report a file that does not; the result is sorted by path. | `search_tree` over `scan_tree`, the two-pass loop above. |
| 2.5 | RED: a file whose first 8 KiB contain a NUL is skipped entirely, even when the needle appears after it. | The `looks_binary` gate. |
| 2.6 | RED: with `max_total_bytes` set to just under two files' worth, the third file is not read (a spy on `read_capped` counts calls) and `truncated` is `True`. | The byte budget, checked after each read. |
| 2.7 | RED: `MAX_MATCH_FILES` and `MAX_TOTAL_MATCHES` each cut the list and set `truncated`; a run that hits neither reports `truncated: False`. | The two counters. |
| 2.8 | RED: a FIFO under the root does not hang the search (bounded by a test timeout) and does not appear in the results. | Nothing new -- it must already pass because of R1. This is the pin that stops a future "optimisation" from replacing `read_capped` with `open()`. |
| 2.9 | RED, over the parsed source: `content_search.py` imports neither `subprocess` nor `re`, and names no `asyncio.create_subprocess_*`. | Nothing -- it must already pass. The contract, written down as a test. |
| 2.10 | RED: `search_frame` produces `{"kind": "searchResult", "query", "files": [{"path", "count"}], "truncated", "error"}` with only JSON types, and an empty query yields an empty `files` with `truncated: False` **without walking anything** (a spy on `scan_tree` records zero calls). | `search_frame` and the empty-query short circuit. |
| 2.11 | RED: `content_search` runs the walk off the loop -- a blocking `search_tree` stub does not stop the loop servicing another task. | `await asyncio.to_thread(search_tree, ...)`. |

**Test to write first.** 2.1 -- property: *folding for comparison must not change the length of
the text, or every offset computed against it is wrong*. Input that trips it today: the module
does not exist; and the naive implementation a developer would reach for, `str.lower()`, fails
this test on `"İ"` (length 1 in, length 2 out), which is exactly why it is step one.

**Owner.** `developer-tester` -> `developer-backend`.

---

### R3 -- A command cannot carry a query. **Rank: now**

**What is wrong.** `parse_command` (`daemon/server.py:461-497`) demands a string `path` on every
frame (`:491`) and `COMMAND_KINDS` (`:458`) is a closed three-tuple. There is no shape for a
command whose payload is text that is not a path -- and reusing `path` for a query would be a
lie that every reader of the gate at `server.py:781` and `:794` has to un-learn.

**Where.** `daemon/server.py:458` (the tuple), `:461-497` (the parser), `:710-745`
(`handle_command`). The gates at `:778-800` are **not** touched, and that is a property to test,
not just an intention.

**Why it costs.** Five tests pin the parsed dict by exact equality
(`tests/test_ws_commands.py:102, 110, 274`; `tests/test_ws_control_token.py:143, 153`), one of
them with a comment saying the exactness is deliberate because the whole token gate turns on the
difference between an absent and an empty token. An unconditional `query` key breaks all five for
no behavioural reason.

**Target shape.**

```
COMMAND_KINDS = ("complete", "setRoot", "file", "search")

parse_command:
    kind must be in COMMAND_KINDS
    if kind == "search":  query must be a str, else None;  path = ""
    else:                 path must be a str, else None
    result = {"kind", "path", "token"}  + "query" only for search
                                        + "prefer" only when it is exactly "text"   # R4
```

`path: ""` for a search is deliberate and documented: it is the echo field the two gates put into
their refusal, not a path. Keeping it present means `server.py:781` and `:794` are literally
unchanged.

`handle_command` gains one branch:

```
if kind == "search":
    asked_about = self.root
    frame = await content_search(asked_about, command["query"])
    if self.root != asked_about:
        frame = search_frame(command["query"], [], False, "the observed project changed")
    await _send(websocket, frame)
    return
```

The root re-read is `publish_status`'s rule (`server.py:598-628`) with one difference, and the
difference is the point: **status drops a stale answer, search answers anyway**. A dropped search
answer leaves the browser's `pending` flag set forever with no second reply coming -- the failure
`parseFileView`'s docstring already names for the file route. The empty-with-a-reason frame is
the honest version.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-backend) |
|---|---|---|
| 3.1 | `tests/test_ws_search_command.py`: the five existing exact-equality assertions are **re-asserted verbatim** for `complete`, `setRoot` and `file`. | Nothing -- they must already pass. This is the jaw that makes 3.2 safe to write. |
| 3.2 | RED: `parse_command('{"kind":"search","query":"needle"}')` equals `{"kind": "search", "path": "", "query": "needle", "token": ""}`. | The `search` kind and the conditional `query` key. |
| 3.3 | RED: `{"kind":"search"}` and `{"kind":"search","query":42}` are both `None`; `{"kind":"search","query":"x","token":42}` still yields the empty token. | The per-kind required field. |
| 3.4 | RED: a `search` command refused by the token gate answers a refusal frame **and never reaches** `content_search` (a spy records zero calls); and a right token from a non-loopback peer is still refused. | Nothing -- both must already pass. The pin that the fourth kind did not grow a path around the gates. |
| 3.5 | RED: a `Session` whose `content_search` is stubbed to change `session.root` mid-await answers a frame carrying the reason and **no files**, rather than the abandoned root's results. | The root comparison after the await. |
| 3.6 | RED: the answer goes to the client that asked and to nobody else (the existing `file`-command test's technique). | Nothing -- `_send`, not the hub. |

**Test to write first.** 3.1 -- property: *the three existing command shapes parse exactly as they
do today*. It is a regression jaw and it costs nothing; write it before 3.2 so the widening is
provably additive.

**Owner.** `developer-tester` -> `developer-backend`.

---

### R4 -- The panel returns a diff, and a content match is a line of the file. **Rank: now**

**What is wrong.** `file_view` tries `git diff HEAD --` first and returns it whenever it is
non-empty (`rhizome_graph/file_view.py:133-139`). `git diff` prints hunks with three lines of
context, so a file with one small edit shows perhaps 10 of its 400 lines. An `F3` step onto a
match at line 220 of a dirty file would open a document that does not contain line 220. The
counter would say `7 / 213` over a panel showing none of them.

**Where.** `rhizome_graph/file_view.py:115-160`, reached from `daemon/server.py:727`.

**Why it costs.** This is not a polish item: without it the feature is wrong on exactly the files
an agent has just touched, which are the files anyone is searching for.

**Target shape.** `file_view(root, relative_path, max_bytes=..., allow_diff=True)`. With
`allow_diff=False` the diff step is skipped and the chain becomes refused -> directory ->
not-on-disk -> text -> hex. Two things stay put:

- **`resolve_inside` stays first, alone, and unconditional.** The new parameter is read *after*
  it, and it changes no path handling whatsoever.
- **The `no such file` branch is reached earlier for a deleted file under `allow_diff=False`,
  and that is correct**: a deleted file has no content on disk, so the search never matched it
  and never asks. The status-panel click keeps `allow_diff=True` and keeps its removal diff.

On the wire: `{"kind": "file", "path": ..., "prefer": "text"}`, parsed per decision 11.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-backend) |
|---|---|---|
| 4.1 | `tests/test_file_view_prefer_text.py`, real repo in `tmp_path`: a modified tracked file answers `mode: "diff"` by default and `mode: "text"` with `allow_diff=False`, and the text is the whole file. | The parameter and the skipped branch. |
| 4.2 | RED, spy on `git_diff`: `allow_diff=False` does not fork at all. | The branch, placed before the call rather than around its result. |
| 4.3 | RED: `allow_diff=False` on a refused path still answers `refused:` and never reaches the existence check. | Nothing -- ordering must already hold. |
| 4.4 | RED, in `tests/test_ws_search_command.py`: `{"kind":"file","path":"a.txt","prefer":"text"}` parses with `"prefer": "text"`; `prefer: "diff"`, `prefer: 42` and an absent `prefer` all parse **without** the key and reach `file_view` with `allow_diff=True`. | The conditional key and the `handle_command` argument. |

**Test to write first.** 4.1 -- property: *a dirty file can be asked for as text*. Input that
trips it today: a committed file with one line changed; `file_view(root, "a.txt")` answers a diff
and there is no argument that changes it.

**Owner.** `developer-tester` -> `developer-backend`.

---

### R5 -- `ctrl+shift+F` opens the name search. **Rank: now, and it can land first**

**What is wrong.** `searchKeys.ts:54-58` returns `"open"` for any `ctrl`/`meta` plus a key that
lowercases to `f`. `SearchKeyEvent` (`:31-35`) carries `key`, `ctrlKey` and `metaKey` and cannot
see a shift. The key this feature needs is currently bound to the wrong feature, and nothing
about that is visible from the module that will bind it.

**Where.** `web/src/searchKeys.ts:31-35` and `:54-58`. `main.ts:276` passes the real
`KeyboardEvent`, which already carries `shiftKey`.

**Why it costs.** Until this lands, `ctrl+shift+F` opens the name box, and any content binding
added afterwards will either sit behind it in the chain and never fire, or sit in front of it and
silently change what the name search's own tests describe.

**Target shape.** `SearchKeyEvent` gains `readonly shiftKey?: boolean`. **Optional**, not
required: `web/tests/searchKeys.test.ts` builds plain objects, and a required field would make
every one of them a compile error -- turning a one-line semantic change into a diff across a
pinned test file. Absent means `false`, which is the unshifted meaning, which is the safe
default. The branch becomes: a shifted `ctrl+f` answers `null`, leaving the key to whoever is
next in the chain.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-frontend) |
|---|---|---|
| 5.1 | `web/tests/searchKeys.test.ts` (existing file, new cases): `{key:"F", ctrlKey:true, shiftKey:true}` answers `null` both open and closed; `{key:"f", ctrlKey:true}` with no `shiftKey` still answers `"open"`; `metaKey` + shift also `null`. | The optional field and the one condition. |

**Test to write first.** 5.1 -- property: *a shifted ctrl+F is not the name search*. Input that
trips it today: `interpretSearchKey({key:"F", ctrlKey:true, shiftKey:true}, false, false)` returns
`"open"`.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R6 -- There is no state machine for a search that is a round trip. **Rank: now**

**What is missing.** `search.ts` walks paths and recomputes on every event. A content search
submits, waits, receives, and walks occurrences. None of its transitions exist.

**Where.** Three new pure modules, plus two small additions to the wire layer:

- `web/src/matchRanges.ts` -- the rule of decision 6/9, the TypeScript half of R2's
  `fold_ascii` / `match_ranges` / `countMatches`. Its own module, not part of `contentSearch.ts`,
  because `fileDoc.ts` needs it too and `fileDoc` must not import a search state machine.
- `web/src/contentSearch.ts` -- the state machine and its selectors.
- `web/src/contentSearchKeys.ts` -- the binding.
- `web/src/protocol.ts` -- `parseSearchResult`, beside `parseFileView` (`:302-334`).
- `web/src/wsClient.ts:178-232` -- one more route, before `parseEvent`, consumed with or without
  a sink, exactly as `parseStatus` is and for the same reason (a result frame routed as an event
  would grow a node called `searchResult` in the graph).

**Why it costs to skip a module.** Folding the ranges into `contentSearch.ts` means `fileDoc.ts`
imports the search state to highlight a row -- the panel would then depend on the search, and the
modal path would carry a dependency it never uses.

**Target shape.**

```ts
// matchRanges.ts
export function foldAscii(text: string): string;                    // length-preserving
export interface MatchRange { readonly start: number; readonly end: number }
export function matchRanges(text: string, query: string): MatchRange[];
export function countMatches(text: string, query: string): number;

// contentSearch.ts
export interface FileMatchCount { readonly path: string; readonly count: number }
export interface ContentSearchState {
  readonly open: boolean;
  readonly query: string;       // what is in the field
  readonly submitted: string;   // the query the results describe, "" when none
  readonly pending: boolean;    // a request is in flight
  readonly files: readonly FileMatchCount[];
  readonly truncated: boolean;
  readonly error: string;
  readonly occurrence: number;  // global 0-based index; -1 before the first F3
}
createContentSearch / openContentSearch / setContentQuery / submitContentSearch
applyContentResults(state, frame) / failContentSearch / nextOccurrence / closeContentSearch
// selectors
matchedPaths(state): readonly string[]
totalMatches(state): number
activeOccurrence(state): { path: string; indexInFile: number } | null
isDirty(state): boolean                       // query !== submitted
requiresLoad(state, loadedPath): string | null
docMarkingFor(state, path): DocMarking | null
searchFrameOf(state): SearchFrame             // "all" until the first F3, then "active"
```

Five rules carry it, each a test:

- **`applyContentResults` refuses three ways and returns the SAME reference**, the idiom
  `applyView` established (`fileView.ts:134-144`): not open, not pending, or `frame.query !==
  state.submitted`. The third is what drops the answer to a superseded submission.
- **`setContentQuery` does not search and does not clear the results.** Typing over a finished
  search keeps the highlights and the counter until `Enter`; that is what makes `isDirty` mean
  something and what makes decision 5 livable.
- **`nextOccurrence` wraps and is a no-op on an empty result set.** `searchFrameOf` answers
  `"all"` while `occurrence < 0` and `"active"` after, so `renderer.setSearch` gets exactly the
  two behaviours it already implements.
- **`requiresLoad` is what stops a re-request inside one file.** It answers the path only when
  `activeOccurrence(state).path !== loadedPath`. Decision 2, expressed as a pure function so that
  `main.ts` holds a call and not a comparison.
- **The walk clamps rather than breaking.** `activeOccurrence` maps the global index into
  `files` by cumulative count; the panel's own recount of the loaded text may be smaller (the
  file changed between the grep and the click), and `fileDoc` clamps the active range to the last
  one it found. The counter keeps the daemon's numbers. Stated degradation, not a silent one.

`contentSearchKeys.ts` mirrors `searchKeys.ts`, including the "every key answers `null` while
closed" rule that `fileViewKeys` and `fileViewClicks` both state:

```ts
interpretContentSearchKey(event, open, dirty):
  ctrl/meta + shift + "f"  -> "open"     (whatever `open` is: reopening refocuses)
  !open                    -> null       for everything else
  "Enter"                  -> dirty ? "submit" : "next"
  "F3"                     -> "next"
  "Escape"                 -> "close"
```

`Enter` mirrors `interpretSearchKey`'s `fileFocused` parameter exactly: a fact the state machine
knows, passed in, so the binding stays a table of keys.

**Precedence in `main.ts:234-311`** becomes: file-view key -> root key -> **content search key**
-> name search key. Consequences, all of which follow from bindings that already decline while
closed:

- With the docked panel open, `Escape` closes the **panel** first (`interpretFileViewKey` goes
  first and claims it), and a second `Escape` closes the bar. That is VS Code's behaviour and it
  needs no new rule.
- `F3` is not claimed by `interpretFileViewKey` (`fileViewKeys.ts:33` answers only `Escape`), so
  it falls through to the content binding while the panel is docked. That is required: walking
  with the panel open is the feature.
- The name search cannot be open at the same time (decision 4), so its `F3`/`Enter`/`Escape`
  branch is unreachable while the content bar is open, with no change to `searchKeys.ts` beyond
  R5.
- Closing the content search leaves a docked panel open. The alternative -- closing it too -- is
  a coupling between two state machines to save one `Escape`, and the panel is still a perfectly
  readable file.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-frontend) |
|---|---|---|
| 6.1 | `web/tests/matchRanges.test.ts`: `foldAscii` preserves length for the dotted capital I; the shared fixture table of decision 14, asserted here in the same order as in `tests/test_content_search.py`. | `matchRanges.ts`, folding with a char-code map, never `toLowerCase()`. |
| 6.2 | RED: `matchRanges("aaa","aa")` is one range at `[0,2)`; `countMatches` equals `matchRanges().length` for the whole table; an empty query gives `[]`. | The loop advancing by `query.length`. |
| 6.3 | `web/tests/searchProtocol.test.ts`: a well-formed frame parses; a wrong `kind` is `null`; a non-string `query` is `null` (an answer naming no query cannot be matched to a submission); a junk entry is dropped **one at a time** while the frame survives; a non-integer or negative `count` drops its entry; `truncated`/`error` degrade. | `parseSearchResult` in `protocol.ts`. |
| 6.4 | `web/tests/wsClientSearch.test.ts`: a `searchResult` frame reaches `onSearchResult` and **never** `onEvent`; it is consumed even with no sink. | The route in `wsClient.handleMessage`, before `parseEvent`. |
| 6.5 | `web/tests/contentSearch.test.ts`: `openContentSearch` gives an empty, non-pending state; `setContentQuery` changes `query` and leaves `submitted`, `files` and `occurrence` alone; `submitContentSearch` sets `pending` and copies `query` into `submitted`. | The three transitions. |
| 6.6 | RED: `applyContentResults` returns the same reference when closed, when not pending, and when `frame.query !== submitted`; adopts otherwise and clears `pending`. | The three guards. |
| 6.7 | RED: `totalMatches` sums the counts; `activeOccurrence` maps global index 6 into the right file and `indexInFile`; it wraps at the end; it is `null` for an empty result set and before the first `nextOccurrence`. | The cumulative mapping. |
| 6.8 | RED: `requiresLoad` answers `null` while the active occurrence stays in the loaded file and the path when it crosses into another. | The comparison. |
| 6.9 | RED: `searchFrameOf` is `"all"` before the first walk and `"active"` after; `closeContentSearch` returns a state equal to `createContentSearch()`. | The selector and the close. |
| 6.10 | `web/tests/contentSearchKeys.test.ts`: the table above, including *every key answers `null` while closed except the shifted ctrl+F*, and `Enter` -> `"submit"` when dirty, `"next"` when not. | `contentSearchKeys.ts`. |
| 6.11 | RED: `docMarkingFor(state, path)` answers `null` for a path that is not among the matches and for an empty `submitted`; otherwise the submitted query and the index of the active occurrence **within that file**. | The selector -- this is what R7 consumes. |

**Test to write first.** 6.1 -- property: *the browser folds case exactly as the daemon does, and
without changing the length of the text*. Input that trips it today: the module does not exist,
and `"İ".toLowerCase()` is two characters in JavaScript too, so the obvious implementation
fails the first assertion.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R7 -- The panel cannot highlight a match inside a coloured line. **Rank: now**

**What is missing.** A row is painted either as one text node or as a run of `<span>`s, one per
`CodeToken` (`fileViewHud.ts:95-111`). A match highlight crosses those spans arbitrarily -- half
a keyword, one whole string, the space between two tokens -- so painting it means **splitting the
token run at match boundaries**. Nothing in `fileDoc.ts` knows about matches, and if the split
happens in `codeCell` it happens in the one module that cannot be tested.

**Where.** `web/src/fileDoc.ts:58-68` (`Row`), `:79-94` (`FileDoc`), `:200-251` (`buildDoc`);
`web/src/fileViewHud.ts:95-111` (`codeCell`), `:119-137` (`paintRows`), `:162-191` (`render`);
`web/src/style.css` (two new rules under `#file-view #file-view-body .row`).

**Why it costs.** Splitting spans by index is exactly the kind of arithmetic that is
"silently, plausibly wrong" -- `fileDoc`'s own docstring uses that phrase about `stitch`. Untested,
the failure is one character of highlight offset on rows with tabs or multi-byte characters, which
nobody notices and everybody distrusts.

**Target shape.** `buildDoc` gains a **second, optional argument** rather than two new fields on
`FileViewState`:

```ts
export interface DocMarking { readonly query: string; readonly activeMatch: number | null }
export type MarkKind = "none" | "match" | "active";
export interface MarkedSpan extends CodeToken { readonly mark: MarkKind }

// Row gains:      readonly spans: readonly MarkedSpan[] | null;
// FileDoc gains:  readonly activeRow: number | null;
export function buildDoc(state: FileViewState, marking?: DocMarking): FileDoc;
```

Why an argument and not state: the query and the active occurrence belong to the **search**, and
copying them onto `FileViewState` creates two owners for one fact and a synchronisation bug the
first time an answer lands late. `main.ts` passes `docMarkingFor(contentSearch, fileView.path)`
(R6 step 6.11), which is `null` on every path the content search did not open -- so the modal
route calls `buildDoc(state)` with one argument and behaves byte for byte as it does today.

Why a new `spans` field rather than changing `tokens`: `web/tests/fileDoc.test.ts` and
`web/tests/fileViewHighlight.test.ts` assert on `row.tokens` as `CodeToken[]`. An extra `mark` key
on those objects fails deep-equality assertions across a pinned file. `spans === null` is the
existing path, untouched; `spans !== null` is the new one, and the painter branches once.

Three invariants, each a test:

- **`spans.map(s => s.text).join("") === row.text`.** The splitter must not lose, duplicate or
  reorder a character. This is `fileDoc`'s `code.split("\n").length === rows.length` for the new
  axis, and it is the assertion that catches every off-by-one.
- **A row with `tokens === null` still gets spans** (plain text, colour `""`), so an uncoloured
  file -- a diff over budget, an unknown extension -- is still highlighted. Colour is the
  optional layer; the match is not.
- **`MAX_MARKS_PER_DOC = 2000`.** Past it only the active occurrence's row is marked. A one-letter
  query over a 4 000-line file would otherwise add ~40 000 spans to a panel that is rebuilt on
  every paint, and the panel shares a frame budget with a force layout that never settles. The
  counter already tells the user how many there are; the panel is read, not counted.

`FileDoc.activeRow` is the row index holding the `activeMatch`-th range, counted across rows in
order, or `null`. It is `null` on the plain fast path (`rows === null`, i.e. past `MAX_ROWS`) --
a 20 000-row file gets neither highlight nor scroll, which is the same degradation that path
already applies to colour.

The painter then: uses `row.spans` when non-null (one `<span>` per span, `classList.add("match")`
or `"match active"`), and scrolls `doc.activeRow` into view when it is not `null`, ahead of the
existing `keepScroll` rule. `textContent` never `innerHTML`, and the mark is a **class**, not an
inline style, so the two shades live in the stylesheet next to the diff palette.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-frontend) |
|---|---|---|
| 7.1 | `web/tests/fileDocMarks.test.ts`: `buildDoc(state)` with **no** second argument produces `spans === null` on every row and `activeRow === null` -- today's shape, unchanged. | Nothing beyond the field defaults. The jaw for everything below. |
| 7.2 | RED: with a marking, a row of plain text (`tokens === null`) is split into spans whose concatenated text equals `row.text` and whose middle span is marked. | The splitter over the plain branch. |
| 7.3 | RED: a match that starts inside one token and ends inside the next produces spans whose text concatenates to `row.text`, whose colours are inherited from the token each fragment came from, and where exactly the matched fragments are marked. | The splitter over the token branch. |
| 7.4 | RED: `activeMatch: 3` marks the fourth range in document order `"active"` and the rest `"match"`; `activeRow` is that range's row. `activeMatch: null` marks all of them `"match"` and `activeRow` is `null`. | The document-order counter. |
| 7.5 | RED: `activeMatch` larger than the number of ranges found **clamps to the last one** rather than producing `activeRow: null` -- the R6 degradation rule, pinned where it is implemented. | The clamp. |
| 7.6 | RED: past `MAX_MARKS_PER_DOC` only the active row carries spans and every other row keeps `spans === null`. | The budget. |
| 7.7 | RED: a `mode: "diff"` state with a marking still parses into diff rows and marks them (the modal path never passes one, but the model must not depend on that). | Nothing -- it must already pass. Pins that marking is orthogonal to mode. |

**Test to write first.** 7.1 -- property: *a document built with no marking is exactly today's
document*. Input: any existing `fileDoc.test.ts` fixture, re-asserted for the two new fields.
Write it before the splitter exists, so the additive change is provable.

**Owner.** `developer-tester` -> `developer-frontend`. Steps 7.1-7.7 are `fileDoc.ts`; the painter
change in `fileViewHud.ts` and the CSS carry no unit test (DOM-bound by doctrine) and land with
7.3 and 7.4 respectively.

---

### R8 -- The panel has one placement and it buries the graph. **Rank: now**

**What is wrong.** `#file-view` is `position: fixed; inset: 0; display: flex; pointer-events:
auto` with a 0.72-alpha backdrop (`web/src/style.css:408-432`). The container covers the whole
window, so even without the backdrop's paint it would swallow every click meant for a file dot.
A search result that hides the graph it is pointing at is a modal with extra steps.

**Where.** `web/src/fileView.ts:39-60` and `:85-87`; `web/src/fileViewHud.ts:140-142` and
`:162-191`; `web/src/style.css:408-465`; `web/index.html:52-63` needs no change.

**Why it costs.** The docked layout is what makes decision 13 defensible -- it is the reason
walking may open a file at all. Without it the feature has to choose between a modal on every
`F3` step and no panel.

**Target shape.** `placement` on the panel's state, defaulted so nothing else moves:

```ts
export type FileViewPlacement = "modal" | "docked";
// FileViewState gains:  readonly placement: FileViewPlacement;   // "modal" in createFileView
requestView(state, path, placement: FileViewPlacement = "modal"): FileViewState
```

The painter sets one class (`container.classList.toggle("docked", state.placement === "docked")`)
and the stylesheet does the rest. **Three CSS rules are load-bearing** and each is the sort of
thing that is invisible until someone clicks:

```
#file-view.docked                     { pointer-events: none; justify-content: flex-end; }
#file-view.docked #file-view-panel    { pointer-events: auto; width: 40vw; height: 100vh; }
#file-view.docked #file-view-backdrop { display: none; }
```

The first is the one that matters: without it the full-window flex container keeps eating clicks
and the graph is as dead as it is under the modal, with nothing on screen to explain why.

What is deliberately **not** done:

- **The canvas is not resized.** It stays full-window under the panel, so `renderer.resize()`
  (`renderer.ts:752`) and the camera aspect (`renderer.ts:1172`) are untouched, and no frame
  budget is spent re-allocating a render target when the panel opens. What that leaves is a
  camera that frames its target at 50% of the window, i.e. behind the panel -- fixed purely, in
  R9.
- **`#status` is not hidden.** It is bottom-right at 32vw and the panel is `position: fixed`
  later in DOM order, so the panel simply paints over it. Hiding it would be a second rule about
  a second panel; covering it costs nothing and is undoable by closing the viewer. Flagged in
  section 6 as a visual unknown.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-frontend) |
|---|---|---|
| 8.1 | `web/tests/fileViewPlacement.test.ts`: `createFileView().placement === "modal"`; `requestView(s, "a.txt")` with no third argument is `"modal"`; every other transition (`applyView`, `applyTokens`, `failView`) preserves it; `closeView` returns to `"modal"`. | The field and the default. |
| 8.2 | RED: `requestView(s, "a.txt", "docked").placement === "docked"`, and a late `applyView` for that path keeps it docked. | The third parameter. |
| 8.3 | RED: `web/tests/fileView.test.ts` re-run unchanged -- no existing assertion moves. | Nothing. The pin that the field is additive. |

The painter's class toggle and the three CSS rules land with 8.2 and carry no unit test.

**Test to write first.** 8.1 -- property: *the panel's placement is modal unless something asks
otherwise, and no transition loses it*. Input that trips it today: `createFileView().placement`
is `undefined`.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R9 -- The camera frames the match behind the docked panel. **Rank: now, last**

**What is wrong.** `frameMatches` (`web/src/search.ts:248-277`) centres its target on the whole
viewport and sizes the fit against the full `aspect`. With 40% of the width covered, the node an
`F3` step just approached sits under the panel, and a multi-match fit spreads its right-hand
matches under it too.

**Where.** `web/src/search.ts:248-277`, called from `web/src/renderer.ts:1039`.

**Why it costs.** The step lands on nothing visible, which reads as the camera being broken. It is
ranked last because the feature is testable and shippable without it and because it is the only
step that touches the renderer.

**Target shape.** A third, defaulted parameter -- so all of `web/tests/searchFrame.test.ts` keeps
compiling and passing:

```ts
frameMatches(points, aspect, occludedRight = 0): ViewTarget | null
```

With half-width `halfW = halfHeight * aspect` and an occluded right fraction `f`, the visible band
runs from `-halfW` to `halfW * (1 - 2f)` in camera space and its centre is at `-halfW * f`. So
`centerX = targetCentreX + halfW * f`, and the width-driven half-height divides by `(1 - f)`
because only that fraction of the width is usable. `f` is clamped to `[0, 0.9)`: a panel claiming
the whole width would otherwise divide by zero and hand the camera an infinite half-height, which
is the same class of bug the existing `safeAspect` guard at `:253` exists for.

The renderer passes the fraction it can measure -- the panel's width over the canvas width, or
`0` when the panel is closed or modal -- through a setter beside `setOpenFile`
(`renderer.ts:627`). It must not import the panel's CSS constant; the number is a measurement,
not a duplicate of `40vw`.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-frontend) |
|---|---|---|
| 9.1 | `web/tests/searchFrame.test.ts` (existing file): `frameMatches(points, aspect)` with no third argument returns exactly what it returns today, for every existing fixture. | Nothing. The jaw. |
| 9.2 | RED: with `occludedRight = 0.4`, a single point's `centerX` is shifted right by `halfHeight * aspect * 0.4` and `centerY` is unchanged. | The offset. |
| 9.3 | RED: a wide spread of points needs a half-height `1 / (1 - f)` larger than with `f = 0`, still clamped by `MIN_HALF_HEIGHT`/`MAX_HALF_HEIGHT`; `f = 1`, `f = -1` and `NaN` all degrade to `0`. | The divisor and the clamp. |

**Test to write first.** 9.1 -- property: *the two-argument call is unchanged*. It costs one
parameterised re-run of the existing fixtures and it is what makes 9.2 safe.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R10 -- Wiring. **Rank: now, and it has no test of its own**

`main.ts` is the composition root and is not unit-tested, by doctrine. This step is listed
separately and **explicitly carries no RED test**, which is only acceptable because every decision
it needs was pinned in R6-R9 first. If a reviewer finds a branch here that is not a call to one of
those, that is the finding.

What it adds:

- a third state variable and a `showContentSearch(next)` beside `showSearch` and `showFileView`,
  which paints the bar and calls `renderer.setSearch(matchedPaths(s), activeOccurrence(s)?.path
  ?? null, searchFrameOf(s))` -- the same channel, no renderer change;
- `openFile(path, placement)` gaining its second parameter, passed `"docked"` from exactly one
  call site;
- `client.send({kind: "search", query})` on `"submit"`, and `client.send({kind: "file", path,
  prefer: "text"})` on a walk that `requiresLoad` says needs one;
- `buildDoc(fileView, docMarkingFor(contentSearch, fileView.path) ?? undefined)` in
  `showFileView`;
- `onSearchResult: (frame) => showContentSearch(applyContentResults(contentSearch, frame))`;
- `onReset` (`main.ts:209-225`) clearing the content search alongside everything else. This is
  what makes R3 step 3.5 complete: the frame that says "the observed project changed" arrives at
  a browser whose `pending` is already `false`, so `applyContentResults` refuses it by the second
  guard and nothing spins.

New DOM in `web/index.html`: a `#content-search` bar mirroring `#search` (`index.html:24-33`) with
an input, a count span, and a short label reading `in files` -- **the label is load-bearing**,
because two identical boxes in the same screen position with different behaviours is worse than
either. Same slot as `#search`, since decision 4 guarantees only one is open. The keys legend
(`index.html:14-17`) gains one entry.

**Owner.** `developer-frontend`.

---

### R11 -- Every command refusal is reported as a `rootError`. **Rank: noted**

`server.py:779-800` answers both gate failures with `kind: "rootError"`, and `main.ts:201` paints
every `rootError` in the observed-root bar. A `file` command refused for a bad token already
reports itself in a bar about directories; a refused `search` will too. The cost is a real one --
"a viewer that draws the graph but refuses every ctrl+L, completion and file click" is already a
documented symptom in `CLAUDE.md`, and this adds a fourth silent case to it -- but the fix is a
new refusal frame kind with a `for` field naming the command, plus a router in the browser, and
that is a change to the security-relevant path for a feature that does not need it. **Trigger to
build it:** the first time someone reports a content search that "does nothing" and the cause
turns out to be the token. Hand the design to `security-auditor` if it is built, since it changes
what the gate emits.

---

### R12 -- Results go stale as the tree changes. **Rank: noted, with a trigger**

The name search has `refreshMatches` (`search.ts:167-177`) driven from every event
(`main.ts:187`). A content search cannot have it: re-grepping 64 MiB per file event is absurd, and
even a debounced version would restart the walk under an `F3` the user is in the middle of.

What happens instead, and it is enough: a file deleted from the graph stops being highlighted by
itself, because `renderer.setSearch` skips paths with no node (`renderer.ts:1032-1035`); a file
whose contents changed keeps its old count until the next `Enter`; and the panel's own recount of
the text it received is what gets highlighted, so the highlight is never wrong about the document
on screen -- only the counter can be, and only by being stale.

**Trigger to revisit:** a measured complaint that the counter drifts during a long session.
The shape would be a staleness marker on the bar (an asterisk on the counter once an event has
touched a matched path), not a re-grep.

---

### R13 -- `web/index.html` is outside the language policy's scan. **Rank: next**

`tests/test_language_policy.py:43-52` scans `web/src` recursively and four named root files.
`web/index.html` is in neither list, so its placeholder text, its keys legend and its
`aria-label`s are unchecked -- and this feature adds two more strings to it. The fix is one entry
in `SCANNED_FILES` and a RED test asserting that `web/index.html` is among `_scanned_files()`.
Cheap, and it should land with R10 rather than after it.

**Owner.** `developer-tester` -> `developer-backend` (the policy test is Python).

---

### R14 -- One client's search blocks that client's other commands. **Rank: noted, with a trigger**

`_handle_ws_client` awaits `handle_command` inside `async for raw in websocket`
(`server.py:774-804`), so commands from one browser are serialised. That is a **good** property
here -- it means one client cannot have two searches in flight and there is no supersede race on
the daemon side at all -- but it also means a 3 s search leaves that browser's file clicks and
`ctrl+L` unanswered for 3 s. Other clients are unaffected (one task each), though N clients
searching at once put N walks into the shared default executor, which also serves `scan_tree` and
`file_view`.

**Trigger to build it:** a measured search above ~1 s on a real root, or a report of clicks being
ignored mid-search. The shape would be a per-connection task holding at most one search, cancelled
and replaced by the next one -- **not** a module-level semaphore, for the reason
`status.py:395-400` records: a semaphore built at import time binds to the first loop that waits
on it and raises on every loop after, which passes every single-loop test.

---

## 4. What conflicts with what

The three terms do not align here, and the plan resolves them in this order.

- **Maintainability vs performance, at the two-pass loop.** The maintainable answer is one pass
  over decoded text: one rule, one code path, nothing to keep in step. The measurement says that
  costs 5x (98 MB/s against 514 MB/s), and the second pass touched 4% of the corpus on a real
  query. Performance wins, and the maintainability cost is paid down by decision 6: because the
  fold is ASCII-only, the two passes are **the same rule at two granularities** rather than two
  rules that have to agree. Had the fold been Unicode, the fast pass would have been a heuristic
  and this trade would have gone the other way.
- **Maintainability vs correctness, at the match ranges.** Two implementations of one rule
  (Python and TypeScript) is a drift risk with no shared-code answer available. Sending ranges
  from the daemon would remove one of them -- and would replace it with byte offsets that have to
  be converted to UTF-16 code units in the browser, which is a *third* rule and a harder one.
  Recomputation wins, and the shared fixture table (decision 14) is what keeps it honest.
- **Performance vs completeness, at `MAX_TOTAL_BYTES`.** 64 MiB is a cut, and over a big monorepo
  it will cut. The alternative is a search whose worst case is the disk's, polled by an
  impatient user. The frame says `truncated` and the alphabetical cut is deterministic, which is
  the same bargain the status panel already makes at 200 entries.
- **Security vs convenience, at the read.** The convenient shape for a bulk reader is a plain
  `open()` in a loop: no `fcntl`, no `fstat`, no descriptor juggling, and measurably faster per
  file. It is also a second way into the same syscall with none of the FIFO defence, in a module
  whose whole job is to open thousands of files it did not choose. R1 pays for the extraction
  first so there is exactly one such path. **If R2 is implemented with a bare `open()`, that is a
  finding for `security-auditor`, not a style note** -- the failure mode is a permanently parked
  worker thread and a daemon that cannot exit.
- **Security vs surface, at the command shape.** A separate `searchFile` command would have been
  simpler to parse than `prefer: "text"` on the existing one. It would also be a second route
  from a network string to an open file descriptor, bypassing nothing today and everything the
  day someone edits one of them. One route, one parameter.

Nothing here adds a path around a chokepoint: `resolve_inside` stays the only containment check
and stays first; `gitcmd` stays the only fork; `WsClient.send` stays the only token stamp; the two
gates stay in front of every command, including the new one, and R3 step 3.4 pins it.

---

## 5. What cannot be verified on this host

No browser, no `DISPLAY`, no Chrome, no playwright -- the same gap `CLAUDE.md` records for the
read ring and the file viewer. Everything below is a judgement a human has to make on a real
screen, and none of it is settled by either suite being green.

1. **Whether a 40vw docked panel leaves a usable graph.** The point of docking is that the tree
   stays legible and clickable beside the text. At what window width it stops being true is
   unknown; a laptop at 1366 px gives the graph 820 px.
2. **Whether the graph really stays interactive.** The `pointer-events: none` on the container
   with `auto` on the panel is the rule that decides it, and it is CSS -- no test in this repo
   can reach it. Someone must click a file dot with the panel open.
3. **Whether the camera offset of R9 looks right.** The arithmetic is testable; whether framing a
   match at 30% of the window reads as centred, or as pushed to the edge, is not.
4. **How the docked panel sits against `#status`, `#context` and `#hud`.** `CLAUDE.md` already
   flags the bottom-right panel's behaviour at narrow widths as unverified; a 40vw right panel
   covering it is a new case on top of an unverified one. `#context` is centred at 50vw and will
   be partly covered.
5. **Whether the two match shades are distinguishable** over the diff stripes and the Dark+
   token colours, and whether the active one is findable at a glance. The stripes are already
   translucent by design (`style.css:445-452`), so a third translucent layer over a coloured
   token is a real legibility question.
6. **Whether `scrollIntoView` on the active row is calm or jarring** when `F3` steps within one
   file, and whether `block: "center"` is the right choice against `"nearest"`.
7. **Whether two search boxes in the same screen slot confuse.** The `in files` label is the
   mitigation and it is untested by anything but a reader.
8. **Whether a real search feels instant.** Every number in section 0 is from trees of a few
   hundred files. A 20 000-file checkout on a cold cache is the case the caps exist for and it
   has not been observed.

---

## 6. What I examined and found sound

- **`renderer.setSearch` / `updateSearchCamera`** (`renderer.ts:675-690`, `:1012-1049`). I
  expected to have to widen this for a second search and I do not: it is already a path-set
  channel that skips unknown paths and recomputes its target every frame. Only R9's third
  parameter touches it, and that is about a panel, not about a second search.
- **`resolve_inside`** (`file_view.py:91-112`). Orthogonal to this feature: the search never
  resolves a network string as a path, and the click that follows an `F3` goes through the
  existing route unchanged. No second containment check is proposed and none is needed.
- **The two gates** (`server.py:778-800`). Kind-indifferent, so a fourth kind inherits both. The
  plan's only obligation is not to grow a dispatch in front of them, and step 3.4 pins it.
- **`WsClient.send`** (`wsClient.ts:154-163`). One new command, zero new token code.
- **`hexdump.looks_binary`** (`hexdump.py:34-35` and its 8 KiB sniff). Written for one file at a
  time and correct for thousands: it reads only the head, which is the whole reason it is affordable
  in a loop.
- **`fileView.ts`'s late-answer guards** (`:107-120`, `:137-145`). `applyContentResults` is the
  same shape for the same reason, and the "refusal returns the same reference" idiom carries over
  intact.
- **`parseFileView`'s degrade-a-field-never-drop-the-frame doctrine** (`protocol.ts:302-334`).
  `parseSearchResult` copies it, including the one hard requirement -- the echo field must be a
  string or the frame cannot be matched to what asked for it.
- **`fileDoc`'s "a `highlight` whose shape disagrees paints NOTHING" rule** (`:36`, `:179-197`).
  R7 does not weaken it: marks are computed from the row text itself, never indexed against a
  separately delivered array, so there is no shape to disagree.
- **`tree.scan_tree`'s ignore rules and 20 000 cap** (`tree.py:48-102`). Reusing them is what
  makes "matching nodes light up" true by construction rather than by coincidence. No change
  proposed.
- **`status.py`'s "semaphore inside the call"** (`:395-400`). Not needed by this plan -- decision
  5 removes the concurrency it would guard -- but it is the shape R14 must take if it is ever
  built, and it is recorded there so nobody re-derives it.

---

## 7. Where I stopped

- **Not read:** `daemon/watcher.py`, `web/src/simulation.ts` beyond `listNodes`,
  `web/src/labels.ts`, `web/src/highlight.ts` beyond confirming that nothing in this plan imports
  it, and `web/src/style.css` outside the `#file-view` and `#search` blocks. R8's CSS needs a real
  read of the stacking context around `#status` before it is written.
- **Not measured, extrapolated:** the ~375 ms `scan_tree` over 20 000 files and the ~2.0 s cold
  read of 64 MiB. Both are linear extrapolations from trees of 773 files and 7.71 MB on this host,
  whose `$HOME` yields only 789 files after pruning. The ceiling that would make them matter is a
  checkout above ~5 000 files on a cold or network-backed filesystem, which nothing here has seen.
- **Not measured:** the DOM cost of `MAX_MARKS_PER_DOC`. 2 000 extra spans is a guess at a safe
  ceiling in the same spirit as `MAX_SCANNED_DIRS`, not an observed frame-time budget. Step 7.6
  makes it a pinned guess.
- **Not measured:** whether `bytes.lower()` on a 256 KiB buffer allocates enough per-file garbage
  to matter across 20 000 files. It doubles peak memory for one file at a time, which is 512 KiB,
  so I judged it free rather than measuring it.
- **Not run:** the opt-in packaging tests (`RHIZOME_PACKAGE_TESTS=1`). Nothing here touches
  packaging -- no new dependency on either side, and the new modules are ordinary files in the two
  source trees `packaging/build-deb.sh` already installs -- so I judged them irrelevant rather
  than checking. The one thing worth a glance when R2 lands: `compileall` runs over both source
  trees, so `content_search.py` and `safe_read.py` ship byte-compiled like everything else,
  with no change to the script.
- **Not settled here:** the exact two mark colours. They are a stylesheet decision and belong
  next to the diff palette (`style.css:445-458`), chosen against `#1e1e1e` with the same
  contrast reasoning the stripes already record.
- **Not attempted:** any judgement about how severe R11 is as a security matter. The structure --
  one refusal frame kind serving four commands, routed into one bar -- is what I am reporting;
  ranking it belongs to `security-auditor`.
