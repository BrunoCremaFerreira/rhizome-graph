# Plan: Agent life cycle on camera -- waiting, leaving, lineage

- **Status:** todo
- **Created:** 2026-08-26 20:56
- **Implemented:** -- (date, and the branch it landed on)
- **PR/commit:** --
- **Consultations (mandatory):**
  - `software-architect` (2026-08-26) -- this document is its assessment and staged plan, and
    it names the owner of every RED/GREEN step below.
  - `security-auditor` (2026-08-26) -- consulted. R2 and R4 are the two it was pointed at: R2
    turns a payload field into a broadcast frame, and R4 changes what `--install-hooks` writes
    into somebody else's repository. It found worse than either -- see H1 in the appended
    section. Its findings are appended at the end of this document; the full report is
    `docs/security/2026-08-26-audit-five-planned-features.md`.
  - `developer-tester` (2026-08-27) -- consulted on the step table below, and it wrote **no**
    test code: every row carries a verdict of `OK`, `NEEDS SHARPENING` or `NOT WRITABLE AS
    SPECIFIED`, appended at the end of this document. The full review is
    `docs/features/2026-08-26-tester-review-five-plans.md`. No implementation step here may
    start before the RED test it names exists.

Written 2026-08-26 against `fd0f34e`, on branch `development`, with the tree clean. Every line
number below is from that commit.

Scope: the graph shows what an agent **does to files** and nothing about the agent itself. Three
gaps, in descending order of value:

1. **A blocked agent looks exactly like a thinking one.** The `Notification` hook fires when
   Claude Code needs permission or has gone idle. Today both states are one motionless figure.
2. **An actor never leaves.** `SubagentStop` / `Stop` are the facts; today there is only an
   inference from silence, and section 1 shows that even the inference is weaker than
   `CLAUDE.md` describes.
3. **Two figures appear with no relation drawn between them.** Whether a `Task` call can be
   joined to the `agent_id` that later shows up on that subagent's own calls is an open
   question that **step 0 answers**, not this document.

One new backend module, one new hub slot, one new frame kind, two new pure frontend modules, one
new renderer channel, one new marker sprite. No new runtime dependency on either side, nothing
new forks a process, nothing new opens a file descriptor, and no new command travels **inbound**.

Per `CLAUDE.md` rule 3, **nothing in this document is committed**, and per rule 2 nothing in it
was implemented while it was written. The tree is untouched by it.

---

## 0. Baseline, measured on this host

| Measurement | Command | Result |
|---|---|---|
| Frontend suite before any change | `cd web && node node_modules/vitest/vitest.mjs run` | `1403 passed (1403)`, 51 files, **18.38 s** |
| Backend suite before any change | `.venv/bin/pytest -q` | **COULD NOT RUN** -- see below |
| Backend test functions, counted statically | `grep -c '^def test_' tests/*.py` | **1343** functions in **79** files |
| One hook invocation, no daemon listening | 20 runs of `python3 hooks/emit_event.py` with `RHIZOME_SOCKET` pointing at nothing | **40.2 ms** per call |
| One hook invocation, live socket accepting | 25 runs, against a scratch `AF_UNIX` listener | **40.6 ms** per call |
| A bare `python3 -c pass` on this host | 20 runs | **20.1 ms** |
| Our own cost above a bare interpreter | difference of the two above | **20.1 ms** |
| The socket write itself, in process | 300 calls to `hook._send` against a live listener | **0.061 ms** |
| An `agentState` frame, 6 agents with captions | `json.dumps(frame, separators=(",",":"))` | **884 bytes** |
| The same frame, one agent | as above | **174 bytes** |
| `json.dumps` of that frame | 20 000 iterations | **0.016 ms** |
| Replay ring size | `REPLAY_BUFFER_SIZE`, `server.py:105` | 200 messages |
| Actor decay to zero intensity | `ACTOR_DECAY_PER_SEC = 0.08`, `simulation.ts:95` | **12.5 s** |
| Actor alpha floor while idle | `0.4 + 0.6 * intensity`, `renderer.ts:970` | **0.4, forever** |

**The backend suite could not be run here and no number is invented for it.** `.venv/bin/pytest`
does not exist, `.venv/bin/python -m pytest` answers `No module named pytest`, and the system
`python3` has none either. Installing one is forbidden by this agent's own rules and by the
project's (`pip install` mutates the environment). The static count above is a floor, not the
suite's number: `CLAUDE.md` records `1498 passed, 20 skipped`, and the gap between 1343 and 1498
is parametrised cases, which a `grep` cannot see. **Every claim in this document about backend
behaviour comes from reading the source, never from a green run**, and section 7 says so again.

Four of these numbers decide the design.

- **A hook invocation costs 40 ms and 20 ms of it is the interpreter starting.** The work inside
  is 0.061 ms. So the price of a new matcher is not what the hook does with the payload, it is
  **one more Python process on the agent's loop, per firing**. That single fact is what ranks
  every matcher in R4 and it is why `TodoWrite` is in a plan of its own rather than here.
  `tools/read_burst.py:22` already records the same ~40 ms from an independent measurement,
  which is why the number is quoted rather than re-derived.
- **The frame is 174 bytes per agent.** Beside a `sizes` answer at 1.2 MB
  (`2026-08-25-22-17-size-mode.md`, section 0) this is nothing, and it is deduped besides. There
  is no wire cost to argue about in this feature, and saying so is what keeps a reviewer's
  attention on the two places that do cost: the hook invocations and the per-frame sprite.
- **An actor's alpha floor is 0.4 and nothing ever removes it.** This is the finding that
  reshapes gap 2 and it is in section 1.
- **12.5 s to zero intensity** is the window inside which "the decay already handles it" is even
  arguably true. A session where a subagent finishes and the orchestrator keeps working for ten
  minutes is thirty times longer than that window.

---

## 1. Assessment: how an agent is represented today

### The seams, and which are load-bearing

**The hook forwards the payload untouched and classifies nothing** (`rhizome_graph/hook.py:55-66`).
`_forward` traces, parses the envelope, checks it is a `dict`, and sends. It never looks at
`tool_name`, `hook_event_name` or anything else. **This is the single most important fact in the
plan: adding a matcher to `config/settings.json` requires no change to the hook at all.** The hot
path stays byte for byte what it is, the stdlib-only rule is not even approached, and the
"never fail loudly" rule needs no new guard because no new branch exists. Every decision about a
lifecycle payload therefore lands in the daemon, which is exactly where `CLAUDE.md`'s "capture
code that makes an aggregation decision is the recurring defect" says it belongs.
**Load-bearing, and unchanged by this plan.**

**`hook_event_name` is already on the wire.** `tests/test_agent_identity.py:46` -- a fixture built
from real captures on Claude Code 2.1.229 -- carries `"hook_event_name": "PostToolUse"` beside
`session_id`, `tool_name` and `tool_input`. Nothing in `rhizome_graph/` reads it. It is the field
that tells a `Notification` from a tool call, and it is present in the one payload shape this
repository has actually measured. **Load-bearing for R2, and step 0 must confirm it appears on
the lifecycle payloads too rather than only on `PostToolUse`.**

**`actor_of` is the one place identity is decided** (`normalize.py:83-109`) and it is deliberately
shared between `normalize_event` and `EventHub.ingest_line`, "so this path cannot credit a
subagent's copies to the orchestrator while the event it did produce carries the subagent"
(`server.py:334-338`). A lifecycle payload gets its actor from the same function or it gets a
second opinion about who is who. **Load-bearing, extended by nothing -- reused verbatim.**

**`_broadcast_transient` (`server.py:383-402`) is the precedent for "show it and remember
nothing".** Its docstring enumerates the three pieces of state a read must not touch and why. A
lifecycle event is one step further out: it names no path at all, so it has nothing to say to
`known_paths`, nothing to be echoed by the watcher, and nothing worth replaying as a change.
**Load-bearing as the argument; not reused as the mechanism, for the reason in decision 2.**

