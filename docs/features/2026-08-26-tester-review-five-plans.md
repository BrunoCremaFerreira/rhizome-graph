# Tester's review of five planned features and their security audit

Written by `developer-tester`, 2026-08-27, against `fd0f34e` on branch `development`.
**No test file and no production file was created or edited in producing this document.**
The only files written were this review and one throwaway probe under the session scratchpad.

Reviewed:

1. `docs/features/todo/2026-08-26-20-56-agent-lifecycle-events.md`
2. `docs/features/todo/2026-08-26-20-56-attention-rules.md`
3. `docs/features/todo/2026-08-26-20-56-session-stats-panel.md`
4. `docs/features/todo/2026-08-26-20-56-ambient-sound.md`
5. `docs/features/todo/2026-08-26-20-56-todo-caption.md`
6. `docs/security/2026-08-26-audit-five-planned-features.md`

---

## 0. What I actually ran

| What | Command | Result |
|---|---|---|
| Frontend suite | `cd web && node node_modules/vitest/vitest.mjs run` | **1403 passed (1403)**, 51 files, **17.58 s** |
| Backend suite | `.venv/bin/python -m pytest` | **COULD NOT RUN.** `ModuleNotFoundError: No module named 'pytest'`, in `.venv` and in `/usr/bin/python3` alike. There is no `.venv/bin/pytest`. Installing one is not mine to do. |
| Attribution probe | a throwaway script under `.venv/bin/python`, importing the real `daemon.server.EventHub` and monkeypatching `broadcast` | see §C.4 — five scenarios, all confirmed |
| Ignore-matcher probe | `.venv/bin/python`, real `rhizome_graph.gitignore` | see §A.2 R1 — the attention plan's section-0 table, re-measured |

**On the frontend count.** The ambient-sound plan's coordinator note is correct and I confirm it
independently: the suite is **1403 across 51 files**; `CLAUDE.md` still says `1287/1287`. It is
**stale by 116 tests**. All four plans that quote a baseline quote 1403, so their tables are worth
what they say; `CLAUDE.md` is the document that is wrong. That is not any of these plans' defect
and none of them should fix it as a rider — but the first plan that touches `CLAUDE.md`'s Status
section should correct it, and until then no reviewer should treat that number as a measurement.

**On the backend count.** All five plans say the same thing — 1343 `def test_` statically, 1498
claimed by `CLAUDE.md`, unverifiable here. I reproduce that limitation exactly. Every backend
verdict below therefore rests on **reading the source, plus the live probe above**, never on a
green run. Where I say "fails today", I either ran it in the probe or read the branch that
decides it; I say which.

---

## 1. Verdict counts

| Plan | Rows | OK | NEEDS SHARPENING | NOT WRITABLE AS SPECIFIED |
|---|---|---|---|---|
| Agent lifecycle events | 44 | 36 | 7 | 1 |
| Attention rules | 49 | 40 | 6 | 3 |
| Session stats panel | 45 | 39 | 4 | 2 |
| Ambient sound | 26 | 16 | 7 | 3 |
| TodoWrite caption | 46 | 39 | 7 | 0 |
| **Total** | **210** | **170** | **31** | **9** |

"Rows" counts every numbered RED/GREEN row plus the steps that declare *no* test (Step 0, the
`main.ts` wiring steps). A step that declares itself untestable and says why is counted **OK** —
that is the honest form, not a defect.

**The single step most likely to produce a test that passes before the feature exists:**

> **attention-rules R10.2 / session-stats R8.2 / ambient-sound 3.2** — "over the parsed source:
> `renderer.ts` no longer contains the string `"actor:"`."

Three plans name it and it is **one test**. It is green today and would stay green forever.
Measured:

```
$ grep -c '"actor:"' web/src/renderer.ts
0
```

The line is `const color = hashColor(`actor:${agent}`);` — a template literal, so the double-quoted
string the three plans all quote **does not exist in the file**. Worse, the obvious repair (search
for the bare substring `actor:`) can never go green: `renderer.ts` also contains `actor: string;`
at :83 and `actor: event.agent,` at :700, both legitimate property names. So as written the step
is a no-op, and the first fix a developer reaches for is impossible.

**Corrected specification** (one test, in whichever plan lands first; delete the other two rows):

- File: `tests/test_actor_color_prefix.py` (pytest, because there is no TypeScript-source test
  harness in this repository — see §5).
- Name: `test_the_actor_colour_prefix_is_spelled_once_in_a_module_a_test_can_reach`.
- Assertion: the text of `web/src/renderer.ts` contains **no occurrence of `actor:${`** —
  the template-literal interpolation, which is the only spelling that exists and the only one the
  fix removes. Plus the behavioural half in vitest: `actorColor("x") === hashColor("actor:x")`.
- Why it fails today: `web/src/renderer.ts:1240` contains `actor:${agent}`.
- State in the test's header that it is a **text scan, not a parse**, and what that costs: a
  comment containing the sequence would trip it, and a renamed local would evade it. The
  behavioural half is the real pin; the scan only stops the prefix being respelled.

---

## 2. Cross-cutting findings — these change the project's test culture, so they are called out first

### 2.1 There is no TypeScript-source test harness in this repository, and nine steps assume one

`grep -rln "readFileSync\|readFile" web/tests/` returns **nothing**. Not one vitest test reads a
source file. Every source-level contract in this project is a **pytest** test using `ast` over
**Python** source: `tests/test_checkouts.py`, `tests/test_daemon_environment_boundary.py`,
`tests/test_gitignore.py`, `tests/test_window_backend.py`, `tests/test_ready_callback.py`.
`tests/test_bottom_row_containment.py` parses HTML and CSS by hand, also in pytest.

**"No shiki outside `highlight.ts`" is not a test.** It is cited as the precedent by four of the
five plans and by the audit. I looked for it: it exists only as prose in comments
(`web/tests/fileDoc.test.ts:48`, `web/tests/fileViewHighlight.test.ts:37`) and as a sentence in
`CLAUDE.md`. There is no assertion anywhere that scans `web/src/` for shiki imports. A plan that
says "asserted over the parsed source, the way 'no shiki outside `highlight.ts`' is" is building on
a precedent that does not exist in code.

`typescript` **is** in `web/node_modules`, so a vitest test could use the compiler API to parse
`.ts` files — but that would be a **new technique in this project**, and it should be adopted
deliberately, not smuggled in by a step table. The cheap alternative is a text scan, which is what
`tests/test_language_policy.py` already does over `web/src`.

**Affected rows** — attention 6.4, 6.5, 6.6, 8.4, 10.2; stats 6.5, 7.3, 8.2; sound 1.9, 2.1, 2.2,
3.2, 4.5, 5.1, 5.2, 5.3. **Recommendation:** one decision, taken once, before any of them is
written:

> Frontend source-level contracts are **text scans in pytest**, in a shared helper
> `tests/frontend_source.py` exposing `read_src(name) -> str` and `index_of(text, needle) -> int`,
> and every such test's header states in one sentence that it pins a spelling and not a behaviour,
> and names the behavioural test that pins the behaviour.

With that helper, the ordering assertions (`the F8 branch sits between the F7 branch and the
file-view branch`) become writable: they are `text.index("interpretSizeKey(") <
text.index("interpretStatsKey(") < text.index("interpretFileViewKey(")`. That is why most of the
affected rows below are NEEDS SHARPENING rather than NOT WRITABLE.

### 2.2 Three plans insert a frame into the same gap in `replay_messages()`, and one of them pins the sequence exactly

`replay_messages()` today is `reset, meta, status, *seed, *recent` (`daemon/server.py:207-221`).

- lifecycle R3 3.4 inserts `agentState` **after status, before seed**, asserted **by index**.
- caption R3 3.6 inserts the same frame in the same place, asserted **by index**.
- attention R7 2 inserts a rule-source/refusal header frame **before the seed**.
- stats R3 3.2 inserts `stats` after `status` and before the seed, asserted as an **exact
  sequence**: "`reset`, `meta`, `status`, `stats`, seed, recent — in that order, asserted as a
  sequence and not as a set".

Two problems. First, **nothing defines the relative order of `agentState`, the attention header
and `stats` among themselves**, so whichever lands second silently decides it and whichever lands
third breaks the first one's assertion. Second, the existing precedent is **pairwise index
comparison**, not an exact sequence — `tests/test_hub_status.py:138` is
`kinds.index("meta") < kinds.index("status")` and `:148` is
`kinds.index("status") < kinds.index("event")`. There is **no** exact-sequence assertion on
`replay_messages()` anywhere in the suite today (I grepped; the only sequence-shaped assertion is
`tests/test_root_switch.py:290`, which compares a replay against itself).

**Corrected specification for stats 3.2:** assert
`kinds.index("status") < kinds.index("stats") < kinds.index("event")` in
`tests/test_hub_stats.py`, matching `test_hub_status.py`'s form exactly. Do **not** assert an
exact sequence; it is a pin on three other plans' freedom for no additional safety.

### 2.3 The five pinned exact-equality `parse_command` assertions are safe — none of the five plans moves them

