# Plan: Dotted names on the graph, `.gitignore` as the filter -- assessment and staged plan

- **Status:** done -- G1-G7 implemented; G8, G9 and G10 noted and not built, each with its
  trigger in section 3
- **Created:** 2026-08-26 18:43
- **Implemented:** 2026-08-26 (branch `development`, fast-forwarded into `main`)
- **PR/commit:** `db23a79`, the same commit that recorded this plan
- **Consultations (mandatory):** `software-architect` (2026-08-26) -- this document is its
  assessment and staged plan, and it names the owner of every RED/GREEN step below.
  `security-auditor` is referred to five times inside the plan, the residual ReDoS question
  among them; it was not consulted.

Written 2026-08-26 against `dcf103a`, with the suites at the numbers in section 0. Every line
number below is from that commit.

Scope: the graph draws the directories and files whose names begin with `.`, and what stays off
the graph is what a project's `.gitignore` says stays off. One new backend module, one predicate
split in `tree.py`, one parameter on the watcher's path filter. **Zero frontend changes** -- see
section 6, where that is a result and not an omission. No new runtime dependency on either side,
and nothing new forks a process.

---

## 0. Baseline, measured on this host

| Measurement | Command | Result |
|---|---|---|
| Backend suite before any change | `.venv/bin/pytest -q` | **`1 failed, 1376 passed, 20 skipped in 41.46s`** -- see the note below |
| Frontend suite before any change | `cd web && node node_modules/vitest/vitest.mjs run` | `1403 passed (1403)`, 51 files, 30.82 s |
| Backend area this plan touches | `pytest tests/test_tree.py tests/test_watcher.py tests/test_checkouts.py tests/test_sizes.py` | green inside the run above |
| `scan_tree` over this checkout, today | `rhizome_graph.tree.scan_tree` | **231 files, 17 directories opened, 4.7 ms** warm |
| `scan_tree` over `~/projects`, today | as above | **815 files, 124 directories, 14.5 ms** |
| `scan_tree` over `$HOME`, today | as above | **12 500 files, 5 290 directories, 334 ms** |
| The same three, dot rule dropped outright (`.git` still out) | prototype walk | 1 735 / 4 920 / **20 000 (cap hit)** files; 39.8 / 92.3 / 707 ms |
| The same three, `.gitignore` + structural noise, no dot rule | prototype walk | 238 / 845 / **20 000 (cap hit)** files; 11.4 / 46.0 / 993 ms |
| The same three, **the recommended rule** (section 2, decision 2) | prototype walk | **238 / 843 / 12 528** files; **6.5 / 40.3 / 461 ms** |
| Directories opened under the recommended rule | prototype walk | 21 / 125 / 5 291 (against 17 / 124 / 5 290 today) |
| `tree.is_ignored` per filesystem event, today | 50 000 calls over 5 sample paths | **1.74 us** |
| The ancestor-chain answer, 11 compiled rules | same paths | **12.43 us** |
| One rule matched against one path | 20 000 calls, this repo's 11 rules | **2.44 us**; at 214 rules, **63.45 us** |
| Loading and compiling this repo's `.gitignore` | 200 loads | **173.6 us** |
| What this checkout gains | set difference | exactly 7 files: `.claude/agents/*.md` (5), `.claude/settings.json`, `.github/workflows/release.yml` -- **33 274 bytes**, and **nothing is lost** |

**About the one failing test.** `tests/test_start_script.py::test_a_failed_ci_in_dev_still_reaches_the_vite_dev_server`
fails on this host for an environment reason, not a code one: a live daemon is running
(`.venv/bin/python -m daemon.server`, pid 644348) and holds `/tmp/rhizome-graph.sock`, so the
sandboxed `start.sh` hits the `IngestSocketInUseError` guard `CLAUDE.md` documents and never prints
its daemon marker. It is unrelated to this plan and must not be "fixed" by it. **The number to
compare against after each step is `1 failed, 1376 passed`, and the failure must stay that exact
one.** If a step is verified on a host with no daemon running, the target is `1377 passed`.

Five of these measurements decide the design.

- **Dropping the dot rule outright costs the seed cap.** `$HOME` goes from 12 500 files to
  20 000 -- which is `DEFAULT_MAX_FILES`, so the walk is **truncated** and the graph silently
  stops being the tree. On this host 13 044 of the gained files are top-level dotted noise
  (`.vscode-server`, `.cache`, `.local`, `.config`, `.npm`), none of which any `.gitignore`
  speaks for, because `$HOME` is not a repository.
- **The recommended rule costs almost nothing on a project and nothing structural on a home
  directory.** 231 -> 238 files here (4.7 -> 6.5 ms), 12 500 -> 12 528 on `$HOME` (334 -> 461 ms,
  no cap hit).
- **The cost is the matcher, not the walk.** Directories opened go 17 -> 21, 124 -> 125,
  5 290 -> 5 291. Every millisecond added is a regex run against a path, which is why the caps in
  decision 3 are about rules and not about directories.
- **Per filesystem event the watcher goes from 1.74 us to 12.43 us.** That is 7x and it is 12
  microseconds, on watchdog's own thread, not on the agent's loop. `hooks/emit_event.py` and
  `rhizome_graph/hook.py` **do not import `tree` at all** (verified by grep) -- the hot path this
  repository actually protects is untouched by every line of this plan.
- **A big `.gitignore` is linear in rules and it bites.** 11 rules cost 2.44 us per path; 214
  rules cost 63.45 us. At 20 000 paths that is 1.3 s, which is why `MAX_RULES_PER_FILE` exists.

---

## 1. Assessment: how the filter is shaped today

### What is actually missing is narrower than the request

The request says "files and directories whose names begin with `.`". **Files are already drawn.**
`tree.is_ignored` (`tree.py:48-54`) splits the relative path and inspects
`relative_path.split("/")[:-1]` -- **directory segments only**, and its own docstring says so.
Verified against this checkout: `scan_tree(".")` returns 231 paths and `.gitignore` is one of
them.

So the defect is exactly this: **`_is_ignored_dir` (`tree.py:57-62`) prunes every directory whose
name starts with `.`, and everything under it disappears.** On this repository that is `.claude/`
and `.github/` -- six agent definitions, one settings file and one CI workflow, all of them
committed, authored, English-policed source that the graph refuses to admit exists. The user is
right about the symptom and the fix is one line narrower than the framing.

### The seams, and which are load-bearing

**`tree._is_ignored_dir` is one predicate serving two different questions.** `scan_tree`
(`tree.py:89`) asks "does the graph draw this?"; `checkouts._child_directories`
(`checkouts.py:131`) asks "could a working tree be under here?". They agree today by coincidence,
and `checkouts.py`'s own docstring (`:7-10`) states the coincidence as if it were a contract: the
prune is *why* that walk "can never *see* a `.git`". The day the graph's question changes, the
discovery walk starts descending into `.git/`, and its `MAX_SCANNED_DIRS = 4000` budget is spent
on git objects before it finds the second checkout. **This is the coupling this feature has to
break, and it is the only one that survives a refactor.** It is also crossed through a *private*
name -- `checkouts.py` reaches for `tree._is_ignored_dir` -- which is the smell that says the
boundary was never drawn.

**`is_ignored(relative)` is pure and takes no root, and the watcher is the reason.**
`daemon/watcher.py:70` calls it from `relative_to_root(path, root)`, which *has* the root in hand
and throws it away one frame later. A `.gitignore` answer needs the root (to find the files) and
the directory (to find the nested ones), so **this signature is the central design question of the
whole feature**, not a detail. It is answered in decision 5.