**`set_status` (`server.py:252-269`) is the shape this feature copies.** A replaceable slot, a
dedupe on the encoded message rather than on the dict ("because that is exactly what a client
would receive"), and one line in `replay_messages` (`server.py:221`). It exists because a frame
republished for the life of the session would otherwise grow the replay without bound and push
the project's own tree out of it (`server.py:165-169`). An agent-state frame has exactly that
lifetime. **Load-bearing, copied exactly.**

**`replay_messages`'s ordering is a documented argument, not a list** (`server.py:207-221`): the
reset first because it is an order to empty the canvas, meta next so the HUD is captioned before
the first node, status next because a list of changes needs a project attached to it, then the
seed, then the recent ring. A new slot has to justify its position in that argument.
**Load-bearing; decision 6 places the new slot and says why.**

**`reset` clears every piece of state that describes the old project** (`server.py:271-304`) and
its docstring is a per-field justification. A new slot that is not cleared there is a bug the
docstring already predicts. **Load-bearing; R3 step 3.6 pins it.**

**`wsClient.handleMessage` routes every answer frame BEFORE `parseEvent`, and consumes it with or
without a sink** (`wsClient.ts:203-274`). The comment on the `sizes` branch states the rule in
full: `parseEvent` ignores `kind`, so **only the ordering** keeps an answer out of the simulation.
**Load-bearing, copied exactly.**

**`renderer.setSearch` / `setSizeColors` -- "the renderer takes an answer, never a question"**
(`renderer.ts:694-703`, `:669-671`). `setSizeColors` takes colours keyed by path and knows
nothing about bytes, ramps or F7. `setAgentStates` is the same shape: it takes a per-agent record
the renderer paints and knows nothing about `Notification`, `Stop` or hook events.
**Load-bearing, and the model for the new channel.**

**`renameActor` (`renderer.ts:1277-1289`) already solves "repaint a caption only when it
changes".** An actor is created by its first event, which may be a watcher event with no `label`,
so the name is not fixed at creation; an empty or unchanged caption is ignored because
"repainting costs a canvas and a texture upload". Any per-actor text this feature adds inherits
that rule rather than inventing one. **Load-bearing, and the reason the caption in R10 is cheap.**

**`hookinstall.merge_hook_block` iterates `block.items()`** (`hookinstall.py:198-206`), so a
`hook_block` that returns two event keys instead of one merges both with no change to the merge
at all -- and `tests/test_hook_install_model.py:676-685` already pins that a stranger's `Stop`
hook survives a merge that does not name `Stop`. **Load-bearing, and it means R4 is additive in
the merge and only in the merge; the diagnosis is a different story, below.**

**`tests/test_capture_settings.py:89-95` asserts coverage as a SUBSET, not as a string**
(`REQUIRED_TOOLS <= covered`), and its docstring says so: "reordering it or adding a sixth tool is
not a regression and must not fail this". `tests/test_hook_install_model.py:739-755` asserts
`_template_tools() <= written`, in the same direction. **Load-bearing: adding matchers is
non-breaking for both, by their own design, and no existing assertion has to move.**

### The seven things that are actually in the way

1. **`ingest_line` records the active agent from ANY payload carrying one, before it knows what
   the payload is** (`server.py:340-342`). `actor_of(payload)` runs, `_last_hook` is stamped, and
   only then is `normalize_event` asked whether there is an event. That is correct today, because
   the only payloads that arrive are tool calls and the comment explains exactly why a
   glob-expanding `cp` must still stamp it. The moment a `Notification` arrives it is wrong in
   the worst available direction: **a blocked agent would become the attributor of the next
   filesystem change**, for `ATTRIBUTION_WINDOW_SECONDS = 5.0` (`server.py:110`). An agent
   waiting on a permission prompt is, by definition, the one entity on the machine that is not
   changing files; the change in that window is far more likely to be the human's editor.
   This is a **required** change, not an optional refinement, and it is R1.
2. **`Event` has no room for a pathless fact.** `normalize.Event` (`normalize.py:52-80`) is
   `ts, agent, type, path, color, origin, label`, and `_encode` serialises it whole with
   `asdict` (`server.py:458-459`). `path` is not optional in any consumer. Routing a lifecycle
   fact through it means a mandatory field with no meaning.
3. **`EVENT_TYPES` is a closed set and `applyEvent` routes on it.** `protocol.ts:69` and its
   docstring: "`R` was added as a member, not by relaxing the check into 'any single letter'".
   `simulation.applyEvent` (`simulation.ts:140-165`) branches `D`, then materialises ancestor
   directories from `event.path`, then branches `R`, then `touchFile`. A fifth type carrying
   `path: ""` reaches `touchFile("")`, and `""` is **the layout's `ROOT_ID`**
   (`layout.ts:24`) -- the pinned centre every top-level node hangs from. `ForceLayout.sync`
   (`layout.ts:60-76`) sees `""` already present and keeps the root, so the tree survives, but
   `listNodes()` now holds a file node at the pinned centre: it is drawn, it is offered a label
   by `updateFileLabels` (`renderer.ts:1387-1409`), and `pickFile` will hand it to a click.
   A phantom clickable file on the origin of the graph. This is decision 2's whole argument.
4. **An actor with no file event has no position and is therefore invisible.**
   `ensureActor` is called only from `onEvent` (`renderer.ts:680`), and the figure is placed by
   `layout.position(event.path)` (`:683-689`). `updateActors` hides any actor whose `hasPos` is
   false (`renderer.ts:982-984`). **This is fatal to the highest-value half of the feature**:
   `PostToolUse` fires *after* a tool runs, so an agent blocked on a permission prompt for its
   *first* tool call has fired no `PostToolUse` at all, has no actor, and would have a state with
   nothing to paint it on. R7 is this.
5. **`hookinstall.diagnose` reads `PostToolUse` and nothing else**
   (`hookinstall.py:119`, `_post_tool_use_commands` at `:210-222`). If R4 writes a second event
   key, a settings file holding our `PostToolUse` block and *not* our `Notification` block
   diagnoses as `installed`. `--doctor` would report a healthy setup over a half-installed one,
   which is the exact class of false reassurance `hookinstall.py`'s own docstring says is worse
   than no diagnostic (`:16-25`, and `overall_state`'s docstring at `:149-158`). R4 has to widen
   the question or state the price of not widening it.
6. **There is no browser-side owner for a per-agent fact.** `Actor` is `{agent, intensity}`
   (`simulation.ts:46-53`) and carries no label, no state and no timestamp; the *label* lives on
   the renderer's `ActorView` (`renderer.ts:91-102`), which is untestable by doctrine. There is
   no pure module between the socket and the figure. R6 is this.
7. **The daemon has no ticker that could expire anything.** `poll_repo` and `poll_status`
   (`server.py:726-762`) are the only loops, and both exist to *fork or read*, not to age state
   out. A "waiting" that has to stop being true after some interval has nowhere to be aged.
   Decision 5 resolves this without adding a third loop.

### Two defects this feature exposes rather than creates

- **An actor never leaves, and the decay is a dimming rather than a departure.** `CLAUDE.md` and
  the brief for this plan both describe `ACTOR_DECAY_PER_SEC = 0.08` as an actor "fading out".
  It is not. `updateActors` computes `alpha = 0.4 + 0.6 * intensity` (`renderer.ts:970`) with the
  comment "the figure never fades out entirely: an idle agent is still present and must stay
  findable". `SimulationImpl.actors` is only ever cleared by `reset()` (`simulation.ts:182-185`),
  and `Renderer.actors` only by `resetScene` (`renderer.ts:751-757`). So after 12.5 s an idle
  figure stops moving and sits at 40% opacity **for the life of the page**. The correction
  matters for scoping: gap 2 is not "replace an inference with a fact", it is "there is no
  departure at all, and the fact is the first mechanism that could produce one". R7, **now**.
- **The actor map is unbounded.** One entry per distinct `agent` seen, never removed, in both
  `SimulationImpl.actors` and `Renderer.actors`; each renderer entry owns a `Sprite` for the
  figure and a `Sprite` plus a texture for the caption. A daemon watching one root across many
  Claude Code sessions accumulates one of each per subagent, forever. Small -- a texture at
  `labelFontPixels(dpr)` is a few tens of kilobytes -- but monotonic, and it is `updateActors`'s
  own loop that walks it every frame. Pre-existing; this feature makes it *visible* by giving the
  first mechanism that could delete an entry. R12, **noted**, with its trigger.

---

## 2. Decisions before step 1

Decisions 1-3 are forced by the assessment above. Decisions 4-12 are mine; say so if you would
have chosen otherwise. Three of them (2, 5, 9) are places where I did **not** ratify the brief
this plan was commissioned from.

**1. Step 0 is a measurement and it gates everything after it.** `CLAUDE.md`'s "Agent
attribution" section records that the `PostToolUse` shape "was settled by capture, not by
reasoning -- measured against Claude Code 2.1.229 with `RHIZOME_TRACE_LOG`". Nothing in this
repository has ever seen a `Notification`, `Stop` or `SubagentStop` payload. Every field named in
the steps below is an **assumption until step 0 replaces it with a capture**, and the steps say
which assumption they rest on so a surprise invalidates a step rather than the plan.

**2. A lifecycle fact is a new frame KIND, not a new `EventType`.** Rejected: `"W"` in
`EVENT_TYPES`. It looks cheaper -- it rides `parseEvent`, `applyEvent` and the existing broadcast
-- and it is wrong three times. `Event.path` becomes a mandatory field with no meaning (obstacle
2); the closed-set docstring at `protocol.ts:62-68` exists precisely to stop the set being
widened for convenience; and `applyEvent` with `path: ""` grows a phantom clickable file on the
layout's pinned centre (obstacle 3). The new frame follows `meta`, `status`, `searchResult` and
`sizes`: a `kind`, its own parser, its own route ahead of `parseEvent`, its own pure model. **The
price is one more parser, one more route and one more sink -- about 120 lines of frontend that a
new `EventType` would not have needed.** I would pay it again for obstacle 3 alone.

**3. The frame is per-agent and cumulative, in a replaceable slot.**
`{"kind":"agentState","agents":[{"agent","label","state","caption","ts"}, ...]}` -- the whole
current picture, not a delta. Deltas need an ordering guarantee across a reconnect and a rule for
a client that missed one; a full picture in a deduped slot needs neither, is 174 bytes an agent
(section 0), and is what `set_status` already does with up to 200 entries. **`caption` is
declared here and filled by nothing in this plan** -- see "How the two plans compose" below.

**4. `state` is a closed set of three: `working`, `waiting`, `stopped`.** Not a free string.
`working` exists so that "the agent was waiting and is not any more" is a value rather than an
absence, which is what makes a dedupe on the encoded frame correct. Anything the daemon does not
recognise produces no entry, in the same direction as `EVENT_TYPES`: the set stays closed.

**5. A `waiting` is cleared by the agent's own next tool call, never by a timer.** The brief asks
for "the expiry rule" and I am refusing the obvious one. A human can be away from the keyboard
for an hour with the agent genuinely still blocked, so a timeout that clears `waiting` reports
*false progress*, which is worse than a stale flag. The exact rule is available for free: any
payload carrying a usable `tool_name` from agent A is proof A is no longer blocked, and
`ingest_line` already runs `actor_of` on every payload (`server.py:340`). One condition, at a
line that already exists. **The residual failure mode -- an agent killed while blocked leaves a
`waiting` nothing will clear -- is handled by decision 9, in the browser, where it is testable.**

**6. The new slot sits after `_status` and before the seed in `replay_messages`.** The existing
argument (`server.py:207-219`) is: clear the canvas, caption the project, then things about the
project, then the tree. An agent state is a thing about the project's *actors*, and it is
smaller and more perishable than the tree, so it belongs in the third group. It cannot go after
the seed: `register` sends the replay in order and the client is drawing as it arrives, so a
waiting ring arriving after 20 000 seed events is a ring that appears seconds late on a graph
that has already settled.

**7. `SubagentStop` requires a usable `agent_id`; `Notification` does not.** This is the answer
to the brief's "say what happens if a hook does not carry `agent_id` at all", and the asymmetry
is deliberate. `actor_of` falls back to `session_id` (`normalize.py:106-108`), which is the
**orchestrator's** actor key. A `SubagentStop` that fell back would retire the orchestrator's
figure every time any specialist finished -- the figure most likely to still be working. So a
`SubagentStop` with no `agent_id` produces **no frame at all**, and the feature degrades to
"departure works for the orchestrator, via `Stop`", which is half the value and never wrong. A
`Notification` may fall back: a permission prompt blocks the session as a whole, so crediting it
to the session is approximately true rather than backwards. Both halves are RED tests in R2.

**8. A lifecycle payload never refreshes `_active_agent`.** The brief asks whether a
`Notification` counts as evidence of who is at work "the way a read does". It counts as evidence
of the exact opposite. `CLAUDE.md` says a read "is evidence of who is at work, so the watcher's
next change is credited to whoever was reading" -- a blocked agent is the one actor on the
machine provably not writing files, and a stopped one has finished. The rule generalises to a
single condition: **only a payload carrying a usable `tool_name` refreshes `_last_hook`.** It is
keyed on `tool_name` rather than on `hook_event_name` so that it degrades correctly if step 0
finds `hook_event_name` missing from some payload shape.

**9. Staleness is decided in the browser, from a timestamp the daemon stamps.** Obstacle 7 says
the daemon has no ticker. Adding a third poll to age one dict is the wrong trade -- and it would
still not cover the case that matters, which is a client connecting long after the daemon last
heard anything. So the frame carries a wall-clock `ts` (`time.time()`, as `Event.ts` already does
-- `normalize.py:399-404`) and `agentState.ts` decides what an hour-old `waiting` looks like.
Pure, testable without a socket, and the decision lives beside the thing that draws it. **The
stated price: a remote viewer whose clock differs from the daemon's host reads the age wrong.
`Event.ts` already has this property and nothing has ever suffered from it, because in practice
the page and the daemon are the same machine over loopback.**

**10. Departure is a fade with a floor, and the floor is longer than the longest beam.**
`BEAM_LIFE_SECONDS` is 1.2 (`renderer.ts:140`) and a write flash decays at
`HIGHLIGHT_DECAY_PER_SEC = 0.9` (`simulation.ts:96`), so a full flash takes ~1.1 s. A subagent
that stops while its last write is still flashing must not vanish and orphan a lit beam that
claims an author. `DEPARTURE_SECONDS = 2.5` clears both with margin. **The departure rides ON TOP
of the decay and does not replace it** -- that is the brief's question answered directly. The
decay stays as the floor for every event that never arrives: a missed `SubagentStop`, a killed
process, a hook that turns out not to fire. A fact retires a figure promptly; silence still dims
it as it always did.

**11. `Stop` retires exactly one actor and never cascades.** A `Stop` for a session with three
live subagents does **not** retire the subagents. To do so the hub would need a session-to-agent
registry it deliberately does not keep, and building one means keying actor lifetime on something
other than `agent`, which is one step from the rule `CLAUDE.md` states twice ("never key an actor
on the label"). In practice a `Task` is synchronous, so every subagent has already fired its own
`SubagentStop` before the turn ends -- **an assumption step 0 can confirm cheaply** by whether a
`SubagentStop` is observed for each spawned subagent. If it is wrong, the subagents are retired
by the decay floor, which is today's behaviour, so nothing regresses.

**12. The waiting marker is a SHAPE in the actor's own colour, not a new hue.** The page already
spends five semantic colours: `33FF33` add, `FFAA00` modify, `FF3333` delete
(`normalize.py:32-37`), `AA66FF` read (`renderer.ts:151`) and `00E5FF` search
(`renderer.ts:190`). A sixth is where a colour vocabulary stops being readable, and `CLAUDE.md`
already establishes the alternative: "a different shape, not a different shade, so the two never
blur together through the bloom". `searchMarker` is one thick ring, `readMarker` is two thin ones
(`readMarker.ts:1-16`); the waiting marker is a **broken ring -- a small number of arcs with gaps
between them** -- painted in `hashColor("actor:" + agent)`, the actor's own colour
(`renderer.ts:1240`). Two reasons for the actor's colour rather than a signal colour: the fact is
about the agent, not about a file, so it should carry the agent's identity; and with three agents
on screen the ring says *which one* is blocked without the user reading a caption. **This is a
judgement about a screen nobody here can see -- section 5, item 1.**

### How the two plans compose

`2026-08-26-20-56-todo-caption.md` was written at the same time and **shares two things with this
one**. Neither plan may be built in a way that forces the other to rework:

- **Step 0 is one measurement, not two.** Both plans need a `RHIZOME_TRACE_LOG` capture from a
  real session; this document specifies it, and the todo-caption plan cross-references it. Run it
  once, with every matcher from both plans installed at the same time, and record the result in
  one place.
- **There is ONE per-agent frame, `kind: "agentState"`, and it has room for both.** The shape in
  decision 3 declares `state` (this plan fills it) and `caption` (the todo plan fills it). Every
  field beyond `agent` degrades independently, which is `protocol.ts`'s own doctrine
  (`:374-419`), so **either plan can land first and alone**, and the second one adds a field
  rather than a frame. If the todo plan lands first, its R2 builds the hub slot and this plan's
  R3 becomes a set of assertions that must already pass. A second per-agent frame kind is the
  outcome to refuse: it would mean two dedupe slots, two replay lines, two `reset` clauses, two
  parsers and two routes, all answering the same question about the same actor.
- **`rhizome_graph/agentstate.py` is the module name in both.** One module answers "what does
  this non-file payload say about this agent", whichever half of it lands first.

---

## 3. The plan

Ranked, ordered, every step one RED test plus one GREEN implementation, both suites green between
any two steps. Step 0 is the exception and says why.

New test files throughout, so no existing assertion moves: `tests/test_agent_state.py`,
`tests/test_hub_agent_state.py`, `tests/test_lifecycle_settings.py`,
`web/tests/agentStateProtocol.test.ts`, `web/tests/agentState.test.ts`,
`web/tests/waitMarker.test.ts`.

---

### Step 0 -- Nobody here has ever seen these payloads. **Rank: now, and nothing may precede it**

**What is missing.** Not code: facts. `CLAUDE.md`'s "Agent attribution" section is the standard --
the `PostToolUse` shape "was settled by capture, not by reasoning" -- and this feature rests on
three payload shapes nothing in this repository has captured. `tests/test_agent_identity.py:41-60`
is what a captured shape looks like once it is written down.

**Why it is not a RED/GREEN pair.** It writes no production code and specifies no behaviour, so
there is nothing for `developer-tester` to fail first. It produces the fixtures that R2's RED
tests are built from. Making it a step rather than a preamble is deliberate: it has an owner, a
deliverable and a place in the order.

**What to run.** In a **scratch project, not this checkout**, a `.claude/settings.json` holding
the existing `PostToolUse` block plus these entries, every command prefixed with
`RHIZOME_TRACE_LOG=/tmp/rhizome-lifecycle.jsonl`:

- `Notification`
- `Stop`
- `SubagentStop`
- `PostToolUse` widened with `Task` (and, for the sibling plan, `TodoWrite`)

Then one real session that: triggers a permission prompt; goes idle long enough for the idle
notification; spawns **two subagents of the same type** in one turn and lets both finish; and
ends its turn. The trace file is the deliverable.

**The eight questions the trace must answer.** Each one is named because a later step assumes it.

| # | Question | Which step depends on it |
|---|---|---|
| 0.1 | Does `Notification` fire at all, and does it carry `hook_event_name`? | R2, all of it |
| 0.2 | Does a `Notification` raised for a **subagent's** tool call carry `agent_id`, or only `session_id`? | R2, decision 7 |
| 0.3 | Is a permission prompt distinguishable from an idle timeout -- a `message` field, a `notification_type`, anything? | R2 step 2.4, and R8's caption |
| 0.4 | Does `SubagentStop` carry `agent_id`? **If not, decision 7 puts the whole subagent half of gap 2 out of scope.** | R2, decision 7 |
| 0.5 | Does `SubagentStop` fire once per subagent, including two of the same type in one turn? | Decision 11 |
| 0.6 | Does `Stop` fire once per turn, and does it carry only `session_id`? | R2 |
| 0.7 | Does a `PostToolUse` on `Task` carry any id of the subagent it spawned -- in `tool_response`, or anywhere? | R11, lineage |
| 0.8 | Does a **subagent's own** payload carry a parent id (`parent_agent_id`, `parent_session_id`, anything of that shape) beside `agent_id`? | R11, lineage |

**What happens to the plan on each bad answer.** 0.1 negative retires the feature's highest-value
half and leaves R7 and R12 as standalone fixes worth doing anyway. 0.2 negative is survivable:
the ring lands on the session figure and the caption says so. 0.4 negative scopes gap 2 to the
orchestrator, per decision 7. **0.7 and 0.8 both negative retire lineage entirely** -- see R11.

**Owner.** A human, on a machine running Claude Code. **This host cannot do it: it is a tty with
no agent session to observe** (section 5).

---

### R1 -- A payload that is not a tool call makes its agent the attributor of the next filesystem change. **Rank: now, and it lands before any matcher is added**

**What is wrong.** `EventHub.ingest_line` stamps `_last_hook` from `actor_of(payload)`
(`server.py:340-342`) before it knows whether the payload is a tool call. `_active_agent`
(`server.py:425-437`) then hands that actor to every watcher change for
`ATTRIBUTION_WINDOW_SECONDS = 5.0` (`server.py:110`, used at `:374`).

**Where.** `daemon/server.py:340-342`, read by `daemon/server.py:374` through
`_active_agent` at `:425-437`.

**Why it costs.** Today it costs nothing, because only tool calls arrive. The moment R4 installs
a `Notification` matcher it costs the correctness of attribution in the worst direction available:
the agent that is **blocked waiting for a human** becomes the author of whatever changes on disk
in the next five seconds, which is very likely the human's own editor -- the human who is at that
moment reading the prompt. Attribution is the point of this program (`hookinstall.py:3`), and a
confidently wrong actor is worse than the empty one the watcher would otherwise carry.

**Target shape.** One condition at the line that already exists: `_last_hook` is stamped only when
the payload carries a usable `tool_name` string. `normalize_event` already keys on exactly that
(`normalize.py:146-149`), so no new notion of "is this a tool call" enters the codebase. The
boundary afterwards: **`_last_hook` means "the last agent that ran a tool", which is what
`_active_agent`'s docstring already claims it means.** What stops it being crossed later is R1's
own test, which asserts the negative over a payload with no `tool_name`.

**Cost, in the units that matter.** One `isinstance` on a dict lookup, on the ingest path, which
runs once per hook payload and is already doing `json.loads` on the line (`server.py:447-456`).
Not on the agent's loop at all -- the hook has returned by then. Unmeasurable.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-backend) |
|---|---|---|
| 1.1 | `tests/test_hub_agent_state.py`: a payload with `session_id` and **no `tool_name`** does not become the attributor -- a watcher change one second later carries `agent: ""`. Fails today because `_last_hook` is stamped unconditionally. | The `tool_name` condition at `server.py:340-342`. |
| 1.2 | RED, the jaw: a payload with a `tool_name` the normalizer ignores (`Grep`) **still** stamps it -- the existing behaviour the comment at `server.py:334-338` was written for, re-asserted so 1.1 cannot be taken green by narrowing to "only Write/Edit/Read". | Nothing. It must already pass. |
| 1.3 | RED: a payload with `tool_name` of the wrong type (a number, `null`, an empty string) does not stamp. | Falls out of "usable string"; pin it so a later `if "tool_name" in payload` does not creep in. |

**Test to write first.** 1.1 -- property: *only a tool call decides who the watcher's next change
belongs to*. Input that trips it today: `{"session_id": "s-1", "hook_event_name": "Notification"}`
on the ingest socket, followed by `hub.ingest_fs_change("src/a.py", "M")`, which today reports
`agent: "s-1"` and must report `agent: ""`.

**Owner.** `developer-tester` -> `developer-backend`.

---

### R2 -- Nothing turns a non-tool-call payload into anything. **Rank: now**

**What is missing.** `normalize.py` answers one question -- which file did this tool call touch --
and returns `None` for everything else (`normalize.py:243-244`). There is no function anywhere
that reads `hook_event_name`.

**Where.** New module `rhizome_graph/agentstate.py`. Not in `normalize.py`: that module's contract
is "hook JSON -> `Event`", it is on the hook's hot path in principle, and its whole surface is
about paths -- growing a second return type onto it would mean every caller learns which of two
things it got. Not in `server.py`: the hub owns *state*, and this is a pure classification, which
is the same split `status.py`/`checkouts.py` and `content_search.py` already take.

**Why it costs to put it elsewhere.** The next change is predictable and named in step 0: a
payload field turns out to be spelled differently, or a fourth lifecycle event is worth capturing.
In its own module that is one function and one test file. Inside `normalize.py` it is a change to
the function the hot path and every attribution test go through.

**Target shape.**

```
WORKING = "working"; WAITING = "waiting"; STOPPED = "stopped"
STATES = (WORKING, WAITING, STOPPED)

@dataclass(frozen=True)
class AgentState:
    agent: str
    label: str
    state: str
    ts: float
    caption: str = ""          # declared here, filled by the sibling plan

agent_state(payload: dict, ts: float | None = None) -> AgentState | None
agent_state_frame(states: Iterable[AgentState]) -> dict      # pure, JSON types only
```

Five properties hold it up, and each is a test.

- **The actor comes from `actor_of`, imported.** Never a second reading of `agent_id` /
  `session_id`. `normalize.py:99-103` says why in full: two copies of that rule drift, and the
  drift shows up as a lifecycle fact landing on a different figure than the events beside it.
- **`SubagentStop` refuses the session fallback** (decision 7). It reads `agent_id` directly, and
  answers `None` when there is none. This is the one place in the module where `actor_of` is not
  enough, and it is a deliberate, tested exception rather than a second identity rule.
- **The state set is closed.** An unrecognised `hook_event_name` answers `None`. Same direction
  as `EVENT_TYPES` (`protocol.ts:62-68`): a daemon from another version must produce nothing, not
  something.
- **It never raises.** `normalize_event`'s blanket guard (`normalize.py:131-135`) is the
  precedent, and the reason is the same one step down: this runs on a payload the network handed
  us through a socket, and the ingest loop's own `except` (`server.py:917-919`) logs at DEBUG and
  keeps the connection -- so an exception here is a silently dropped connection, not a visible
  failure.
- **The module opens nothing, forks nothing and imports no `re`.** Asserted over the parsed
  source, the way `checkouts.py`'s "starts no process" and `content_search.py`'s "imports no
  `re`" are (`sizes.py` step 1.6 in `2026-08-25-22-17-size-mode.md` is the closest model). The
  `re` half is what keeps a future "parse the notification message" from turning a payload field
  into a regular expression evaluated on the daemon.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-backend) |
|---|---|---|
| 2.1 | `tests/test_agent_state.py`: `agent_state` on a **captured** `Notification` payload (step 0's fixture) answers `state == "waiting"` with the actor `actor_of` gives. Today the module does not exist, so the import fails. | Create `agentstate.py` with the `Notification` branch. |
| 2.2 | RED: a captured `Stop` answers `stopped` for the session actor; a captured `SubagentStop` **carrying `agent_id`** answers `stopped` for that id and **not** for the session. | The two branches. |
| 2.3 | RED, decision 7: a `SubagentStop` with **no** `agent_id` answers `None` -- never the session. A `Notification` with no `agent_id` **does** answer, for the session. The asymmetry, as two assertions in one file so a reader meets them together. | The `agent_id` requirement on one branch only. |
| 2.4 | RED: a `Notification` distinguishable as a permission prompt and one distinguishable as idle both answer `waiting` and differ only in `caption` -- **or, if step 0's question 0.3 came back negative, this test asserts they are indistinguishable and both answer a bare `waiting`.** Written after step 0, from what the trace actually said. | Whichever of the two the trace supports. |
| 2.5 | RED: a `PostToolUse` payload answers `working`; a payload with an unknown `hook_event_name`, a missing one, a non-dict, `None` and `{}` all answer `None`. | The closed set and the guards. |
| 2.6 | RED: garbage in every field -- `agent_id` a dict, `agent_type` a number, `hook_event_name` a list -- answers `None` and raises nothing. | The blanket guard. |
| 2.7 | RED: `agent_state_frame` produces `{"kind":"agentState","agents":[{...}]}` with JSON types only -- an `AgentState` smuggled through whole would raise inside `broadcast`, on the loop, long after the function returned. | `agent_state_frame`, modelled on `sizes_frame`. |
| 2.8 | RED, over the parsed source: `agentstate.py` names no `open`, no `subprocess`, and imports neither `re` nor `os`. | Nothing -- it must already pass. The contract, written down as a test. |

**Test to write first.** 2.1 -- property: *a payload that is not a tool call still names an actor,
and that actor is the one `actor_of` names*. Input that trips it today:
`import rhizome_graph.agentstate` raises `ModuleNotFoundError`. It is first because it is the
step that consumes step 0's deliverable, and writing it is what proves the trace was actually
captured rather than assumed.

**Owner.** `developer-tester` -> `developer-backend`.

---

### R3 -- The hub has no slot for a fact about an actor. **Rank: now**

**What is missing.** `EventHub` holds `_known_paths`, `_seed`, `_recent`, `_meta`, `_status`,
`_reset`, `_last_hook`, `_hook_paths`, `_fs_paths` (`server.py:189-203`). Nothing is keyed by
agent.

**Where.** `daemon/server.py`: a new `_agent_states: dict[str, str]` beside `_status` at `:194`,
a `set_agent_state` beside `set_status` at `:252`, one line in `replay_messages` at `:221`, one
clause in `reset` at `:298-304`, and a branch in `ingest_line` at `:344`.

**Why it costs to put it elsewhere.** There is nowhere else. The alternative shape -- broadcasting
the fact and keeping nothing -- is `_broadcast_transient` (`server.py:383`), and it is wrong here
for the reason `_status` is a slot rather than a ring: a waiting agent is a **standing** fact, so
a client connecting one second after the `Notification` would see a working figure and stay wrong
until the agent unblocked. A read is a flash and a wait is a state; that is the whole distinction.

**Target shape.** The dict holds one `AgentState` per agent; the broadcast is the whole picture,
encoded once and deduped on the encoded string, exactly as `set_status` does (`server.py:265-269`).
Four properties, each a test:

- **`_agent_states` is keyed on `agent` and never on `label`.** The rule `CLAUDE.md` states twice.
- **The frame never reaches `_publish`.** Not into `_known_paths` (it names no path), not into
  `_recent` (it is a slot for the same reason `_status` is one -- republished for the life of the
  session, so appended it grows the replay without bound), not into `_hook_paths` (there is no
  watcher echo to suppress). `_broadcast_transient`'s docstring (`server.py:383-402`) is the
  argument; the mechanism here is `set_status`'s.
- **A `waiting` is cleared by that agent's next tool call** (decision 5), at the line that already
  stamps `_last_hook`.
- **`reset` clears the dict and the slot.** Its docstring already predicts the bug
  (`server.py:271-296`): every other piece of state describes the old project. Actors of the old
  project are the clearest case of all.

**Cost, in the units that matter.** One dict write and one `json.dumps` of 174 bytes per agent per
lifecycle payload -- 0.016 ms for six agents, measured -- on the ingest path, not on the agent's
loop and not per frame. The dedupe means a repeated identical state costs the `json.dumps` and
nothing on the wire.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-backend) |
|---|---|---|
| 3.1 | `tests/test_hub_agent_state.py`: a `Notification` line on the ingest socket broadcasts one `agentState` frame naming that agent as `waiting`. | `set_agent_state` and the `ingest_line` branch. |
| 3.2 | RED, the "a lifecycle event is even less of a change than a read" test: after that line, `known_paths` is unchanged, `_recent` is empty, and a `Write` to a path the agent later touches is still an **`A`**. Modelled on `tests/test_hub_read_events.py`. | Nothing beyond 3.1 -- the branch returns before `_publish`. The pin that keeps it there. |
| 3.3 | RED: the same state arriving twice broadcasts **once** (dedupe on the encoded frame); a different state broadcasts again. | The `set_status` comparison, copied. |
| 3.4 | RED: a client connecting afterwards receives the frame, and it sits **after** the status frame and **before** the first seed message in `replay_messages()`. Position asserted by index, not by presence. | The one line at `server.py:221`. |
| 3.5 | RED, decision 5: agent A goes `waiting`; a `Write` payload from A arrives; the next frame says A is `working`. And: a `Write` payload from **B** leaves A `waiting`. | The clear, keyed on the actor. |
| 3.6 | RED: after `hub.reset(...)`, `replay_messages()` holds no `agentState` frame, and a client connecting mid-switch gets the `reset` first. | The `reset` clause. |
| 3.7 | RED: two subagents of the same `agent_type` and different `agent_id` produce **two** entries. | Nothing beyond keying on `agent`. The pin against a future dedupe by label. |

**Test to write first.** 3.2 -- property: *a fact about an agent touches none of the state that
describes the tree*. Input that trips it today: there is no branch at all, so a `Notification`
line reaches `normalize_event`, which answers `None`, and the assertion about the frame arriving
fails first. Write 3.1 and 3.2 together; 3.2 is the one that must never be allowed to go red
later, which is why it is named here.

**Owner.** `developer-tester` -> `developer-backend`.

---

### R4 -- The matchers are not installed, and the doctor cannot see a half-install. **Rank: now**

**What is missing.** `config/settings.json:30` and `.claude/settings.json:27` both spell
`"matcher": "Write|Edit|MultiEdit|Bash|Read"` under `PostToolUse` and name no other event.
`hookinstall.CAPTURED_TOOLS` (`hookinstall.py:70`) is the same five, and `hook_block`
(`:167-180`) returns a dict with `PostToolUse` as its only key.

**Where.** `config/settings.json`, `.claude/settings.json`, `rhizome_graph/hookinstall.py:64-80`
and `:167-180`, and -- this is obstacle 5 -- `hookinstall.py:119` and `:210-222`, which read
`PostToolUse` alone.

**Why it costs.** Two separate costs, and they pull in opposite directions.

- **On the agent's loop:** each new matcher is one more ~40 ms Python process per firing
  (section 0). `Notification` fires when the agent is *already* blocked waiting for a human, so
  its 40 ms is free by definition. `Stop` fires once per turn, at the moment the turn ends. A
  session of 30 turns with 20 subagents and 15 prompts is 65 firings, **2.6 s of agent-loop time
  per session**, against a `PostToolUse` count in the thousands. This is the cheapest capture in
  the program. **The estimate of the firing counts is mine; the 40 ms is measured.**
- **In the doctor:** if `hook_block` grows a second event key, a settings file holding our
  `PostToolUse` and not our `Notification` diagnoses `installed` (obstacle 5). That is a
  `--doctor` reporting health over a half-installed setup, and `hookinstall.py:16-25` is a
  docstring about exactly why that is worse than no diagnostic.

**Target shape.** `hook_block` returns `{PostToolUse: [...], Notification: [...], Stop: [...],
SubagentStop: [...]}`, and `merge_hook_block` needs **no change at all** (`:198-206` already
iterates the block's keys, and `tests/test_hook_install_model.py:676-685` already pins that a
stranger's `Stop` survives a merge that does not name `Stop` -- the same test now covers a merge
that does). `LIFECYCLE_EVENTS` becomes a named tuple beside `CAPTURED_TOOLS`, so the two settings
files, the installer and the doctor all read one list.

For the doctor, **two options, and I am recommending the cheaper one with its price stated.**

- *Recommended:* `diagnose` widens `_post_tool_use_commands` to walk **every** event key in
  `hooks`, not just `PostToolUse`. `_is_ours` already recognises our hook by its own program name
  (`:247-257`), so nothing else changes, `STALE` gets stronger (a rotted path under `Stop` is now
  seen), and the states keep their meanings. What it does **not** do is notice a *partial*
  install: our command under `PostToolUse` and absent under `Notification` still reads
  `installed`. **Price: the doctor reports the lifecycle half as healthy when it is missing, and
  the symptom is a graph with no waiting rings -- which looks exactly like nobody being blocked.**
  That is the same ambiguity `CLAUDE.md` says cost real hours, one feature smaller.
- *Rejected for now:* a per-event verdict. It means `Diagnosis` grows a field, every caller of
  `overall_state` learns about events, and the report grows a line per event. Worth building when
  somebody is actually bitten by the partial install; **trigger: the first `--doctor` output that
  says `installed` while the page shows no waiting ring during a session that was demonstrably
  blocked.**

**Steps.**

| # | RED (developer-tester) | GREEN (developer-backend) |
|---|---|---|
| 4.1 | `tests/test_lifecycle_settings.py`: `config/settings.json` carries an entry running our hook under each of `Notification`, `Stop`, `SubagentStop`. Coverage as a **subset**, never string equality -- the rule `tests/test_capture_settings.py:13-16` already sets. | The three entries. |
| 4.2 | RED, the jaw: `tests/test_capture_settings.py`'s existing subset assertion still passes byte for byte, and the installed `.claude/settings.json` still names a script that exists (`test_capture_settings.py:98`). | Nothing. The pin that R4 is purely additive. |
| 4.3 | RED: `hook_block(cmd)` carries the same command under all four event keys, and `merge_hook_block({}, hook_block(cmd))` is still idempotent (`test_hook_install_model.py:632-646`, re-asserted against the wider block). | The `hook_block` change. Nothing in `merge_hook_block`. |
| 4.4 | RED: a settings file holding a stranger's `Notification` hook keeps it after the merge, byte for byte. The `Stop` test at `test_hook_install_model.py:676-685` widened to the key we now write into. | Nothing -- it must already pass. The pin that the merge did not become a write. |
| 4.5 | RED: `diagnose` over a settings file whose **only** entry for our hook is under `Stop`, with a command that does not resolve, answers `STALE` -- today it answers `ABSENT`, because only `PostToolUse` is read. | The walk over every event key. |
| 4.6 | RED: `diagnose` over a file with our hook under `PostToolUse` and a **stranger's** under `Notification` answers `INSTALLED`, not `FOREIGN` -- a stranger elsewhere is not a contest over our block. | Falls out of `_is_ours`; pin it, because 4.5 is the change that could break it. |
| 4.7 | RED: the installed `.claude/settings.json` of **this** repository carries the same four keys, so this project observes itself with the feature on. | The edit. |

**Test to write first.** 4.2 -- property: *widening the capture breaks no existing assertion about
it*. Input that trips it today: nothing; it passes. It is first on purpose. It is the jaw that
makes every step after it provably additive, and running it before 4.1 is what tells the tester
whether the existing subset assertions really are subsets, rather than trusting this document's
reading of them.

**Owner.** `developer-tester` -> `developer-backend`.

---

### R5 -- The browser has no parser and no route for the frame. **Rank: now, and it can land early**

**What is missing.** `protocol.ts` has parsers for `meta`, `completion`, `reset`, `rootError`,
`fileView`, `searchResult`, `sizes` and `status`. Nothing per-agent. `wsClient.handleMessage`
(`:203-274`) routes all eight before `parseEvent`.

**Where.** `web/src/protocol.ts` (new `AgentStateEntry`, `AgentStates`, `parseAgentStates`),
`web/src/wsClient.ts` (a new `onAgentStates` sink and one route, placed with the others before
`parseEvent` at `:273`).

**Why it costs to get the ordering wrong.** `parseEvent` ignores `kind` (`protocol.ts:102-127`),
so a frame routed after it that happens to carry `ts`, `agent`, `type`, `path` and `color` would
be parsed as an event. Ours carries none of those at the top level, so it would simply be
dropped -- which is the *quiet* failure: the feature would do nothing with no error anywhere. The
ordering is what `wsClient.ts:263-268` already documents for `sizes`, and it is copied rather
than re-derived.

**Target shape.** `protocol.ts`'s degradation doctrine, verbatim: `kind` is the one hard field;
`agents` absent, `null` or a non-array yields `[]` and a **surviving frame**; a junk item is
dropped one at a time; an entry with a non-string `agent` drops only itself; an unrecognised
`state` degrades to `working` rather than dropping the entry, because the entry's `agent` and
`ts` are still true. **`caption` degrades to `""`** -- declared now, filled by the sibling plan,
and its absence must cost nothing.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-frontend) |
|---|---|---|
| 5.1 | `web/tests/agentStateProtocol.test.ts`: a well-formed frame parses with entries in order; a wrong `kind` is `null`; a non-object is `null`. | `parseAgentStates`. |
| 5.2 | RED: `agents` absent, `null` or a string all yield `[]` and a surviving frame; a junk item is dropped while its neighbours survive; an entry with a non-string `agent` or a non-finite `ts` drops **only itself**. | The per-item loop. |
| 5.3 | RED: an unrecognised `state` degrades to `working`; an absent `label` and an absent `caption` both degrade to `""`. **The `caption` assertion is written now and stays true when the sibling plan fills it.** | The fallbacks. |
| 5.4 | RED: an `agentState` frame reaches `onAgentStates` and **never** `onEvent`, and is consumed even with no sink given. Modelled on `web/tests/wsClientStatus.test.ts`. | The route, placed before `parseEvent`. |

**Test to write first.** 5.4 -- property: *an answer about actors never becomes an event*. Input
that trips it today: `{"kind":"agentState","agents":[]}` reaches `parseEvent`, which returns
`null`, so nothing observable happens -- which is why the assertion has to be that the sink was
called, not that the graph is unchanged.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R6 -- There is no pure model of who is waiting and who has left. **Rank: now**

**What is missing.** `Actor` is `{agent, intensity}` (`simulation.ts:46-53`). The label lives on
the renderer's `ActorView` (`renderer.ts:91-102`), which has no unit test by doctrine. Between
the socket and the figure there is nothing pure.

**Where.** New module `web/src/agentState.ts`. Not in `simulation.ts`: that module's whole
contract is the tree plus the time-based fade, and it is driven by `applyEvent`/`tick` -- adding
a second input would make `reset()` mean two things. Not in the renderer: it would be untestable,
which is the cost `CLAUDE.md` names explicitly.

**A finding that shrinks this step.** `sim.listActors()` has **no production caller** -- only
tests (`web/tests/simulation.test.ts:111,319`, `seedEvents.test.ts:98,117,133`) -- and
`sim.getActor` is called from exactly one line, for `intensity` alone (`renderer.ts:968`). So the
departure needs **no change to `simulation.ts` at all**: the renderer owns the figure, and the
renderer is what retires it. That is worth a paragraph because the obvious design puts a
`departed` flag on `Actor` and would touch a module with 60 pinned assertions for nothing.

**Target shape.**

```
export type AgentPhase = "working" | "waiting" | "stopped";

export interface AgentStateModel { readonly byAgent: ReadonlyMap<string, AgentEntry>; }
export interface AgentEntry { agent: string; label: string; phase: AgentPhase; caption: string; ts: number; }

createAgentStates(): AgentStateModel
applyAgentStates(state, frame): AgentStateModel      // same reference when nothing changed
closeAgentStates(state): AgentStateModel             // the reset
waitingAgents(state, now): readonly string[]         // decision 9 lives here
departedAgents(state, now): readonly string[]
```

Three properties, each a test:

- **`applyAgentStates` returns the same reference when the frame changes nothing.** The
  `applyView` / `applySizes` idiom (`fileView.ts:107-120`), where `if (next !== state)` is the
  caller's whole adoption test. It is what keeps `main.ts` from repainting on every deduped
  frame.
- **Staleness is a function of `now`, not of a stored flag** (decision 9). `waitingAgents(state,
  now)` drops an entry whose `ts` is older than `STALE_WAIT_SECONDS`. Testable with a number, no
  clock, no socket, no timer.
- **A `stopped` entry survives for `DEPARTURE_SECONDS` and then is gone** (decision 10), so the
  renderer has a window in which to fade rather than a deletion it must react to instantly.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-frontend) |