They live at `tests/test_ws_commands.py:102,110,274` and `tests/test_ws_search_command.py:158,166,174,182,192`,
each a whole-mapping `==` including `"token": ""`. **No plan adds a `COMMAND_KIND`:** attention
decision 4 refuses one explicitly and gives the best reason in the set (a pattern from the network
reaching `re.compile`); stats decisions 2 and 5 answer by poll and slot, not by command; sound
decision 2, lifecycle §4 and caption §4 each state that `COMMAND_KINDS` is untouched. **Cost of
moving them: zero.** The only document that contemplates a sixth kind is the audit (M6), and the
plan it addresses has already declined it — see §B, M6.

### 2.4 "Assert on the private attribute" is not this repository's form, and four steps use it

`tests/test_hub_read_events.py` is cited by lifecycle 3.2, caption 3.2 and audit H1 RED 3 as the
model for a four-way "touches none of the state" assertion. I read it. **It makes no
private-attribute assertion at all.** It asserts behaviourally: a read then a write is still an
`A` (:79-91); a read reaches a live client and is absent from `replay_messages()` (:94-116); the
watcher's report of a just-read file is still published (:119-133). `tests/test_hub_reset.py` is
the same — every clause is asserted through the replay, never through `hub._status`.

The audit's claim that this file "already makes" a four-way private assertion "for `R`" is simply
wrong about the file. Respecified in each row below.

### 2.5 Several rows labelled RED are green today, and the plans mostly say so

lifecycle 1.2, 2.8, 4.2, 4.4, 4.6; attention 1.4, 3.5(part), 4.2, 4.4; stats 4.5(part); caption
4.2, 4.4. Most carry `Nothing. It must already pass.` in the GREEN column, which is honest —
they are **regression jaws**, and a jaw is a legitimate thing to write. Two notes:

- A jaw that **duplicates an assertion that already exists in another file** should be *run*, not
  *written*. lifecycle 4.2 and caption 4.2 both say "`tests/test_capture_settings.py:89` still
  passes byte for byte". That is an instruction to run a test, not to write one; writing it
  creates a second copy of one assertion in a second file, which is the thing
  `content_search.MAX_FILE_BYTES IS file_view.DEFAULT_MAX_BYTES` exists to prevent, applied to
  tests. Marked NEEDS SHARPENING in both.
- The step tables put jaws in a column headed **RED**. Rename that column, or a reader six months
  from now runs a green test and concludes the feature shipped.

### 2.6 The lifecycle and caption plans are **one plan** with respect to two steps, and separable everywhere else

I tested the claim that "either plan can land first and alone".

**It holds for the frame, and it does not hold for two step tables.** Concretely:

- **Separable, genuinely:** the wire frame (`kind: "agentState"` with `state` and `caption`
  degrading independently) is exactly `protocol.ts`'s degradation doctrine and needs no
  coordination. `parseAgentStates` with a `caption` that degrades to `""` (caption 5.3) and a
  `state` that degrades to `working` (lifecycle 5.3) are two independent assertions over one
  parser. Either can be written first. **Verdict: the claim is true here.**
- **Not separable:** `tests/test_hub_agent_state.py` is named by **both** plans, and both fill it.
  lifecycle R3 has rows 3.1-3.7, caption R3 has rows 3.1-3.8, and four of them are the *same
  assertion about the same slot* (a broadcast on ingest, no `_publish`, dedupe, replay position,
  reset clears). If both are written as specified, that file contains four pairs of near-duplicate
  tests with different names. **This is a merge, not two step tables.**
- **Not separable:** `tests/test_lifecycle_settings.py` is named by both (lifecycle R4, caption
  R4), and both edit `config/settings.json` and `.claude/settings.json`. Two plans editing one
  matcher string and one hook block in two orders is a conflict in the working tree, not in the
  design.