**`scan_tree(root, max_files)` has three callers and one of them is the seed.** `daemon/server.py:709`
(root switch), `:1153` (boot), `rhizome_graph/content_search.py:195`, `rhizome_graph/sizes.py:108`.
Two of those run on user-visible latency: a `ctrl+L` switch and every `ctrl+shift+F`. Anything
added to the walk is paid four times over. **Load-bearing; the plan must not change this
signature**, and decision 5 explains why it does not have to.

**`daemon/server.py:120-124` justifies the branch poll with a fact this feature makes false.** The
comment says polling is necessary because `tree.is_ignored` "drops every dotted directory segment,
so `.git/HEAD` is invisible to it by design". After this change `.git/HEAD` is still invisible --
but because `.git` is a named rule, not because it is dotted. The conclusion survives, the reason
does not, and a comment whose reason is false is worse than no comment. Same for `tree.py`'s own
docstring at `:12-14` ("This is deliberately not a `.gitignore` parser: the daemon also watches
projects that are not git repositories") -- that argument is **correct and must be answered, not
deleted**. Decision 2 is the answer.

**`gitcmd.py` stays the one place this project forks, and this feature must not touch it.**
`git check-ignore --stdin` is the obvious answer and it is wrong four times over: it costs a fork
on the seed walk and, worse, on the watcher's per-event path; it answers nothing for a root that
is not a repository, which is a first-class case here; it answers nothing for a workspace of
several checkouts, which is the case `checkouts.py` exists for; and `git` is **Recommends, not
Depends** in the `.deb`, so on a machine without it the graph's contents would depend on whether
an optional package happened to be installed. Pure Python, or nothing.

**`file_view.resolve_inside` and `normalize._read_path` are orthogonal and stay so.** This feature
adds no path that arrives from the network. The one new read is a `.gitignore` under the observed
root, named by the walk, never by a frame. The rule that keeps it that way is decision 4's
"never above the observed root".

### Two things already correct that the plan depends on

- **`.git` is a directory the watcher must never report,** and the branch and status polls exist
  *because* it is invisible. That is not a side effect of the dot rule to be preserved by accident;
  it is a rule, and decision 1 promotes it to one.
- **`IGNORED_DIRS` is about generated output, not about git.** `node_modules`, `dist`, `build`,
  `target`, `coverage`, `htmlcov`, `vendor`, `venv`, `*.egg-info`. That set is what makes the
  daemon usable on a project with no repository at all, which is exactly the argument `tree.py`'s
  docstring makes.

---

## 2. Decisions before step 1

Decision 1 is the user's rule made explicit. Decisions 2 to 8 are mine; say so if you would have
chosen otherwise.

1. **`.git` is excluded unconditionally. Closed -- not a recommendation.** It becomes a named rule
   with its reason written next to it, and steps 4.5, 4.5a, 4.5b and 5.3a pin it on a governed
   root, on a root with no `.gitignore` at all, on each checkout of a multi-checkout workspace,
   and on the watcher's path. Git never lists `.git` in a `.gitignore`, so the user's rule alone would put it on the
   graph. It holds thousands of loose objects, and every `git status`, `git add` and commit rewrites
   the index -- the watcher would flood the graph with churn nobody can read. And two features
   depend on its invisibility: the branch poll (`server.py:120-124`) and the status poll
   (`STATUS_POLL_INTERVAL_SECONDS`) both exist because a commit typed in a terminal touches only
   `.git/` and the watcher never sees it. **The constant is `ALWAYS_IGNORED_DIRS = frozenset({".git"})`
   and it is checked before anything else, including a `.gitignore` negation.** A `!.git` in a
   `.gitignore` does not re-include it: git would not honour that either.

2. **A root with no `.gitignore` keeps today's filter; a subtree a `.gitignore` governs does not.**
   This is the recommendation, and it is the one decision worth arguing about, so here is the
   argument in full.

   - The **structural noise set** (`IGNORED_DIRS` plus `*.egg-info`) applies **always**, governed
     or not. Its subject is generated output, not git, and dropping it inside a governed subtree
     means a repository whose `.gitignore` happens not to name `node_modules` floods the graph with
     ten thousand nodes. Measured on `~/projects`: 905 files without the set against 845 with it,
     and that is a tidy workspace. The stated price is the mirror image and it is real: a project
     that deliberately **commits** its `dist/` never sees it on the graph. That is one nameable case
     against an unbounded one, and it is filed as G8 (noted) with a trigger.
   - The **blanket dot rule survives only where no `.gitignore` speaks.** A directory is *governed*
     when a `.gitignore` exists at or above it, at or below the observed root. In a governed
     subtree, a dotted directory is drawn unless the rules say otherwise -- which is precisely the
     user's request. In an ungoverned subtree, today's rule applies unchanged.
   - Why not "drop the dot rule everywhere": measured, `$HOME` goes to 20 000 files and hits
     `DEFAULT_MAX_FILES`, so the seed is silently truncated and the picture stops being the tree.
     `.cache`, `.local`, `.config`, `.npm` and `.vscode-server` are 13 044 files here and no
     `.gitignore` anywhere will ever mention them.
   - Why not "keep the dot rule everywhere and only subtract": that is not the feature. `.claude/`
     and `.github/` would stay invisible, which is the entire complaint.
   - **The property that makes this cheap to build:** no fixture in `tests/` creates a `.gitignore`
     in a `scan_tree` or watcher context (verified by grep over `tests/` and `web/tests/`), so
     **every existing pinned assertion about the ignore rules stays true verbatim.** The feature is
     provably additive, and section 3's first step is the jaw that proves it.
   - **An empty `.gitignore` is a `.gitignore`.** A user who wants everything under a root drawn
     writes an empty file, and that is a documented escape hatch rather than an accident.

3. **The matcher is pure Python in a module of its own, `rhizome_graph/gitignore.py`, and it uses
   `re` -- but never `fnmatch.translate`.** Measured, `fnmatch.translate` is wrong three ways at
   once: `fnmatch.translate("*.py")` is `(?s:.*\.py)\Z`, so `*` crosses `/`;
   `fnmatch.translate("x?y")` matches `x/y`, so `?` crosses `/`; and `a/**/b` becomes `a/.*/b`,
   which fails to match `a/b` where git succeeds. It also knows nothing of leading-`/` anchoring,
   trailing-`/` dir-only, or `!`. The translation is written here: `*` -> `[^/]*`, `?` -> `[^/]`,
   a `**/` segment -> `(?:[^/]+/)*`, a trailing `/**` -> `/.*`, a bracket class passed through with
   a leading `!` folded to `^`, an unanchored pattern prefixed with `(?:.*/)?`, and every pattern
   suffixed with `(?:/.*)?\Z` so an ignored directory ignores its subtree.

   **On `re` and the "no regex" doctrine.** `content_search.py` bans `re` over its parsed source
   because its patterns arrive *from the network*. These arrive from a file on disk. That is a
   different threat and `re` is available -- but it is not free, because `setRoot` lets a
   token-holding client point the daemon at a directory whose `.gitignore` it chose, and
   `a/**/**/**/**/b` compiles to adjacent unbounded quantifiers. Three structural answers, all
   cheap: **consecutive `**` segments are collapsed to one during translation** (which is what git
   means by them anyway, so no two unbounded quantifiers can ever be emitted adjacent);
   `MAX_DOUBLESTAR_PER_PATTERN = 4`, above which the pattern is refused; and
   `MAX_PATTERN_LENGTH = 512`. Alongside them `MAX_RULES_PER_FILE = 1000` and
   `MAX_IGNORE_FILES = 500` bound the linear cost measured in section 0.
   **The residual question -- whether a crafted `.gitignore` can still make one match superlinear --
   is for `security-auditor`, not for this document.** What I am reporting is the structure that
   makes it possible; ranking it is not my job. Hand it over when G1 lands.

   **A refused pattern is skipped, and skipping means the file is shown.** This feature exists to
   show more, so the safe direction of a failure is visibility. That is stated so nobody later
   "hardens" it into hiding a tree because one line would not compile.

4. **What ships, and what is refused in writing.**

   **In scope.** Blank lines and `#` comments; trailing whitespace stripped unless escaped as
   `\ `; a leading `\#` or `\!` escaping the special first character; a leading `/` anchoring to
   the file's own directory; a trailing `/` meaning directories only; an inner slash making a
   pattern anchored; `*`, `?` and `[...]`; `**` in its three positions (`**/x`, `x/**`, `a/**/b`);
   `!` negation; and **`.gitignore` files in subdirectories**.

   **Nested files are not optional.** The workspace case -- `rhi ~/projects` over a folder of
   checkouts -- is a first-class root in this project, and every one of those checkouts keeps its
   ignores at its own top level, which is a *nested* file relative to the observed root. Measured:
   `~/projects` is 843 files with nesting and would be 4 920 without any ignore rules at all.

   **Git's "a file cannot be re-included under an excluded directory" comes for free on the walk,
   and must be paid for on the watcher's path.** `_scan` prunes `dirnames` in place, so an excluded
   directory is never descended into and no `!` inside it can be reached -- the prune *is* the rule.
   The watcher has no walk, so its per-path answer must test each ancestor directory in order and
   stop at the first excluded one. Those are two entry points to one rule, and G6 is the property
   test that pins them to the same answer.

   **Refused, each with its price.**
   - `.git/info/exclude` -- it lives inside the one directory this plan never opens, and opening it
     would be a special case cut through decision 1. *Price:* a user who keeps local-only ignores
     there sees those files on the graph.
   - `core.excludesFile` and `~/.config/git/ignore` -- both are outside the observed root, and
     reading them makes the graph depend on the machine's git configuration rather than on the
     project. *Price:* the same, for a global ignore list.
   - **`.gitignore` files above the observed root** -- pointing `rhi` at `~/projects/repo/web`
     does not read `~/projects/repo/.gitignore`. This is the security-shaped half of the decision
     and it matches `resolve_inside` and `_read_path`: **this daemon does not open a file outside
     the root the user pointed at**, not even to decide what to draw. *Price:* observing a
     subdirectory of a checkout leaves that subtree ungoverned, so the decision-2 fallback applies
     there -- which is today's behaviour, so nothing regresses.
   - POSIX bracket classes (`[[:alpha:]]`) -- `re` reads `[[:alpha:]]` as a class of `[`, `:`, `a`,
     `l`, `p`, `h` and matches the wrong thing **silently**. A pattern containing `[[:` is refused
     whole. *Price:* those files are shown. Rare in real `.gitignore` files and loud in a test.
   - Case-insensitive matching on case-insensitive filesystems (`core.ignoreCase`). Matching is
     byte-exact. *Price:* on macOS, `Build/` is not matched by `build/`.

5. **Ownership: each walk builds its own `IgnoreRules`; the watcher owns one and drops it when it
   sees a `.gitignore` change. `scan_tree`'s signature does not change.**

   `IgnoreRules(root)` is **lazy and memoized per directory**: it loads a directory's `.gitignore`
   the first time it is asked about that directory, and caches the compiled stack. That is what
   lets one object serve both the walk (which discovers nested files as it descends) and a per-path
   question (which walks up to find them).

   - **`scan_tree` builds one internally, per call.** Cost: 173.6 us to load and compile this
     repository's file, once. That buys three things worth far more than the microseconds: the walk
     is **always fresh**, so an edited `.gitignore` is in force on the next boot, root switch,
     content search or F7 pass with no invalidation logic to get wrong; `sizes.py:108` and
     `content_search.py:195` need **no change at all**; and there is no mutable object shared
     between `asyncio.to_thread` workers and watchdog's thread.
   - **`FsWatcher` builds one from the root it already holds** (`server.py:1050` constructs it with
     that root) and keeps it for its lifetime. It **invalidates on any event whose basename is
     `.gitignore`** -- the watcher already sees that write today, because a dotted *file* at a
     visible level is not filtered. Self-contained: no `Session` plumbing, and `switch_root`
     (`server.py:683-717`) already stops and restarts the watcher, so a root switch gets a new
     object for free.
   - **`relative_to_root(path, root, rules=None)`** gains a third, defaulted parameter. With
     `rules=None` it answers from the structural noise set alone, which is exactly what
     `tests/test_watcher.py:59-62` asserts today, so that file compiles and passes untouched.

   Rejected alternative: threading one `IgnoreRules` through `Session` into both the walk and the
   watcher. It saves 173.6 us per walk and buys a mutable object crossing two threads, an
   invalidation protocol between them, and a new parameter on a signature with four call sites.
   **The cheapest architecture is the one that changes the fewest signatures**, and here that is
   also the one with no shared state.

6. **`checkouts.py` keeps the dot rule, as its own, with its own reason.** It stops importing
   `tree._is_ignored_dir` and gets `_is_uninteresting(name)`: the structural noise set, plus
   `.git`, plus every dotted name. The reason is not the graph's: **a working tree is never inside
   a dotted directory**, and a discovery walk with a 4 000-directory budget that descends into
   `.cache` and `.vscode-server` spends it before it finds the second checkout. It also must never
   import `gitignore` -- `tests/test_checkouts.py:352-357` pins
   `FIRST_PARTY_IMPORTS_ALLOWED = {"repo", "tree"}` and that set stays exactly two names, for the
   same reason `gitcmd` is excluded from it: discovery is 50-100x cheaper than what it decides on,
   and routing per-path regex matching through it inverts that trade silently.

7. **`gitignore.py` knows nothing about `.git`, `IGNORED_DIRS` or dotfiles.** It answers one
   question -- what does git's ignore syntax say about this path -- and every rhizome policy
   (decision 1, decision 2's fallback, the structural set) lives in `tree.py`. That is what makes
   the module testable against real git behaviour instead of against our own taste, and it is why
   `governs(directory)` is exported: `tree` asks it whether to apply the fallback, and
   `gitignore.py` never learns what the fallback is.

8. **`paths.py:139-140` is out of scope, deliberately.** The `ctrl+L` completion hides dotted names
   unless the typed prefix starts with `.`, which is what a shell does and what a person typing a
   path expects. It is a rule about a *typed prefix*, not about what the graph draws, and the
   request was about the graph. Changing it would make `rhi ~` complete into `.cache` on the first
   Tab. Left alone, and said out loud so the next reader does not think it was missed.

---

## 3. The plan

Ranked, ordered, every step one RED test plus one GREEN implementation, both suites green between
any two of them -- where "green" means the section 0 baseline, the one environment failure
included.

New test files: `tests/test_gitignore.py`, `tests/test_tree_gitignore.py`,
`tests/test_watcher_gitignore.py`. Existing files gain cases; **no existing assertion moves**, and
G3 is the step that proves it.

---

### G1 -- Nothing in the tree can read a `.gitignore`. **Rank: now**

**What is missing.** There is no ignore-syntax question anywhere in this project. `tree.py` has a
name blocklist, `repo.py` reads `.git/HEAD`, `status.py` parses porcelain output, `checkouts.py`
looks for `.git` directories. Nothing parses a pattern.

**Where.** New module `rhizome_graph/gitignore.py`. Not in `tree.py`: that module is the boot
snapshot and must stay cheap enough to run on every root switch, and its whole docstring is about
a name blocklist. Not in `repo.py`: that is the upward walk and its "files, never `subprocess`"
doctrine. Not in `status.py`: nothing here is the porcelain format.

**Why it costs to put it elsewhere.** The next change is nameable: someone will want
`.git/info/exclude`, or case-insensitive matching on macOS, or a cap raised. In its own module
that is one function and one constant. Inside `tree.py` it is a change to the module three other
modules walk through.

**Target shape.**

```
MAX_PATTERN_LENGTH        = 512
MAX_DOUBLESTAR_PER_PATTERN = 4
MAX_RULES_PER_FILE        = 1000
MAX_IGNORE_FILES          = 500

@dataclass(frozen=True) Rule:  regex: re.Pattern, negated: bool, dir_only: bool
compile_rule(pattern: str) -> Rule | None        # pure; None means refused, so shown
parse_patterns(text: str) -> tuple[Rule, ...]    # pure; comments, blanks, escapes, the cap
match_rules(rules, relative: str, is_dir: bool) -> bool   # pure; last match wins
```

What stops the boundary being crossed later: the module imports `os`, `re` and `dataclasses` and
**nothing of ours**, and it starts no process -- asserted over its parsed source the way
`tests/test_checkouts.py` asserts it for `checkouts.py`. Its docstring says it answers git's
question and no rhizome policy, and names decision 4's refusals.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-backend`) |
|---|---|---|
| 1.1 | `tests/test_gitignore.py`: `compile_rule("*.py")` matches `a.py` and `src/a.py` but **not** `a.pyc`; and `compile_rule("x?y")` does **not** match `x/y`. Today the module does not exist. | `gitignore.py` with the segment-aware translation. |
| 1.2 | RED: `fnmatch.translate` is asserted to be wrong -- the test names it and shows `re.match(fnmatch.translate("x?y"), "x/y")` is truthy while ours is not. The measurement, pinned so nobody "simplifies" the translation later. | Nothing new. |
| 1.3 | RED: a leading `/` anchors (`/dist` matches `dist/x` and not `a/dist/x`); an inner slash anchors (`doc/x`); a trailing `/` is dir-only (`build/` matches the directory, not a file named `build`). | The three flags. |
| 1.4 | RED: `**` in three positions -- `**/node_modules` matches at any depth; `a/**` matches everything under `a`; `a/**/b` matches **both** `a/b` and `a/x/y/b`. | The `(?:[^/]+/)*` segment and the trailing `/.*`. |
| 1.5 | RED: `!` negation, last-match-wins (`*.log` then `!keep.log`); and a `Rule` for `\!literal` matches a file literally named `!literal`. | The negation flag and the escapes. |
| 1.6 | RED: blank lines and `#` comments produce no rules; `\#notacomment` produces one; trailing spaces are stripped and `a\ ` keeps its space. | `parse_patterns`. |
| 1.7 | RED: an ignored **directory** ignores its subtree -- `match_rules(parse_patterns("build/"), "build/x/y.txt", False)` is `True`. | The `(?:/.*)?\Z` tail. |
| 1.8 | RED: `compile_rule("[[:alpha:]].txt")` is `None`; a pattern longer than `MAX_PATTERN_LENGTH` is `None`; a pattern with five `**` is `None`; `parse_patterns` over 2 000 lines returns `MAX_RULES_PER_FILE` rules. | The four refusals. |
| 1.9 | RED: `compile_rule("a/**/**/**/b")` produces a regex whose source contains **one** `(?:[^/]+/)*` and matches `a/b` -- the collapse, pinned where it is the ReDoS defence. | The collapse. |
| 1.10 | RED, over the parsed source: `gitignore.py` imports nothing from `rhizome_graph`, `daemon` or `hooks`; names no `subprocess`, `popen`, `system`, `fork` or `gitcmd`; and its text contains neither `IGNORED_DIRS` nor a literal `".git"`. | Nothing -- it must already pass. The contract, written down. |

**Test to write first.** 1.1 -- property: *a glob wildcard does not cross a path separator*. Input
that trips it today: the module does not exist, and the implementation a developer reaches for
first, `re.compile(fnmatch.translate(pattern))`, fails 1.1's second assertion on `x?y` against
`x/y`. That is why it is step one and why 1.2 pins the measurement beside it.

**Owner.** `developer-tester` -> `developer-backend`.

---

### G2 -- Nothing knows which `.gitignore` governs which directory. **Rank: now**

**What is missing.** A rule set is not a property of a root; it is a property of a *directory*,
because a nested `.gitignore` adds rules below itself and only below itself. And two different
callers need that stack differently: the walk knows its ancestors are clean, the watcher does not.

**Where.** `rhizome_graph/gitignore.py`, the stateful half.

**Why it costs.** Without the per-directory stack, `~/projects` -- a workspace of checkouts, the
root the multi-repository status panel was built for -- has no ignore rules at all: measured, 4 920
files instead of 843. Nested support is not a refinement, it is the workspace case working.

**Target shape.**

```
class IgnoreRules:
    def __init__(self, root: str) -> None
    def governs(self, directory_relative: str) -> bool
    def ignored_child(self, directory_relative: str, name: str, is_dir: bool) -> bool
    def ignored(self, relative: str, is_dir: bool) -> bool
    def invalidate(self) -> None
```

- `ignored_child` is the **walk's** entry point: ancestors are known clean because they were
  pruned, so only the leaf is tested. O(rules).
- `ignored` is the **watcher's**: it tests every ancestor directory in order and stops at the
  first excluded one, which is git's "no re-inclusion under an excluded directory" rule expressed
  for a caller that has no walk. O(depth x rules) -- measured at 12.43 us for depth 5 and 11 rules.
- `governs` is what `tree` asks to decide decision 2's fallback, so `gitignore.py` never learns
  what the fallback is.
- **Never above the root.** The stack for the root directory is the root's own `.gitignore` and
  nothing else. Decision 4.
- **Never raises.** An unreadable `.gitignore` is an empty rule list, which shows more. Same rule
  as `scan_tree`'s.
- **The cache is a dict of immutable tuples and every write is idempotent** -- the same key always
  computes the same value -- so a walk thread and watchdog's thread racing recompute rather than
  corrupt. Stated because the watcher's object and a `to_thread` walk's object are separate today
  (decision 5) and someone will eventually try to share one.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-backend`) |
|---|---|---|
| 2.1 | `tests/test_gitignore.py`: over a `tmp_path` with a root `.gitignore` naming `build/`, `ignored_child("", "build", True)` is `True` and `ignored_child("", "src", True)` is `False`. | `IgnoreRules.__init__` and the root stack. |
| 2.2 | RED: a nested `sub/.gitignore` naming `*.tmp` makes `ignored_child("sub", "a.tmp", False)` `True` and `ignored_child("", "a.tmp", False)` `False` -- the nested file governs below itself and nowhere else. | The per-directory stack. |
| 2.3 | RED: the root's rules still apply inside `sub` (the stack accumulates, it does not replace). | Stack concatenation, parent first. |
| 2.4 | RED: `governs("")` is `False` for a root with no `.gitignore`, `True` for a root with an **empty** one, and `True` for `sub` when only the root has one. | `governs`, and the empty-file escape hatch of decision 2. |
| 2.5 | RED: `ignored("build/x/y.txt", False)` is `True` through the ancestor chain, and a `!` inside an excluded directory does **not** re-include -- `parse_patterns("build/\n!build/keep.txt")` still hides `build/keep.txt`. | The ancestor walk, stopping at the first exclusion. |
| 2.6 | RED: a `.gitignore` **above** the root is not read -- `tmp_path/.gitignore` naming `keep.txt` has no effect on `IgnoreRules(tmp_path/"sub")`. | The root boundary. |
| 2.7 | RED: an unreadable `.gitignore` (mode `0o000`, skipped when running as root) yields no rules and raises nothing. | The blanket `except OSError`. |
| 2.8 | RED: past `MAX_IGNORE_FILES` distinct directories, further `.gitignore` files are not loaded and nothing raises. | The counter. |
| 2.9 | RED: a second call for the same directory does not re-read the file (a spy on the loader counts one call); `invalidate()` makes the next call read again. | The memo and its clearing. |

**Test to write first.** 2.2 -- property: *a nested `.gitignore` governs its own subtree and no
other*. Input that trips it today: nothing reads a nested file at all, so `sub/a.tmp` is drawn.
It is chosen over 2.1 because 2.1 is satisfiable by a root-only implementation, and a root-only
implementation is the wrong shape that would then have to be unwound.

**Owner.** `developer-tester` -> `developer-backend`.

---

### G3 -- One predicate answers two questions, through a private name. **Rank: now, and it changes no behaviour**

**What is wrong.** `tree._is_ignored_dir` (`tree.py:57-62`) is consumed by `tree._scan`
(`tree.py:89`), by `tree.is_ignored` (`tree.py:54`) and -- reaching through the underscore -- by
`checkouts._child_directories` (`checkouts.py:131`). The graph's question and the discovery walk's
question are not the same question, and G4 is about to change one of them.

**Where.** `rhizome_graph/tree.py:12-14` (docstring), `:23-24` (the comment on `IGNORED_DIRS`),
`:48-62`, `:89`; `rhizome_graph/checkouts.py:7-10` (docstring) and `:131`;
`daemon/server.py:120-124` (the branch poll's stated reason).

**Why it costs.** Without this step, G4 either drags `checkouts` into `.git/` and burns
`MAX_SCANNED_DIRS` on git objects, or it forces a `.gitignore` matcher into a walk whose whole
contract is that it is 50-100x cheaper than the forks it decides on. And the three docstrings above
would go on stating a reason that is no longer the reason.

**Target shape.** Two named predicates in `tree.py`, each with an audience in its docstring:

```
ALWAYS_IGNORED_DIRS = frozenset({".git"})     # decision 1, with its reason beside it
IGNORED_DIRS        = ... unchanged ...
def is_structural_noise(name: str) -> bool    # ALWAYS_IGNORED_DIRS | IGNORED_DIRS | *.egg-info
def is_ignored(relative_path: str) -> bool    # unchanged answer, now built on the above
```

and in `checkouts.py`, its own:

```
def _is_uninteresting(name: str) -> bool:
    """...a working tree is never inside a dotted directory..."""
    return tree.is_structural_noise(name) or name.startswith(".")
```

**`is_ignored` keeps its exact answer.** `.git` moves from the dot rule to the named rule, and the
dot rule stays in place at this step -- so `is_ignored(".git/HEAD")`, `is_ignored(".venv/x")` and
`scan_tree` over every existing fixture answer exactly what they answer today. This step is a
refactor whose whole purpose is that the suite does not move.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-backend`) |
|---|---|---|
| 3.1 | `tests/test_tree.py` (existing file): re-assert `test_skips_vcs_and_build_directories`, `test_skips_packaging_metadata_directories` and `test_is_ignored_matches_any_segment_of_the_path` **verbatim**, plus `is_ignored(".pytest_cache/x")` is `True` and `is_ignored(".claude/agents/a.md")` is `True`. The jaw for G4. | Nothing -- it must already pass. |
| 3.2 | RED: `tree.is_structural_noise(".git")` is `True`, `tree.is_structural_noise(".claude")` is **`False`**, `tree.is_structural_noise("node_modules")` and `("a.egg-info")` are `True`. | `ALWAYS_IGNORED_DIRS` and the new predicate. |
| 3.3 | RED: `checkouts._child_directories` over a directory holding `.git`, `.cache`, `node_modules` and `src` returns `["src"]`, and `checkouts.py`'s source does not contain `_is_ignored_dir`. | `_is_uninteresting` and the changed call site. |
| 3.4 | RED, in `tests/test_checkouts.py`: `FIRST_PARTY_IMPORTS_ALLOWED` is re-asserted as exactly `{"repo", "tree"}` and `gitignore` is named in a new `FORBIDDEN` list beside `gitcmd`, with the reason in the comment. | Nothing -- the pin that G4 does not leak into discovery. |

The three docstring corrections (`tree.py:12-14`, `checkouts.py:7-10`, `server.py:120-124`) land
with 3.2 and 3.3 and carry no test of their own beyond `tests/test_language_policy.py`, which
already scans all three files.

**Test to write first.** 3.1 -- property: *the ignore rules answer today exactly what they
answered yesterday*. Input: the existing fixtures, re-asserted. It costs nothing and it is what
makes G4 provably additive rather than hopefully additive.

**Owner.** `developer-tester` -> `developer-backend`.

---

### G4 -- The walk hides every dotted directory, `.gitignore` or not. **Rank: now**

**What is wrong.** `tree._scan:89` prunes on `_is_ignored_dir`, so `.claude/` and `.github/` --
committed, authored source in this very repository -- never reach the graph. Measured: 7 files and
33 274 bytes missing from a 231-file picture, and **nothing at all is gained by their absence**,
because everything a `.gitignore` would have hidden here (`.venv/`, `.npm-bootstrap/`,
`.pytest_cache/`) it does hide.

**Where.** `rhizome_graph/tree.py:80-102`.

**Why it costs.** It is the feature. And the same walk feeds the content search
(`content_search.py:195`) and the F7 size pass (`sizes.py:108`), so a file the graph will not draw
is also a file `ctrl+shift+F` will not find -- which is the failure `2026-08-23-02-51-content-search.md` decision 8
went out of its way to prevent in the other direction.

**Target shape.** `_scan` builds one `IgnoreRules(root)` and prunes with the composite rule:

```
skip a directory when:
    tree.is_structural_noise(name)                     # always, decision 1 + 2
 or (not rules.governs(dir_rel) and name.startswith("."))   # the scoped fallback
 or rules.ignored_child(dir_rel, name, True)
skip a file when:
    rules.ignored_child(dir_rel, name, False)
```

Two consequences to state rather than discover:

- **Files are now filtered too.** `is_ignored`'s docstring says "Only *directory* segments are
  considered"; the walk's answer no longer works that way, because `*.pyc` and `.DS_Store` are file
  patterns. That is a documented behaviour change, and `is_ignored` itself keeps its old contract
  (it is the structural-noise-only answer for a caller with no root).
- **`scan_tree`'s signature does not change** (decision 5), so `sizes.py` and `content_search.py`
  are untouched files in this plan.

**Cost, measured, in the units that matter.** Boot and every `ctrl+L` switch: this checkout
4.7 -> 6.5 ms, `~/projects` 14.5 -> 40.3 ms, `$HOME` 334 -> 461 ms -- all four `scan_tree` callers
are already on a thread (`server.py:709`, and `to_thread` in `sizes.py`/`content_search.py`), so
none of it reaches the event loop. Directories opened barely move (17 -> 21, 124 -> 125,
5 290 -> 5 291): **the cost is regex matching per path, not extra walking**, which is what
`MAX_RULES_PER_FILE` bounds. The `~/projects` figure is from a deliberately naive prototype that
rebuilds the combined rule list per directory; a memoized stack should beat it, so treat 40.3 ms as
a ceiling.

**Which caps now bite, and which do not.** `DEFAULT_MAX_FILES` (20 000): not reached under this
rule on any of the three roots -- `$HOME` lands at 12 528 -- but it **is** reached (and the graph
silently truncated) under the rejected "drop the dot rule everywhere" variant, which is the whole
reason decision 2 reads as it does. `_MAX_WALK_ENTRIES` (200 000): far away, 25 657 walked at
worst. `checkouts.MAX_SCANNED_DIRS` (4 000): untouched, because G3 gave discovery its own
predicate. `content_search.MAX_TOTAL_BYTES` (64 MiB): grows by the 33 KB this checkout gains, and
by 28 files on `$HOME`; not a factor.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-backend`) |
|---|---|---|
| 4.1 | `tests/test_tree_gitignore.py`: a `tmp_path` with **no** `.gitignore`, holding `src/app.py`, `.venv/bin/python`, `.pytest_cache/x`, `.git/config`, `node_modules/a.js` -- `scan_tree` returns `["src/app.py"]`, exactly as today. The fallback, pinned before it can be lost. | Nothing -- it must already pass after G3. |
| 4.2 | RED: the same tree **plus an empty `.gitignore`** returns `.gitignore`, `.pytest_cache/x`, `.venv/bin/python` and `src/app.py`, and does **not** return `.git/config` or `node_modules/a.js`. | The `governs` branch, `is_structural_noise` ahead of it. |
| 4.3 | RED: a `.gitignore` naming `.venv/` over that same tree returns `.claude/agents/a.md` and hides `.venv/bin/python` -- the user's request, in one assertion. | `ignored_child` in the prune. |
| 4.4 | RED: files are filtered, not only directories -- a `.gitignore` naming `*.log` hides `src/a.log` and keeps `src/a.py`. | The file branch. |
| 4.5 | RED: `.git/` is hidden **even when the `.gitignore` says `!.git`** -- decision 1, pinned as a rule and not as a side effect. | `is_structural_noise` checked first. |
| 4.5a | RED: `.git/config` is hidden over a root with **no `.gitignore` at all** (the ungoverned branch, where the fallback would hide it for the *wrong* reason -- so the assertion is made against a tree where `.git` is the only dotted directory, and it must still hold after the fallback is removed by 4.2's sibling fixture). | Nothing -- `is_structural_noise` already answers. The pin that decision 1 does not lean on the dot rule. |
| 4.5b | RED, a **workspace of three checkouts** under one root (`a/.git`, `b/.git`, `c/` plain, each of `a` and `b` carrying its own `.gitignore`): `scan_tree` returns no path under `a/.git` or `b/.git`, returns `a/.claude/x.md`, and honours each checkout's own patterns. The multi-checkout case, pinned once for the walk. | Nothing new -- G2's nested stack plus `is_structural_noise`. |
| 4.6 | RED: `node_modules/` is hidden even under a `.gitignore` that does not name it -- decision 2's structural half. | Already in 4.2's implementation; the pin. |
| 4.7 | RED: a nested `sub/.gitignore` hides `sub/x.tmp` and not `x.tmp`. | Nothing new -- G2. The pin that the walk actually consults it. |
| 4.8 | RED: `scan_tree`'s existing guard rails re-asserted -- a missing root is `[]`, `max_files` caps, symlinked directories are not followed, the result is sorted -- over a tree that **has** a `.gitignore`. | Nothing. |

**Test to write first.** 4.2 -- property: *the presence of a `.gitignore` is what turns the dotted
fallback off*. Input that trips it today: a `tmp_path` holding an empty `.gitignore` and
`.pytest_cache/x`; `scan_tree` returns only `.gitignore`, because the dot rule prunes regardless.
Chosen over 4.3 because 4.3 is satisfiable by "drop the dot rule and add a matcher", which is the
variant measured to truncate `$HOME`.

**Owner.** `developer-tester` -> `developer-backend`.

---

### G5 -- The watcher still hides what the walk now draws. **Rank: now**

**What is wrong.** `relative_to_root` (`watcher.py:55-72`) calls the root-free
`tree.is_ignored`, so after G4 the seed shows `.claude/agents/a.md` and every subsequent edit to it
is dropped: a file on the graph that never flashes. The mirror failure is worse -- a `.gitignore`
naming `build/` would have its files pruned from the seed and then **added back** by the watcher,
one node per write, permanently, because a wrong node stays on screen forever.

**Where.** `daemon/watcher.py:29` (the import), `:55-72` (`relative_to_root`), `:75-101`
(`_Handler`), `:107-...` (`FsWatcher.__init__`, which already normalizes the root);
`daemon/server.py:1050` (the construction site, unchanged).

**Why it costs.** A graph whose seed and whose live events disagree about what exists is the one
failure mode this repository has documented as costing real hours: it looks alive and it is lying.

**Target shape.**

```
relative_to_root(path: str, root: str, rules: IgnoreRules | None = None) -> str | None
```

With `rules=None`, the answer is `tree.is_ignored(relative)` -- today's, so
`tests/test_watcher.py:59-62` compiles and passes untouched. With rules, `rules.ignored(relative,
is_dir)` is consulted **after** the structural answer, never instead of it: `.git/HEAD` is refused
by `is_ignored` before a pattern is ever matched, which is decision 1 holding on the second path
as well as the first.

`FsWatcher.__init__` builds `IgnoreRules(self._root)` and `_Handler` calls
`rules.invalidate()` whenever an event's basename is `.gitignore`, before classifying it. The
`.gitignore` write itself still produces its own `M` event -- it is a file on the graph and editing
it is a change like any other.

**Cost per event: 1.74 us -> 12.43 us, measured**, at depth 5 with this repository's 11 rules. That
is on watchdog's observer thread, which already does a `normpath`, a `startswith` and a
`call_soon_threadsafe` per event. The hook's hot path is not involved: `hooks/emit_event.py` and
`rhizome_graph/hook.py` import nothing from `tree` (verified by grep).

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-backend`) |
|---|---|---|
| 5.1 | `tests/test_watcher.py` (existing file): `test_ignored_paths_are_rejected` and the three neighbours re-asserted **verbatim**, two-argument calls included. The jaw. | Nothing. |
| 5.2 | `tests/test_watcher_gitignore.py`: with an `IgnoreRules` over a root whose `.gitignore` names `build/`, `relative_to_root("/proj/build/x", "/proj", rules)` is `None` and `relative_to_root("/proj/.claude/a.md", "/proj", rules)` is `".claude/a.md"`. | The third parameter. |
| 5.3 | RED: `.git/HEAD` is refused **with** rules whose `.gitignore` says `!.git`, and the structural check is shown to run first (a spy on `rules.ignored` records zero calls for that path). | Ordering: structural, then patterns. |
| 5.3a | RED: over a **workspace of three checkouts**, `relative_to_root` refuses `a/.git/index` and `b/.git/index` and accepts `a/.claude/x.md` -- decision 1 on the second path, for every checkout and not only the root's. | Nothing -- the structural check. The pin that `.git` is a name, not a position. |
| 5.4 | RED: a file under an ignored directory is refused through the ancestor chain -- `relative_to_root("/proj/build/deep/x", "/proj", rules)` is `None`. | Nothing -- G2's `ignored`. The pin that the watcher uses the chain entry point and not `ignored_child`. |
| 5.5 | RED, over a real `FsWatcher` in `tmp_path` (the technique `tests/test_watcher.py` already uses for live events): writing a file the root `.gitignore` names produces no change, and writing a dotted file it does not name produces one. | `FsWatcher` building its own `IgnoreRules`. |
| 5.6 | RED: rewriting the `.gitignore` to add a pattern makes the very next write to a matching file produce no change -- the invalidation, end to end. | The basename check in `_Handler`. |