|---|---|---|
| 6.1 | `web/tests/agentState.test.ts`: `createAgentStates()` is empty; `waitingAgents` and `departedAgents` over it are `[]`. | The state and the two selectors. |
| 6.2 | RED: a frame with two agents adopts both, keyed by `agent`; two entries with the same `label` and different `agent` stay two. | The adoption. |
| 6.3 | RED: the **same** frame applied twice returns the same reference the second time. | The comparison. |
| 6.4 | RED: an entry whose `phase` is `waiting` and whose `ts` is `now - STALE_WAIT_SECONDS - 1` is **not** in `waitingAgents(state, now)`; one a second younger is. | The staleness cut. |
| 6.5 | RED: a `stopped` entry is in `departedAgents` for `DEPARTURE_SECONDS` and absent after; it is never in `waitingAgents`. | The departure window. |
| 6.6 | RED: `closeAgentStates` returns a state equal to `createAgentStates()`. | The close. |
| 6.7 | RED: an agent that goes `waiting` and then `working` in a later frame leaves `waitingAgents` immediately, with no timer involved. | Falls out of adoption; pin it, because it is decision 5 arriving in the browser. |

**Test to write first.** 6.4 -- property: *a fact about the past has an age, and an old enough
"waiting" stops being drawn*. Input that trips it today: the module does not exist. It is first
because it is the property most likely to be dropped as an optimisation, and the failure mode it
prevents -- a ring latched forever on a figure of an agent that died an hour ago -- is the one
the brief asked to have an answer for.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R7 -- An actor with no file event is invisible, and no actor ever leaves. **Rank: now**

