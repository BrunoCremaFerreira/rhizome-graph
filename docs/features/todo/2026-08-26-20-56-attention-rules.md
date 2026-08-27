# Plan: Attention rules -- tell me when an agent touches something it should not

- **Status:** todo
- **Created:** 2026-08-26 20:56
- **Implemented:** -- (date, and the branch it landed on)
- **PR/commit:** --
- **Consultations (mandatory):**
  - `software-architect` (2026-08-26) -- this document is its assessment and staged plan, and
    it names the owner of every RED/GREEN step below.
  - `security-auditor` (2026-08-26) -- consulted. This feature adds a rule file the daemon
    reads from the observed root and a new field on the event frame; R7 and R11 were written
    for it, and the audit's H4 and H5 are the two that landed. Its findings are appended at the
    end of this document; the full report is
    `docs/security/2026-08-26-audit-five-planned-features.md`.
  - `developer-tester` (2026-08-27) -- consulted on the step table below, and it wrote **no**
    test code: every row carries a verdict of `OK`, `NEEDS SHARPENING` or `NOT WRITABLE AS
    SPECIFIED`, appended at the end of this document. The full review is
    `docs/features/2026-08-26-tester-review-five-plans.md`. No implementation step here may
    start before the RED test it names exists.

Written 2026-08-26 against `fd0f34e`, with the frontend suite green at the numbers in section 0
and the backend suite **unrunnable on this host** (see section 0). Every line number below is
from that commit.

Scope: the user declares a set of path patterns that deserve a second look --
`.github/workflows/`, `package.json`, `pyproject.toml`, `.claude/settings.json`, lockfiles,
anything outside `src/`. When an agent's event lands on a matching path the node wears a
distinct alarm marker on the graph, the alarm is listed, and (opt-in, secondary) a browser
notification is raised. Nothing about the graph, the search, the size mode, the file viewer or
the git status panel changes.

Per `CLAUDE.md` rule 3, **nothing in this document is committed**. It is a plan; the tree is
untouched by it and stays that way until the user asks otherwise.

---

## 0. Baseline, measured on this host

| Measurement | Command | Result |
|---|---|---|
| Frontend suite before any change | `cd web && node node_modules/vitest/vitest.mjs run` | **1403 passed (1403)**, 51 files, **19.16 s** |
| Backend suite before any change | `.venv/bin/pytest -q` | **could not be run.** `pytest` is installed in neither `/usr/bin/python3` nor `.venv`, and installing it is forbidden to this role. Static count instead: **1343 `def test_` across 79 files in `tests/`**. `CLAUDE.md` claims 1498 passing (parametrization accounts for the difference); that number is **quoted, not verified here**. |
| `CLAUDE.md`'s recorded frontend count | -- | says **1287/1287**; the tree says 1403. The document is stale by 116 tests. Noted, not a finding of this plan. |
| `match_rules` with 11 realistic attention patterns | `parse_patterns` then 200 000 `match_rules` calls, `python3`, this host | **5.35 us per call** |
| `match_rules` with 200 patterns, no match | 20 000 calls | **64.1 us per call** |
| `parse_patterns` over an 11-line rule file | 1 000 calls | **131.5 us per call** (paid once at boot and once per root switch) |
| Watcher per-event path today, with ignore rules in force | `CLAUDE.md`, "The cost is known, named" | **30.29 us** (was 2.90 us before the ignore work) |
| `scan_tree`, this checkout | `rhizome_graph.tree.scan_tree` | **247 files, 10.0 ms** |
| `scan_tree`, `~/projects` | as above | **829 files, 64.5 ms** |
| `scan_tree`, `$HOME` | as above | **12 524 files, 623.7 ms** |
| Entry chunk, built | `ls -la web/dist/assets/index-*.js` | **551 195 bytes** |
| Node | `node --version` | v18.19.1 |

Does the `.gitignore` matcher actually express what attention rules need? Measured, not assumed:

| Rule file | Path | `match_rules` answers |
|---|---|---|
| `*` / `!src/` / `!src/**` | `src/a.ts` | `False` |
| same | `src/deep/b.ts` | `False` |
| same | `docs/x.md` | `True` |
| same | `package.json` | `True` |
| same | `src` (the directory entry itself) | **`True`** -- a wart, see decision 3 |
| `.github/workflows/` | `.github/workflows/ci.yml` | `True` |
| same | `.github/x.md` | `False` |

Four of these decide the design.

- **"Anything outside `src/`" is expressible today, in git's own syntax, with three lines.**
  That is the hardest of the user's named targets and it needs no new pattern language. It is
  the single strongest argument for reuse in decision 3.
- **A directory-only pattern reaches the files under it.** `.github/workflows/` matching
  `.github/workflows/ci.yml` is `_rule_matches`'s ancestor rule (`gitignore.py:332-350`) doing
  exactly what an attention rule wants, with nothing added.
- **5.35 us per event at 11 rules is 18% of the watcher's current 30.29 us per-event path**, and
  it grows linearly: 200 rules is 64.1 us, more than the whole of today's path. That is what
  makes the rule cap in decision 6 a budget rather than a formality.
- **The seed is 12 524 events on this host's home directory.** At 5.35 us each that is 67 ms of
  matching for a snapshot on which no agent did anything. Decision 5 makes seed exemption
  structural rather than a filter, and it costs nothing to make it so -- see the finding in
  section 1.

---

## 1. Assessment: how an event reaches a browser today, and where a rule could sit

### The seams, and which are load-bearing

**There are exactly THREE places an activity event is encoded and fanned out, and one of them is
the seed's own.** `EventHub.seed_paths` (`server.py:312-326`) builds its own message, appends it
to `self._seed` and broadcasts it, never touching `_publish`. `_publish` (`server.py:403-407`) is
the write path -- hook and watcher alike. `_broadcast_transient` (`server.py:383-401`) is the read
path. **This is the most useful fact in the whole assessment**: a rule evaluated in `_publish` and
`_broadcast_transient` is a rule the seed never asks, so "the boot snapshot never alarms" is a
consequence of the existing shape rather than a condition anyone has to remember to write. The
67 ms above is never paid. **Load-bearing, and the reason this feature is cheap.**

**`gitignore.py` is two layers, and they are already cleanly separated.** The pure layer is
`compile_rule` (`:218`), `parse_patterns` (`:278`) and `match_rules` (`:312`): stateless
functions over `(text) -> tuple[Rule, ...]` and `(rules, relative, is_dir) -> bool`, importing
nothing but `re` and `dataclasses`. The stateful layer is `IgnoreRules` (`:497-638`): it reads
files, memoizes per directory, answers `governs`, and owns `ignored_child` / `ignored` /
`invalidate`. `match_rules`'s own docstring (`:312-331`) says the ancestor-chain half of git's
semantics "belongs to the caller that owns the ancestor chain", and `CLAUDE.md` says the `.git`
and `node_modules` divergences "live in the **caller**". **So the pure layer carries no rhizome
policy at all** -- which is exactly what makes it reusable by a second caller with a different
policy. **Load-bearing, and decision 3 turns on it.**

**`parse_command` and the two gates are kind-indifferent and additive.** `COMMAND_KINDS`
(`server.py:462`) is a five-tuple, `parse_command` (`:467-548`) builds `kind`/`path`/`token` and
adds a fourth key only when it understood one, and `control_allowed` then `token_matches`
(`server.py:871-891`) sit in front of `handle_command` echoing `command["path"]`. `sizes` is
already the precedent for a command that names nothing. **Load-bearing, and decision 4 is that
this feature adds NO command at all** -- which is a stronger position than adding one carefully.

**`parseEvent` (`protocol.ts:102-127`) destructures named fields and ignores the rest, and every
non-required field degrades.** `origin` degrades to `"hook"`, `label` to `""`, and the docstring
says why: "a page served from a newer or older daemon than the one broadcasting still draws
everything it receives". A new boolean on the event frame follows that rule exactly -- absent
degrades to `false`, so an old page against a new daemon simply never alarms, and a new page
against an old daemon never alarms either. **Load-bearing, copied exactly.**

**`updateNodeAttributes` (`renderer.ts:875-940`) is a three-way branch and a fixed post-chain.**
Matched (cyan, no idle fade) at `:901-908`; directory at `:909-918`; file at `:919-939`, where
`const base` is the size colour or `fileColor`, then the write flash lerps against it
(`:928`), then the read tint (`:934-936`), then the idle fade `multiplyScalar(0.35 + 0.65 *
node.opacity)` (`:937`), then the point size (`:938`). **The colour channel is fully spoken
for**, and decision 8 is that the alarm must not compete for it. **Load-bearing, and this plan
changes exactly one expression in it.**

**`readMarker.ts` plus `updateReadMarkers` (`renderer.ts:1151-1210`) is the precedent for
"a different shape, not a different shade".** A pooled sprite set, slots bound to a path, sized
in pixels through `labelMetrics.worldPerPixel`, living in the main scene so the bloom reaches it.
`CLAUDE.md` states the doctrine outright: "A write is a *flash that decays*; a read is a *ring
that pulses* -- a different shape, not a different shade, so the two never blur together through
the bloom." **Load-bearing, and the model for the alarm marker.**