**What I would say in the plans:** the two documents are separable at the *frame* and joined at
the *hub slot* and the *settings edit*. Write §3's R3 and R4 **once**, in one document, owned by
one plan, with the other cross-referencing it — exactly as caption R3 already half-says ("If the
sibling plan's R3 has already landed, this step is done ... run them first and implement
nothing"). Make that the whole of it rather than a conditional preface to a duplicate table.

---

## A. Per plan, per step

### A.1 Agent lifecycle events — 36 OK / 7 NEEDS SHARPENING / 1 NOT WRITABLE

**Step 0 — OK.** Correctly declared as not a RED/GREEN pair. **Unrunnable on this host** (no
`DISPLAY`, no Claude Code session), and the plan says so. It gates R2 2.1-2.4 and caption R1 1.1,
1.7 and R3 3.1 — see the respecification under R2, which un-gates most of it.

**R1 — 3 OK.** All three verified against the running code with the probe.

| Row | Verdict | Evidence |
|---|---|---|
| 1.1 | **OK** | Probe scenario B: `hub.ingest_line('{"session_id":"s-1","hook_event_name":"Notification"}')` then `ingest_fs_change("src/a.py","M")` broadcasts `"agent":"s-1"` today. Must be `""`. **RED for exactly the reason stated.** |
| 1.2 | **OK** (green jaw, correctly declared) | Probe C and D: a `Grep` payload, with and without `tool_input`, stamps today (`agent: "s-2"`, `"s-3"`), and still stamps after the `tool_name` narrowing. Stays green. |
| 1.3 | **OK** | Probe E: `{"session_id":"s-4","tool_name":123}` stamps today (`agent: "s-4"`). Must not. **RED.** |

**R2 — 4 NEEDS SHARPENING, 4 OK.**

Rows 2.1, 2.2, 2.3 and 2.4 each say "over a **captured** payload (step 0's fixture)". That fixture
does not exist and cannot be produced here. As written the tester cannot start. Writing them
against *assumed* field names is precisely what `CLAUDE.md`'s "settled by capture, not by
reasoning" forbids.

> **Corrected specification (2.1-2.4).** Split the assumption from the behaviour. `agentstate.py`
> declares four module constants — `NOTIFICATION = "Notification"`, `STOP = "Stop"`,
> `SUBAGENT_STOP = "SubagentStop"`, and the payload key `EVENT_KEY = "hook_event_name"` — and the
> tests are written **against the constants, never against the literals**:
>
> - `tests/test_agent_state.py::test_a_notification_payload_answers_waiting_for_the_actor_actor_of_names`
>   builds `{EVENT_KEY: NOTIFICATION, "session_id": "s-1"}` and asserts
>   `agent_state(payload).state == WAITING` and `.agent == actor_of(payload)[0]`.
>   Fails today: `import rhizome_graph.agentstate` raises `ModuleNotFoundError`. **Correct RED for
>   a new module.**
> - Same shape for 2.2 and 2.3 (`SUBAGENT_STOP` with and without `agent_id`).
> - 2.4 stays gated: it asks whether a permission prompt is distinguishable from an idle timeout,
>   which is a fact about the payload and nothing else. **Leave it out of the first pass** and
>   write it after Step 0.
>
> Then Step 0 confirms or corrects **four string constants** and no test changes. The behavioural
> state machine — closed set, actor delegation, the `SubagentStop` asymmetry, never raises — is
> fully testable today. Note the key `hook_event_name` is *already* confirmed present on real
> captures: `tests/test_agent_identity.py:45` and nine other fixtures carry it. Only the three
> *values* are assumptions.

| Row | Verdict |
|---|---|
| 2.1 | **NEEDS SHARPENING** — see above |
| 2.2 | **NEEDS SHARPENING** — see above |
| 2.3 | **NEEDS SHARPENING** — see above |
| 2.4 | **NEEDS SHARPENING** — gate it on Step 0 explicitly; do not attempt it in the first pass |
| 2.5 | **OK** — `PostToolUse` is a measured value, not an assumption |
| 2.6 | **OK** |
| 2.7 | **OK** — `sizes_frame` is the model and it exists |
| 2.8 | **OK** — `ast` over Python source; `tests/test_checkouts.py` is the working precedent |

**R3 — 1 NEEDS SHARPENING, 6 OK.**

| Row | Verdict | Note |
|---|---|---|
| 3.1 | **OK** | RED: no branch exists |
| 3.2 | **NEEDS SHARPENING** | "`known_paths` is unchanged, `_recent` is empty" reaches into private attributes. §2.4: `test_hub_read_events.py` does not do this. **Corrected:** assert behaviourally — after the lifecycle line, a `Write` to a path is still an `A` (that *is* the `known_paths` claim), and `[m for m in hub.replay_messages() if "kind" not in json.loads(m)] == []` (that is the `_recent` claim, and it survives 3.4 adding an `agentState` frame to the replay). |
| 3.3 | **OK** | |
| 3.4 | **OK** | Index-based, matching `test_hub_status.py:138,148`. See §2.2 for the three-plan collision. |
| 3.5 | **OK** | And see §C.5 — this is the testable half of decision 5. |
| 3.6 | **OK** | |
| 3.7 | **OK** | |

**R4 — 1 NEEDS SHARPENING, 6 OK.**

| Row | Verdict | Note |
|---|---|---|
| 4.1 | **OK** | RED |
| 4.2 | **NEEDS SHARPENING** | It is an instruction to *run* `tests/test_capture_settings.py`, not to write a test. I confirmed the assertion is a genuine subset (`REQUIRED_TOOLS <= covered`, `:89`) with a docstring saying adding a sixth tool must not fail it. Writing a copy in a new file duplicates one fact. **Corrected:** delete the row; replace with a line in R4's prose — "run `tests/test_capture_settings.py` and `tests/test_hook_install_model.py` before touching anything, and record that they pass." |
| 4.3 | **OK** | |
| 4.4 | **OK** (jaw) | I confirmed `merge_hook_block` iterates `block.items()` (`hookinstall.py:198-206`); widening to `Notification` is a real new case |
| 4.5 | **OK** | **RED confirmed by reading:** `diagnose` calls `_post_tool_use_commands` (`hookinstall.py:119`, `:210-222`), which reads `hooks["PostToolUse"]` and nothing else. A file whose only entry is under `Stop` answers `ABSENT` today. **Merge with audit M2 — see §B.** |
| 4.6 | **OK** (jaw) | |
| 4.7 | **OK** | |

**R5 — 4 OK.** 5.4's prose already gets the sharp part right ("the assertion has to be that the
sink was called, not that the graph is unchanged"). That matters — see §B, M1, where the audit
gets it wrong.

**R6 — 7 OK.** New pure module, new test file, `ModuleNotFoundError` is correct RED. 6.4's
staleness cut is a pure function of `(state, now)` and needs no clock, no socket, no timer. Good
step, and it is the one that makes decision 5 testable at all (§C.5).

**R7 — 1 OK, 1 NOT WRITABLE.**

- **7.1 — OK.** Correctly declares that no test is possible.
- **7.2 — NOT WRITABLE AS SPECIFIED.** "`DEPARTURE_SECONDS > BEAM_LIFE_SECONDS`, asserted."
  Measured: `BEAM_LIFE_SECONDS` is `const BEAM_LIFE_SECONDS = 1.2;` at `web/src/renderer.ts:140`
  — **module-private, not exported**, in a module that imports three.js and carries no unit test
  by doctrine. A vitest test cannot import it. Re-declaring `1.2` in the test pins nothing: the
  whole point of the row is that the two constants must move together, and two literals in two
  files do not.

  > **Corrected specification.** The GREEN step must first move the beam lifetimes into a pure
  > module. Concretely: `web/src/beams.ts` exporting `BEAM_LIFE_SECONDS = 1.2` and
  > `READ_BEAM_LIFE_SECONDS = 0.6`, with `renderer.ts:140,163,704` importing them.
  > Then, in `web/tests/agentState.test.ts`:
  >
  > - name: `test_a_departing_figure_outlives_the_beams_that_name_it_as_author`
  > - assertion: `expect(DEPARTURE_SECONDS).toBeGreaterThan(BEAM_LIFE_SECONDS)`, both imported.
  > - fails today: `web/src/agentState.ts` does not exist → `Failed to load url ../src/agentState`.
  >   That is correct RED for a new module, and after the module exists it fails again on the
  >   missing `beams.ts` import, which is the second half of the same step.
  >
  > Say in the step that the extraction of `BEAM_LIFE_SECONDS` is production work the plan is
  > asking for, because as written the plan does not ask for it and the tester cannot invent it.

**R8 — 1 NEEDS SHARPENING, 3 OK.**

- **8.3 — NEEDS SHARPENING.** "the stroke width is not thinner than `readMarker`'s outer width,
  **imported from that module**". Measured: `web/src/readMarker.ts:31` is
  `const OUTER_WIDTH = 0.05;` — **not exported**. `readMarker.ts`'s exports are
  `READ_MARKER_SIZE`, `ReadMarkerContext`, `paintReadRings`, `createReadMarkerCanvas`.
  The import fails to compile. That is *a* RED, but it is an import error, and the plan's GREEN
  column ("The constant, imported") does not name the export as work.
  **Corrected:** the GREEN step is two things — `export const OUTER_WIDTH = 0.05;` in
  `readMarker.ts`, and `WAIT_ARC_WIDTH >= OUTER_WIDTH` in `waitMarker.ts`. Assertion:
  `expect(WAIT_ARC_WIDTH).toBeGreaterThanOrEqual(OUTER_WIDTH)` with both imported. Fails today on
  the missing module *and* the missing export; say both in the step so the developer exports it
  rather than respelling `0.05`.
- 8.1, 8.2, 8.4 — **OK.** `web/tests/readMarker.test.ts` is the working template (a recording
  context object, no DOM), and 8.2's "total swept angle strictly below `2π`" is a real property of
  a recording context that captures `arc()` calls.

**R9 — OK.** Declares no test and says why. Correct.

**R10-R13 — noted, no steps.** No verdict needed. R11's decision to gate lineage on Step 0
questions 0.7/0.8 is right and I would keep it.

---

### A.2 Attention rules — 40 OK / 6 NEEDS SHARPENING / 3 NOT WRITABLE

**R1 — 2 NEEDS SHARPENING, 6 OK.**

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

- **1.3 — NEEDS SHARPENING.** The section-0 row for `src` does not say which `is_dir` produced
  `True`. It is `is_dir=False`. **Corrected:** the fixture table in `tests/test_attention.py` must
  record `("src", False, True)` explicitly and carry a comment naming it as the wart, so the next
  reader meets the measurement rather than the plan's summary of it.
- **1.4 — NEEDS SHARPENING.** The plan says: "Attention rules are only ever asked about **files**
  ... so the wart is unreachable, and R1 step 1.4 pins that `is_dir` is never passed as `True`."
  The measurement says the opposite: **the wart lives at `is_dir=False`**, which is the mode the
  plan chooses. Refusing the parameter does not make it unreachable; it makes it the only mode.

  And it *is* reachable. `EventHub._expand` (`daemon/server.py:409-414`) expands a directory
  deletion into `[*children, path]` — the directory's own path is the last event published. So
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
  > - The GREEN answer is the caller's, not `gitignore.py`'s — the same split `CLAUDE.md` records
  >   for `.git` and `node_modules` ("both rules live in the **caller**").

| Row | Verdict |
|---|---|
| 1.1 | **OK** — identity assertion (`is`), and `MAX_IGNORE_BYTES` exists at `gitignore.py:181` |
| 1.2 | **OK** |
| 1.3 | **NEEDS SHARPENING** |
| 1.4 | **NEEDS SHARPENING** + one new row |
| 1.5 | **OK** — fixture verified real |
| 1.6 | **OK** — `safe_read.read_capped` exists; the FIFO case is `tests/`-precedented |
| 1.7 | **OK** |
| 1.8 | **OK** — `ast` over Python, real precedent |

**R2 — 5 OK.** `tests/test_cli_settings.py` and `tests/rhi_process.py` give the harness for 2.5;
2.4 is a jaw and correctly declared.

**R3 — 1 NEEDS SHARPENING, 6 OK.**

- **3.5 — NEEDS SHARPENING.** "every existing pinned event-frame assertion is byte-identical."
  I looked: **there are none.** No pytest test asserts an event frame by whole-mapping equality
  (`grep 'json.loads(...) == {' tests/test_hub*.py` → nothing), no test asserts the key set of an
  event, and `web/tests/protocol.test.ts` contains **zero** `toEqual` calls. The jaw as written
  guards nothing.

  The real risk the row is reaching for is different and sharper: `_encode` is
  `json.dumps(asdict(event), ...)` (`daemon/server.py:459-460`). `asdict` emits **every** field
  of the dataclass unconditionally, so a `attention: bool = False` field on `Event` produces
  `"attention":false` on all 12 524 seed events — which is exactly what decision 12 forbids.

  > **Corrected specification.**
  > - `tests/test_hub_attention.py::test_an_event_that_does_not_match_carries_no_attention_key_at_all`
  > - Assert: `"attention" not in json.loads(message)` for a non-matching hook event, a watcher
  >   event and a seed event.
  > - Fails today trivially (no feature), and — the point — fails again against the first
  >   implementation that adds a field to `Event` and leaves `_encode` alone. Say so in the header:
  >   this test is what forces `_encode` to stop being a bare `asdict`.

- 3.1, 3.2, 3.3, 3.4, 3.6, 3.7 — **OK.** 3.6's "exactly one call site, asserted over the parsed
  source of `server.py`" is Python and `ast`-able; the precedent is real.

**R4 — 4 OK.** 4.2 is green today and the plan says so explicitly and tells the tester to write
4.1 first. That is the right handling of a green jaw and is worth copying into the other plans.

**R5 — 8 OK.** New pure module, `ModuleNotFoundError` RED. 5.2 (the `eventLog.ts` divergence) is
the best-argued row in this plan and I agree it should be written first.

**R6 — 2 NEEDS SHARPENING, 2 NOT WRITABLE, 2 OK.**

- 6.1, 6.2 — **OK.**
- **6.3 — NEEDS SHARPENING (dependency inversion).** It requires `actorColor` from R10, which the
  plan ranks **next**, while R6 is ranked **now**. A `now` step cannot depend on a `next` step.
  **Corrected:** promote R10 to `now` and place it before R6 — it is two lines of production code
  and it is shared with two other plans, so it is the cheapest thing in the whole programme (see
  §C).
- **6.4 — NOT WRITABLE AS SPECIFIED.** "over the parsed source of `alarmMarker.ts`: the geometry
  is expressed in the same pixel-metric terms `readMarker.ts` uses and **names no world units**."
  There is no TS parser (§2.1), and "names no world units" is not a predicate a text scan can
  evaluate — there is no token that means "world unit".
  > **Corrected:** drop the source assertion; assert the geometry **behaviourally**, exactly as
  > `web/tests/readMarker.test.ts` does. File `web/tests/alarmMarker.test.ts`; a recording context
  > object; assert (a) `clearRect` is called before any stroke, (b) every painted primitive stays
  > inside the box (`radius + width/2 < 0.5`, `readMarker.ts:26-28`'s stated invariant), (c) the
  > relations between radii, never their values. Fails today with
  > `Failed to load url ../src/alarmMarker`. That is correct RED and it pins more than the scan
  > would have.
- **6.5 — NEEDS SHARPENING.** "asserted over its parsed source, that `resetAttention` is named
  inside the reset handler." No TS parser, and a text scan cannot tell "inside the handler" from
  "anywhere in the file".
  > **Corrected:** a text scan in pytest (§2.1's helper), asserting that `main.ts` contains
  > `resetAttention` at an index **between** the index of `onReset: ()` and the index of the next
  > top-level option key — plus a header stating that this pins a spelling. And note the honest
  > limit: the assertion is only worth having because `main.ts` is untestable; it is not
  > equivalent to a behavioural test and must not be described as one.
- **6.6 — NOT WRITABLE AS SPECIFIED.** The plan already calls it "the weakest test in the plan".
  I go further: "the `multiplyScalar(0.35 + 0.65 * node.opacity)` call at `:937` sits behind a
  condition naming the alarm set" is not expressible as a text scan (you cannot see nesting in a
  substring search) and there is no parser.
  > **Corrected:** delete the row and move the decision out of the renderer. Put the exemption in
  > `labels.ts`-style pure code: `nodeOpacityFactor(opacity, {matched, alarmed})` in a pure module,
  > with `web/tests/nodeFade.test.ts` asserting `nodeOpacityFactor(0.1, {alarmed: true}) === 1`
  > and `nodeOpacityFactor(0.1, {}) === 0.35 + 0.65*0.1`. `renderer.ts:937` then calls it.
  > That is the project's own move — "when asked to specify something that lives in the renderer,
  > specify the pure module it should be extracted into". Fails today: the module does not exist.

**R7 — 5 OK.** This is the strongest section of the attention plan. 7.4's property — *"no rule
file" and "an empty rule file" are two different sentences* — is exactly the kind of test that
earns its place, and it is writable today against a module that does not yet exist.

**R8 — 1 NEEDS SHARPENING, 3 OK.** 8.4 ("`Notification` named in exactly one module") is a text
scan; writable (I confirmed `grep -rc AudioContext`-style scans over `web/src` return clean today,
and `Notification` has zero hits), but state the technique and its weakness per §2.1.

**R10 — 1 OK, 1 NOT WRITABLE.** 10.1 is fine. 10.2 is the nominated defect — see §1.

---

### A.3 Session stats panel — 39 OK / 4 NEEDS SHARPENING / 2 NOT WRITABLE

**R1 — 9 OK.** The best-specified backend section in the five plans. 1.3's property ("`agent` is
identity and `label` is only text") is the right first test and the reason given — "keying on
`label` is the natural mistake, it is the readable one" — is correct.

**R2 — 6 OK.** 2.4's "the boot snapshot is not work" is a genuine RED: today nothing counts, and
I confirmed `seed_paths` (`server.py:312-326`) never touches `_publish`, so the structural
exemption the plan claims is real.

**R3 — 1 NEEDS SHARPENING, 5 OK.** 3.2 — see §2.2 for the corrected index-based form.

**R4 — 5 OK.** 4.5 is handled honestly: the plan states that the "never reaches `onEvent`" half is
green by accident and that the RED is the sink call. Keep that sentence in the test's header.

**R5 — 1 NEEDS SHARPENING, 7 OK.** 5.4 depends on `actorColor` from R8, which the plan ranks
`next` while R5 is `now`. Same inversion as attention 6.3 — promote the shared step (§C).

**R6 — 1 NEEDS SHARPENING, 4 OK.** 6.5 ("the F8 branch sits between the F7 branch and the
file-view branch") — writable as a text scan with index comparisons once §2.1's helper exists;
not writable as "parsed source" today. 6.1-6.4 are exemplary: `sizeKeys.ts` is the template, it
exists, and 6.4's enumeration is the right guard on first position.

**R7 — 1 NEEDS SHARPENING, 2 OK.** 7.1 and 7.2 are writable — `tests/test_bottom_row_containment.py`
already parses HTML and CSS by hand and is the stated precedent, and it really does what the plan
says it does. 7.3 is the `main.ts` text scan again.

**R8 — 1 OK, 1 NOT WRITABLE.** 8.2 is the nominated defect (§1); 8.1 is fine and is the same test
as attention 10.1 and sound 3.1 — **write it once**.

**R9 — 1 NOT WRITABLE AS SPECIFIED, and correctly declared as such.** "the legend's character
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
> - Fails today: **no**, it passes — so it is a jaw, not a RED. That is correct: there is no
>   behaviour to specify yet. It converts "somebody will remember to re-measure" into "the suite
>   stops you". Same for ambient-sound R6.1.

---

### A.4 Ambient sound — 16 OK / 7 NEEDS SHARPENING / 3 NOT WRITABLE

This plan has the highest NEEDS-SHARPENING density of the five, and the reason is structural
rather than careless: **more of its content lives in `main.ts` and in an untestable module than any
other plan's**, so more of its rows are source scans. Its own §4 says the trade "cannot be
improved, only chosen", and I agree with the choice.

**R1 — 1 NEEDS SHARPENING, 8 OK.**

1.1-1.8 are model rows: pure function, injected clock, boundary pinned with `>=`, a test whose
whole purpose is the *ordering* of two checks (1.2). 1.2 is the right first test and its stated
reason — that an optimiser would put the cheap integer compare before the string compare and turn
a 12 524-event seed into eight minutes of clicking — is the best "input that trips it" sentence in
any of the five documents.

- **1.9 — NEEDS SHARPENING.** "over the parsed source: `sound.ts` names no `AudioContext`, no
  `Date`, no `performance` and no `window`." As a text scan, `performance` and `window` are
  ordinary English words that will appear in a docstring and trip it; `Date` will not, being
  capitalised. **Corrected:** scan for the *call* forms — `Date.now`, `performance.now`,
  `new AudioContext`, `window.` — and state in the header that it is a text scan.

**R2 — 1 NEEDS SHARPENING, 1 OK.**

- **2.1 — OK.** "the identifier `AudioContext` appears in exactly one module, and that module is
  `audio.ts`" is a text scan and a genuine RED: `grep -rc AudioContext web/src/*.ts` returns zero
  hits today, so "exactly one" fails on the zero side. Good.
- **2.2 — NEEDS SHARPENING.** "it imports the `Voice` type from `sound.ts` and imports nothing
  else from the application" needs an import-graph, i.e. a parser. **Corrected:** assert the
  negative only, as a text scan: `audio.ts` contains no `from "./protocol"` and no
  `from "./simulation"`. The positive half (it imports `Voice`) is proved by `tsc`, which already
  runs in this project's build.

**R3 — 1 NEEDS SHARPENING, 1 NOT WRITABLE, 3 OK.**

- 3.1 — **OK**, and it is the same test as attention 10.1 and stats 8.1. Write once.
- 3.2 — **NOT WRITABLE AS SPECIFIED.** §1.
- **3.3 — NEEDS SHARPENING.** "`actorColor(a)` is **derivable** from `actorHash(a)`" is not an
  assertion; "derivable" has no operational meaning. The plan's own diagnosis is right —
  `hashColor` (`colors.ts:68-76`) computes FNV-1a and immediately does
  `(hash >>> 0) % 360` into a private `hslToInt`, so the raw value never escapes — but the fix has
  to name the seam.
  > **Corrected:** `colors.ts` exports **two** functions, `actorHash(agent): number` and
  > `colorFromHash(hash): number`, and `actorColor(a)` is defined as `colorFromHash(actorHash(a))`.
  > The test is then an equality, not a claim about derivability:
  > `expect(actorColor("x")).toBe(colorFromHash(actorHash("x")))` and
  > `expect(actorColor("x")).toBe(hashColor("actor:x"))` — the second is 3.1 and pins that the
  > refactor changed no colour on screen. Fails today: `actorHash` does not exist.
- 3.4, 3.5 — **OK.** 3.4's "pin the mapping, not the frequencies" is the read-marker bargain and
  is right.

**R4 — 1 NEEDS SHARPENING, 4 OK.** 4.5 is the `main.ts` text scan (§2.1). 4.1-4.4 are the
`sizeKeys.ts` template and are fine; 4.4's enumeration must include `F8` if the stats plan lands,
which the plan already says.

**R5 — 3 NEEDS SHARPENING, 1 NOT WRITABLE.**

- **5.1 — NEEDS SHARPENING.** Writable as a text scan with index comparison
  (`index("sim.applyEvent") < index("voiceFor")`); not as "parsed source".
- **5.2 — NEEDS SHARPENING, and this is the one the coordinator asked about. See §D.6 for the
  full answer.** Short form: it is a **misuse of the precedent**, and there is a behavioural test
  — the plan has already written it as 1.7.
- **5.3 — NEEDS SHARPENING.** Text scan; and "routes through `shouldRun`" is only checkable as
  "the listener body names `shouldRun`".
- **5.4 — NOT WRITABLE AS SPECIFIED.** "the built entry chunk grows by **less than 4 KiB against
  the 551 195-byte baseline**". A delta needs a stored baseline the suite does not have, and
  `web/dist` is gitignored — it exists on this host (551 195 bytes, confirmed) but not in a clean
  checkout. `tests/test_distribution_front_end.py`'s whole docstring is about that fact.
  > **Corrected:** two assertions, both absolute, both skipping when `web/dist` is absent (the
  > `RHIZOME_PACKAGE_TESTS` idiom):
  > - `test_the_entry_chunk_stays_under_its_measured_ceiling`: `size <= 555_291` (the 551 195
  >   baseline plus the 4 KiB budget), with the baseline and its date in the header.
  > - `test_no_audio_library_is_bundled`: `grep -c` for the rejected library names in
  >   `dist/assets/index-*.js` is 0. **Note this is green today and after the feature** — it is a
  >   jaw against decision 14 being quietly reversed, not a RED. Label it as such.

**R6 — 1 NOT WRITABLE AS SPECIFIED**, same as stats R9.1, same corrected form (pin 162 now).

**R7, R8 — noted, no steps.**

---

### A.5 TodoWrite caption — 39 OK / 7 NEEDS SHARPENING / 0 NOT WRITABLE

The best-specified of the five for testability, with one structural problem (the shared step
tables, §2.6) and one arithmetic conflict with the audit (§D.5 and below).

**Step 0 — OK.** Correctly defers to the sibling plan's measurement and adds two questions rather
than a second capture. That is the right call and it should be preserved in the merge.

**R1 — 2 NEEDS SHARPENING, 5 OK.**

- **1.1 — NEEDS SHARPENING.** Same problem as lifecycle 2.1: it names a captured fixture that does
  not exist. **Corrected** the same way — `agentstate.py` declares `TODO_WRITE = "TodoWrite"`,
  `TODOS = "todos"`, `ACTIVE_FORM = "activeForm"`, `CONTENT = "content"`, `IN_PROGRESS =
  "in_progress"`, and every test is written against the constants. Then Step 0 confirms five
  strings and no test moves. 1.2-1.6 are already written this way in effect and are writable
  today.
- 1.2-1.6 — **OK.** 1.4 is correctly nominated as the first test: *when the model has marked
  nothing in progress, the graph says nothing rather than inventing something.* It is writable
  today (`ModuleNotFoundError`), it is the property most likely to be "improved" later, and
  decision 11 is a real argument rather than an obvious truth.
- **1.7 — NEEDS SHARPENING.** Explicitly "written after step 0" and branches on the trace's
  answer. Gate it out of the first pass; it is not a step the tester can start.

**R2 — 7 OK.** This is the strongest single section in all five plans. 2.3 (the bidi fold, with
the code points **named individually in the test** "because this is the class a later 'simplify the
regex' would drop first") and 2.5 (the fold runs **before** the cap) and 2.6 (the jaw: accented
Latin, CJK and emoji pass through unchanged — "this is a fold of dangerous characters, not an
ASCII filter") are exactly right. 2.6 in particular is the test that stops the naive
`str.isprintable()` implementation, and it is the one I would refuse to drop under time pressure.

**R3 — 2 NEEDS SHARPENING, 6 OK.**

- **3.1 — NEEDS SHARPENING.** Captured fixture; corrected as 1.1.
- **3.2 — NEEDS SHARPENING.** Private attributes; corrected exactly as lifecycle 3.2 (§2.4).
- 3.3-3.8 — **OK.** 3.5 is correctly nominated first: *a caption that has become empty is
  published as empty*. The failure it prevents — "there is nothing to say, so send nothing",
  leaving a caption stuck under a figure describing work finished an hour ago — is the kind of bug
  that looks exactly like a working feature, which is the best reason a test can have.

**R4 — 1 NEEDS SHARPENING, 4 OK.** 4.2 is the "run the existing test" instruction again (§2.5).

**R5 — 4 OK.** 5.3 is correctly identified as the row that belongs to *this* plan rather than the
sibling one.

**R6 — 1 NEEDS SHARPENING, 4 OK.**

- **6.3 — NEEDS SHARPENING.** "`MAX_CAPTION_CHARS` here equals the daemon's, asserted **through
  the shared table's longest case** rather than by restating the number in two files." A shared
  table only pins the cap if it contains the boundary. **Corrected:** the shared fixture table
  must contain three cases at the boundary — a string of exactly `MAX_CAPTION_CHARS` (unchanged),
  one of `MAX_CAPTION_CHARS + 1` (cut, head kept, ellipsis), and one of astral characters spanning
  it (6.2's case). With those three present, "equals the daemon's" is implied by the table and
  needs no separate assertion. Without them, the row asserts nothing.
- 6.1, 6.2, 6.4, 6.5 — **OK.** 6.5 (idempotence) is correctly nominated first, and its reason —
  "a fold that is not idempotent turns 'defence in depth' into 'the caption is mangled once for
  every layer it passes'" — is a real hazard of decision 7.

**R7 — 4 OK.** 7.3 (agent B's entry identical **by reference** when only A changed) is a good,
cheap property that directly buys R8's texture-upload budget.

**R8 — 1 NEEDS SHARPENING, 3 OK.**

- 8.1 — **OK, and it is the single most valuable row in the whole programme.** See §D.5.
- 8.2 — **OK.**
- **8.3 — NEEDS SHARPENING, and it is where the caption plan and the audit collide.** See §D.5 for
  the arithmetic. Two smaller problems in the row as written: `MAX_FONT_PIXELS` is
  **module-private** in `labels.ts:128` (`grep '^export' labels.ts` does not list it), so the
  assertion cannot import it; and "the widest plausible glyph" is not a constant, it is a
  judgement that has to be written down as one (`WIDEST_GLYPH_EM = 1.0`, with a comment saying
  full-width CJK).
- 8.4 — **OK** (declares no test possible).

**R9 — OK** (declares no test). **R10-R13 — noted, no steps.**

---

## B. The audit's RED tests

| Finding | Writable as written? | Where it belongs | Duplicates / merges with |
|---|---|---|---|
| **C1** RED 1 | **No — private attributes** | `tests/test_hub_agent_state.py`, beside caption 3.2 | **Merge** with caption R3 3.2 and lifecycle R3 3.2 — one test, three claimants |
| **C1** RED 2 | **Yes, but it contradicts two plans** | `tests/test_ws_control_token.py`'s neighbourhood | Nothing; it is new policy — see below |
| **C1** RED 3 | **Yes** | `tests/test_hub_reset.py`'s style, in `tests/test_hub_agent_state.py` | **Merge** with lifecycle 3.6 and caption 3.7 |
| **H1** RED 1 | **Yes** | `tests/test_normalize.py` or a new `tests/test_refreshes_actor.py` | Partially overlaps lifecycle 1.1-1.3 — see below |
| **H1** RED 2 | **Yes, and it fails today — but not for the reason the audit gives** | `tests/test_hub_agent_state.py` | **Conflicts** with lifecycle R1 — see §C.4 |
| **H1** RED 3 | **No — private attributes; and it misdescribes the file it cites** | as C1 RED 1 | **Merge** with C1 RED 1 |
| **H2** RED (frontend) | **Yes** | `web/tests/agentCaption.test.ts` | **Merge** with caption R2/R6 — same function, different number |
| **H2** RED (pytest) | **Yes** | `tests/test_agent_caption.py` | **Merge** with caption 2.1 — see §D.5 |
| **H3** RED 1 | **Yes, and it fails today** | `tests/test_ingest_socket_guard.py` | Nothing. Independent, cheap, no plan touches it |
| **H3** RED 2 | **Yes, if a module is named** | new pure module | Nothing; no plan proposes a rate limiter |
| **H4** RED x3 | **Yes** | `web/tests/notify.test.ts` | **Merge** with attention R8 8.1-8.3 |
| **H5** RED 1 | **Yes** | `tests/test_attention.py` | **Merge** with attention 1.8 |
| **H5** RED 2 | **Yes** | `tests/test_attention.py` | Overlaps attention 1.5/1.7; the *direction* half is new and valuable |
| **H5** RED 3 | **Yes** | `tests/test_attention.py` | **Merge** with attention 1.6 |
| **M1** RED | **Half of it is green today** | `web/tests/wsClient*.test.ts` | **Merge** with lifecycle 5.4 / stats 4.5 / caption 5.4 |
| **M2** RED | **Yes, and it is sharper than the plan's** | `tests/test_hook_install_model.py` | **Merge** with lifecycle 4.5 — take the audit's fixture |
| **M3** RED | **Yes** | `web/tests/labels.test.ts` | Nothing; no plan proposes an actor cap |
| **M4** RED | **Yes** | `web/tests/sound.test.ts` | **Merge** with ambient-sound 1.2, 1.5 |
| **M5** RED | **Yes** | `web/tests/agentCaption.test.ts` | **Merge** with caption 2.2/2.3 + 6.1 |
| **M6** RED | **Moot as written** | — | The stats plan already declined the command; see below |
| **M7** RED | **Second half not writable as specified** | `tests/test_ingest_socket_guard.py` | Nothing |

Expanded where it matters:

**C1 RED 2 — writable, and it contradicts the caption plan's design.** "a client whose peer
address is not loopback ... receives every ordinary event frame and **no** caption frame." That is
writable in `tests/test_ws_control_token.py`'s harness (a real listener, a real client, an injected
peer address) and it fails today. But it requires the caption to be **filtered per client at
broadcast time**, and the caption plan's R3 puts it in a *deduped replaceable slot broadcast to
everyone* (`set_status`'s shape, `server.py:252-269`), which has one encoded message and no
per-client branch. **These two designs cannot both be built.** The audit should be told this is a
design conflict, not a test to add: either the caption slot grows a second encoded form and
`register`/`broadcast` learn about peers, or the audit's gate moves to a coarser place (refuse the
whole `agentState` frame to non-loopback peers). I would put that question back to
`security-auditor` and `software-architect` together before any RED test is written for it.

**H1 RED 1 — writable, and it belongs in `normalize.py`.** `refreshes_actor(payload) -> bool` as a
pure predicate is better placed than the lifecycle plan's inline `tool_name` condition, for one
concrete reason the plan does not give: it is the only form in which `Stop` clearing `_last_hook`
(the audit's stronger proposal) and `Notification` merely not stamping it can be two separate,
separately-tested rules. Fails today on the missing function. **Merge note:** lifecycle 1.1-1.3
then become tests *of the predicate* plus one hub-level integration test, which is a better shape
than three hub-level tests.

**H1 RED 2 — see §C.4. It does fail today, and I agree it should be written early, but the audit's
sentence "the existing code passes the naive version of it by accident and fails this one" is not
what I measured, and the test as written cannot be made green by the lifecycle plan's R1.**

**M1 RED — half green today.** "a client constructed with **no** sink for the new kind, handed the
new frame, calls `onEvent` **zero** times. That is the assertion that catches the fall-through,
and it fails today for any kind that does not yet exist." It does **not** fail today.
`parseEvent` (`protocol.ts:102-127`) requires `ts`, `agent`, `path`, `color` and a member of
`EVENT_TYPES`; an `agentState` or `stats` frame has none of them, so it returns `null` and
`onEvent` is never called. The stats plan says this itself ("safe **by accident**") and the
lifecycle plan says it too. **Corrected:** the RED is `onAgentStates`/`onStats` **called exactly
once**; the `onEvent`-zero half is the jaw that keeps the route above `parseEvent` when the frame
later gains a `path`-like field. Write both, in one test, and say which is which.

**M2 RED — sharper than the plan's, take the audit's.** lifecycle 4.5 uses a file whose *only*
entry is under `Stop` (today `ABSENT` → must be `STALE`). The audit uses a file whose `PostToolUse`
resolves and whose `Stop` does not (today **`INSTALLED`** → must be `STALE`). The audit's is the
dangerous case — `--doctor` reporting health over a hook that errors on every agent stop — and it
is the one `hookinstall.py:16-25`'s docstring is about. **Write the audit's; keep the plan's as a
second case in the same test file.** Both fail today; I confirmed by reading `diagnose`
(`hookinstall.py:119`) and `_post_tool_use_commands` (`:210-222`), which read `hooks["PostToolUse"]`
and nothing else.

**M6 — moot as written, and its recommendation contradicts the plan it addresses.** The daemon-side
half ("`parse_command('{"kind":"stats","token":"t"}')` returns exact equality") is unnecessary: the
stats plan adds **no command kind** (decision 5: a poll in a slot). The browser-side half
("accumulate the stats in the browser") is a recommendation the stats plan already considered and
refused with a stronger argument than the audit's — `REPLAY_BUFFER_SIZE = 200`, so a browser-side
counter is *silently* approximate after any reconnect and two tabs disagree about one session.
The audit's own counter-argument ("a daemon-side counter and a browser-side counter would disagree
anyway") is true and irrelevant: the question is which one is *right*, and only one of them can
see the whole session. **No test to write. Tell the auditor the plan resolved it, and which way.**

**M7 — first half writable, second half not.** "a hook payload of N bytes ... produces no event
**and** produces a log record at `debug` naming the drop." The first half is writable today (the
64 KiB `asyncio` default is real; the audit measured it and I have no reason to doubt it). The
second half asserts a log record from a *chosen* limit that does not exist and whose value the
audit itself says must be measured with `RHIZOME_TRACE_LOG` first. **Corrected:** split. Write
today: `tests/test_ingest_socket_guard.py::test_an_over_long_ingest_line_is_dropped_and_says_so`
using `caplog` at `DEBUG`, asserting a record naming the drop — fails today because
`_handle_ingest_client`'s blanket `except` (`server.py:911-916`) swallows it silently. Defer the
`limit=` value entirely to the Step 0 trace. The logging half is the whole value of the finding
and it needs no measurement at all.

**H3 RED 1 — the cheapest real test in the whole set.** `stat.S_IMODE(os.stat(socket_path).st_mode)
== 0o600` after `run()` reports ready. The harness exists: `tests/test_ready_callback.py:188`
already starts a real `run()` and waits for the ingest socket to accept, and
`tests/test_ingest_socket_guard.py` has `_serve_then_stop`. I confirmed `daemon/server.py:1170`
calls `asyncio.start_unix_server(...)` and there is **no `chmod` anywhere in the file**. It fails
today under any umask (0o775 or 0o755, both ≠ 0o600). One line to fix. **No plan touches this.**

---

## C. Ordering, across all five plans

### C.1 The principles I ordered by

1. **A defect that exists today, independently of every feature, comes first.** Three of them:
   `makeLabelTexture`'s missing bound, the ingest socket's mode, and the silent 64 KiB drop.
2. **A step shared by three plans is written once, before any of them.** `actorColor`/`actorHash`
   and `_observe` are both in this class, and both are currently ranked `next` inside plans whose
   `now` steps depend on them — an inversion that will cost rework.
3. **Nothing that depends on Step 0's capture is scheduled before a human runs it.** With the
   respecification in §A.1 R2, that is a much smaller set than the plans imply: four string
   constants, not four step tables.
4. **A step whose test cannot be written on this host is not scheduled at all** — it is a
   verification note, in the `CLAUDE.md` "Not yet verified" form.

### C.2 The sequence

**Phase 0 — pre-feature, no plan required, all writable today.**

| # | Test | Plan of origin |
|---|---|---|
| 1 | `labelCanvasWidth` bound | caption 8.1 / 8.2 |
| 2 | ingest socket mode `0o600` | audit H3 RED 1 |
| 3 | over-long ingest line logs at DEBUG | audit M7 (first half) |
| 4 | legend length pinned at 162 | stats 9.1 / sound 6.1, respecified |
| 5 | `actorColor` / `actorHash` / `colorFromHash` + the prefix scan | attention 10, stats 8, sound 3.1-3.3 — **one step** |
| 6 | `refreshes_actor` predicate (pure) | audit H1 RED 1 |

**Phase 1 — the attribution correction. Must land before any new matcher is installed.**

7. lifecycle 1.1, 1.3 (hub-level), rewritten against `refreshes_actor`.
8. audit H1 RED 2, as the **separate** clearing test (§C.4).
9. lifecycle 1.2 as the jaw.

**Phase 2 — Step 0, by a human.** Blocks nothing in phases 0-1 and 3, and only four string
constants in phase 4.

**Phase 3 — attention rules, R1-R7.** It is the only feature with a user question behind it that
depends on nothing else: no Step 0, no shared frame, no matcher. Order inside it: R1 (with the
corrected `src` row and the new directory-delete row), R2, R3, R7, R4, R5, R6.

**Phase 4 — the merged lifecycle + caption backend.** One `agentstate.py`, one
`tests/test_agent_state.py` + `tests/test_agent_caption.py`, **one** `tests/test_hub_agent_state.py`,
**one** `tests/test_lifecycle_settings.py`, one settings edit adding all four event keys **and**
`TodoWrite` in one change. Then the doctor widening (audit M2 fixture first, plan's second).

**Phase 5 — the merged frontend.** `parseAgentStates` + the route (one test file), `agentState.ts`,
`agentCaption.ts`, then the two markers and the two sprites.

**Phase 6 — session stats.** Independent of everything above once `_observe` exists. Whoever
builds `_observe` — attention R3 or stats R2 — writes it; the second one writes **only** the
"exactly one call site" assertion, and both plans already say so.

**Phase 7 — ambient sound.** Last, by its own recommendation, which I endorse. Its R1 and R4 are
excellent, cheap and independent; its value is unknowable without headphones.

### C.3 The first three tests I would write on day one

1. **`web/tests/labelTextureBound.test.ts::test_no_string_can_ask_for_a_texture_wider_than_the_bound`**
   (caption 8.1). `labelCanvasWidth(measuredWidth, pad)` never exceeds `MAX_LABEL_TEXTURE_PX`, for
   `Infinity`, `NaN`, `1e9` and `-1`, and is exact below the bound. Fails today because the
   function does not exist — the arithmetic is inline at `renderer.ts:1519-1522` with, confirmed,
   **no `Math.min`**. It is first because it fixes a live latent defect, it is independent of all
   five plans and of Step 0, and it is the only row in the programme whose GREEN step is worth
   taking even if every feature is cancelled.
2. **`tests/test_ingest_socket_guard.py::test_the_ingest_socket_is_readable_only_by_its_owner`**
   (audit H3 RED 1). Fails today, one line to fix, harness already exists.
3. **`tests/test_actor_color_prefix.py` + `web/tests/colors.test.ts`** — the merged
   `actorColor`/`actorHash` step (§1). Three plans need it, three plans rank it `next`, and two of
   them have `now` steps that import it. Writing it on day one is what stops attention 6.3 and
   stats 5.4 being blocked or, worse, respelling the prefix.

### C.4 Verifying the audit's claim about H1 RED 2

**The claim:** "ingest a `Stop` payload for `agent-a` immediately after a `Write` by `agent-a`;
the next `ingest_fs_change` publishes an event with `agent == ""`. **This is the test that fails
for the right reason today** — write it as the very first RED of feature 1, because the existing
code passes the naive version of it by accident and fails this one."

**What I ran** (`.venv/bin/python`, real `daemon.server.EventHub`, `broadcast` captured):

```
A  write-then-Stop, then fs change  -> {"agent":"agent-a","type":"M","path":"src/app.py",...,"origin":"watch"}
B  Notification only, then fs change -> {"agent":"s-1",...}
C  Grep (with tool_input)            -> {"agent":"s-2",...}
D  Grep (no tool_input)              -> {"agent":"s-3",...}
E  tool_name = 123                   -> {"agent":"s-4",...}
```

**Do I agree it fails today?** Yes. Scenario A publishes `agent-a` where the test demands `""`.

**Do I agree it fails for the *right* reason? No, and the difference matters enough to change the
plan.** Scenario A has **two independent causes**, and the test cannot distinguish them:

- the `Stop` payload stamps `_last_hook` (`server.py:340-342` runs `actor_of` on every payload);
- the *earlier* `Write` already stamped `_last_hook`, and `ATTRIBUTION_WINDOW_SECONDS = 5.0`
  (`server.py:110`) has not elapsed.

The lifecycle plan's R1 fixes only the first: decision 8 is "only a payload carrying a usable
`tool_name` refreshes `_last_hook`". Under that fix, scenario A **still publishes `agent-a`**,
because the Write's stamp is untouched and still inside the window. **So the audit's H1 RED 2 is
not satisfiable by the lifecycle plan's R1 at all.** It requires the audit's stronger, separate
proposal — that `Stop`/`SubagentStop` *clear* `_last_hook` when it names that same actor — which
the lifecycle plan does not adopt and does not mention.

Two documents therefore name one test and mean two different behaviours. That is the thing to fix
before anyone writes it.

> **Corrected specification — two tests, not one, in `tests/test_hub_agent_state.py`:**
>
> - `test_a_lifecycle_payload_does_not_make_its_agent_the_attributor`
>   Arrange: a **fresh** hub. Act: ingest `{"session_id":"s-1","hook_event_name":"Stop"}`, then
>   `ingest_fs_change("src/a.py","M")`. Assert: `agent == ""`.
>   Fails today (probe B, with `Notification`; `Stop` behaves identically — `actor_of` never reads
>   `hook_event_name`). **This is the one the lifecycle plan's R1 makes green.**
> - `test_an_agent_that_has_stopped_owns_nothing_that_happens_afterwards`
>   Arrange: ingest a `Write` by `agent-a`. Act: ingest a `Stop` for `agent-a`, then
>   `ingest_fs_change("src/app.py","M")`. Assert: `agent == ""`.
>   Fails today (probe A). **This one needs the clearing behaviour, and it is a decision neither
>   plan has taken.** Write it, and let the RED be the thing that forces the decision — that is
>   what a RED test is for. Add the audit's own caveat as a third test:
>   `test_a_subagent_stopping_does_not_orphan_the_orchestrators_changes` — a `Stop` naming
>   `agent-b` must **not** clear a stamp left by `agent-a`.

### C.5 Is lifecycle decision 5 testable without a Claude Code session?

**Half of it, today, fully. The other half needs one string.** Decision 5 is: *a `waiting` is
cleared by the agent's own next tool call, never by a timer,* with staleness decided in the browser
from a daemon-stamped `ts`.

- **The clearing rule is testable today.** lifecycle R3 3.5 — agent A goes `waiting`, a `Write`
  payload from A arrives, the next frame says A is `working`; a `Write` from **B** leaves A
  `waiting`. Every input is a hand-built payload, and the only thing it turns on is the presence
  of a usable `tool_name`, which is measured, not assumed (ten fixtures in `tests/` carry
  `hook_event_name: "PostToolUse"` beside `tool_name`). **No capture needed.**
- **The staleness cut is testable today and needs no clock at all.** R6 6.4 —
  `waitingAgents(state, now)` drops an entry whose `ts` is older than `STALE_WAIT_SECONDS`, and
  one a second younger is kept. A pure function of two arguments. This is the entire browser-side
  half of decision 5 and it is the cleanest step in the plan.
- **What is *not* testable without Step 0 is the arming.** That a `Notification` payload produces
  `waiting` at all rests on the string `"Notification"` under the key `hook_event_name`. The key
  is measured; the value is not.

> **So: decision 5 is testable as specified, provided §A.1 R2's respecification is adopted** —
> one module constant per assumed value, tests written against the constants. Then Step 0 confirms
> four strings and **no test changes**, and the whole state machine can be built and taken green
> before anybody runs a Claude Code session. Without that respecification, four rows of R2 and
> three of R3 are blocked on a human, and decision 5 is untestable here in both halves.
>
> One honest residual: nothing on this host can confirm that `Notification` *fires at all*
> (Step 0 question 0.1). That is a `CLAUDE.md`-style "not yet verified" note, not a test.

---

## D. Coverage gaps — behaviour these plans change that no step tests

### D.1 A directory-delete event reaching the attention matcher

The attention plan asserts that "events name files, never directories" and builds decision 3's
whole safety case on it. `EventHub._expand` (`server.py:409-414`) publishes the directory's own
path as the last event of a `D` expansion. So a rule file of `*` / `!src/` / `!src/**` alarms on
`src` itself, which I measured returns `True` at `is_dir=False`. **No step tests this.**

> **Closing test:** `tests/test_hub_attention.py::test_deleting_a_directory_the_rules_excluded_raises_no_alarm`
> — seed `src/a.ts`, `ingest_fs_change("src", "D")`, assert no published frame carries
> `attention: true`. Fails today (no feature) and fails again against the obvious delegation.

### D.2 Nothing defines the order of the three new replay frames relative to each other

§2.2. Three plans insert a frame between `status` and the seed and none orders them against the
others. **Closing test:** one assertion, in whichever file lands last, pinning the full pairwise
order of whatever slots exist — written as `index()` comparisons so it survives a fourth.

### D.3 The `agentState` slot has two writers and no test that they compose

lifecycle fills `state`, caption fills `caption`, on **one entry in one dict**. Neither plan tests
what happens when a `Notification` and a `TodoWrite` arrive for the same agent in either order.
The failure is obvious once stated: a naive `set_agent_state(AgentState(agent, label, state, ts))`
overwrites the caption with `""` on every `Notification`, and vice versa.

> **Closing test:** `tests/test_hub_agent_state.py::test_a_lifecycle_payload_does_not_erase_the_agents_caption`
> — ingest a `TodoWrite` giving agent A a caption, then a `Notification` for A; assert the frame
> carries **both** the caption and `state: "waiting"`. Then the reverse order. This is the test
> that proves the "either plan can land first and alone" claim, and neither plan has it.

### D.4 No plan tests that the new `_observe` seam preserves today's behaviour

attention R3 and stats R2 both introduce `_observe(event) -> str`, replacing two independent
`_encode`-and-broadcast sites. Both plans test that the *new* thing is reached from one place.
Neither tests that the refactor changed nothing: that a read still goes through
`_broadcast_transient` and not `_publish`, that `_recent` still receives writes and not reads,
that the encoded string is byte-identical to today's.

> **Closing test:** run `tests/test_hub_read_events.py`, `tests/test_hub_seed_and_attribution.py`
> and `tests/test_hub_agent_labels.py` as the jaw and record it in the step — and add one new
> assertion, `test_the_encoded_message_is_unchanged_by_the_observation_seam`, comparing
> `_observe(event)` against `json.dumps(asdict(event), separators=(",",":"))` for an event with no
> verdict and no counter. Green after the refactor, red if `_observe` starts reordering keys.

### D.5 The caption cap: two documents, two numbers, and the arithmetic settles it

**This is the coordinator's first question and the answer is a calculation, not a judgement.**

- caption decision 9: `MAX_CAPTION_CHARS = 60`.
- audit H2: 64 displayed characters, and a 256-byte daemon-side cap derived as 64 × 4.
- caption 8.2: `MAX_LABEL_TEXTURE_PX <= 4096` (the lowest `MAX_TEXTURE_SIZE` a WebGL2
  implementation may report).
- caption 8.3: the pixel bound must never clip an in-policy caption.

Measured inputs: `labels.ts:128` is `const MAX_FONT_PIXELS = 64;`, and `renderer.ts:1521` is
`const pad = Math.max(2, Math.round(font * 0.25));` → `pad = 16` at 64 px. The widest plausible
glyph is a full-width CJK ideograph, advance ≈ 1.0 em = 64 px. So:

```
60 chars: 60 * 64 + 2*16 = 3840 + 32 = 3872  <= 4096   OK, 224 px of headroom
64 chars: 64 * 64 + 2*16 = 4096 + 32 = 4128  >  4096   FAILS
```

**The audit's 64 cannot satisfy the caption plan's own 8.2 ∧ 8.3.** 60 can, with 3.5 characters of
margin. **The test that settles it is caption 8.3**, and it settles it in the plan's favour — which
is the useful outcome, because the plan's number was derived from the sink and the audit's was
derived from a viewport width.

**Can the two caps be pinned as one fact?** Yes, and they should be:

> - `MAX_CAPTION_CHARS = 60` is the **only** authored constant.
> - `MAX_CAPTION_BYTES = MAX_CAPTION_CHARS * 4` — derived, not authored, the
>   `content_search.MAX_FILE_BYTES IS file_view.DEFAULT_MAX_BYTES` idiom. It is **an assertion,
>   not a second truncation**: a string already cut to 60 code points cannot exceed 240 UTF-8
>   bytes, so nothing needs to enforce it and the audit's second cap becomes a property of the
>   first.
> - `MAX_LABEL_TEXTURE_PX` is authored, `<= 4096`, and caption 8.3 asserts
>   `MAX_CAPTION_CHARS * MAX_FONT_PIXELS * WIDEST_GLYPH_EM + 2*pad <= MAX_LABEL_TEXTURE_PX`.
>   For that to be writable, **`MAX_FONT_PIXELS` must be exported from `labels.ts`** (it is
>   private today) and `WIDEST_GLYPH_EM = 1.0` must be a named constant with a comment, not a
>   number in an expression.
>
> Three constants, one authored, two assertions binding them. One test — caption 8.3 — settles
> both documents' numbers, and it is RED today because none of the three exists.

The caption plan's own §7 already flags the danger: the half-em assumption is "**wrong for CJK by
roughly a factor of two in the dangerous direction**". The calculation above uses the full em, so
it is the safe side of exactly that error.

### D.6 The sound toggle's `onReset` exemption — the parsed-source assertion is a misuse of the precedent

**This is the coordinator's second question on the sound plan.** Sound 5.2: "over the parsed
source: `onReset` names `resetLimiter` and does **not** name `toggleSound` or set `enabled`."

**It is not the same kind of thing as the precedents.** Every existing source-level contract in
this repository pins a **negative capability of a module**: "no shiki outside `highlight.ts`",
"`checkouts.py` starts no process", "`content_search.py` imports no `re`", "`sizes.py` opens
nothing", "`window.py` never sees a token", "`main()` is the only place that reads the
environment". Each has three properties in common:

1. The capability is reachable **only** by naming the identifier — you cannot fork without naming
   a subprocess API, cannot compile a regex without naming `re`. So the scan is **complete**: it
   cannot be evaded except by aliasing, which is itself visible.
2. There is **no behavioural test that could replace it**. You cannot assert "this module did not
   import shiki" from the outside.
3. The thing pinned is a **safety property** whose violation is invisible at runtime.

Sound 5.2 has **none** of the three. (1) The property — "the toggle survives a reset" — is evaded
trivially by an implementation that never names `toggleSound`: `sound = { ...sound, enabled: false }`
inline passes the scan and breaks the behaviour. (2) The behavioural test exists and the plan has
**already written it**: step 1.7 asserts `resetLimiter` clears `lastVoiceMs` and **preserves
`enabled`**. (3) The violation is loudly visible — the sound stops.

So 5.2 pins a spelling in place of a behaviour that is already pinned, and it pins it incompletely.

> **What to do instead — and it is structural, not another test.** Make the wrong thing
> unavailable. `sound.ts` exports `toggleSound` and `resetLimiter` and **exports no function that
> returns `enabled: false` from an enabled state**. There is then nothing for a "consistency"
> refactor of `onReset` to call: the developer who reaches for `closeSound(sound)` beside
> `closeSizeMode(sizeMode)` finds it does not exist, which is a far better signal than a test
> failing three files away. That is the `applyView` move — remove the affordance rather than
> assert its absence — and it is what `fileView.ts`'s `closeView` / `applyView` split already does.
>
> **Keep** step 1.7 as the behavioural pin, and strengthen it: `resetLimiter` applied to a state
> with `enabled: true` returns `enabled: true`, and applied to `enabled: false` returns
> `enabled: false`. **Keep** 5.2 only as a secondary jaw, with its header saying in one sentence
> that it pins a spelling, that 1.7 pins the behaviour, and that it can be evaded by an inline
> object literal. **Do not** let it be the only thing standing behind decision 9.

The plan's own §4 already says both halves of this — "a comment is not a test, and a parsed-source
assertion pins a spelling rather than a behaviour ... **This is the plan's most likely place for a
later 'consistency' refactor to break something quietly.**" I am agreeing with its self-criticism
and naming the fix.

### D.7 The unbounded label texture — writable and green *now*

**The coordinator's second question on the caption plan.** Yes, unambiguously.

`renderer.ts:1516-1522`, read verbatim today:

```ts
const metrics = ctx.measureText(text);
const pad = Math.max(2, Math.round(font * 0.25));
canvas.width = Math.ceil(metrics.width) + pad * 2;
canvas.height = font + pad * 2;
```

There is no `Math.min`. It is reachable by any caller with a long string; it is unreachable today
only because `actorDisplayName` caps at `MAX_ACTOR_LABEL_CHARS = 24` (`labels.ts:264,304`) and
file labels come from paths. Nothing about the fix depends on either plan, on Step 0, on the
`agentState` frame, or on a browser:

> - RED: `web/tests/labelTextureBound.test.ts::test_no_string_can_ask_for_a_texture_wider_than_the_bound`
>   — `labelCanvasWidth(measured, pad)` for `Infinity`, `NaN`, `1e9`, `-1` and `0` never exceeds
>   `MAX_LABEL_TEXTURE_PX` and is exact below it. Fails with
>   `Failed to load url ../src/labels` → no, more precisely: `labels.ts` exists, so it fails with
>   a TypeScript error on the missing export, which for a **new function in an existing module**
>   is the correct RED (the failure is the missing symbol, not a typo or a fixture).
> - GREEN: `labelCanvasWidth` in `labels.ts`, `MAX_LABEL_TEXTURE_PX` beside it, and
>   `renderer.ts:1521` calling it instead of computing inline.
>
> **Schedule it as day-one item 1** (§C.3). It is the only step in 210 whose value is independent
> of every product decision in all five plans, and if Step 0 retires the caption feature entirely
> the defect it fixes is still there. The caption plan says this itself — "the one step here worth
> taking on its own merits even if step 0 retires the feature" — and it is right.

### D.8 Nothing tests that a new matcher does not break the `.deb`

Four plans edit `config/settings.json` and/or `hookinstall.CAPTURED_TOOLS`. Three of them say
`tests/test_deb_package.py:967-1004` is "judged unaffected rather than checked", and each calls
that a judgement rather than a measurement. The opt-in suite (`RHIZOME_PACKAGE_TESTS=1`) is the
one that would answer it, and none of the plans schedules a run of it.

> **Closing action, not a test:** run `RHIZOME_PACKAGE_TESTS=1 pytest tests/test_deb_package.py`
> once, before the settings edit and once after, and record both in the step. It is the only
> packaging risk any of the five plans names, and three of them name it.

### D.9 No plan tests the actor map's growth, and two plans feed it

audit M3 is the only place this appears, and it is a `noted` in the lifecycle plan (R12). Two
plans give a pathless payload the power to create an actor (lifecycle R7 places an actor with no
file event; the caption plan's captions are keyed on agents that may have done nothing). Today an
actor requires an event with a path. **After R7 an actor is one forged ingest line.**

> **Closing test** (audit M3's, respecified to a real home): `web/tests/labels.test.ts::test_only_the_most_recently_active_actors_keep_their_sprites`
> — a pure `selectActors(entries, max)` beside `selectFileLabels`, 200 entries with distinct
> last-active timestamps, returns exactly 32 including the most recent. Fails today on the missing
> selector. The plan ranks it `noted`; the audit ranks it medium; I would write it in the same
> phase as lifecycle R7, because R7 is what makes it reachable.

---

## E. Two things I would put back to the other specialists before any test is written

1. **C1 RED 2 versus the caption plan's slot design** (§B). A per-peer caption gate and a single
   deduped encoded slot are incompatible. That is `software-architect`'s question, not mine, and
   it should be answered before `set_agent_state`'s signature is fixed.
2. **Whether `Stop` clears `_last_hook`** (§C.4). The audit says yes, the lifecycle plan does not
   consider it, and the audit's own headline RED test cannot pass without it. One sentence from
   `security-auditor` and `developer-backend` settles it, and until it is settled the test cannot
   be written with a name that is true.