**What is wrong.** Two things in one loop, and they have to be fixed together because the second
is meaningless while the first holds.

**Where.** `renderer.ts:673-706` (`onEvent`, the only caller of `ensureActor`), `:966-996`
(`updateActors`), `:982-984` (the `hasPos` hide), `:970` (the 0.4 alpha floor), `:751-757`
(`resetScene`, the only place an actor is removed today).

**Why it costs.** Obstacle 4: `PostToolUse` fires *after* a tool runs, so an agent blocked on a
permission prompt for its **first** tool call has fired no `PostToolUse`, has no `ActorView`, and
would have a `waiting` state with nothing on screen to carry it. **That is not an edge case, it
is the commonest shape of the exact situation this feature exists to show.** And the second
defect: after 12.5 s an idle figure sits at 40% opacity for the life of the page (section 1), so
a session with fifteen subagents over an afternoon ends as a field of dim figures, none of which
is doing anything, in front of the two that are.

**Target shape.** A second entry point to `ensureActor`, and one removal path.

- `setAgentStates(entries)` -- the `setSizeColors` shape (`renderer.ts:669`): the renderer takes
  a per-agent record and knows nothing about hooks. For an agent it has never seen it creates the
  `ActorView`, and **places it at `layout.position("")`** -- the layout's `ROOT_ID`, the pinned
  centre every top-level node hangs from (`layout.ts:24`, `:49`). An agent that has done nothing
  yet stands at the root of the tree, which is both cheap and a true statement. `position("")`
  is confirmed to answer, because `sync` always keeps `ROOT_ID` live (`layout.ts:61`).