**`main.ts`'s keydown chain (`main.ts:362-514`) is ordered by contested keys.** F7 first because
it contests nothing (`:370-378`), file view next because a modal owns Escape (`:384`), root bar
next because an open bar owns Enter/Tab/Escape (`:392`), content search, then name search.
**Load-bearing, and this feature adds at most one unconditional key.**

**`main.ts:322-348` is the single `reset` handler, and every stateful thing on the page is
cleared there** -- `sim.reset()`, `renderer.resetScene()`, `eventHud.clear()`,
`statusHud.clear()`, `closeView`, `closeContentSearch`, `closeSizeMode`, `attribution.reset()`.
An alarm set that is not cleared there names files of a project the user has left.
**Load-bearing, and R6 step 6.5 is nothing but this line.**

### The five things that are actually in the way

1. **Nothing anywhere holds a user-declared pattern.** `Settings` (`cli.py:233-260`) has ten
   fields and none of them is a policy about paths. `gitignore.py`'s rules always come from a
   file *inside the tree being walked*, discovered per directory. There is no notion of a rule
   the user wrote about the project rather than about a directory in it.
2. **The event frame has no room for a verdict.** `Event` (`normalize.py:53-80`) is
   `ts/agent/type/path/color/origin/label`, and `_encode` is `json.dumps(asdict(event))`
   (`server.py:459-460`). A verdict has to be a field on it or a second frame; there is no third
   option that keeps the two in step.
3. **`normalize_event` is on the hook's hot path and must stay pure.** `CLAUDE.md`: the check in
   `_read_path` is lexical "because `normalize_event` is pure and runs on the hot path". A
   matcher that reads a rule file cannot live there. The rule set has to arrive as a value the
   hub already holds.
4. **The colour channel has four occupants and no fifth slot.** See the seam above. An alarm
   painted as a base colour is erased by the very write flash that raised it, which is the one
   moment it must be visible.
5. **The direction of failure inverts when `gitignore.py` is reused.** In `gitignore.py` a
   refused pattern, an unreadable file or a cap reached shows **more**, and `CLAUDE.md` says so
   explicitly: "The direction of every failure is the same: [...] shows **more**, never less,
   because showing more is what this feature is for." Here the same refusal alarms **less** --
   the user wrote a rule about `*.pem` in a bracket class this module refuses, and the graph
   stays silent about the file they asked to be told about. **This is the finding of the plan**,
   and R7 exists for it alone.

### Two defects this feature exposes rather than creates

- **The `actor:` colour prefix is a literal inside an untestable module.**
  `renderer.ts:1240` computes `hashColor("actor:" + agent)`, and `hashColor` lives in the pure
  `colors.ts:69`. Any second surface that wants an agent's colour -- the alarm list here, the
  stats panel in `2026-08-26-20-56-session-stats-panel.md`, the per-agent timbre in
  `2026-08-26-20-56-ambient-sound.md` -- has to respell the prefix in its own module, and the
  first typo is a page where the swatch and the figure disagree. Pre-existing. **R10, next**, and
  it is shared with the other two plans: whichever lands first does it.
- **A refused command is reported as a `rootError` painted in the observed-root bar**
  (`server.py:875-891`, `main.ts:304`). Filed as R11 in
  `docs/features/done/2026-08-23-02-51-content-search.md` and again as R12 in
  `docs/features/done/2026-08-25-22-17-size-mode.md`. This feature adds no command, so it adds
  no sixth case -- which is worth stating as a reason for decision 4 rather than as a finding.

---

## 2. Decisions before step 1

Fourteen decisions. Numbers 3, 4, 5 and 8 are the ones I would most want argued with.

**1. The alarm is a supervision signal, not a security control.** It tells a human that an agent
touched something; it does not stop the agent, and it must never be described as if it did. The
agent has already written the file by the time the hook fires -- `PostToolUse`, not `PreToolUse`.
Anything in the UI that reads as prevention is a lie.

**2. The rules are a property of the OBSERVED ROOT, and they are declared in a file.** Not typed
into the page (decision 4), not a command-line list of patterns (a shell would eat the globs and
a long list is unreadable in `ps`), not an environment variable holding a newline-separated blob.
A file, whose *path* is a `Settings` field. Default: `<root>/.rhizome-attention`. Override:
`--attention-rules PATH` / `RHIZOME_ATTENTION`.

**3. Reuse `gitignore.py`'s PURE layer. Refuse `IgnoreRules`.** This is the plan's central
decision, so both halves get their price.

*Reuse `compile_rule` / `parse_patterns` / `match_rules`.* What it buys, measured in section 0:
git's syntax, which every user of this tool already knows; `!` negation, which is the only reason
"anything outside `src/`" is three lines rather than a new feature; `dir_only`, which makes
`.github/workflows/` reach the files under it; and 650 lines of translation with its own suite
(`tests/test_gitignore.py`, `tests/test_gitignore_rules.py`) and a real-`git` oracle behind it.
Writing a second pattern language for this feature would be the largest thing in it and the least
justified.