**Test to write first.** 5.2 -- property: *the watcher and the walk agree about what is on the
graph*. Input that trips it today: after G4, `.claude/a.md` is seeded and
`relative_to_root("/proj/.claude/a.md", "/proj")` is `None`, so the node never flashes again.

**Owner.** `developer-tester` -> `developer-backend`.

---

### G6 -- Two entry points to one rule, and nothing pins them together. **Rank: now, last of the code steps**

**What is missing.** `ignored_child` (leaf only, ancestors known clean) and `ignored` (full
ancestor chain) are two implementations of git's exclusion rule, chosen for two different callers
for a measured reason. Nothing makes them agree, and the failure -- a path the seed drew and the
watcher drops, or the reverse -- is exactly the "silently, plausibly wrong" class this repository
names elsewhere.

**Where.** `rhizome_graph/gitignore.py`, both methods.

**Why it costs.** The disagreement is invisible: the graph looks fine and one file stops updating.
This is the assertion that catches it, and it costs one test file.

**Target shape.** No new code. One property, asserted over a real tree:

> For every path `scan_tree(root)` returned, `IgnoreRules(root).ignored(path, False)` is `False`;
> and for a curated list of paths the walk pruned, it is `True`.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-backend`) |
|---|---|---|
| 6.1 | `tests/test_tree_gitignore.py`: over a `tmp_path` holding a root `.gitignore`, a nested one, a negation, a dotted directory and a `node_modules`, every path `scan_tree` returned satisfies `not rules.ignored(p, False)`. | Nothing -- it must already pass. If it does not, one of G2/G4/G5 is wrong. |
| 6.2 | RED: the same over **this repository** (`REPO_ROOT`), which has a real `.gitignore`, a `.venv` and a `.claude` -- a second fixture nobody wrote by hand. | Nothing. |
| 6.3 | RED: paths the walk pruned for a *pattern* reason (`build/x`, `sub/a.tmp`) satisfy `rules.ignored(p, False)`; paths pruned for a *structural* reason (`.git/HEAD`, `node_modules/a.js`) do **not**, because `gitignore.py` knows nothing about them -- decision 7, pinned as an asymmetry rather than left as a surprise. | Nothing. |

**Test to write first.** 6.1 -- property: *what the walk kept, the per-path answer keeps*. Input:
the fixture built for 4.7, reused whole.

**Owner.** `developer-tester` -> `developer-backend`.

---

### G7 -- The documentation states a reason that stops being true. **Rank: now, and it carries no test of its own**

`CLAUDE.md` lists "`.gitignore` parsing" under "Not yet built" and its Status section describes
the ignore rules nowhere else. That entry moves out, and the Status section gains a bullet in the
voice of its neighbours: the rule, the fallback and its measured reason, the `.git` rule and its
reason, the refusals of decision 4 with their prices, and the two entry points with the property
that binds them.

The three in-tree docstrings (`tree.py:12-14`, `checkouts.py:7-10`, `server.py:120-124`) are
**not** part of this step -- they land with G3 and G4, in the same commit as the change that makes
them false, which is this repository's discipline.

This step is listed separately and explicitly carries no RED test, which is only acceptable because
every behaviour it describes was pinned in G1-G6 first.

**Owner.** `developer-backend`.

---

### G8 -- The structural noise set overrules an explicit `.gitignore`. **Rank: noted, with a trigger**

Decision 2 keeps `IGNORED_DIRS` in force inside a governed subtree, so a project that deliberately
commits its `dist/` or vendors its `vendor/` never sees those files on the graph, even though git
tracks them and the user never asked for them to be hidden. Measured cost of the alternative on
`~/projects`: 905 files instead of 845, and the unbounded case is a repository whose `.gitignore`
omits `node_modules`.

The shape if it is ever built: an **explicit negation** in the `.gitignore` (`!dist/`) overrules
the structural set for that name, and nothing else does. That keeps the default safe, needs no new
constant, and makes the escape hatch something the user writes in a file git already understands.
It is not built now because it is a second interaction between two rule systems, added for a case
nobody in this repository has hit.

**Trigger:** the first report of a tracked, committed directory missing from the graph.

---

### G9 -- A root with no `.gitignore` anywhere still hides dotted project files. **Rank: noted**

A git repository that has never needed a `.gitignore` -- there are many -- is ungoverned under
decision 2, so its `.claude/` stays invisible. The user's rule says "if one exists", so this is
faithful to the request rather than a gap in it, and the workaround is an empty `.gitignore`
(decision 2's escape hatch).

The tempting fix is to trigger on `.git` rather than on `.gitignore`. It is worse: a checkout with
a `.venv` and no `.gitignore` would then draw 1 114 files of vendored Python (measured on this
repository), which is the failure the fallback exists to prevent.

**Trigger:** a user asking why their `.claude/` is missing from a repository that has no
`.gitignore`. The answer to give first is the empty file.

---

### G10 -- `.git/info/exclude` and `core.excludesFile` are not read. **Rank: noted**

Both are refused in decision 4 with their reasons. Recorded here so the next reader knows it was a
decision.

**Trigger:** a report that files hidden locally still appear on the graph. The `.git/info/exclude`
half is the cheaper of the two and would be one extra file in `IgnoreRules.__init__`, read once,
with the `.git` prohibition of decision 1 explicitly carved out at exactly that one path -- which
is a chokepoint being opened, so hand it to `security-auditor` before building it.

---

## 4. What conflicts with what

- **Maintainability vs performance, at the two entry points.** The maintainable answer is one
  method: always walk the ancestor chain. Measured, that is 12.43 us against 2.44 us per path, and
  the walk asks the question 25 000 times on a `$HOME` root -- 310 ms against 61 ms, on a path that
  already costs 461 ms. Performance wins, and the maintainability debt is paid down by G6, which
  makes the two answers a pinned property rather than a hope.
- **Maintainability vs completeness, at the gitignore subset.** Full fidelity means
  `core.excludesFile`, `.git/info/exclude`, `core.ignoreCase` and POSIX bracket classes. Each is a
  new source of truth with its own failure mode, and three of the four sit outside the observed
  root. The subset is smaller than git's and **the difference is written down with a price per
  line** rather than discovered by a user. Completeness loses, deliberately.
- **Performance vs the request, at the fallback.** The user's rule, read literally, is "only
  `.gitignore` filters". Measured on `$HOME` that truncates the seed at `DEFAULT_MAX_FILES` and
  doubles the walk. Decision 2 honours the rule everywhere a `.gitignore` speaks and keeps today's
  behaviour everywhere it does not -- which costs one concept ("governed") and buys back the cap.
  **This is the only place the plan does not do exactly what was asked, and it is why decision 2 is
  the longest one.**
- **Security vs convenience, at `re`.** The convenient matcher is `re.compile(fnmatch.translate(p))`:
  one line, no translation to get wrong. It is measurably incorrect (section 0, and step 1.2 pins
  it) *and* it is the shape that emits adjacent unbounded quantifiers. The hand-written translation
  costs a hundred lines and removes both problems, with the `**` collapse of step 1.9 as the
  structural half. **The residual ReDoS question goes to `security-auditor`; ranking it is not this
  document's job.**
- **Security vs fidelity, at the root boundary.** Git reads `.gitignore` files above the working
  directory. This daemon will not open a file outside the root the user pointed at -- the same rule
  `resolve_inside` and `_read_path` already enforce for the network paths. Fidelity loses, with the
  price stated in decision 4.

Nothing here adds a path around a chokepoint. `resolve_inside` stays the only containment check for
a network-supplied path and is not touched; `gitcmd` stays the only fork and gains no caller;
`WsClient.send` stays the only token stamp and gains no command; the two gates in front of
`handle_command` are not reached by any line of this plan. The one new file the daemon opens is
named by its own walk, under its own root, and is read with the ordinary `open` the walk already
uses for nothing -- **note that `safe_read.read_capped` is the right tool if a `.gitignore` could
be a FIFO under a hostile root, and G2 step 2.7 is where that would be decided.** I did not settle
it; see section 7.

---

## 5. What cannot be verified on this host

1. **Whether the graph is legible with `.claude/` and `.github/` on it.** Seven more nodes here is
   nothing; a project with a large `.github/` of workflows, issue templates and actions is a
   different picture, and this host has no browser (`CLAUDE.md` records the same gap for the read
   ring and the file viewer).
2. **Whether `$HOME` is still usable at 12 528 files.** It is 28 files more than today, so the
   answer is almost certainly "exactly as before", but 461 ms of walking on every `ctrl+L` is a
   third of a second of blank graph that nobody has watched.
3. **Whether the watcher's 12.43 us matters under a real burst.** A `npm install` inside a
   governed subtree fires thousands of events that all resolve to "ignored"; the arithmetic says
   tens of milliseconds on watchdog's thread, and nobody has run it.
4. **Whether a real project's `.gitignore` compiles the way this plan says.** Every pattern in
   section 0's measurements came from this repository's own eleven-line file. A framework's
   hundred-line template with `**`, negations and bracket classes has not been run through the
   translation.
5. **Whether the `~/projects` figure of 40.3 ms survives a real implementation.** The prototype
   rebuilds the combined rule list per directory; a memoized stack should be faster. Treat it as a
   ceiling, and measure again when G4 lands.

---

## 6. What I examined and found sound

- **The front end needs no change at all, and the reason is already written down.**
  `colors.extensionOf` (`colors.ts:61-66`) returns `""` for `dot <= 0`, so `.gitignore` falls to
  `hashColor(path)` rather than being coloured as a file of type `gitignore`;
  `language.languageForPath` (`language.ts:110-117`) has the identical guard with a docstring
  paragraph explaining it, and `web/tests/language.test.ts:163-166` pins the case by name. A grep
  over `web/src` for `startsWith(".")`, `charAt(0) === "."` and `[0] === "."` returns **nothing**:
  no frontend module has an opinion about a leading dot. `simulation.ts` materializes directory
  nodes from child paths, so `.claude/` becomes a node with no code change, and `labels.ts`,
  `eventLog.splitPath`, `statusHud` and `sizeColor` are all path-shape-agnostic. **Zero frontend
  changes is a measured result, not an assumption.**
- **The hook path is untouched.** `hooks/emit_event.py`, `rhizome_graph/hook.py` and
  `rhizome_graph/normalize.py` import nothing from `tree` (verified by grep). The 41.1 ms per tool
  call that `CLAUDE.md` records is unaffected by every line of this plan, and no step should be
  reviewed as if it were.
- **`scan_tree`'s guard rails.** `_MAX_WALK_ENTRIES` at 200 000 against a worst measured 25 657;
  the blanket `except Exception` that makes seeding a nicety; the symlinked-directory drop; the
  sort for a stable seed order. All four survive G4 unchanged and step 4.8 re-asserts them over a
  governed tree.
- **`checkouts.py`'s budgets.** `MAX_DEPTH`, `MAX_CHECKOUTS`, `MAX_SCANNED_DIRS`,
  `MAX_CONCURRENT_STATUS` and the 20 s worst case are all unaffected, **because** G3 gives
  discovery its own predicate. Had the plan shared one predicate, `MAX_SCANNED_DIRS` would have
  been spent inside `.git/objects` and the multi-repository panel would have quietly stopped
  finding the second checkout.
- **`daemon/server.py`'s two polls.** The branch poll and the status poll both depend on `.git/`
  being invisible to the watcher, and decision 1 keeps it invisible by a stronger rule than the one
  they were written against. Only the *comment* at `:120-124` needs correcting.
- **`resolve_inside`, `_read_path`, `gitcmd.py`, `WsClient.send` and the two command gates.** None
  is reached by this plan. No new command kind, no new frame, no new path from the network, no new
  fork. I looked for a way this feature could grow one and did not find it; the closest is
  `.git/info/exclude` in G10, which is why that item names `security-auditor` explicitly.
- **`tests/test_policy_scan_root.py` is not affected.** The task brief listed it among the pinned
  tests that change. It imports `test_language_policy` and `test_project_naming` and never touches
  `rhizome_graph.tree` (verified by grep); the only three test files that import `tree` are
  `tests/test_tree.py`, `tests/test_sizes.py` and `tests/test_content_search.py`. Recorded so the
  next reader does not go looking.
- **`tests/test_sizes.py:168-175` and `tests/test_content_search.py`.** Both rely on
  `node_modules` being pruned, which decision 2 keeps unconditional, and neither builds a
  `.gitignore` fixture. Unchanged, verbatim.
- **`rhizome_graph/paths.py:139-140`.** Examined and deliberately left alone; decision 8.

---

## 7. Where I stopped

- **Not read:** `web/src/simulation.ts` beyond confirming directory nodes come from child paths,
  `web/src/renderer.ts`, `daemon/server.py` outside `EventHub.reset`, `Session.switch_root`,
  `_start_watcher` and the two poll constants, and `rhizome_graph/status.py`. If a step here turns
  out to need a `Session` change, decision 5 was wrong and the plan should be re-read before it is
  patched.
- **Not settled: whether a `.gitignore` should be read through `safe_read.read_capped`.** The
  argument for it is the one `2026-08-23-02-51-content-search.md` R1 makes -- `scan_tree` filters symlinks but not
  FIFOs, and a named pipe called `.gitignore` under a hostile root would park a walk thread
  permanently. The argument against is that the walk opens this path for every root, on boot, and
  `read_capped` is measurably heavier than `open`. I did not measure it and I did not decide it;
  G2 step 2.7 is where it belongs, and it should be decided before that step is written rather
  than after.
- **Not measured, arithmetic only:** the content-search and F7 deltas. Both walk through
  `scan_tree`, so they inherit G4's numbers; the extra bytes are the 33 274 this checkout gains
  against a 64 MiB `MAX_TOTAL_BYTES`, which I judged free rather than running a search before and
  after.
- **Not measured:** whether a memoized per-directory stack beats the naive prototype's 40.3 ms on
  `~/projects`. I asserted it should and marked the number a ceiling; nothing here proves it.
- **Not measured:** a hostile tree. `MAX_RULES_PER_FILE`, `MAX_IGNORE_FILES`,
  `MAX_DOUBLESTAR_PER_PATTERN` and `MAX_PATTERN_LENGTH` are pinned guesses in the spirit of
  `MAX_SCANNED_DIRS`, not observed ceilings. The 214-rule figure of 63.45 us is real; 1 000 rules
  is extrapolation.
- **Not run:** the opt-in packaging tests (`RHIZOME_PACKAGE_TESTS=1`). Nothing here touches
  packaging -- no new dependency, and `gitignore.py` is an ordinary file in a source tree
  `packaging/build-deb.sh` already installs and `compileall` already byte-compiles.
- **Not attempted:** any judgement about how severe the `re`-from-a-file surface is. The structure
  -- a pattern chosen by whoever controls the observed root, compiled into a regex, matched against
  every path on every walk -- is what I am reporting. Hand it to `security-auditor` when G1 lands.
- **The one failing test in section 0 was diagnosed, not fixed.** A live daemon on this host holds
  the ingest socket. I changed nothing.