- Departure: an entry in `departedAgents` fades its figure and caption over `DEPARTURE_SECONDS`,
  then `scene.remove` + `disposeSprite` + `actors.delete`, which is exactly what `resetScene`
  already does per actor (`renderer.ts:751-757`) -- one loop body, reused.
- While `waiting`, the alpha floor is lifted to 1: a blocked agent is the one you most want to
  see, and dimming it by idle decay is precisely backwards.

**Why the boundary holds afterwards.** The renderer still takes an answer and never a question:
it is handed `waiting` and `departed` lists and paints them. Nothing in it knows what a
`Notification` is. What stops the boundary being crossed later is that `agentState.ts` owns both
selectors and has the tests; the renderer has none by doctrine, so any logic that migrates into
it is logic that silently loses its coverage -- which is the cost to state out loud.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-frontend) |
|---|---|---|
| 7.1 | None possible: `renderer.ts` needs a GL context and carries no unit test by doctrine. The properties are pinned in R6 instead, and the renderer only consumes them. | `setAgentStates`, the root placement, the departure fade and removal, the lifted alpha floor. |
| 7.2 | `web/tests/agentState.test.ts`: `departedAgents` never contains an agent whose entry is younger than `DEPARTURE_SECONDS`, and `DEPARTURE_SECONDS > BEAM_LIFE_SECONDS`. **The constant relation, asserted, because it is the one thing that stops a figure vanishing under its own lit beam.** | The constant. |