*Refuse `IgnoreRules`.* Everything in that class is about a rule file that lives **inside** the
tree it governs: `governs` per directory (`:520`), the memoized `_entry`/`_load` (`:595-638`),
`invalidate` (`:584`), the `MAX_IGNORE_FILES = 500` cap, and the two measured traps `CLAUDE.md`
records (reading a `.gitignore` is itself watched; an atomic save carries the name only on the
move's destination). Attention rules are **one file, at the root, read once**. Adopting
`IgnoreRules` would import a per-directory governance model that has nothing to govern, plus an
invalidation problem this feature does not have.

*The price of reuse, stated three ways.* (a) The wart in section 0: under `*` / `!src/` /
`!src/**` the directory entry `src` itself answers `True`, because `!src/` is `dir_only` and the
negation applies to the directory while `*` matched it first at the same level. Attention rules
are only ever asked about **files** -- events name files, never directories -- so the wart is
unreachable, and R1 step 1.4 pins that `is_dir` is never passed as `True`. (b) "Last match wins"
is git's rule and users who know it will expect it; users who do not will write `package.json`
after `!src/**` and be surprised. Documented, not fixed. (c) The refusals invert direction, which
is finding 5 and R7.

**4. NO new command kind, and no rule ever arrives over the socket.** The temptation is a
`setAttention` command so the page can edit the rules. Refuse it, for the reason
`content_search.py` "imports no `re`" is asserted over its parsed source: a pattern from the
network is compiled by `compile_rule` into a `re.Pattern`, and that is a regex built from a
string a browser sent. Catastrophic backtracking is bounded here only by
`MAX_DOUBLESTAR_PER_PATTERN` and `MAX_PATTERN_LENGTH`, which were written against a file the user
owns, not against a hostile input. `sizes` is "the one command in this protocol that turns no
string from the network into anything" (`server.py:481-487`); this feature adds a **second**
surface with that property by adding no surface at all. **The price: changing a rule needs an
editor and a `ctrl+L` (or a restart), and there is no in-page rule editor.** That is the correct
trade and R11 records the trigger that would reopen it.

**5. Evaluated DAEMON-side, and seed exemption is structural.** Three reasons, in order of
weight. (i) The matcher is Python and reusing it (decision 3) is only possible daemon-side; a
browser-side matcher means a second implementation of git pattern syntax in TypeScript. The twin
implementation precedent exists -- `content_search.py` and `matchRanges.ts` share a fixture table
-- but that rule is an ASCII fold in 97 lines with a table of triples as its oracle, while this
one is a regex translator in 650 lines whose oracle is the installed `git`, which vitest cannot
fork. (ii) Every viewer must agree: a supervision panel that says different things in two tabs is
not supervision. (iii) The cost is affordable and measured: 5.35 us on a per-event path that
already costs 30.29 us, paid in `_publish` and `_broadcast_transient` only, so the 12 524-event
seed pays nothing. *The price of daemon-side:* the rules cannot be per-viewer, so two people
watching one daemon see one policy. That is the right answer for a shared supervision view and
the wrong one for two engineers with different concerns; R11 records it.

**6. The rule file is capped, and the caps are the matcher's own.** `MAX_IGNORE_BYTES`
(256 KiB), `MAX_RULES_PER_FILE` (1000), `MAX_PATTERN_LENGTH` (512) are already in
`gitignore.py:159-181`. Reuse them by import rather than respelling -- the
`content_search.MAX_FILE_BYTES IS file_view.DEFAULT_MAX_BYTES` precedent
(`content_search.py:80-84`). **But 1000 rules is 320 us per event** by linear extrapolation from
the 200-rule measurement, which is ten times today's whole per-event path. So this feature adds
one cap of its own, `MAX_ATTENTION_RULES`, well below 1000 -- **64** is the proposal, giving
~17 us worst case, which is half of today's path. A rule file with more than 64 patterns is not
a supervision policy, it is a second `.gitignore`.

**7. The verdict is a FIELD ON THE EVENT, not a second frame.** A second `attention` frame would
have to name the path again and would arrive out of order with the event it describes -- the
browser would have to hold unmatched alarms waiting for their events, which is a join. A boolean
on the event that already names the path is one word on the wire and cannot desynchronize. It
degrades to `false` in `parseEvent` by the `label` rule. *The price:* every event frame grows by
`,"attention":false` (18 bytes) or `,"attention":true` (17). At 12 524 seed events that is
225 KB -- **except the seed never sets it**, and decision 12 makes the key **conditional**:
present only when `true`, exactly as `parse_command`'s fourth key is present only when
understood. Then the wire cost is zero for every event that does not alarm.

**8. The alarm is a MARKER, not a colour, and it changes ONE expression in the renderer.** The
colour channel is spoken for four times over (`renderer.ts:919-939`) and the last of those, the
write flash, fires at exactly the moment an alarm is raised: an alarm painted as a base colour is
repainted amber by its own cause. So the alarm is a third *shape* -- `alarmMarker.ts`, modelled
line for line on `readMarker.ts`, pooled, sized in pixels through `labelMetrics.worldPerPixel`,
in the main scene so the bloom reaches it, drawn after `updateReadMarkers` because it needs the
same frame's metrics. The **one** renderer expression that changes is the idle fade at
`renderer.ts:937`: an alarmed node is exempt from it, the way a search match is exempt at
`:901-908` ("full colour -- the user asked for this node by name, so it must be visible however
cold it is"). An alarm that fades out over the next minute is an alarm nobody sees.
*The precedence chain at `:901-918` is not touched at all*, which is the whole reason this is
cheap: a search match stays cyan while alarmed, exactly as it stays cyan while the size mode is
armed.

**9. Reads alarm too.** An agent *reading* `.env` or `~/.ssh/id_rsa` is the case a supervision
feature exists for, and `_broadcast_transient` (`server.py:383`) is one line away from
`_publish`. But reads arrive roughly ten times more often than writes (`CLAUDE.md`, repeatedly),
so this is only survivable because of decision 10. *The price:* a project that keeps its
lockfile under attention will alarm every time an agent reads it to answer a question, which is
not what the user meant. Mitigated by decision 10's per-path latch, not by a rule about `R`.

**10. One alarm per path, latched, with a count -- and it diverges from `eventLog.ts` on
purpose.** `eventLog.ts:92-98` folds a repeat into the **top** entry only, "folding into an older
entry further down would reorder the list under the reader's eye". An alarm list is a **set**,
not a stream: forty touches of `package-lock.json` are one alarm with `count: 40`, whether or not
something else alarmed in between, because the reader is being asked "what needs looking at",
not "what happened last". So the fold is against the matching entry wherever it sits, and the
entry keeps its **first** timestamp for ordering and its **last** for the count line. State the
divergence in the module docstring, or the next reader will "fix" it into `eventLog`'s rule.

**11. Acknowledgement clears, `reset` clears, nothing else does.** An alarm has no natural end
-- the file stays modified -- so it must be dismissible, and the dismissal is per alarm (click
the row) plus a clear-all. It does **not** clear on a new event for the same path: that would
make an alarm that keeps re-arming look like one that was handled. It **must** clear on `reset`
(`main.ts:322-348`), because the paths belong to a project the user left; the same sentence
`closeSizeMode` and `eventHud.clear()` are there for. *Ranking note:* the dismissal affordance
does not get a key. Escape is contested three ways in the chain already, and this panel does not
cover the graph, so it is a click.

**12. The wire key is CONDITIONAL, present only when the answer is `true`.** `parse_command`'s
rule -- "a fourth key appears **only** when the frame carried it in a form this daemon
understands" (`server.py:489-496`) -- read from the other direction. It keeps every existing
pinned event-frame assertion byte-identical, and it makes the wire cost zero for the ~99.9% of
events that do not alarm. `parseEvent` reads an absent key as `false` by the `label` rule.

**13. The on-screen alarm is PRIMARY; the notification is a secondary opt-in.** `Notification`
requires a secure context. `http://localhost:8080` and `http://127.0.0.1:8080` qualify (both are
"potentially trustworthy" by origin), and so does an SSH forward, because
`ssh -L 9000:localhost:8080` means the browser's origin **is** `localhost:9000` -- which is the
shape `CLAUDE.md` documents as the supported remote workflow, and it works. What does **not**
qualify is browsing straight to `http://192.168.1.10:8080`, the `--host 0.0.0.0` case: there
`window.Notification` may be absent entirely, and `requestPermission()` either does not exist or
resolves `denied`. So: the graph marker and the alarm list are the product; the notification is a
toggle that reports "unavailable in this context" once and stays off, and never blocks anything.
`requestPermission()` is called from the toggle's own key handler, because it needs a user
gesture. **Rank: next.** It is the part most likely to be judged noise, and none of it can be
exercised on this host.

**14. The rule file is re-read on every root switch, and both the default and an explicit path
are re-read.** `Session.switch_root` (`server.py:687-722`) already stops the watcher, resets the
hub, re-seeds and restarts; the rule load joins that sequence, before the re-seed, so the first
event after a switch is matched against the new project's rules. The default path moves with the
root by construction. An **explicit** `--attention-rules /etc/rhizome/attention` does not move,
but its patterns are still interpreted relative to the *new* root -- which is a silent
re-anchoring, and it is the one place this feature can surprise. Stated rather than fixed: a
pattern language whose meaning depends on a root the user can change from the page cannot avoid
this, and the alternative (refusing the switch while explicit rules are loaded) trades a
surprise for a refusal nobody would understand. The panel names the rule file it loaded, which
is what makes the re-anchoring visible. *The load itself needs no `asyncio.to_thread`*: it is one
capped read of at most 256 KiB plus 131.5 us of compilation, measured, against a `scan_tree` that
runs to 623.7 ms on this host and is already threaded. Adding a thread here would be cargo, and
saying so is cheaper than a reader wondering why it is missing.

---

## 3. The plan

Ranked, ordered, every step one RED test plus one GREEN implementation, both suites green
between any two steps. R1 and R2 are backend and land before the front end has anything to show.
R7 is the safety property and should not be deferred past R6.

New test files throughout, so no existing assertion moves: `tests/test_attention.py`,
`tests/test_attention_settings.py`, `tests/test_hub_attention.py`,
`web/tests/attentionState.test.ts`, `web/tests/attentionProtocol.test.ts`,
`web/tests/attentionHudModel.test.ts`.

---

### R1 -- Nothing holds a user-declared pattern. **Rank: now, and it can land first**

**What is missing.** `Settings` (`cli.py:233-260`) has no field about paths-as-policy;
`gitignore.py`'s rules are always discovered per directory from a file inside the tree
(`gitignore.py:604-638`); `normalize.py` is pure and hot-path and cannot read a file.

**Where.** New module `rhizome_graph/attention.py`. Not in `gitignore.py`: that module's whole
docstring and suite are about answering *git's* question, and `CLAUDE.md` names that as the
reason it can be tested against real `git` rather than against our taste -- a rhizome policy
inside it retires that property. Not in `normalize.py`: pure and hot-path, and this reads a file.
Not in `tree.py`: that is the boot snapshot and this has nothing to do with which files are drawn.

**Why it costs to put it elsewhere.** The predictable next change is a second rule *kind* -- "warn
me when an agent DELETES anything under `migrations/`", an op-type qualifier on a pattern. In its
own module that is one signature and one parse branch. Inside `gitignore.py` it is a change to the
function `scan_tree` calls 20 000 times per boot and the watcher calls on every inotify event.

**Target shape.**

```
MAX_ATTENTION_RULES = 64                       # this module's own cap; see decision 6
MAX_BYTES = gitignore.MAX_IGNORE_BYTES         # IMPORTED, never a second literal

@dataclass(frozen=True)
class AttentionRules:
    rules: tuple[gitignore.Rule, ...]
    source: str            # the file it came from, "" when none was found
    refused: tuple[str, ...]   # patterns this module could not compile -- see R7
    truncated: bool            # the file was longer than MAX_BYTES

EMPTY = AttentionRules((), "", (), False)

load_rules(path: str) -> AttentionRules       # reads; never raises
matches(rules: AttentionRules, relative: str) -> bool   # pure; never raises
```

Five properties hold it up, and each is a test.

- **`matches` never passes `is_dir=True`.** Events name files. It is what keeps the `src`-answers-
  `True` wart of section 0 unreachable, and it must be a test rather than a comment, because the
  obvious "improvement" is to pass the flag through.
- **`MAX_BYTES` IS `gitignore.MAX_IGNORE_BYTES`, imported by identity.** Same reason
  `content_search.MAX_FILE_BYTES` is `file_view.DEFAULT_MAX_BYTES`.
- **A refused pattern is RECORDED, not dropped silently.** This is finding 5 made structural: the
  tuple exists so R7 has something to report. `parse_patterns` today drops refusals
  (`gitignore.py:298-306`), so this module compiles line by line with `compile_rule` and keeps
  what came back `None`.
- **It never raises.** No file, an unreadable file, a directory where a file was named, a FIFO --
  all answer `EMPTY` with `source: ""`. A daemon that will not boot because a rule file is odd is
  worse than one that boots without rules and says so.
- **The module opens exactly one path and forks nothing.** Asserted over the parsed source, the
  way `checkouts.py`'s "starts no process" and `content_search.py`'s "imports no `re`" are. Note
  it must go through `rhizome_graph.safe_read` (`safe_read.py`), not a bare `open()`: a rule file
  at a path the user typed can be a FIFO, and `CLAUDE.md` records that this is the failure
  `safe_read.py` exists for -- a worker parked on a writerless pipe that shutdown then joins.

**Worst case, in the units that matter.** One capped read plus 64 `compile_rule` calls at boot and
once per `ctrl+L`; measured at 131.5 us for 11 patterns, so ~750 us at the cap. Once, off the
hot path. Nothing.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-backend`) |
|---|---|---|
| 1.1 | `tests/test_attention.py`: `attention.MAX_BYTES is gitignore.MAX_IGNORE_BYTES` -- identity, not equality. Today the module does not exist, so the import fails. | Create `attention.py` with the imported constant and `EMPTY`. |
| 1.2 | RED: `load_rules` over a `tmp_path` file of the eleven realistic patterns yields eleven rules, `source` equal to the path, `refused` empty, `truncated` false. | The read plus the per-line `compile_rule` loop. |
| 1.3 | RED, the section-0 table as a fixture: `matches` answers exactly those eleven verdicts, including `*` / `!src/` / `!src/**` for `src/a.ts` -> `False` and `docs/x.md` -> `True`. | `match_rules`, delegated. |
| 1.4 | RED: `matches` is asked about `src` (a directory name) and answers as a **file** -- the module exposes no `is_dir` parameter at all. | The signature. It must already pass; the test is what stops the parameter being added. |
| 1.5 | RED: a pattern with a POSIX bracket class (`[[:alpha:]].pem`) lands in `refused` and is absent from `rules`; the other patterns still work. | Keep `compile_rule`'s `None` rather than dropping it. |
| 1.6 | RED: a missing path, a directory, an unreadable file and a FIFO each answer `EMPTY` and raise nothing. A FIFO with no writer must not block -- the test writes nothing to it. | `safe_read`, and a blanket guard. |
| 1.7 | RED: a file of 200 patterns yields exactly `MAX_ATTENTION_RULES` rules and `truncated` true. | The cap. |
| 1.8 | RED, over the parsed source: `attention.py` names no `subprocess`, no `asyncio.create_subprocess_*`, and no bare `open` -- the only read is through `safe_read`. | Nothing; it must already pass. The contract, written down. |

**Test to write first.** 1.1 -- property: *the cap on a rule file this module reads is the same
object as the cap on a rule file `gitignore.py` reads*. Input that trips it today:
`import rhizome_graph.attention` raises `ModuleNotFoundError`. It is first because the constant is
the thing a later tidy-up is most likely to retype.

**Owner.** `developer-tester` -> `developer-backend`.

---

### R2 -- Configuration cannot name a rule file. **Rank: now**

**What is wrong.** `Settings` (`cli.py:233-260`) is frozen and complete, and `main()` in
`daemon/server.py` is the only place that touches `os.environ` --
`tests/test_daemon_environment_boundary.py` pins that "with **no** exemptions", and its definition
is "deliberately wide enough to catch `default_web_dist(os.environ)` passed as an *argument*". So
the rule-file path cannot be read anywhere but `cli.py`.

**Where.** `cli.py`: one new `Settings` field `attention_rules: str`, one `--attention-rules`
argument, one `RHIZOME_ATTENTION` environment read, all inside the existing pure
`argv + environ + cwd -> Settings`.

**Why it costs to put it elsewhere.** Reading the path in `server.py` breaks the boundary test
outright. Reading it in `attention.py` makes that module environment-aware and therefore
untestable without monkeypatching `os.environ`, which nothing else in `rhizome_graph/` needs.

**Target shape.** `attention_rules` is a **string, possibly empty**, and it stays a string --
`web_dist`'s exact rule, with `cli.py:245-248`'s reason quoted: "deciding which candidate exists
is a filesystem question, and this value is built without a filesystem". Empty means "use the
default under the observed root"; non-empty means the user named a file. `Session` resolves it,
because `Session` is the thing that knows the root and the thing that changes it.

**The refusal rule applies.** "A default may be adjusted; an explicit request may not." An
**explicit** `--attention-rules` naming a file that does not exist, or is a directory, **refuses
at boot**: rc 1, one line, no traceback, exactly as an explicit `--port` that is taken does
(`CLAUDE.md`). Someone who typed a path and got silence has been lied to, and the silence is
indistinguishable from "nothing has alarmed yet", which is the worst reading this feature can
produce. The **default** path being absent is the normal case and degrades to no rules at all.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-backend`) |
|---|---|---|
| 2.1 | `tests/test_attention_settings.py`: `build_settings` with no flag and no variable yields `attention_rules == ""`. | The field, defaulted. |
| 2.2 | RED: `--attention-rules /x/y` wins over `RHIZOME_ATTENTION=/a/b`, which wins over the default -- the same precedence every other setting has. | The parse. |
| 2.3 | RED: the value is returned **verbatim**, un-expanded and un-resolved: `~/rules` stays `~/rules`. | Do nothing to it. |
| 2.4 | RED: the existing environment-boundary test still passes with the new field. | Nothing; it is the regression jaw. |
| 2.5 | RED, over `rhi`: an explicit `--attention-rules` naming a path that is not a readable file exits 1 with one line naming the path, and starts no daemon. An absent **default** starts normally. | The boot check, beside the port and socket refusals. |

**Test to write first.** 2.1 -- property: *the setting exists and defaults to "no override"*.
Input that trips it today: `Settings` has no such attribute, so the construction raises.

**Owner.** `developer-tester` -> `developer-backend`.

---

### R3 -- The hub cannot answer "does this path deserve attention?". **Rank: now**

**What is missing.** `EventHub` (`server.py:151-457`) holds `_known_paths`, `_seed`, `_recent`,
`_meta`, `_status`, `_reset`, `_last_hook`, `_hook_paths`, `_fs_paths` -- and no policy.
`_publish` (`:403`) and `_broadcast_transient` (`:383`) each encode and broadcast directly.

**Where.** `EventHub`, one new field `_attention: AttentionRules` and one new private
`_verdict(event) -> bool`; `Session`, the load and the re-load on switch.

**Target shape, and the one refactor it needs.**

```
class EventHub:
    def set_attention(self, rules: AttentionRules) -> None: ...
    def _observe(self, event: Event) -> str:      # verdict + encode, ONE place
        ...
```

`_publish` and `_broadcast_transient` both call `_observe`. **They must not each call the matcher**
-- two call sites for one policy is how a later "reads should not alarm" change lands in one of
them. This is also the exact seam
`docs/features/todo/2026-08-26-20-56-session-stats-panel.md` needs for its counters: **if both
features are built, `_observe` is written once and both hang off it.** Whichever lands first
creates it; the second one must not add a parallel hook.

`seed_paths` (`:312`) is deliberately left alone. That is decision 5's structural exemption, and
R3 step 3.4 is the test that pins it -- because the obvious "consistency" refactor is to route
the seed through `_observe` too, and that would alarm 12 524 times on a fresh `$HOME`.

**Worst case, in the units that matter.** 5.35 us at 11 rules and ~17 us at the 64-rule cap, on a
path that costs 30.29 us today, paid only on hook and watcher events. Zero on the seed. The
extrapolation to 64 rules is linear from the 11-rule and 200-rule measurements in section 0 and
is **not** an observation; the ceiling that would make it matter is a burst above roughly 3 000
events per second, which nothing here has ever produced.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-backend`) |
|---|---|---|
| 3.1 | `tests/test_hub_attention.py`: with rules naming `package.json`, a hook event on `package.json` broadcasts a frame carrying `attention: true`; one on `web/src/a.ts` carries **no `attention` key at all**. | `set_attention`, `_observe`, the conditional key. |
| 3.2 | RED: a **read** (`type: "R"`) on a matching path also carries `attention: true`, and still goes through `_broadcast_transient` -- it does not enter `_known_paths` or `_recent`. | `_broadcast_transient` calls `_observe`. |
| 3.3 | RED: a **watcher** event on a matching path carries it too, and keeps its attribution. | Nothing extra; `_publish` covers it. |
| 3.4 | RED: `seed_paths` over a matching path broadcasts a frame with **no** `attention` key, and `replay_messages()` holds none. | Nothing; `seed_paths` must stay off `_observe`. The test is the guard on the refactor. |
| 3.5 | RED: with `EMPTY` rules nothing ever carries the key, and every existing pinned event-frame assertion is byte-identical. | The empty-rule short circuit. |
| 3.6 | RED: `_publish` and `_broadcast_transient` reach the matcher through exactly one call site -- asserted over the parsed source of `server.py`, the way the "no shiki outside `highlight.ts`" contract is. | `_observe`. |
| 3.7 | RED: `Session.switch_root` re-loads the rules from the **new** root before re-seeding; an event after the switch is matched against the new file, not the old. | The load, in the existing sequence. |

**Test to write first.** 3.1 -- property: *the verdict rides the event that names the path, and
only when it is true*. Input that trips it today: `EventHub` has no `set_attention`, so the test
does not construct.

**Owner.** `developer-tester` -> `developer-backend`.

---

### R4 -- The browser drops a field it does not know. **Rank: now**

**What is wrong.** `parseEvent` (`protocol.ts:102-127`) destructures seven names and builds a new
object from them; an eighth key on the wire is discarded. So the daemon can be right and the page
still blind.

**Where.** `protocol.ts:104` (the destructure) and `:118-126` (the returned object), plus
`AgentEvent` (`:38`).

**Target shape.** `attention: boolean`, resolved as
`typeof attention === "boolean" ? attention : false`. The **`label` rule** verbatim
(`protocol.ts:95-97`): an absent or mistyped value degrades rather than dropping the frame, "so a
page served from a newer or older daemon than the one broadcasting still draws everything it
receives". A non-boolean truthy value -- `"yes"`, `1` -- must degrade to `false`, not to `true`:
the fail-safe direction here is the *loud* one, but a page that alarms on a malformed frame from
a daemon of another version alarms on nothing the user wrote, which is worse than silence.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-frontend`) |
|---|---|---|
| 4.1 | `web/tests/attentionProtocol.test.ts`: a frame with `attention: true` parses with `attention: true`. | The field. |
| 4.2 | RED: a frame with no `attention` key parses with `attention: false` and is otherwise byte-identical to today's answer. | The degradation. |
| 4.3 | RED: `attention: "yes"`, `attention: 1`, `attention: null` each parse with `attention: false`; none of them drops the event. | The type check. |
| 4.4 | RED: every existing `protocol.test.ts` assertion about `parseEvent` still passes. | Nothing; the jaw. |

**Test to write first.** 4.2, not 4.1 -- property: *an event frame from a daemon that knows
nothing about attention still parses, and does not alarm*. Input that trips it today: nothing;
4.2 is green before the change and must stay green, so **4.1 is the one that is RED**. Write 4.1
first and 4.2 in the same commit, and say in the test file which of the two is the guard.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R5 -- Nothing on the page holds an alarm. **Rank: now**

**What is missing.** `simulation.ts`'s `SimNode` (`:16-43`) has four channels -- `highlight`,
`opacity`, `color`, `reading` -- and `tick` (`:167-180`) decays three of them. An alarm has no
decay: it lasts until dismissed. Putting it on `SimNode` beside four decaying channels is exactly
what `sizeMode.ts:19-22` refuses for `bytes`: "a value with a lifetime of its own beside four
channels the tick decays".

**Where.** New pure module `web/src/attentionState.ts`. Beside `search.ts`, `contentSearch.ts`,
`fileView.ts` and `sizeMode.ts`, for the reason all four give: a decision taken in `main.ts`
carries no test by doctrine, and one taken in `renderer.ts` needs a GL context and cannot be
tested at all.

**Target shape.**

```
interface Alarm {
  readonly path: string;
  readonly firstTs: number;   // ordering
  readonly lastTs: number;    // "last seen" line
  readonly count: number;     // folded repeats
  readonly agent: string;     // identity, for the swatch
  readonly label: string;     // text only
  readonly types: readonly EventType[];  // did it write, or only read?
}

createAttention(max?: number): AttentionState
observe(state, event): AttentionState        // same reference when nothing changed
acknowledge(state, path): AttentionState
acknowledgeAll(state): AttentionState
resetAttention(state): AttentionState
alarms(state): readonly Alarm[]              // newest FIRST alarm first
isAlarmed(state, path): boolean
```

Six properties hold it up.

- **A seed event never alarms** even if the daemon ever set the flag on one. `eventLog.ts:82`'s
  rule, restated locally, because two guards on one path is this repository's stated form of
  depth (`CLAUDE.md`: "two conditions on one path, never two paths"). Cheap: one comparison.
- **`attention: false` is not an event this module has anything to do with.** It returns the same
  reference, `applyView`'s idiom, so `main.ts` needs no comparison of its own.
- **The fold is against the MATCHING entry, wherever it sits** -- decision 10 -- and the entry
  keeps `firstTs` for ordering. Write the divergence from `eventLog.ts` into the docstring.
- **`agent` is the key for the swatch; `label` is text.** Two subagents of the same type that both
  touch one path leave one alarm; the alarm carries the **latest** agent, and the docstring says
  so, because "which of them did it" is not a question one row can answer.
- **The list is capped.** `MAX_ALARMS`, proposed 100. A rule file matching a whole subtree during a
  refactor is the ordinary case, not the hostile one.
- **`acknowledge` does not suppress.** A later event on an acknowledged path opens a **new** alarm
  with `count: 1`. Decision 11: an alarm that keeps re-arming must not look like one that was
  handled.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-frontend`) |
|---|---|---|
| 5.1 | `web/tests/attentionState.test.ts`: an `attention: true` event opens one alarm with `count: 1`; an `attention: false` event returns the **same reference**. | `createAttention`, `observe`. |
| 5.2 | RED: forty events on one path fold into one alarm with `count: 40`, `firstTs` from the first and `lastTs` from the last -- **including** when other paths alarmed in between. This is the `eventLog.ts` divergence and it must be its own test. | The keyed fold. |
| 5.3 | RED: an `origin: "seed"` event with `attention: true` opens nothing. | The seed guard. |
| 5.4 | RED: `acknowledge(path)` removes that alarm and leaves the others; a later event on the same path opens a fresh alarm with `count: 1`. | `acknowledge`. |
| 5.5 | RED: `resetAttention` empties the list, and `alarms()` on a fresh state is `[]`. | `resetAttention`. |
| 5.6 | RED: past `MAX_ALARMS` the **oldest** alarm is dropped and the newest kept; the cap is exact. | The cap. |
| 5.7 | RED: an `R` on a matching path alarms, and its `types` records `"R"` alone -- so a painter can tell "read" from "written". | `types`. |
| 5.8 | RED: a degenerate `max` (0, negative, NaN, Infinity) falls back to the default, exactly as `eventLog.resolveMax` does. | `resolveMax`, copied. |

**Test to write first.** 5.2 -- property: *an alarm list is a set, not a stream*. Input that trips
it today: the module does not exist; and once it does, the `eventLog.ts`-shaped implementation
(fold against the top entry only) is what 5.2 catches, which is why it and not 5.1 is the one
worth writing first.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R6 -- Nothing on screen shows an alarm. **Rank: now**

**What is missing.** Two halves: the marker in the graph, and the list.

**Where.**
- New `web/src/alarmMarker.ts`, modelled on `web/src/readMarker.ts`; new
  `updateAlarmMarkers` in `renderer.ts` beside `updateReadMarkers` (`renderer.ts:1151-1210`),
  called after it because it needs the same frame's `labelMetrics`.
- One expression in `updateNodeAttributes`: the idle fade at `renderer.ts:937`.
- New `renderer.setAlarms(paths: ReadonlySet<string>)`, the shape `setSearch`
  (`renderer.ts:717-725`) and `setSizeColors` (`:669-671`) already have: **the renderer takes an
  answer, never a question.** Nothing in it learns that a rule file exists.
- New `#attention` element top-left in `web/index.html`, new `web/src/attentionHud.ts` painter,
  new `web/src/attentionList.ts` if the ordering and the visibility rule prove worth their own
  module -- and they do, by `statusList.ts`'s own precedent: `visible` derives from the entry
  count, never from a flag, because a permanent empty strip reports nothing.

**Placement, and what it can collide with.** Top-left is the only free corner, verified:
`#search` and `#content-search` are `top: 14px; left: 50%` (`style.css:194-197, 246-249`),
`#size-legend` is `top: 14px; right: 14px` (`:313-316`), `#root-bar` is `top: 56px` centred
(`:387-389`), `#bottom-bar` is `bottom: 10px` (`:31-35`). Three collisions to state rather than
discover: (a) `#hud`'s `#log` is bottom-left with `max-height: 30vh` (`style.css:78`), so this
panel takes `max-height: 45vh` and scrolls -- at a very short viewport they still meet, and the
bargain is the one `#size-legend` already accepts (`style.css:306-308`); (b) the **modal** file
view paints over it, same bargain, undone by closing the panel; (c) the **docked** file view is
`width: 40vw` on the right (`style.css:679-683`) and cannot reach it. And
`pointer-events: none` on the container with `auto` on the list, the load-bearing line
`#bottom-bar` and the docked panel both carry -- without it a full-height box swallows drags meant
for the canvas.

**Why the marker and not a colour.** Decision 8. Restated as a cost: an alarm as a base colour is
overwritten by `this.scratchColor.setHex(base).lerp(tmpColor.setHex(flash), node.highlight)` at
`renderer.ts:928` for the full second after the write that raised it -- the alarm would be
invisible for exactly as long as it is interesting.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-frontend`) |
|---|---|---|
| 6.1 | `web/tests/attentionHudModel.test.ts`: the list model orders alarms newest-first by `firstTs`, caps the rows, and answers `visible: false` on an empty list -- `statusList.ts`'s rule, not a flag. | `attentionList.ts`. |
| 6.2 | RED: a row splits its path with `splitPath` (`eventLog.ts:129`) so the directory and the name paint in two greys -- imported, never respelled. | The row model. |
| 6.3 | RED: the row's swatch colour is `actorColor(agent)` -- the same function the renderer's figure uses (see R10); with `agent: ""` there is **no swatch**, because an empty agent is nobody on camera. | The swatch field. |
| 6.4 | RED, over the parsed source of `alarmMarker.ts`: the geometry is expressed in the same pixel-metric terms `readMarker.ts` uses and names no world units. Pin **relations** between radii, never their values, so retuning is free -- `readMarker`'s own stated rule. | `alarmMarker.ts`. |
| 6.5 | RED: `main.ts`'s `onReset` clears the alarms. Asserted the only way `main.ts` can be: over its parsed source, that `resetAttention` is named inside the reset handler. | One line in `main.ts:322-348`. |
| 6.6 | RED: an alarmed node is exempt from the idle fade. Untestable in `renderer.ts` by doctrine, so the assertion is over the parsed source: the `multiplyScalar(0.35 + 0.65 * node.opacity)` call at `:937` sits behind a condition naming the alarm set. **This is the weakest test in the plan** and it is stated as such -- it pins the shape, not the pixel. | The condition. |

**Test to write first.** 6.1 -- property: *an empty alarm list is not on screen at all*. Input that
trips it today: the module does not exist. It is first because a permanently visible empty panel
is the failure `statusList.ts` was written to avoid and the one a painter written first would
reproduce.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R7 -- A refused rule alarms LESS, and today nothing would say so. **Rank: now. This is the safety property**

**What is wrong.** Finding 5 in section 1. `gitignore.py` refuses a pattern it cannot translate
correctly -- POSIX bracket classes, over-long patterns, too many `**`, anything `re` will not
compile (`gitignore.py:218-273`) -- and `parse_patterns` drops it silently
(`gitignore.py:298-306`). In `gitignore.py` that is safe by construction, and `CLAUDE.md` says so:
"a refused rule, an unreadable ignore file or a cap reached shows **more**, never less". Reused
here the same refusal shows **less**: the user wrote a rule, the daemon dropped it, and the graph
reports the silence that means "nothing has happened".

**Where.** `attention.py`'s `refused` tuple and `truncated` flag (R1), `Session`'s load (R3), the
`meta` frame or a small frame of its own, and the panel's header.

**Why it costs.** Concretely: a user protecting private keys writes `[[:alnum:]]*.pem`. That
pattern is refused (`gitignore.py:436-468`, and `CLAUDE.md` explains why: `re` reads a POSIX class
as an ordinary class of the letters inside it and "matches the wrong thing *silently*, which is
worse than not matching"). The rule file looks correct, the panel stays empty, and the empty panel
is the same picture as a well-behaved session. **A supervision feature whose failure mode is
indistinguishable from success is not a supervision feature.**

**Target shape.** The panel's header states, always and not only on failure, three facts: which
file the rules came from, how many rules are in force, and how many were refused. A non-zero
refusal count is the loud part; the other two are what make "no rule file was found" visible
instead of inferred. **`source: ""` is the case that matters most** -- a typo in
`RHIZOME_ATTENTION` that R2 step 2.5 does not catch (a readable file with the wrong contents), or
a `ctrl+L` into a project with no rule file. The boundary is: `attention.py` reports facts, the
panel decides what to say about them, and no layer between them may collapse "0 rules" into
"nothing to show".

**Steps.**

| # | RED (`developer-tester`) | GREEN |
|---|---|---|
| 7.1 | `tests/test_attention.py`: a rule file mixing four good patterns with a bracket class yields four rules and `refused` naming the bad pattern **verbatim**, so the report can quote it. | `developer-backend` -- keep the refusal. |
| 7.2 | RED: the daemon publishes the rule source, the in-force count and the refused patterns to a connecting client, and the frame sits in `replay_messages()` **before** the seed -- the header is right on the first paint, `set_status`'s own rule. | `developer-backend`. |
| 7.3 | RED: the same frame is republished on a root switch with the **new** root's numbers. | `developer-backend`. |
| 7.4 | RED, `web/tests/attentionHudModel.test.ts`: with `source: ""` the header says no rule file was found, and this is **distinct** from the string it shows for a file that was found and held zero rules. | `developer-frontend`. |
| 7.5 | RED: a non-zero refusal count is reported with the refused patterns; zero refusals says nothing about refusals at all. | `developer-frontend`. |

**Test to write first.** 7.4 -- property: *"no rule file" and "an empty rule file" are two
different sentences*. Input that trips it today: neither exists, and the natural first
implementation collapses both to an absent header, which is exactly finding 5 shipping.

**Owner.** `developer-tester` -> `developer-backend` (7.1-7.3), `developer-frontend` (7.4-7.5).

---

### R8 -- There is no way to raise a notification. **Rank: next**

**What is missing.** Nothing in `web/src/` names `Notification` (grepped: zero hits across
`web/src/` and `web/tests/`).

**Where.** New pure `web/src/notify.ts` deciding *whether and what*, and the API call itself in
`attentionHud.ts` -- because vitest here is `environment: "node"` (`web/vitest.config.ts`) and
`Notification` does not exist in it. So the split is forced by the test environment, which is the
cleanest reason a split ever has.

**Why it costs, and why it is `next` and not `now`.** The graph marker and the panel are the
product. A notification adds a second surface with a real availability matrix (decision 13), a
permission prompt, and a rate limit -- and it is the part most likely to be turned off within a
day. Ship the alarm first, and add this when someone has run the alarm for a week and asked for
it. **Trigger: the first time a user says they missed an alarm because they were in another
window.**

**Target shape.** Pure: `shouldNotify(state, alarm, nowMs) -> NotificationRequest | null`, with
one notification per alarm **opening** (never per fold), and a floor of
`MIN_NOTIFY_INTERVAL_MS` between any two regardless of how many alarms opened -- the OS
notification centre is not ours to flood. Impure: `Notification` named in exactly one module,
asserted over the parsed source the way "no shiki outside `highlight.ts`" is
(`CLAUDE.md`). Availability degrades in three steps and each is visible in the toggle's own
caption: the API is absent (non-secure context), permission is `denied`, permission is `default`
and the gesture has not happened yet.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-frontend`) |
|---|---|---|
| 8.1 | `web/tests/notify.test.ts`: one request per alarm opening; a fold produces none. | `shouldNotify`. |
| 8.2 | RED: two alarms opening inside `MIN_NOTIFY_INTERVAL_MS` produce one request; the second is dropped, not queued. | The floor. |
| 8.3 | RED: with the toggle off, nothing is ever requested whatever arrives. | The gate. |
| 8.4 | RED, over the parsed source of `web/src/`: `Notification` is named in exactly one module. | Nothing; the contract. |

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R9 -- The rule file is read once and never again. **Rank: noted, with a trigger**

**What is missing.** Editing `.rhizome-attention` while the daemon runs changes nothing until a
`ctrl+L` or a restart.

**Why it is not built.** Live reload means either a second watcher or a poll. A second watcher on
one file is a `watchdog` observer whose whole job is one path, and `CLAUDE.md` records the two
measured `.gitignore` traps it would walk into: reading the file is itself watched (the daemon's
own load emits `opened` and `closed_no_write` carrying that basename, so invalidating on any
event with that name throws away the very read that filled the cache), and an atomic save moves
`.rhizome-attention.tmp` onto the target so only the move's **destination** carries the name.
A poll is a fourth task on a file that changes once a month. Neither is worth it for a file the
user edits and then presses `ctrl+L` on.

**Trigger.** If someone reports editing the rules and not noticing they had to reload -- or if
the rule file ever becomes something the page can write, which decision 4 refuses.

---

### R10 -- The agent colour prefix is a literal in an untestable module. **Rank: next. Shared with two other plans**

**What is wrong.** `renderer.ts:1240` is `const color = hashColor("actor:" + agent);`.
`hashColor` is pure and exported (`colors.ts:69`); the `"actor:"` prefix is not. Any second
surface wanting an agent's colour respells it.

**Where.** `colors.ts`, one new export.

**Why it costs.** Three surfaces want it now: this plan's alarm swatch (R6 step 6.3), the stats
panel's per-agent row (`2026-08-26-20-56-session-stats-panel.md`), and the per-agent timbre in
`2026-08-26-20-56-ambient-sound.md`, which derives a voice from the same hash so sound and colour
agree. Three respellings of one prefix, in a value nobody would think to compare.

**Target shape.** `export function actorColor(agent: string): number` in `colors.ts`, and
`renderer.ts:1240` calls it. Nothing else changes.

**Steps.**

| # | RED (`developer-tester`) | GREEN (`developer-frontend`) |
|---|---|---|
| 10.1 | `web/tests/colors.test.ts`: `actorColor("x")` equals `hashColor("actor:x")` -- pinning the prefix, which is the only thing that can drift. | The export. |
| 10.2 | RED, over the parsed source: `renderer.ts` no longer contains the string `"actor:"`. | The call site. |

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R11 -- Rules cannot be edited from the page, and are one policy per daemon. **Rank: noted, and I recommend keeping it that way**

**What is wrong, from a user's point of view.** Changing what deserves attention means an editor
and a reload, and two people watching one daemon share one policy.

**Why it is not built, and what it would cost.** Decision 4. A `setAttention` command compiles a
regex from a string that arrived over the WebSocket. Today `sizes` is "the one command in this
protocol that turns no string from the network into anything" (`server.py:481-487`), `file` and
`complete` and `setRoot` pass their string through `resolve_inside`, and `search` is folded by a
module asserted to import no `re`. A command carrying a pattern would be the **first** input from
the network to reach `re.compile`, guarded only by caps written for a file the user owns. That is
a finding for `security-auditor`, not a feature to weigh, and this plan does not rank its
severity.

**Trigger.** If in-page editing is ever wanted, the shape that avoids the whole question is: the
page sends **no pattern**, only a path already on the graph, and the daemon appends a
`compile_rule`-escaped literal of that path to the rule file. Then the network contributes a path
-- which `resolve_inside` already contains -- and never a pattern. That is a different feature
with a different plan, and it should be commissioned as one.

---

## 4. What conflicts with what

- **Decision 3 (reuse the matcher) and decision 5 (daemon-side) are ONE decision.** Reuse is only
  available daemon-side, and daemon-side is only cheap because reuse means no new matcher. If a
  reviewer wants browser-side evaluation, they are also choosing to write git's pattern syntax in
  TypeScript, and the two must be argued together.
- **Decision 9 (reads alarm) and decision 10 (latch) are ONE decision.** Reads without the latch
  are a wall; the latch without reads leaves the leak case uncovered. Neither ships alone.
- **Decision 8 (a marker, not a colour) conflicts with legibility, and I cannot resolve it here.**
  The graph would then carry three ring-shaped markers: the read ring, the search's active ring
  (`renderer.ts:1118`) and this one. `CLAUDE.md` already records an unresolved risk about the
  read ring -- a 2.24 px stroke on a 64 px texture with `generateMipmaps = false`, "drawn much
  smaller than 64 px it is sampled sparsely and can fade out". A third ring inherits that risk and
  adds a discrimination problem on top of it. **The mitigation is that the alarm marker must not
  be a ring at all** -- a bracket, a caret, a filled wedge -- and which of those reads at four
  device pixels is a judgement nobody on this host can make.
- **R7 (report refusals) conflicts with header real estate.** The panel's header must carry the
  rule source, the in-force count and the refusal count, which is three facts in the corner the
  panel is trying to keep small. The file viewer's header solved the same problem by **removing**
  something (`CLAUDE.md`: the `esc` caption "was a second thing to read in a row already full of
  path, mode, language and truncation"). Expect to make that trade here too, and make it in favour
  of the refusal count, which is the one that can be wrong.

---

## 5. What cannot be verified on this host

This host is a tty. No `DISPLAY`, no browser, no audio device, and `pytest` is installed nowhere.

- **The backend suite was never run.** Every "both suites green between any two steps" above is a
  requirement, not an observation. `CLAUDE.md`'s 1498 is quoted from the document.
- **Nothing in this feature has been seen on a screen.** Whether a third marker shape is
  distinguishable from the read ring and the search ring at real zoom; whether an alarm exempt from
  the idle fade reads as important or as a stuck pixel; whether the top-left panel collides with
  `#log` at a short viewport; whether the refusal line in the header fits.
- **The notification matrix (decision 13) is asserted from the specification, not measured.** That
  `http://localhost` is a secure context and `http://192.168.x.x` is not, and that an SSH forward
  presents as `localhost`, are all read from how the platform is defined. None of it has been
  exercised in a browser here.
- **The 64-rule figure in decision 6 is a linear extrapolation** from the 11-rule (5.35 us) and
  200-rule (64.1 us) measurements, not an observation. The ceiling that would make it matter is
  roughly 3 000 events per second.
- **No hostile rule file has been fed to `compile_rule` through this path.** `gitignore.py`'s own
  suite covers the patterns; what is unmeasured is 64 of the worst of them at once on the per-event
  path.
- **The `re` engine's backtracking is not bounded**, and decision 4 exists because of it. That the
  existing caps are sufficient for a file the *user* owns is an assumption this plan makes and does
  not test.

---

## 6. What I examined and found sound

- **The three fan-out sites, and the seed's separation from the other two.** `seed_paths`
  (`server.py:312`), `_publish` (`:403`), `_broadcast_transient` (`:383`). The seed having its own
  path is what makes the exemption structural. Nothing wrong here; it is the feature's foundation.
- **`gitignore.py`'s two-layer split.** The pure functions carry no rhizome policy and the caller
  carries all of it, exactly as `CLAUDE.md` claims. Verified by reading `match_rules`'s docstring
  (`:312-331`) and `IgnoreRules` (`:497-638`); the reuse in decision 3 is available because that
  split is real.
- **`parse_command`'s conditional-key rule** (`server.py:489-496`) and the two gates
  (`server.py:871-891`). Kind-indifferent, additive, and this feature adds nothing to them --
  which is the best outcome available.
- **`parseEvent`'s degradation doctrine** (`protocol.ts:85-127`). A new optional boolean fits it
  without argument.
- **`setSearch` / `setSizeColors` as the renderer's interface** (`renderer.ts:717`, `:669`). "The
  renderer takes an answer, never a question" holds, and `setAlarms` is the same shape a third
  time.
- **`main.ts`'s single `onReset`** (`:322-348`). Every stateful thing on the page is cleared in one
  place; adding one line there is the whole of R6 step 6.5.
- **`statusList.ts`'s "visible derives from the entry count, never from a flag"** and
  `eventLog.ts`'s `splitPath`. Both reusable as-is.
- **`readMarker.ts` as a template.** Pooled, path-bound slots, pixel-sized, main scene, run after
  `updateLabels`. The alarm marker copies its structure and should copy its stated caution about
  pinning relations between radii rather than values.

---

## 7. Where I stopped

- I read `gitignore.py`'s pure layer closely and `IgnoreRules` only well enough to justify refusing
  it. I did not read `_translate`, `_translate_segment` or `_translate_class` line by line.
- I read `renderer.ts` only at the sites named above -- `updateNodeAttributes`, `setSearch`,
  `setSizeColors`, `updateReadMarkers`, the actor colour. The other ~1 400 lines I saw as a grep.
- I ran the frontend suite once and did not run it again after any measurement. I ran no backend
  suite at all.
- Every per-event figure is `python3` on this host with `time.perf_counter`, warm, single-threaded,
  and not under a running daemon. The 30.29 us baseline it is compared against is quoted from
  `CLAUDE.md`, measured by somebody else on some other day.
- I did not measure the wire cost of the conditional key against a real burst, and I did not
  measure the browser's cost of `observe` per event -- it is a `Map` lookup and a compare, and I
  am asserting rather than showing that it is free.
- I did not examine `daemon/watcher.py` beyond knowing that its events reach
  `EventHub.ingest_fs_change`. If the alarm ought to distinguish "an agent did this" from "the
  filesystem changed and we guessed which agent", that distinction lives in `_active_agent`
  (`server.py:426-437`) and this plan does not use it.

---

## Consultation: `security-auditor` (2026-08-26)

Appended by the orchestrator. The audit covered all five plans of this batch **together** and
ranked one critical, five high and seven medium findings; the full report is
`docs/security/2026-08-26-audit-five-planned-features.md` and it is the authority. This section is a pointer into it, never a second
copy of it. It was written against the feature descriptions, **not** against this document --
the auditor states so itself -- so where the two disagree the disagreement is real and unresolved,
not an editing slip.

### Findings that land on this plan

- **H4 (high).** A `Notification` is drawn by the operating system, in OS chrome, and survives in the
  notification centre after the page is gone. If its text is built from event data, then anything
  that can put an event on the wire writes onto the user's desktop -- a phishing primitive through
  a channel the user already granted. Also: `Notification.requestPermission()` needs a secure
  context, so `localhost` and an SSH-forwarded `localhost:9000` qualify and the `http://192.168.x.x`
  origin `start.sh` serves by default does **not** -- `window.Notification` may be `undefined`
  entirely there. Fixed template, only the path variable, 100 characters, one per 10 s with a
  collapsed count, a constant `tag`, and never an `icon` URL built from event data.
- **H5 (high).** Three shapes were offered and they are not equally safe. Page-side rules are the
  recommendation. A config file **inside** the observed project is written by the agent, which
  turns "content an agent writes" into "a pattern the daemon compiles", and must go through
  `safe_read` rather than a bare `open()`. Across all three shapes: **do not compile a user pattern
  with `re`** on the per-event path -- `content_search.py` imports no `re` at all and that is
  asserted over its parsed source precisely so the rule is structural. Caps: 64 rules, 256
  characters each, 64 KiB of config.
- **H3 (high).** The group-writable ingest socket means one forged line can *fire* the alarm and choose the
  notification's text.
- **M1 (medium).** A rule-source or refusal frame must be routed above `parseEvent`.
- **M5 (medium).** The shared `sanitizeDisplayText`, applied to the notification body.

### The auditor's own summary of this feature

**3. Attention rules -- the feature whose shape decides its severity.** Page-side rules add
nothing to the daemon and are the recommendation. A daemon-side config file is a new file read
(FIFO rule, cap, and it must not live where an agent writes) and a new pattern language; a
page-side command is a sixth `COMMAND_KIND` that inherits both gates by construction. The
notification is the sharp part: it renders outside the page, the attacker chooses its text, and
the secure-context requirement silently removes it for LAN viewers. Rate-limit it, template it,
and never build an `icon` URL from event data.

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

- **2.1** -- rows 6.4, 6.5, 6.6, 8.4 and 10.2 assume a TypeScript source-level test harness.
  **There is none**: `grep -rln "readFileSync\|readFile" web/tests/` returns nothing, and "no shiki
  outside `highlight.ts`" -- cited as the precedent by four of the five plans and by the audit --
  exists only as prose in comments and in `CLAUDE.md`. There is no such assertion in code.
- **2.2** -- R7 step 2 inserts a frame before the seed, into the same contested gap.
- **2.3** -- decision 4 refuses a sixth `COMMAND_KIND` and gives the best reason in the set (a
  pattern from the network reaching `re.compile`), so the five pinned exact-equality
  `parse_command` assertions are untouched.
- **2.5** -- rows 1.4, 3.5 (part), 4.2 and 4.4 are green today.
- **D.1** -- a directory-delete event reaching the matcher is behaviour this plan changes and no
  step tests.

### Row by row

### A.2 Attention rules -- 40 OK / 6 NEEDS SHARPENING / 3 NOT WRITABLE

**R1 -- 2 NEEDS SHARPENING, 6 OK.**

I re-measured the plan's section-0 table against the real `rhizome_graph.gitignore`:

```
compile_rule("[[:alpha:]].pem")           -> None          (1.5's fixture is real)
rules = parse_patterns("*\n!src/\n!src/**\n")
  match_rules(rules, "src/a.ts",    False) -> False   agrees with the plan
  match_rules(rules, "src/deep/b.ts", False) -> False agrees
  match_rules(rules, "docs/x.md",   False) -> True    agrees
  match_rules(rules, "package.json",False) -> True    agrees
  match_rules(rules, "src",         False) -> True    <-- the wart
  match_rules(rules, "src",         True ) -> False
parse_patterns(".github/workflows/\n")
  ".github/workflows/ci.yml" -> True ;  ".github/x.md" -> False   both agree
```

Ten of the eleven verdicts are exactly as the plan states. The eleventh is the load-bearing one
and the plan's conclusion from it is **backwards**.

- **1.3 -- NEEDS SHARPENING.** The section-0 row for `src` does not say which `is_dir` produced
  `True`. It is `is_dir=False`. **Corrected:** the fixture table in `tests/test_attention.py` must
  record `("src", False, True)` explicitly and carry a comment naming it as the wart, so the next
  reader meets the measurement rather than the plan's summary of it.
- **1.4 -- NEEDS SHARPENING.** The plan says: "Attention rules are only ever asked about **files**
  ... so the wart is unreachable, and R1 step 1.4 pins that `is_dir` is never passed as `True`."
  The measurement says the opposite: **the wart lives at `is_dir=False`**, which is the mode the
  plan chooses. Refusing the parameter does not make it unreachable; it makes it the only mode.

  And it *is* reachable. `EventHub._expand` (`daemon/server.py:409-414`) expands a directory
  deletion into `[*children, path]` -- the directory's own path is the last event published. So
  `rm -rf src/` under a rule file of `*` / `!src/**` publishes an event whose path is `src`, which
  `matches()` answers `True` for, and the panel alarms on a directory the user excluded.

  > **Corrected specification.** Keep 1.4 as the signature test (it is still worth having), and
  > **add a row**:
  >
  > - `tests/test_attention.py::test_a_directory_delete_does_not_alarm_on_a_directory_the_rules_excluded`
  > - Arrange: `rules = load_rules(<file holding "*\n!src/\n!src/**">)`.
  > - Assert: `matches(rules, "src") is False`.
  > - Fails today because the module does not exist; and once it does, a straight delegation to
  >   `match_rules(rules.rules, relative)` fails it, which is the point.
  > - The GREEN answer is the caller's, not `gitignore.py`'s -- the same split `CLAUDE.md` records
  >   for `.git` and `node_modules` ("both rules live in the **caller**").

| Row | Verdict |
|---|---|
| 1.1 | **OK** -- identity assertion (`is`), and `MAX_IGNORE_BYTES` exists at `gitignore.py:181` |
| 1.2 | **OK** |
| 1.3 | **NEEDS SHARPENING** |
| 1.4 | **NEEDS SHARPENING** + one new row |
| 1.5 | **OK** -- fixture verified real |
| 1.6 | **OK** -- `safe_read.read_capped` exists; the FIFO case is `tests/`-precedented |
| 1.7 | **OK** |
| 1.8 | **OK** -- `ast` over Python, real precedent |

**R2 -- 5 OK.** `tests/test_cli_settings.py` and `tests/rhi_process.py` give the harness for 2.5;
2.4 is a jaw and correctly declared.

**R3 -- 1 NEEDS SHARPENING, 6 OK.**

- **3.5 -- NEEDS SHARPENING.** "every existing pinned event-frame assertion is byte-identical."
  I looked: **there are none.** No pytest test asserts an event frame by whole-mapping equality
  (`grep 'json.loads(...) == {' tests/test_hub*.py` → nothing), no test asserts the key set of an
  event, and `web/tests/protocol.test.ts` contains **zero** `toEqual` calls. The jaw as written
  guards nothing.

  The real risk the row is reaching for is different and sharper: `_encode` is
  `json.dumps(asdict(event), ...)` (`daemon/server.py:459-460`). `asdict` emits **every** field
  of the dataclass unconditionally, so a `attention: bool = False` field on `Event` produces
  `"attention":false` on all 12 524 seed events -- which is exactly what decision 12 forbids.

  > **Corrected specification.**
  > - `tests/test_hub_attention.py::test_an_event_that_does_not_match_carries_no_attention_key_at_all`
  > - Assert: `"attention" not in json.loads(message)` for a non-matching hook event, a watcher
  >   event and a seed event.
  > - Fails today trivially (no feature), and -- the point -- fails again against the first
  >   implementation that adds a field to `Event` and leaves `_encode` alone. Say so in the header:
  >   this test is what forces `_encode` to stop being a bare `asdict`.

- 3.1, 3.2, 3.3, 3.4, 3.6, 3.7 -- **OK.** 3.6's "exactly one call site, asserted over the parsed
  source of `server.py`" is Python and `ast`-able; the precedent is real.

**R4 -- 4 OK.** 4.2 is green today and the plan says so explicitly and tells the tester to write
4.1 first. That is the right handling of a green jaw and is worth copying into the other plans.

**R5 -- 8 OK.** New pure module, `ModuleNotFoundError` RED. 5.2 (the `eventLog.ts` divergence) is
the best-argued row in this plan and I agree it should be written first.

**R6 -- 2 NEEDS SHARPENING, 2 NOT WRITABLE, 2 OK.**

- 6.1, 6.2 -- **OK.**
- **6.3 -- NEEDS SHARPENING (dependency inversion).** It requires `actorColor` from R10, which the
  plan ranks **next**, while R6 is ranked **now**. A `now` step cannot depend on a `next` step.
  **Corrected:** promote R10 to `now` and place it before R6 -- it is two lines of production code
  and it is shared with two other plans, so it is the cheapest thing in the whole programme (see
  §C).
- **6.4 -- NOT WRITABLE AS SPECIFIED.** "over the parsed source of `alarmMarker.ts`: the geometry
  is expressed in the same pixel-metric terms `readMarker.ts` uses and **names no world units**."
  There is no TS parser (§2.1), and "names no world units" is not a predicate a text scan can
  evaluate -- there is no token that means "world unit".
  > **Corrected:** drop the source assertion; assert the geometry **behaviourally**, exactly as
  > `web/tests/readMarker.test.ts` does. File `web/tests/alarmMarker.test.ts`; a recording context
  > object; assert (a) `clearRect` is called before any stroke, (b) every painted primitive stays
  > inside the box (`radius + width/2 < 0.5`, `readMarker.ts:26-28`'s stated invariant), (c) the
  > relations between radii, never their values. Fails today with
  > `Failed to load url ../src/alarmMarker`. That is correct RED and it pins more than the scan
  > would have.
- **6.5 -- NEEDS SHARPENING.** "asserted over its parsed source, that `resetAttention` is named
  inside the reset handler." No TS parser, and a text scan cannot tell "inside the handler" from
  "anywhere in the file".
  > **Corrected:** a text scan in pytest (§2.1's helper), asserting that `main.ts` contains
  > `resetAttention` at an index **between** the index of `onReset: ()` and the index of the next
  > top-level option key -- plus a header stating that this pins a spelling. And note the honest
  > limit: the assertion is only worth having because `main.ts` is untestable; it is not
  > equivalent to a behavioural test and must not be described as one.
- **6.6 -- NOT WRITABLE AS SPECIFIED.** The plan already calls it "the weakest test in the plan".
  I go further: "the `multiplyScalar(0.35 + 0.65 * node.opacity)` call at `:937` sits behind a
  condition naming the alarm set" is not expressible as a text scan (you cannot see nesting in a
  substring search) and there is no parser.
  > **Corrected:** delete the row and move the decision out of the renderer. Put the exemption in
  > `labels.ts`-style pure code: `nodeOpacityFactor(opacity, {matched, alarmed})` in a pure module,
  > with `web/tests/nodeFade.test.ts` asserting `nodeOpacityFactor(0.1, {alarmed: true}) === 1`
  > and `nodeOpacityFactor(0.1, {}) === 0.35 + 0.65*0.1`. `renderer.ts:937` then calls it.
  > That is the project's own move -- "when asked to specify something that lives in the renderer,
  > specify the pure module it should be extracted into". Fails today: the module does not exist.

**R7 -- 5 OK.** This is the strongest section of the attention plan. 7.4's property -- *"no rule
file" and "an empty rule file" are two different sentences* -- is exactly the kind of test that
earns its place, and it is writable today against a module that does not yet exist.

**R8 -- 1 NEEDS SHARPENING, 3 OK.** 8.4 ("`Notification` named in exactly one module") is a text
scan; writable (I confirmed `grep -rc AudioContext`-style scans over `web/src` return clean today,
and `Notification` has zero hits), but state the technique and its weakness per §2.1.

**R10 -- 1 OK, 1 NOT WRITABLE.** 10.1 is fine. 10.2 is the nominated defect -- see §1.

---