**Test to write first.** 7.2 -- property: *a figure outlives the beams that name it as author*.
Input that trips it today: `DEPARTURE_SECONDS` does not exist. It is the only assertable half of
this step and it is the half that would be silently retuned to 0.5 by somebody who found the fade
slow.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R8 -- There is no marker for a waiting agent. **Rank: now**

**What is missing.** Three marker modules exist -- `avatar.ts`, `searchMarker.ts`,
`readMarker.ts` -- and each paints against a narrow context slice so the shape is testable with
no DOM, no canvas and no GL context (`readMarker.ts:12-16`). There is none for an agent.

**Where.** New module `web/src/waitMarker.ts`, painted into a square like the others, added to
`this.scene` (not `overlayScene`): it is a glow, and `CLAUDE.md` is explicit that "unlike text, a
glow through the bloom is exactly what is wanted".

**Why the shape rather than a colour** -- decision 12, and the shape is a **broken ring**: arcs
with gaps, which reads apart from `searchMarker`'s one thick continuous ring and `readMarker`'s
two thin continuous ones, on a screenshot, on a colour-blind eye, and through the bloom.

**A known risk, inherited rather than discovered.** `CLAUDE.md` records that the read marker's
inner stroke is 2.24 px on a 64 px texture with `generateMipmaps = false` and `LinearFilter`, so
drawn much smaller than 64 px it is sampled sparsely and can fade out. **A broken ring is more
exposed to that than a continuous one**, because a gap and a thin stroke are the same artefact at
low sampling. So: the arcs are drawn at a stroke no thinner than the read marker's **outer**
ring (`OUTER_WIDTH = 0.05`, `readMarker.ts:31`), and the tests pin the *relations* between the
radii and widths, never their values, so retuning after a real screen is free -- the same bargain
the read marker already took.

**Steps.**

| # | RED (developer-tester) | GREEN (developer-frontend) |
|---|---|---|
| 8.1 | `web/tests/waitMarker.test.ts`: `paintWaitRing` against a recording context clears first, then strokes; every arc stays inside the box (`radius + width / 2 < 0.5`), the invariant `readMarker.ts:26-28` states. | `paintWaitRing`. |
| 8.2 | RED: the ring is **broken** -- the painted arcs leave gaps, asserted as a count of arcs and a total swept angle strictly below `2 * PI`. This is what makes it a different shape rather than a third continuous ring. | The arc loop. |
| 8.3 | RED: the stroke width is not thinner than `readMarker`'s outer width, imported from that module rather than respelled. | The constant, imported. |
| 8.4 | RED: `paintWaitRing` takes the colour as an argument and paints it verbatim through `cssHex` -- it never derives one, so the actor's own colour reaches it unchanged (decision 12). | Nothing beyond 8.1. The pin that a signal colour is not sneaked in later. |

**Test to write first.** 8.2 -- property: *the waiting marker is a different shape, not a
different shade*. Input that trips it today: the module does not exist.

**Owner.** `developer-tester` -> `developer-frontend`.

---

### R9 -- Wiring. **Rank: now, and it has no test of its own**

`main.ts` is the composition root and carries no test by doctrine, which is why every decision
above lives somewhere else. What lands here:

- `onAgentStates: (frame) => showAgentStates(applyAgentStates(agentStates, frame))`, in the
  options object beside `onSizes` and `onStatus` (`main.ts:318-321`).
- `showAgentStates(next)` sets the variable and calls `renderer.setAgentStates(...)`, the
  `showSizeMode` shape (`main.ts:271-277`).
- One line in the existing `onReset` handler (`main.ts:322-340`):
  `showAgentStates(closeAgentStates(agentStates))`, beside the five closes already there.
- The selectors are evaluated **per frame** inside the renderer, from a `now` the renderer
  already has, not in `main.ts`: `waitingAgents(state, now)` depends on time, and evaluating it
  once on adoption would freeze the answer. Same reason `frameMatches` is recomputed every frame
  and `updateLabels` runs every frame.

**Owner.** `developer-frontend`. **No RED test**, and it is listed as a step so that the absence
is deliberate rather than an omission.

---

### R10 -- A ring says "something", a word says what. **Rank: next, and it depends on the sibling plan**

**What is missing.** The waiting ring distinguishes blocked from thinking, which is the whole
value. It does not distinguish *waiting for permission to run a command* from *idle, waiting for
you to say something* -- and step 0's question 0.3 decides whether the payload even can.

**Where.** The actor already owns a caption sprite and a repaint-on-change rule
(`renderer.ts:1277-1289`). `2026-08-26-20-56-todo-caption.md` builds a **second** caption line
under the name, with its pure text module and its sanitisation. If that plan lands, one word
("waiting", "needs permission") rides that line for free. If it does not, this step means
building the second sprite here.

**Why it is `next` and not `now`.** The ring alone answers the question that made this feature
worth building. The word is a refinement whose cost -- a second sprite per actor, a second
texture per repaint -- is real but small, and paying it twice (once here, once in the sibling
plan) is the thing to avoid.

**Trigger to promote it to `now`:** step 0 answers question 0.3 positively **and** the
todo-caption plan is not going to be built. Then the distinction between "it wants permission"
and "it is waiting for you" is information nobody else will carry.

**Owner.** `developer-frontend`, after the sibling plan or instead of it.

---

### R11 -- Lineage: two figures with no relation drawn between them. **Rank: noted, with a trigger that step 0 evaluates**

**What is missing.** The README's promise is two people working at once; the graph draws two
strangers. A birth edge from parent to child would say which.

**Why I am not planning it.** The join is very probably not derivable, for three reasons that
compound:

1. **`PostToolUse` on `Task` fires when the Task is over.** A birth edge drawn from it is drawn
   at the child's death. A `PreToolUse` on `Task` would fire before -- and at that moment the
   subagent does not exist, so it can carry no id for one.
2. **The only field plausibly present on both sides is `agent_type` / `subagent_type`, and this
   codebase forbids joining on it.** `CLAUDE.md`: "`agent` is identity; `label` is only text ...
   Never key an actor on the label." Two `developer-backend` subagents spawned in one turn are
   two figures with two colours by design, and an `agent_type` join would tie both to one parent
   edge or to the wrong one, with nothing on screen saying which.
3. **A wrong edge is permanent.** `CLAUDE.md`'s "when the parser would have to guess, it stays
   silent" was written about `_parse_bash` and the reason generalises exactly: "a wrong node stays
   on screen forever, a missing one is filled in by the watcher milliseconds later". There is no
   watcher for lineage. A wrong edge is never corrected by anything.

**The trigger, and it is step 0's to evaluate.** Build lineage **if and only if** question 0.7 or
0.8 comes back positive -- that is, if a `Task` payload carries an id of the subagent it spawned,
or a subagent's own payload carries a parent id. Either is an exact join and the feature becomes
a small one: a `parent` field on the `agentState` entry, and a line in the renderer between two
figures it already places. **If both come back negative, write that into `CLAUDE.md` rather than
leaving it as an open idea**, because the next person to have it will spend the same hour.

**Owner.** Nobody, until step 0 says otherwise.

---

### R12 -- The actor map grows without bound. **Rank: noted**

**What is wrong.** One entry per distinct `agent` in `SimulationImpl.actors` (`simulation.ts:138`)
and in `Renderer.actors` (`renderer.ts:308`), removed only by `reset()` / `resetScene()`. Each
renderer entry owns a figure `Sprite` and a caption `Sprite` with its own texture.

**Why it is noted rather than now.** R7 gives the first mechanism that ever deletes one, so the
common case -- a subagent that finishes -- is fixed as a side effect of a feature worth building
for other reasons. What remains is the agent that never reports a `Stop`: a killed process, a
crashed session, a hook that turns out not to fire. Those accumulate at a rate of a few per day
at most, at a few tens of kilobytes each, in a page a user reloads.

**Trigger:** a viewer left open across many sessions showing figures nobody recognises, or a
measured frame-time regression traceable to `updateActors`'s loop length. Either would make the
fix -- retire an actor whose `intensity` has been 0 for longer than some multiple of the decay --
worth its own RED test, in `agentState.ts` where it is testable.

---

### R13 -- Nothing on screen counts how many agents are blocked. **Rank: noted**

A user watching a second monitor wants "2 agents waiting" in text as well as two rings on a graph
that may be zoomed away from them. The obvious home is the bottom row, and the obvious home is
closed: `bottomRow.ts`'s `contextCharBudget` assumes exactly two side reserves of
`MIN_SIDE_WIDTH_PX = 231` measured in a browser (`bottomRow.ts:37`, `:74-76`), and
`2026-08-25-22-17-size-mode.md` already declined to put the size legend there for that reason.
`#attribution` (`web/index.html:22`) is a conditional box in the existing `#hud` and is the
plausible second home.

**Trigger:** somebody actually running the window on a second monitor and reporting that the ring
is missed when the camera is framed elsewhere. Until then this is a guess about a screen, and
this host has none.

---

## 4. What conflicts with what

- **Maintainability vs surface, at the frame kind.** A new `EventType` touches two files; a new
  frame kind touches six and adds about 120 lines of frontend that carry no new behaviour. The
  measurement that settles it is not a number, it is obstacle 3: `applyEvent` with `path: ""`
  grows a clickable phantom file on the layout's pinned centre. **Correctness wins**, and the
  maintainability cost is bounded by copying an existing shape exactly rather than inventing one
  -- `parseSizes` and its route are the template, line for line.
- **Performance vs completeness, at the matchers.** Each matcher is 40 ms of agent-loop time per
  firing, measured, and the loop is the user's own latency. **Completeness wins for these three**,
  because their firing rate is bounded by human actions -- a prompt, a turn, a subagent -- rather
  than by tool calls. **It does not generalise**, and that is exactly why `TodoWrite` is in a
  separate plan with its own accounting: a matcher whose rate scales with the agent's work is a
  different trade from one whose rate scales with the human's.
- **Security vs surface, and there is nothing to trade.** Worth saying explicitly rather than
  leaving as an absence. This feature adds **no inbound command**: `COMMAND_KINDS`
  (`server.py:464`) is untouched, so the two gates (`control_allowed` then `token_matches`,
  `server.py:843-866`) gain no new caller and lose none. It resolves no path, so `resolve_inside`
  is not involved. It forks nothing, so `gitcmd.py` is not involved. It opens no file, so
  `safe_read.py` is not involved. **The one thing it does do is take a string from a hook payload
  and broadcast it to every connected browser** -- `label` already travels that way
  (`normalize.py:109`, `_encode` at `server.py:458`), and in this plan `state` is a closed set of
  three so nothing free-form is added. **The moment the sibling plan fills `caption`, that
  sentence stops being true**, which is why the caption's sanitisation is specified there and
  why `security-auditor` should read both documents as one change.
- **Honesty vs simplicity, at the expiry rule.** A timeout on `waiting` is one constant and one
  comparison. It also reports false progress for the commonest real case -- a human away from the
  keyboard -- which is a lie the user cannot detect. **Honesty wins** (decision 5): the state is
  cleared by the agent's own next tool call, and the only thing a clock decides is how an *old*
  fact is drawn, in a pure module where it is a test rather than a timer.
- **Two sources of truth about an actor, and this feature creates the second one.** Today the
  renderer's `actors` map is populated only from events. After R7 it is populated from two places,
  and they can disagree: an `agentState` frame naming an agent the simulation has never seen
  creates a figure the model knows nothing about. That is intended -- obstacle 4 is precisely
  that the model *cannot* know about it yet -- but it is a real coupling and the honest statement
  is that `renderer.actors` becomes the union of two inputs, with `sim.getActor(...)?.intensity
  ?? 0` (`renderer.ts:968`) already written to tolerate a missing model entry. **The `?? 0` that
  makes this safe was there before this plan and was written for another reason**; R7 depends on
  it, so it is now load-bearing and should not be tidied into a non-null assertion.

Nothing here adds a path around a chokepoint: `resolve_inside` stays the only containment check
and is not involved; `gitcmd` stays the only fork and is not involved; `WsClient.send` stays the
only token stamp and gains no caller, because nothing in this feature travels inbound; the two
gates stay in front of every command and the set of commands is unchanged.

---

## 5. What cannot be verified on this host

**This host is a tty.** No `DISPLAY`, no browser, no Chrome, no playwright -- the same gap
`CLAUDE.md` records for the read ring, the file viewer, the content search and the size mode.
**And it has no running Claude Code session to observe**, which is a second and sharper gap: step
0 cannot be run here by anyone.

1. **Every payload shape in this document.** Step 0 exists because of this and the plan is
   written so that a surprise invalidates a step rather than the feature. It is item 1 because it
   is the largest unknown by a distance.
2. **Whether a broken ring around a stick figure reads as "waiting".** It may read as a selection,
   as damage, or as decoration. The alternatives -- a raised figure, a bob, a caption alone --
   are written into decision 12 so nobody has to re-derive them on the day it is looked at.
3. **Whether the actor's own colour is legible as a ring at the sizes a figure is drawn.**
   `hashColor` produces arbitrary hues, some of them dark, and the figure is drawn at
   `AVATAR_WORLD_HEIGHT = 7` (`renderer.ts:181`). A dark actor colour is a dark ring on a black
   field. If that is what a real screen shows, the ring takes a fixed light tint and the *shape*
   keeps doing the distinguishing -- the fallback is written down so it is not re-argued.
4. **Whether the broken ring survives the sampling problem `CLAUDE.md` already flags for the read
   marker.** R8 sets the stroke floor to guard against it; whether the floor is enough is a real
   screen's answer.
5. **Whether a figure standing at the layout's pinned centre reads as "this agent has not started
   yet"** or as a figure stuck in the middle of the tree. This is the placement decision in R7 and
   it is the one I am least sure of.
6. **Whether `DEPARTURE_SECONDS = 2.5` reads as leaving or as a glitch.** It is arithmetic from
   `BEAM_LIFE_SECONDS` and the highlight decay, not an observation of how a fade looks.
7. **Whether the firing counts in R4 are anywhere near right.** 30 turns, 20 subagents and 15
   prompts is my estimate of a busy session. The 40 ms is measured; the multiplier is not.
8. **The backend suite, at all.** No pytest on this host (section 0). Every backend claim here
   is from reading `daemon/server.py`, `rhizome_graph/normalize.py`, `rhizome_graph/hook.py` and
   `rhizome_graph/hookinstall.py`, and from the tests' source rather than from their results.

---

## 6. What I examined and found sound

- **`rhizome_graph/hook.py`, all of it.** I went looking for where a lifecycle payload would have
  to be classified on the hot path and found that there is no such place: the hook forwards the
  envelope and nothing else (`:55-66`). The feature therefore costs the agent's loop one process
  per firing and not one line of new hot-path logic. No change proposed, and the "stdlib only"
  and "never fail loudly" rules are not even approached.
- **`actor_of` and its shared-with-the-daemon docstring** (`normalize.py:83-109`,
  `server.py:334-338`). Designed for exactly this: a payload that yields no event still names an
  actor. R2 imports it rather than re-reading `agent_id`.
- **`set_status` and the replaceable-slot pattern** (`server.py:252-269`, `:221`, `:301`). A
  standing fact that is republished for the life of the session, deduped on the encoded message,
  cleared on reset, and placed in the replay by an argument rather than by habit. R3 is a copy.
- **`_broadcast_transient`'s docstring** (`server.py:383-402`). It enumerates the three pieces of
  state and why each must not be touched, which is what let R3 step 3.2 be written as one
  assertion rather than three guesses.
- **`hookinstall.merge_hook_block`** (`:183-207`). It iterates the block's own keys, so a block
  with four events merges with **no change**, and `tests/test_hook_install_model.py:676-685`
  already pins that a stranger's hook under another event survives. I expected to have to widen
  the merge and I do not.
- **`tests/test_capture_settings.py` and `test_hook_install_model.py:739-755`.** Both assert
  coverage as a subset and both say so in prose. Adding matchers is non-breaking by their own
  design; R4 step 4.2 re-runs them as the jaw rather than modifying them.
- **`wsClient.handleMessage`'s ordering doctrine** (`:203-274`) and `protocol.ts`'s degradation
  rules (`:374-419`). Copied exactly by R5, including the "consumed with or without a sink"
  clause, which is what stops an unrouted frame from reaching `parseEvent`.
- **`renameActor`** (`renderer.ts:1277-1289`). Repaint only on change, an empty caption never
  replaces a good one, and the cost of a repaint is stated in the comment. Any per-actor text
  inherits this and needs no new rule.
- **`layout.ts`'s `ROOT_ID` handling** (`:24`, `:49`, `:61`). `sync` always keeps the root live,
  so `position("")` always answers -- which is what makes R7's placement one line instead of a
  new concept. No change proposed.
- **`simulation.ts`'s `Actor`** (`:46-53`). I went looking for somewhere to put a `departed` flag
  and found that `listActors` has no production caller and `getActor` is read for `intensity`
  alone. The right answer was to touch this module not at all, which is a result rather than an
  absence of one.

---

## 7. Where I stopped

- **Not run:** the backend suite, because this host has no pytest and installing one is
  forbidden (section 0). The `1343` figure is a `grep` over `tests/*.py` and is a floor, not the
  suite's number. **Every backend statement in this document is from source, not from a green
  run**, and R4 step 4.2 exists partly so the tester finds out early whether my reading of the
  existing subset assertions is right.
- **Not run:** the opt-in packaging tests (`RHIZOME_PACKAGE_TESTS=1`). R4 changes
  `config/settings.json` and `hookinstall.hook_block`, and `tests/test_deb_package.py:967-1004`
  asserts that a shipped fragment runs `rhi-hook` -- by *behaviour* (a JSON object with a `hooks`
  mapping, at `:1041`), not by shape, so I judged it unaffected rather than checking. **That is a
  judgement, not a measurement**, and it is the one packaging risk in this plan.
- **Not measured, estimated:** the per-session firing counts in R4. The 40.2 / 40.6 / 20.1 ms
  figures are measured on this host, 20-25 runs each; the number of times a `Notification` fires
  in an hour is a guess, and the ceiling that would make it matter is a session prompting for
  permission dozens of times a minute, which nothing has seen.
- **Not measured:** the cost of one more sprite per actor per frame. `updateActors` and
  `updateLabels` already walk the actor map every frame (`renderer.ts:967`, `:1347`); adding a
  ring sprite makes that walk do one more `position.set` and one more `sizeLabel` per actor.
  With a handful of actors this is far below the 774 us `fileColor` was measured at over 1 500
  nodes (`2026-08-25-22-17-size-mode.md`, section 0), but I did not measure it and there is no
  browser here to measure it in.
- **Not read:** `daemon/watcher.py` (it produces no payload this feature touches),
  `web/src/view.ts`, `web/src/style.css`, `rhizome_graph/cli.py` beyond the `--doctor` and
  `--install-hooks` entry points named in R4, and `rhizome_graph/assets.py`. R4's edit to
  `config/settings.json` should be checked against `packaging/build-deb.sh` by whoever takes it
  green; I did not read that script.
- **Not attempted:** any ranking of the severity of broadcasting a payload-derived string to every
  browser. The structure -- one field, closed set of three, plus a `caption` field this plan
  declares and does not fill -- is what I am reporting; ranking it belongs to
  `security-auditor`, and it should be asked about **both** plans together, because the sibling
  one is what makes the field free-form.
- **Not settled here:** the exact values of `STALE_WAIT_SECONDS`, `DEPARTURE_SECONDS` and the
  ring's radii. R6, R7 and R8 pin the *relations* (a stale wait is older than the cut; a departure
  outlives the longest beam; the arcs stay inside the box and leave gaps), never the values, so
  retuning after a real screen costs nothing -- the same bargain the read marker's radii already
  take.

---

## Consultation: `security-auditor` (2026-08-26)

Appended by the orchestrator. The audit covered all five plans of this batch **together** and
ranked one critical, five high and seven medium findings; the full report is
`docs/security/2026-08-26-audit-five-planned-features.md` and it is the authority. This section is a pointer into it, never a second
copy of it. It was written against the feature descriptions, **not** against this document --
the auditor states so itself -- so where the two disagree the disagreement is real and unresolved,
not an editing slip.

### Findings that land on this plan

- **H1 (high).** `ingest_line` stamps `_last_hook` from `actor_of(payload)` **before** it looks at `tool_name`
  (`daemon/server.py:341-349`), so every one of the four new payloads refreshes the active agent for
  `ATTRIBUTION_WINDOW_SECONDS = 5.0`. A `Stop` is therefore the exact inversion of its own meaning:
  the frame that says an agent has left hands it the next five seconds of watcher changes. Proven
  with a probe, not reasoned. The decision belongs in a pure `refreshes_actor(payload) -> bool` in
  `rhizome_graph/normalize.py`, never in the socket loop.
- **H3 (high).** The ingest socket is left at `0o775` -- `start_unix_server` (`daemon/server.py:1170`) never
  `chmod`s it -- so on this host every member of the user's primary group can write it. One forged
  line then buys this feature a permanent "waiting" alarm on any agent, a fabricated parent/child
  edge, and an actor that never departs. Recommends `chmod 0o600`, an explicit `limit=`, and a rate
  bound of one state change per actor per 0.25 s.
- **M1 (medium).** `parseEvent` ignores `kind` entirely, so a lifecycle frame not routed **above** it in
  `wsClient.handleMessage` grows a permanent node in the graph on any older page.
- **M2 (medium).** `hookinstall.diagnose` reads `_post_tool_use_commands` only, so a stale absolute path in a
  `Stop` or `Notification` block errors on every agent stop while `rhi --doctor` reports
  `installed` -- the rot that `CLAUDE.md` says fails louder and worse than absence, made invisible
  again.
- **M3 (medium).** `ensureActor` allocates per distinct agent string and never evicts. Today an actor needs an
  event with a path; a pathless lifecycle event makes one free, one forged line each. Cap 32, LRU,
  and the eviction decision pure beside `selectFileLabels`.
- **M5 (medium).** `U+202E` and C0/C1 controls already cross the wire inside paths (measured). One pure
  `sanitizeDisplayText`, never applied to a path used as a key, an identity or a request argument.
- **M7 (medium).** The 64 KiB ingest cap is `asyncio`'s default, inherited by accident. Measure with
  `RHIZOME_TRACE_LOG` before choosing any explicit limit.

### The auditor's own summary of this feature

**1. Agent lifecycle events -- the riskiest of the five.** New untrusted input: four new payload
shapes crossing the ingest socket, none carrying a path, all reaching `_last_hook` today (0.4).
The attacker is the agent itself (prompt-injected by a file it read, and able to run `Bash`) or
any process running as the user. The control token is irrelevant -- this data flows toward the
page, not from it -- and nothing replaces it, so the only defences available are structural: the
pathless kinds must touch none of `known_paths`, `_recent`, `_hook_paths`, `_fs_paths` or
`_last_hook` (H1), the frame must be routed above `parseEvent` (M1), the actor map must be
bounded (M3), and `--doctor` must learn to read the new hook event keys (M2). No new command
kind. No new file descriptor, no fork, no regex.

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

- **2.2** -- R3 step 3.4 inserts `agentState` into `replay_messages()` by index, and three other
  plans insert into the same gap; nothing defines their order among themselves. Use the pairwise
  `kinds.index(a) < kinds.index(b)` form `tests/test_hub_status.py` already uses.
- **2.4** -- step 3.2 cites `tests/test_hub_read_events.py` as the model for a four-way private
  attribute assertion. The tester read that file: it makes no private assertion at all, it asserts
  behaviourally through the replay. The audit's H1 RED 3 repeats the same mistake.
- **2.5** -- rows 1.2, 2.8, 4.2, 4.4 and 4.6 are green today. They are regression jaws, which is
  legitimate, but 4.2 duplicates an assertion that already lives in `tests/test_capture_settings.py:89`;
  that is an instruction to *run* a test, not to write a second copy of it.
- **2.6** -- this plan and the caption plan are **one plan** at R3 and R4: both name
  `tests/test_hub_agent_state.py` and both edit the same matcher and hook block. Separable at the
  frame, joined at the hub slot and the settings edit.

### Row by row

### A.1 Agent lifecycle events -- 36 OK / 7 NEEDS SHARPENING / 1 NOT WRITABLE

**Step 0 -- OK.** Correctly declared as not a RED/GREEN pair. **Unrunnable on this host** (no
`DISPLAY`, no Claude Code session), and the plan says so. It gates R2 2.1-2.4 and caption R1 1.1,
1.7 and R3 3.1 -- see the respecification under R2, which un-gates most of it.

**R1 -- 3 OK.** All three verified against the running code with the probe.

| Row | Verdict | Evidence |
|---|---|---|
| 1.1 | **OK** | Probe scenario B: `hub.ingest_line('{"session_id":"s-1","hook_event_name":"Notification"}')` then `ingest_fs_change("src/a.py","M")` broadcasts `"agent":"s-1"` today. Must be `""`. **RED for exactly the reason stated.** |
| 1.2 | **OK** (green jaw, correctly declared) | Probe C and D: a `Grep` payload, with and without `tool_input`, stamps today (`agent: "s-2"`, `"s-3"`), and still stamps after the `tool_name` narrowing. Stays green. |
| 1.3 | **OK** | Probe E: `{"session_id":"s-4","tool_name":123}` stamps today (`agent: "s-4"`). Must not. **RED.** |

**R2 -- 4 NEEDS SHARPENING, 4 OK.**

Rows 2.1, 2.2, 2.3 and 2.4 each say "over a **captured** payload (step 0's fixture)". That fixture
does not exist and cannot be produced here. As written the tester cannot start. Writing them
against *assumed* field names is precisely what `CLAUDE.md`'s "settled by capture, not by
reasoning" forbids.

> **Corrected specification (2.1-2.4).** Split the assumption from the behaviour. `agentstate.py`
> declares four module constants -- `NOTIFICATION = "Notification"`, `STOP = "Stop"`,
> `SUBAGENT_STOP = "SubagentStop"`, and the payload key `EVENT_KEY = "hook_event_name"` -- and the
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
> state machine -- closed set, actor delegation, the `SubagentStop` asymmetry, never raises -- is
> fully testable today. Note the key `hook_event_name` is *already* confirmed present on real
> captures: `tests/test_agent_identity.py:45` and nine other fixtures carry it. Only the three
> *values* are assumptions.

| Row | Verdict |
|---|---|
| 2.1 | **NEEDS SHARPENING** -- see above |
| 2.2 | **NEEDS SHARPENING** -- see above |
| 2.3 | **NEEDS SHARPENING** -- see above |
| 2.4 | **NEEDS SHARPENING** -- gate it on Step 0 explicitly; do not attempt it in the first pass |
| 2.5 | **OK** -- `PostToolUse` is a measured value, not an assumption |
| 2.6 | **OK** |
| 2.7 | **OK** -- `sizes_frame` is the model and it exists |
| 2.8 | **OK** -- `ast` over Python source; `tests/test_checkouts.py` is the working precedent |

**R3 -- 1 NEEDS SHARPENING, 6 OK.**

| Row | Verdict | Note |
|---|---|---|
| 3.1 | **OK** | RED: no branch exists |
| 3.2 | **NEEDS SHARPENING** | "`known_paths` is unchanged, `_recent` is empty" reaches into private attributes. §2.4: `test_hub_read_events.py` does not do this. **Corrected:** assert behaviourally -- after the lifecycle line, a `Write` to a path is still an `A` (that *is* the `known_paths` claim), and `[m for m in hub.replay_messages() if "kind" not in json.loads(m)] == []` (that is the `_recent` claim, and it survives 3.4 adding an `agentState` frame to the replay). |
| 3.3 | **OK** | |
| 3.4 | **OK** | Index-based, matching `test_hub_status.py:138,148`. See §2.2 for the three-plan collision. |
| 3.5 | **OK** | And see §C.5 -- this is the testable half of decision 5. |
| 3.6 | **OK** | |
| 3.7 | **OK** | |

**R4 -- 1 NEEDS SHARPENING, 6 OK.**

| Row | Verdict | Note |
|---|---|---|
| 4.1 | **OK** | RED |
| 4.2 | **NEEDS SHARPENING** | It is an instruction to *run* `tests/test_capture_settings.py`, not to write a test. I confirmed the assertion is a genuine subset (`REQUIRED_TOOLS <= covered`, `:89`) with a docstring saying adding a sixth tool must not fail it. Writing a copy in a new file duplicates one fact. **Corrected:** delete the row; replace with a line in R4's prose -- "run `tests/test_capture_settings.py` and `tests/test_hook_install_model.py` before touching anything, and record that they pass." |
| 4.3 | **OK** | |
| 4.4 | **OK** (jaw) | I confirmed `merge_hook_block` iterates `block.items()` (`hookinstall.py:198-206`); widening to `Notification` is a real new case |
| 4.5 | **OK** | **RED confirmed by reading:** `diagnose` calls `_post_tool_use_commands` (`hookinstall.py:119`, `:210-222`), which reads `hooks["PostToolUse"]` and nothing else. A file whose only entry is under `Stop` answers `ABSENT` today. **Merge with audit M2 -- see §B.** |
| 4.6 | **OK** (jaw) | |
| 4.7 | **OK** | |

**R5 -- 4 OK.** 5.4's prose already gets the sharp part right ("the assertion has to be that the
sink was called, not that the graph is unchanged"). That matters -- see §B, M1, where the audit
gets it wrong.

**R6 -- 7 OK.** New pure module, new test file, `ModuleNotFoundError` is correct RED. 6.4's
staleness cut is a pure function of `(state, now)` and needs no clock, no socket, no timer. Good
step, and it is the one that makes decision 5 testable at all (§C.5).

**R7 -- 1 OK, 1 NOT WRITABLE.**

- **7.1 -- OK.** Correctly declares that no test is possible.
- **7.2 -- NOT WRITABLE AS SPECIFIED.** "`DEPARTURE_SECONDS > BEAM_LIFE_SECONDS`, asserted."
  Measured: `BEAM_LIFE_SECONDS` is `const BEAM_LIFE_SECONDS = 1.2;` at `web/src/renderer.ts:140`
  -- **module-private, not exported**, in a module that imports three.js and carries no unit test
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

**R8 -- 1 NEEDS SHARPENING, 3 OK.**

- **8.3 -- NEEDS SHARPENING.** "the stroke width is not thinner than `readMarker`'s outer width,
  **imported from that module**". Measured: `web/src/readMarker.ts:31` is
  `const OUTER_WIDTH = 0.05;` -- **not exported**. `readMarker.ts`'s exports are
  `READ_MARKER_SIZE`, `ReadMarkerContext`, `paintReadRings`, `createReadMarkerCanvas`.
  The import fails to compile. That is *a* RED, but it is an import error, and the plan's GREEN
  column ("The constant, imported") does not name the export as work.
  **Corrected:** the GREEN step is two things -- `export const OUTER_WIDTH = 0.05;` in
  `readMarker.ts`, and `WAIT_ARC_WIDTH >= OUTER_WIDTH` in `waitMarker.ts`. Assertion:
  `expect(WAIT_ARC_WIDTH).toBeGreaterThanOrEqual(OUTER_WIDTH)` with both imported. Fails today on
  the missing module *and* the missing export; say both in the step so the developer exports it
  rather than respelling `0.05`.
- 8.1, 8.2, 8.4 -- **OK.** `web/tests/readMarker.test.ts` is the working template (a recording
  context object, no DOM), and 8.2's "total swept angle strictly below `2π`" is a real property of
  a recording context that captures `arc()` calls.

**R9 -- OK.** Declares no test and says why. Correct.

**R10-R13 -- noted, no steps.** No verdict needed. R11's decision to gate lineage on Step 0
questions 0.7/0.8 is right and I would keep it.

---

