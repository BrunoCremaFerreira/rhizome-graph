# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

`rhizome-graph` is a **real-time visualizer of what each Claude Code agent is doing**
(file/directory creation, edition, deletion), rendered with the **Gource** look.

The core insight: we do **not** reimplement Gource. Gource already accepts a live
event stream on STDIN. Our job is an **adapter** that captures Claude Code hook
events and translates them into Gource's log format:

```
Claude Code agent(s)  ──PostToolUse hook (JSON)──►  adapter  ──Gource log line──►  gource --realtime
```

Each Gource "user" (the on-screen actor/avatar) represents **one agent**.

## Mandatory rules (non-negotiable)

1. **ALWAYS use TDD before any development.** No line of production code is written before a
   failing test exists specifying the desired behavior. The Red → Green → Refactor cycle
   (see "Agents & TDD workflow") is mandatory for every feature, fix, or refactor — no
   exceptions.
2. **All planning and implementation are done by the specialist agents together, never by the
   orchestrator alone.** The main agent orchestrates and delegates; it does not plan or
   implement on its own. All work goes through the specialists: `developer-tester`
   (tests/RED), `developer-backend` (Python) and/or `developer-frontend` (TypeScript),
   collaborating according to the layer involved.
3. **NEVER commit or push without the user asking for it.** Not at the end of a task, not
   because the work is finished, not because the tree is dirty and tests are green. Leave
   changes in the working tree and say what is uncommitted; the user decides what becomes
   history and what gets published. This covers `git commit`, `git push`, `git merge`,
   branch deletion, tags, and opening PRs. "Implement X" is not permission to commit X, and
   permission given once does not carry to the next change.
4. **English is the only language in this repository.** Identifiers, function and file names,
   comments, docstrings, commit messages, agent definitions, and — this is the one that keeps
   getting missed — every string a human ends up reading: HUD text, `start.sh` log lines and
   `--help` output, error messages. Half-Portuguese was the actual state of this repo (the
   git-status panel counted changes in Portuguese under an English keys legend; `start.sh`
   explained itself entirely in Portuguese), and mixing is worse than either language alone:
   the reader switches mid-sentence, and grepping for a message seen on screen finds nothing.
   `tests/test_language_policy.py` enforces this over the authored sources — it fails on any
   accented Latin letter or a short list of unaccented Portuguese words, so do not quote the
   forbidden text in a file it scans, describe it. The `tests/` trees are exempt only because
   encoding tests need real non-ASCII fixtures, never as licence for prose in another
   language. Talking to the user in Portuguese is fine — writing it into a file is not.
5. **Release numbers are always `YY.MM.NNN`.** `YY` is the year the release was cut, `MM`
   the month it was cut, and `NNN` a sequential counter of releases within that month,
   zero-padded to three digits. `NNN` restarts at `001` when the month turns — it is a
   per-month counter, never a running total. A bugfix release of an existing release is
   `YY.MM.NNN-BB`, where `BB` is the sequential bugfix number of that exact `YY.MM.NNN` and
   nothing else: `26.08.003-01` is the first bugfix of `26.08.003`, and its own second bugfix
   is `26.08.003-02` no matter how many other releases were cut in between. The date in the
   number is the date of the *release being cut*, so a bugfix keeps the base release's `YY.MM`
   even when it ships in a later month. This is the only release-number format — tags,
   package versions, changelog headings and anything a human reads all spell it the same way.

## Architecture

Data flows through five stages. Keep this separation when adding code.

1. **Seed** — `rhizome_graph/tree.py` walks the project root once at daemon boot and publishes
   the existing tree as `origin: "seed"` events. Without it the graph opens blank and only
   ever holds the handful of files an agent happened to touch — nothing like Gource.
2. **Capture** — two sources, deliberately (see "Conventions & gotchas"):
   - `.claude/settings.json` hooks fire `hooks/emit_event.py` and carry the **agent id**.
     `PostToolUse` on `Write` → `A`/`M`, on `Edit`/`MultiEdit` → `M`, on `Bash` → parse the
     command for `rm`/`rmdir`/`mv`/`mkdir`/`touch`/`cp`, on `Read` → `R`, and on
     `TodoWrite` → no event at all, only the caption under the figure.
   - `daemon/watcher.py` (inotify via watchdog) reports **every** change on disk, with no
     idea who caused it.
3. **Normalize + aggregate** — `daemon/server.py` owns the shared state: the set of seen
   paths (drives `A` vs `M`, and lets a directory delete prune its subtree), the seed
   snapshot, the replay buffer, and the last agent to act (which is what attributes a
   filesystem change to an agent).
4. **Transport** — a Unix socket for ingest; WebSocket + static HTTP on one port out.
5. **Render** — `web/` (three.js), not the Gource binary. The `gource --realtime` path
   described below is the original design, kept because the log format is still our
   vocabulary.

### Gource custom log format
Pipe-delimited: `timestamp|user|type|path|color`
- `type` is `A`, `M`, `D`, or `R`
- `color` (optional, hex, no `#`) — we set it by op type: `A`→`33FF33`, `M`→`FFAA00`,
  `D`→`FF3333`, `R`→`AA66FF`
- Example: `1754870400|agent-worker|M|src/api/users.ts|FFAA00`
- `R` (read) is ours, not Gource's: the file was *opened*, nothing about the tree changed.
  It rides the same wire and is drawn as a violet pulsing ring, but it mutates no state —
  see "A read is not a change".

### Agent attribution (the hard part)
"Show what *each* agent is doing" means mapping every op to an actor. What the hook JSON
actually carries was settled by capture, not by reasoning — measured against Claude Code
2.1.229 with `RHIZOME_TRACE_LOG` (below). Re-measure before trusting it on a new version:

- A tool call made by the **orchestrator** carries `session_id` and **no** `agent_id` /
  `agent_type` — the keys are absent, not empty.
- A tool call made by a **subagent** carries the same `session_id` **plus** `agent_id` (an
  opaque per-subagent id) and `agent_type` (the readable name: `developer-backend`,
  `developer-tester`, ...). Subagent tool calls **do** fire the hook; this was the open
  question, and the answer is yes.

So `actor_of` (in `normalize.py`, shared with the daemon) resolves the actor as `agent_id`
when usable, else `session_id`, else `""`. `agent_type` becomes the event's `label`.

**`agent` is identity; `label` is only text.** The actor key and its color hash come from
`agent`, so two subagents of the same type stay two figures with two colors. Never key an
actor on the label.

The `label` had to reach the watcher path too: a filesystem change credited to a subagent
inherits its id *and* its name, or the specialist's figure goes nameless for half the events
it causes.

## Intended layout

```
rhizome_graph/normalize.py  # pure: hook JSON → Event; also actor_of / seed_event / fs_event / retype
rhizome_graph/tree.py       # boot snapshot of the observed project
rhizome_graph/gitignore.py  # git's ignore syntax, pure; IgnoreRules reads the files, per directory
rhizome_graph/repo.py       # pure: reads .git/HEAD for the branch (never shells out to git)
rhizome_graph/paths.py      # pure: resolve a typed root, and complete a directory like a shell
rhizome_graph/token.py      # pure: the control token — mint, compare, and inject into the page
rhizome_graph/hexdump.py    # pure: the xxd format, byte for byte, + is-this-binary
rhizome_graph/safe_read.py  # the ONE capped read of a path we did not construct (FIFO-safe)
rhizome_graph/gitcmd.py     # the ONE place that forks `git` (kill + close + reap on timeout)
rhizome_graph/diff.py       # the uncommitted diff of one file (see the note in Status)
rhizome_graph/checkouts.py  # pure: which checkouts sit BELOW a path (the downward question)
rhizome_graph/status.py     # pure parse of `git status --porcelain -z`, the fan-out, the frame
rhizome_graph/file_view.py  # what a clicked file shows: diff, else text, else hex
rhizome_graph/content_search.py # which files hold this string (forks nothing, imports no `re`)
rhizome_graph/sizes.py      # how big is every file the graph draws (opens nothing, forks nothing)
rhizome_graph/agentstate.py # pure: what a payload says about its AGENT -- its state, and
                            # the caption its own TodoWrite derives (fold + cap live here)
rhizome_graph/session_stats.py # pure: what each agent did this session (counts, capped)
rhizome_graph/attention.py  # pure-ish: the paths the user asked to be told about (one file, read once)
rhizome_graph/cli.py        # pure: argv + environ + cwd → frozen Settings; `rhi` itself
rhizome_graph/assets.py     # pure: where THIS installation keeps web/dist, and the hook command
rhizome_graph/ipc.py        # is that socket live? is that port free? (answers, never raises)
rhizome_graph/launch.py     # the one place `rhi` names the daemon side
rhizome_graph/window.py     # pure choice of backend + the two strategies (never sees a token)
rhizome_graph/hookinstall.py # pure: diagnose a settings file, merge a hook block (idempotent)
rhizome_graph/hook.py       # the hook's ONE implementation, stdlib-only, installed as rhi-hook
hooks/emit_event.py         # shim over rhizome_graph/hook.py, for a checkout with no install
daemon/server.py            # EventHub: seed, attribution, dedupe, meta, WebSocket + HTTP
daemon/watcher.py           # inotify watcher (watchdog)
config/settings.json        # hooks to install into a target project's .claude/
debian/ packaging/ Formula/ # the .deb's control + build script + shims, and the Homebrew formula
tools/webview_spike.py      # the WebGL measurement a human runs on a real desktop session
web/src/avatar.ts           # the agent figure, painted on a canvas
web/src/eventLog.ts         # pure: the recent-changes list model (drops seed, folds repeats)
web/src/attribution.ts      # pure: has any attributed event arrived? (latch, never unlatches)
web/src/search.ts           # pure: match, the walk over matches, and the camera frame for them
web/src/matchRanges.ts      # pure: the ASCII fold + the non-overlapping occurrences in a text
web/src/contentSearch.ts    # pure: the ctrl+shift+F state machine (submit, adopt, walk, mark)
web/src/contentSearchKeys.ts # pure: what ctrl+shift+F / Enter / F3 / Esc mean
web/src/sizeColor.ts        # pure: the no-green ramp, the median-hinged scale, the byte format
web/src/sizeMode.ts         # pure: the F7 round trip (phases, late-answer refusal, the colours)
web/src/sizeKeys.ts         # pure: what F7 means (and what a modified or repeating F7 is not)
web/src/statsPanel.ts       # pure: the session summary's rows (order, swatch, cap, visibility)
web/src/statsKeys.ts        # pure: what F8 means (and what a modified or repeating F8 is not)
web/src/sound.ts            # pure: is this event worth hearing, and in whose voice
web/src/audio.ts            # the ONE place that names AudioContext -- decides nothing, never throws
web/src/soundKeys.ts        # pure: what F9 means (and what a modified or repeating F9 is not)
web/src/rootPrompt.ts       # pure: the ctrl+L bar's state (text, completion, discard on Esc)
web/src/pick.ts             # pure: which file a click (or the resting pointer) landed on
web/src/labels.ts           # pure: label size/placement, and which files are named this frame
web/src/fileView.ts         # pure: the content panel's state (request, adopt, discard, tokens)
web/src/fileViewClicks.ts   # pure: which click closes the panel (never the backdrop)
web/src/language.ts         # pure: path -> the grammar id, or null (no generic fallback)
web/src/diffModel.ts        # pure: the unified diff, parsed into numbered rows
web/src/fileDoc.ts          # pure: what the panel draws — rows, gutter, tokenize requests
web/src/highlight.ts        # the ONE place that names shiki (lazy wasm + 22 literal imports)
web/src/readMarker.ts       # the violet ring a file wears while an agent is reading it
web/src/agentState.ts       # pure: who is waiting, who has left (both selectors take `now`)
web/src/agentCaption.ts     # pure: the SAME fold and cap again, in the browser (decision 7)
web/src/waitMarker.ts       # the BROKEN ring an agent wears while it is blocked on a human
web/src/attentionState.ts   # pure: the alarm latch -- a SET of what needs looking at, not a stream
web/src/attentionList.ts    # pure: the alarm panel (order, cap, and what its header has to say)
web/src/alarmMarker.ts      # the BRACKET a watched file wears once an agent has touched it
web/src/nodeFade.ts         # pure: the idle fade, and who is exempt from it
web/src/beams.ts            # pure: the two beam lifetimes, so a test can compare against them
web/src/statusList.ts       # pure: the uncommitted-changes panel (order, cap, is it visible)
web/src/searchKeys.ts       # pure: what ctrl+F / F3 / Esc mean (and what a SHIFTED ctrl+F is not)
web/src/branding.ts         # pure: APP_NAME, so the untestable renderer never spells it
web/src/token.ts            # pure: read the control token, stamp it on a command frame
web/src/*Hud.ts             # thin DOM painters: context caption, event list, attribution, search
                            # box, content-search box, git status panel, size legend,
                            # attention panel, session summary
setup.py / MANIFEST.in      # the ONLY dynamic build step: copy web/dist in, IF it was built
run.sh / start.sh           # minimal launcher / full bootstrap
```

## Running (target workflow)

```sh
mkfifo /tmp/claude-gource.pipe
tail -f /tmp/claude-gource.pipe | gource --realtime --log-format custom \
  --file-idle-time 0 --key -
# hooks append normalized lines to the pipe as agents work
```

`gource` is an external dependency: `apt install gource` / `brew install gource`.

## Conventions & gotchas

- **The adapter must be dependency-free and fast.** It runs on *every* tool call and blocks
  the agent loop. Use the Python 3 stdlib only; no heavy imports.
- **Never let the adapter fail loudly.** A crashing hook disrupts the user's Claude Code
  session. Wrap logic defensively; on error, exit 0 and stay silent.
- **Paths are relative to the project root** so Gource's directory tree stays clean.
- **`A` vs `M`** requires knowing prior existence — the daemon's `known_paths` set decides it.
- **Two capture sources, both required.** Hooks give *authorship* but only cover Claude's
  file tools and cannot resolve a glob or a compound command; the watcher gives
  *completeness* but no attribution. They are combined in `EventHub`: a filesystem change
  within `ATTRIBUTION_WINDOW_SECONDS` of a hook inherits that hook's agent, and a path a hook
  just reported is suppressed on the watcher side so one write flashes once. **The suppression
  runs both ways, and the second direction is the one that matters**: a change the watcher saw is
  *held* for `FS_SETTLE_SECONDS` rather than drawn on sight, so the hook that owns it has time to
  arrive and supersede it. `PostToolUse` fires *after* the tool wrote the file and the hook is a
  ~40-56 ms process spawn, so the watcher almost always wins the race -- forward suppression alone
  fires in the case that essentially never happens. Neither source replaces the other.
- **When the parser would have to guess, it stays silent.** `_parse_bash` returns `None` for
  globs and directory destinations rather than inventing a path: a wrong node stays on screen
  forever, a missing one is filled in by the watcher milliseconds later.
- **An event with `agent: ""` must never create an actor** — seeded files and unattributed
  changes are real, but nobody did them on camera.
- **A read is not a change.** `R` travels the same wire as `A`/`M`/`D` and must touch none of
  the state they touch. In the daemon it goes through `_broadcast_transient`, never
  `_publish`: not into `known_paths` (Read-then-Edit is the commonest thing an agent does, so
  a read that marks the path as seen turns the very next `Write` into a modification of a node
  no browser was ever shown), not into `_recent` (a reconnecting client would replay stale
  read flashes — a lie about "right now" — and twenty reads would push the real changes out of
  a finite ring), and not into `_hook_paths` (a read has no watcher echo to suppress, and
  stamping it would swallow the genuine write that follows). In the browser, `reading` is a
  channel of its own on `SimNode`, so a read never repaints the amber flash of a write half a
  second old. What a read *does* still do is refresh the active agent: it is evidence of who
  is at work, so the watcher's next change is credited to whoever was reading.
- **Reads are hook-only, by nature.** The watcher cannot see a file being opened — `atime` is
  unreliable under `relatime` and it does not subscribe to access events — so the "two capture
  sources" rule above has no second half here. With no hooks installed there is no read glow
  at all, only the silence that looks like a healthy setup with nobody reading.
- **A read path is held to a stricter rule than a write path.** `_read_path` refuses anything
  that does not stay under the observed root, `..` segments included, where `_make_relative`
  hands an out-of-root absolute path straight back. The asymmetry is deliberate: a stray write
  names a real change and the watcher corrects the picture moments later, while a read has no
  such correction — nothing happened on disk — and agents read `/etc`, `~/.claude`,
  `node_modules` and other checkouts all day. The check is lexical (`normpath`, then a
  boundary test) because `normalize_event` is pure and runs on the hot path; symlinks
  therefore still pass, and resolving them belongs to `resolve_inside` in the daemon.
- If you fork/embed Gource's C++ source later, note it is **GPLv3** — that affects distribution.

## Agents & TDD workflow

Custom agents live in `.claude/agents/`:

- **`developer-backend`** — implements Python (adapter, hook scripts, aggregator daemon, CLI).
- **`developer-frontend`** — implements TypeScript under `web/` (three.js renderer, the
  pure model/layout/view/label modules, WebSocket client, UI).
- **`developer-tester`** — writes tests only, **never** production code; drives development via TDD.
- **`security-auditor`** — audits the network surface, the path defences, the `git` runner and
  the hook; writes a report and a per-finding remediation plan. Writes **no** code, no tests,
  no fixes — its plan names the module to change and the RED test that must come first.
- **`software-architect`** — assesses structure for maintainability, performance and security:
  module boundaries, where a decision belongs, what a coupling will cost the next change.
  Writes **no** code, no tests, no fixes — it hands back an assessment plus a staged plan whose
  every step is one RED test and one GREEN implementation, with an owner per step. Use it
  before a feature that crosses layers, not for a change that fits inside one module.

This project follows **Test-Driven Development**. The intended loop:

1. **RED** — `developer-tester` writes the smallest failing test that specifies a behavior
   (pytest for backend, vitest for frontend) and confirms it fails for the right reason.
2. **GREEN** — a `developer-*` agent writes the minimal implementation to make it pass.
3. **REFACTOR** — with the suite green, refactor safely; tests must stay green.

Subagents don't call each other directly — the main session orchestrates the hand-off
(tester produces the failing tests → developer implements to green). Start a new feature by
asking the tester for the RED tests, not by asking a developer to implement blind. A security
finding enters the same loop rather than bypassing it: `security-auditor` reports, the tester
turns each fix plan into a failing test, and a developer takes it green. `software-architect`
enters it at the other end: it shapes the plan *before* the tester is asked for the first RED
test, and it is the agent to consult when the question is where code belongs rather than what
it should do.

## Plan files

Plans live under `docs/features/` as a `todo` → `doing` → `done` kanban:

- **`todo/`** — planned, not started.
- **`doing/`** — implementation under way.
- **`done/`** — implemented; kept as the historical record of the rationale and of the
  alternatives that were rejected.

**Whenever a plan is asked for, it MUST be written into `docs/features/todo/`**, with this
filename pattern:

```
{YYYY-MM-DD-HH-mm}-{plan_name}.md
```

Use the current local date and time, zero-padded, and a short kebab-case `plan_name` —
`2026-08-26-14-07-read-marker-pulse.md`. The timestamp is when the plan was *written*, and it
never changes as the file moves between folders; it is what keeps a directory listing
chronological and what tells two plans about the same subject apart.

Every plan opens with a status header, before anything else:

```markdown
# Plan: <title>

- **Status:** todo | doing | done
- **Created:** 2026-08-26 14:07
- **Implemented:** — (date, and the branch it landed on)
- **PR/commit:** —
- **Consultations (mandatory):** which specialist agents shaped it, and when
```

**The folder and the `Status` line are one fact written twice, and they must never disagree.**
Move the file as the work progresses and fill in `Implemented` and `PR/commit` on completion —
a plan sitting in `done/` still saying `doing` is a lie told by whichever half the reader
happens to trust.

The `Consultations` line is rule 2 of "Mandatory rules" leaving a trace: the plan is shaped by
the specialists, never by the orchestrator alone, so it names them — `software-architect` for a
change that crosses layers, `security-auditor` for one that touches the network surface, the
path defences, the `git` runner or the hook, and `developer-tester` before any implementation
agent is asked for a line of code. A plan's steps are therefore RED/GREEN pairs with an owner
per step, which is the shape `software-architect` already hands back.

**`done/` is a historical archive, not a description of the current system.** A plan states
intent *before* the implementation and may have diverged from what was built — a constant was
corrected, a finding was noted and deliberately not built. When reading any plan, and
especially one in `done/`, the code is the source of truth and the plan is the reasoning that
led to it. Only `todo/` and `doing/` are active.

Plans are documents a human reads, so rule 4 applies to them in full: English, like every other
authored file here.

## Status

Web MVP implemented and verified end-to-end (TDD).

- **Backend** (`rhizome_graph/`, `hooks/`, `daemon/`): 1879 pytest green with 20 skipped (1899
  with `RHIZOME_PACKAGE_TESTS=1`, which opts into the slow builds — one wheel, one real `.deb`).
  Hook is stdlib-only and exits 0 on garbage input. Daemon seeds the project tree at boot,
  ingests hook events on a Unix socket, watches the filesystem, and serves `web/dist` over
  HTTP **and** broadcasts events over WebSocket (`/ws`) on a single port (`:8080`) — one
  forwarded port is enough for remote/SSH use, and the browser derives the socket URL from
  its own origin.
- **It is an installed application now: `rhi <dir>`.** The five stages above are untouched;
  what changed is how the daemon is started and where its assets live. Six things carry it,
  and each is a rule rather than a detail:
  - **Configuration is passed, not read from the air.** `rhizome_graph/cli.py` is a pure
    `argv + environ + cwd → Settings` (frozen), and `run(settings, ready=None)` takes it.
    `main()` is the **only** place in `daemon/server.py` that touches `os.environ`, and
    `tests/test_daemon_environment_boundary.py` pins that with **no exemptions** — its
    definition of "reads the environment" is deliberately wide enough to catch
    `default_web_dist(os.environ)` passed as an *argument*. Before this, `rhi` would have had
    to talk to the daemon through `os.environ`, which is a protocol between two halves of one
    program. `start.sh` keeps exporting variables and keeps working; it is the from-source
    developer bootstrap, `rhi` is the installed launcher, and all 50 of its pinned assertions
    are untouched by this work.
  - **`web/dist` is found by a search order, not by `__file__`.** `assets.py` walks
    `$RHIZOME_WEB_DIST` → the packaged `rhizome_graph/web` → `/usr/lib/rhizome-graph/web` →
    the checkout's `web/dist`. `daemon/server.py` keeps no path constant derived from
    `__file__` at all. The old constant served nothing the moment it was installed anywhere
    but a checkout, and the failure was a blank page with an `INFO` line, not an error.
  - **A default may be adjusted; an explicit request may not.** `choose_port` walks off a busy
    `:8080` and prints the port it actually got, but `--port 9000` that is taken **refuses**
    (rc 1, one line, no traceback) — a user who typed 9000 and got 9001 has been lied to. The
    ingest socket follows the same rule, and so does the window: `--window` with no backend is
    a refusal, while the *default* degrades to headless.
  - **A second daemon no longer steals the first's ingest socket.** That unlink was
    unconditional; now a live socket raises `IngestSocketInUseError` and a stale one is cleared
    as before. `ingest_socket_path` derives a root-hashed path for a second instance and `rhi`
    **prints the `RHIZOME_SOCKET` its hook block needs** — attribution for a second instance is
    opt-in and explicit rather than silently broken. The *same* root started twice refuses
    rather than walking again, and that refusal is inherited from the guard, not re-implemented.
  - **One teardown, four triggers.** Everything real — signal handlers, cancelling the polls,
    `session.stop()`, unlinking the socket — lives inside `run()` and resolves a single `stop`
    future. SIGTERM, SIGINT, an embedded caller's cancellation and **the window closing** all
    converge there; none of them adds teardown to `cli.py`. Same discipline as `closeView` in
    `main.ts`. `run()` also no longer *requires* signal handlers, which is what lets it live on
    a worker thread while the GUI keeps the main one — pywebview refuses to start anywhere else.
  - **`rhi` diagnoses hooks, offers to install them, and never writes silently.**
    `.claude/settings.json` is a committed file in many repositories, so editing it as a side
    effect of "show me a graph" writes into a git working tree unasked, and merging JSON hook
    arrays silently is how someone loses a hook. `--doctor` reads **both** `~/.claude` and the
    project's file, because Claude Code merges them — a globally installed hook really does
    fire, and a doctor that ignored it would report a failure that does not exist. One line of
    its report carries a settings path and the command it found *together*, so it answers
    "which file?". **The failure mode it exists for is rot, not absence:** a stale absolute path
    fails *louder and worse* than a missing hook — it is a blocking error on every tool call,
    degrading the agent session rather than the graph, which is exactly what this repository's
    own three settings files did until they were fixed during this work.
- **The window is a strategy, and the choice is pure.** `window.choose_window_backend(platform,
  available, requested)` answers `webview` / `app_browser` / `none` with availability injected,
  so no test needs a display. The framing "pywebview vs Tauri vs Go-webview" is **wrong**: on
  Linux all three bind the *same* WebKitGTK, so changing the shell's language retires no
  rendering risk at all. Only a Chromium engine is a different answer, which is why app-mode
  browser is a first-class fallback rather than an improvisation. `PREFERENCE_BY_PLATFORM` is
  the one table a spike result may edit; nothing else changes. The strategy takes
  `(url, on_closed, close_requested)` and **nothing else** — no token, by parameter or by
  import, asserted over the module's AST the way "no shiki outside `highlight.ts`" is. It needs
  none: the daemon injects the token into the `index.html` it serves, so a webview issuing
  `GET /` from loopback inherits it exactly as a browser does, and a window that *accepted* one
  would be a second place a credential lives. `close_requested` is a `threading.Event` rather
  than a returned handle because a strategy blocks until its window is gone — it would only
  return after the thing you wanted a handle to was dead.
- **Packaging: a `.deb` built here and inspected, and a Homebrew formula that no one has run.**
  `packaging/build-deb.sh` produces the package and writes nothing into the checkout. The
  vendored venv holds **`websockets` and nothing else** (1.4 MB, `--system-site-packages`), so
  `python3-watchdog` and `python3-gi` come from the distribution and keep its security updates.
  `websockets` must be vendored and `watchdog` must not: `websockets/asyncio/` has **0 files in
  12.0 and 8 in 13.0** (measured by unpacking the wheels) while noble ships 10.4, whereas the
  whole suite is green on `watchdog==3.0.0` and the watcher imports only three names that 3.0
  has. `git` is **Recommends, not Depends** — `gitcmd.py` answers `None` without it and only the
  diff and status panels go quiet. **The two commands split along the doctrine's own line:**
  `/usr/bin/rhi-hook` is `#!/usr/bin/python3` and reaches the sources at
  `/usr/lib/rhizome-graph/` with one `sys.path` insert, so the hot path never pays a venv's
  import cost and keeps working if the venv is rebuilt or deleted; `/usr/bin/rhi` names the
  vendored interpreter, because the daemon imports `websockets.asyncio.server`. The Python
  sources are installed as plain files *outside* the venv precisely so that split is possible.
  **They ship byte-compiled, in `unchecked-hash` mode, and both halves of that matter.**
  `/usr/lib` is unwritable to the user whose agent fires the hook, so without a shipped `.pyc`
  the interpreter recompiles on *every tool call* and can never cache the result: measured at
  41.1 ms against 37.2 ms per call, which is 17% of our own import cost above a 18.4 ms bare
  interpreter start. And the default timestamp mode would have been worse than useless here —
  `dpkg` stamps mtimes from the archive while source and bytecode are stamped by different
  build steps, so the `.pyc` is silently discarded and the cache rewrite into root-owned
  `/usr/lib` silently fails, leaving a package that recompiles every time *while still
  containing bytecode*. Checked-hash re-hashes the whole source on every import to detect edits
  to a dpkg-managed file, which is `dpkg -V`'s job and not the agent loop's. The `compileall`
  sits after the build script strips `*.py[co]` and before `du` computes `Installed-Size`;
  at that moment the staging tree holds only the two source trees, so the venv is never
  compiled — deliberately, since the daemon starts once per session and the hook does not.
  The formula's `sha256` is deliberately all zeros with a comment: there is no release, so no
  true digest exists, and a plausible-looking wrong one reads as done and never gets revisited.
- **The front end is copied into the distribution by `setup.py`, and it must never be a declared
  package directory.** `package-dir = {"rhizome_graph.web" = "web/dist"}` reads as the obvious
  static answer and is a trap: `package-dir` demands the directory exist at *metadata* time, and
  `web/dist` is gitignored — so **no clean checkout could be installed at all**. `pip install -e
  '.[daemon]'`, the command this file documents, died on `package directory 'web/dist' does not
  exist`, and `start.sh` could never bootstrap past its own first step, because it pip-installs
  before it runs `npm run build`. It shipped that way in `8a166bd` and was found by someone
  running `./start.sh`. The fix is the one dynamic step in the build: a `build_py` subclass that
  appends `web/dist`'s files as package data, where an absent directory is an empty list rather
  than an error, plus `graft web/dist` in `MANIFEST.in` (a graft matching nothing is a warning).
  `tests/test_distribution_metadata.py` is the jaw that keeps an *unbuilt* tree installable and
  `tests/test_distribution_front_end.py` is the jaw that keeps a *built* one complete; neither
  alone is enough, and the first one exists because the second one passing is what made the
  regression invisible.
- **A hollow directory is worse than a missing one, and `RHIZOME_WEB_DIST` is obeyed or refused,
  never overruled.** `find_web_dist` still means "the first candidate that is a directory"; the
  "must hold an `index.html`" rule arrives as an **injected predicate, inside the search rather
  than after it** — a post-filter would answer `None` for `[hollow /usr/lib/rhizome-graph/web,
  good web/dist]` and never try the second. And an explicit `RHIZOME_WEB_DIST` that is hollow or
  absent now answers `None` rather than falling through to the checkout's build: the same rule
  the port and the socket follow, **a default may be adjusted, an explicit request may not.**
  Silently serving a stale checkout build instead of the path a packager typed answers a question
  nobody asked. Note `start.sh` and `packaging/build-deb.sh` still test `is_dir` alone, so a
  hollow `web/dist` would make the launcher skip the build and serve nothing — latent today
  because nothing creates one, and worth a RED test before anything ever does.
- **The observed root is no longer a boot constant.** `ctrl+L` in the page opens a bar that
  swaps it: the WebSocket, once broadcast-only, now also accepts `{"kind":"complete"}` (the
  browser cannot read the disk, so the daemon answers tab-completion) and
  `{"kind":"setRoot"}`. (`COMMAND_KINDS` is five now — `file`, `search` and `sizes` are the
  others — and each kind names its OWN required field: a `search` carries a `query` and parses
  with `path: ""`, which is the echo field both gates put into their refusal, so their code is
  literally unchanged; a `sizes` names nothing at all, and parses with the same empty path. Every
  key beyond `kind`/`path`/`token` is **conditional**, present only when the frame carried it in a
  form this daemon understands, which is what keeps five pinned exact-equality assertions
  byte-identical.) `Session.switch_root` stops the watcher, calls `EventHub.reset` —
  which clears `known_paths`, the seed and the replay, and broadcasts a `reset` frame the
  clients wipe their graph on — re-seeds, and restarts the watcher on the new root. Two
  details are load-bearing: `reset` sits FIRST in `replay_messages()`, so a client connecting
  mid-switch clears before it is handed the new tree; and `scan_tree` runs through
  `asyncio.to_thread`, because a root like `~` would otherwise block the event loop for
  seconds and freeze every viewer. The branch poll reads the session's current root each turn
  — capturing it would caption the new project with the old project's branch forever.
- **Clicking a file opens what is inside it.** A click (not a drag: under 4 px and 400 ms, and
  never the second half of a double-click, which belongs to auto-fit) picks the nearest file
  node within ~14 device px and asks the daemon for `{"kind":"file"}`. The answer is, in this
  order, the `git diff HEAD --` of that path, else its text, else an `xxd` dump — and `xxd`
  means the real format: the tests compare against the installed binary rather than trusting
  a hand-written spec. The order has exactly one opt-out, `prefer: "text"` on the same command,
  and only the content search asks for it — see its bullet below for why a diff is the wrong
  answer to "show me the line that matched". Two defences apply because the path arrives from the network:
  `resolve_inside` refuses anything resolving outside the observed root (symlinks included),
  and the content is capped at 256 KiB, flagged `truncated`, because it crosses the WebSocket
  whole. **Caveat, unfixed:** that cap is on the text/hex path only — `mode: "diff"` returns
  `git diff` output with no cap at all, so a regenerated dump crosses whole. `MAX_ROWS` bounds
  what the browser draws; the frame itself is still unbounded. **The panel closes with Escape
  or with the close button** in its header — a modal over the whole graph with no visible way
  out reads as a page that has hung, and the header carries the button alone: the `esc` caption
  that used to sit beside it was a second thing to read in a row already full of path, mode,
  language and truncation, and the `×` is the affordance nobody has to read. Which click closes is
  decided in the pure `fileViewClicks.ts`, the way Escape is decided in `fileViewKeys.ts`: both
  answer nothing while the panel is closed (a live close handler would swallow clicks meant for
  the file dots underneath), and the backdrop is deliberately **not** a dismiss target, because
  a stray click outside would throw away a long read the panel cannot restore. `fileViewHud.ts`
  binds one delegated listener on the container and stays a painter; both paths run through the
  same `closeView` in `main.ts`, never two.
- **The panel colours what it shows, with VS Code's own palette.** Not an imitation: `shiki`
  carries the real TextMate grammars and the Dark+ theme, so `#569CD6` on a keyword is the
  colour VS Code would paint. Five things are load-bearing:
  - **The whole engine is lazy.** `highlight.ts` is reached by `await import("./highlight")` on
    the first file opened, so the entry chunk is unchanged (measured: +5 KB, and `grep -c
    shikijs dist/assets/index-*.js` is 0). Each grammar is its own chunk.
  - **The 22 language imports must be written as literal arrows.** `` import(`@shikijs/langs/${id}`) ``
    does not work — Vite's dynamic-import-vars plugin cannot glob a bare specifier into
    `node_modules`, and it either fails the build or drags all 346 grammars (~15 MB) into
    `dist`. Typing the table as `Record<LanguageId, Loader>` makes tsc prove it stays in step
    with `language.ts`.
  - **The engine is oniguruma (WASM), and that was measured, not assumed.** The JavaScript
    RegExp engine is ~10× smaller and its docs claim full coverage, but on these 22 grammars it
    diverges on two, and is wrong on both: in C++ a trailing `// c` never becomes a comment, and
    in HTML the embedded `<script>`/`<style>` handling collapses. `forgiving: true` swallows the
    pattern silently. Re-measure before switching.
  - **A diff is tokenized one fragment per hunk per side**, never as two concatenated documents:
    hunks are not contiguous, so joining them invents adjacency, and one unterminated string in
    an early hunk would poison every later one. A context line is present in the *old* fragment
    so the grammar sees coherent code, but its row index there is `-1` — it is painted from the
    *new* side. `code.split("\n").length === rows.length` is the invariant that holds it
    together. The residual cost is inherent to diffs: a hunk that opens inside a block comment
    tokenizes its first lines out of context, exactly as it does on GitHub.
  - **No shiki outside `highlight.ts`, not even `import type`.** That is what keeps the suite
    mock-free, jsdom-free and fast; `CodeToken` is ours, and `highlight.ts` renames shiki's
    `.content` to `.text` and resolves the optional colour on the way through.
  Budget: 4 000 lines / 128 KiB to colour, 20 000 rows before the panel falls back to today's
  single text node. Over budget the diff keeps its rows, stripes and gutter and loses only the
  colour, and the header says so. Unknown extension → plain, deliberately: no generic lexer.
- **The diff reads like the CLI now.** Old/new line-number gutter, a full-width stripe on the
  row (`rgba(63,185,80,.16)` / `rgba(248,81,73,.16)` — translucent so the tokens stay legible on
  top), and the syntax coloured over it. Three details: the stripe covers sign + code but *not*
  the gutter, because banded line numbers are harder to scan; `user-select: none` on the gutter,
  or copying a snippet takes the numbers with it; and `--- a/x` / `+++ b/x` are `meta`,
  classified before the `+`/`-` rules — the old `diffLineClass` coloured them as del/add, which
  with a gutter would have handed them line numbers.
- **Two callers fork `git`, through one runner.** `rhizome_graph/gitcmd.py` owns the fork itself
  and `diff.py`/`status.py` own the argv and the parsing. The "files, never `subprocess`" rule
  in `repo.py` is about the branch poll, and it still holds there: the branch is a dozen bytes
  in `.git/HEAD`. Neither of these has a small file to read — a diff means the index, zlib
  objects and a diff algorithm, and the working-tree status means the same plus the untracked
  walk — so reimplementing them to honour a rule written about one line of one file would be
  the wrong trade. Nothing here raises: no repo, no `git`, a non-zero exit or a timeout all
  mean `None`, which each caller reads as its own "nothing to show". On timeout the child is
  killed *and* its transport closed before waiting — a wrapper script leaves a grandchild
  holding the inherited pipe, and `wait()` alone hangs until it dies.
- **The bottom-right panel lists what is uncommitted,** and only then: over a clean tree, or
  outside a repository, it is not on screen at all (`visible` derives from the entry count,
  never from the `repo` flag — a permanent empty strip would report nothing). A row is a
  `modified` / `added` / `deleted` / `untracked` path, and clicking it opens the same viewer a
  click in the graph opens, through the same `openFile` in `main.ts`. Five things are
  load-bearing:
  - **It is a poll, in a task of its own** (`STATUS_POLL_INTERVAL_SECONDS`, 3 s, or
    `RHIZOME_STATUS_INTERVAL`; ≤ 0 disables it and creates no task). It cannot ride the
    branch poll: that one is fork-free by doctrine. It cannot be event-driven either — a
    `git add` or a `git commit` typed in a terminal touches only `.git/`, which the watcher
    drops through `tree.is_ignored`, so the list would never notice the commit that emptied it.
    A round is skipped while one is still in flight, and outside a repository nothing forks at
    all (`find_checkout_root` answers first, and where it comes back empty `find_checkouts`
    gates the forks in its place).
  - **The frame is deduped** in a replaceable slot like `_meta`, so a status that has not
    changed costs nothing on the wire, and it sits in `replay_messages()` before the seed —
    the panel is right on the first paint, not three seconds later.
  - **An answer about an abandoned root is dropped, not published.** `publish_status` reads
    `self.root` at call time, but the fork *outlives* the read: a `ctrl+L` landing inside that
    window used to have its fresh frame overwritten by the answer about the project the user
    just left. Those rows are not merely stale, they are clickable — `resolve_inside` refuses
    them, so the click errors on a file the panel is offering. The root is compared again once
    the await returns, and the early return sits *after* the `finally` that clears
    `_status_busy`, or the next round is skipped for nothing. The window was one fork; with 16
    repositories it would have been 20 s.
  - **`git status` reports paths relative to the REPOSITORY root** even when run from a
    subdirectory (measured, not assumed), while everything else here — the graph, the click,
    `resolve_inside` — speaks in paths relative to the OBSERVED root, which `ctrl+L` may have
    pointed at a subdirectory. `relativize` converts them and drops what falls outside.
  - **A deleted file had to become clickable**, so `file_view` now tries the diff *before*
    concluding "no such file": the row the user most wants to open is the one whose content is
    gone. The directory check stays ahead of the diff.
- **The panel answers for a whole workspace, not one checkout.** Pointed at `~/projects`, which
  is not itself a repository, the panel used to be absent entirely — and absence here reads as
  *a clean tree*, not as *nobody looked*. Now `find_checkout_root` is asked first and **its
  answer wins outright**: a root that is, or sits inside, a checkout behaves byte-for-byte as it
  always did, and nothing below it is even walked, which is what makes backwards compatibility
  a shape rather than a list of regression tests (a repository holding vendored checkouts keeps
  its single panel). Only when that walk comes back empty does `checkouts.find_checkouts` look
  *downward*. Six things carry it:
  - **The downward question is a module of its own,** `rhizome_graph/checkouts.py`, and it
    **starts no process** — a contract asserted over its parsed source, like "no shiki outside
    `highlight.ts`". Not in `status.py` (nothing about it is the porcelain format, and the click
    router wants the same answer without the parser) and not in `repo.py` (whose whole docstring
    is the upward walk). Discovery is 50–100× cheaper than the forks it decides on — 0.2–0.4 ms
    against ~20 ms, measured — and that is the *reason* it needs no cache: a `git clone` into
    the workspace appears within one poll with no invalidation logic to get wrong. Route a `git`
    call through this module and the trade quietly inverts.
  - **Discovery stops at what it finds,** and is bounded four ways: `MAX_DEPTH = 3` (counted in
    segments of the prefix, so `github.com/org/repo` is found and `a/b/c/d` is not),
    `MAX_CHECKOUTS = 16`, `MAX_SCANNED_DIRS = 4000`, `MAX_CONCURRENT_STATUS = 4` — together a
    20 s worst case per round. What has to be bounded is the worst case, not the measured one:
    a home directory with a network mount in it, polled every three seconds. A checkout found is
    never descended into (`git status` already reports a nested one as a single entry) and the
    walk goes through `asyncio.to_thread`, for the same reason `scan_tree` does.
  - **The merge is a round-robin interleave, and that is what keeps the existing cut fair.**
    `status_frame` takes the first 200; over a list ordered repo-by-repo, one repository with
    300 untracked files fills the whole cut and hides every other — the exact failure this
    feature exists to prevent, moved one level up. A per-repo quota would have to be `200 // N`,
    a constant that depends on N. Round-robin needs no new constant and no signature change.
  - **The per-repo cap is `DEFAULT_MAX_ENTRIES + 1`, and the `+ 1` is the whole point.** The cap
    is only a memory bound (16 × 5000 entries parsed every 3 s to keep 200 is garbage), but at
    exactly 200 it computes `len(entries) > len(shown)` as `200 > 200` → `truncated: False`: the
    panel claims completeness over a list it cut, while the *same* repository observed directly
    says `True`. One entry more than the frame can show keeps the signal exact in both
    directions, and 16 × 201 is the same nothing as 16 × 200. The plan this came from had it
    at 200; the correction is written into
    `docs/features/done/2026-08-17-16-21-multi-repo-git-status.md`.
  - **The semaphore is built inside the call, never at module level.** A module-level
    `asyncio.Semaphore` binds to the first loop that waits on it and raises on every loop after
    — swallowed by `git_status`'s blanket `except` into a silent `None`. It passes every
    single-loop test and fails the second time a daemon's loop exists. Measured, not feared.
  - **One checkout whose `git` fails is one checkout with nothing to say**, not the round's
    answer; only every one of them failing is `None`.
- **The click knows which checkout owns the file, and derives it strictly after the chokepoint.**
  `git_diff` used to run with `cwd` = the observed root, so in a workspace container `git` exits
  128 and the diff route was dead for every file in every sub-repo: existing files fell through
  to text — losing the whole point of the panel — and a **deleted** file answered `no such
  file`, undoing the very ordering `file_view` documents. Now `owning_checkout(root, target)`
  names the working directory. **The ordering is the security property, not a style choice:**
  `resolve_inside` stays the single containment check and stays first, and the checkout is
  derived from the path *it resolved*, never from the string that arrived over the socket.
  Deriving a `cwd` from the raw string is cheap, needs no `realpath`, and is precisely how a
  chokepoint becomes bypassable — `a/../../secret.txt` is the shape that catches a router which
  splits on `/`. `relpath(target, checkout)` cannot escape by construction, since `checkout` was
  found by walking up *from* `target`. One asymmetry is deliberate and stated rather than
  hidden: `target` is a realpath, so the sub-repo branch diffs a symlink's destination, while
  the compat branch keeps the raw string and diffs the link as it always has — unavoidable in
  the first, avoidable in the second, so avoided there.
- **A control command must pass two gates: the peer's address AND a token.** The first is the
  older one — loopback-only, `RHIZOME_ALLOW_REMOTE_CONTROL=1` opens it up — and it is not
  enough on its own, because the peer's address lies in two measured ways. A WebSocket
  handshake is exempt from the same-origin policy and needs no preflight, so any page in any
  browser on the host can open `ws://127.0.0.1:8080/ws` and send `setRoot` + `file`; and any
  loopback-side proxy launders a remote connection into a local one, which `vite.config.ts`
  does by default (`host: true` plus a `/ws` proxy), so `./start.sh --dev` handed the whole
  LAN a gate that says `127.0.0.1`. Both were reproduced against a live daemon: arbitrary
  file read as the daemon's user, no credential anywhere in the protocol.
  So the daemon mints a token at boot (`rhizome_graph/token.py`), **injects it into the
  `index.html` it serves**, and refuses any command frame that does not carry it back. A
  cross-site page cannot read it — same-origin is what stops it fetching the page — and a
  proxy carries none. It was chosen over an `Origin` allow-list for one reason: an allow-list
  has to know the port, and `ssh -L 9000:localhost:8080` or a VS Code forward means the
  browser's origin is a port the daemon never hears about. A token is indifferent to how you
  reached the page. Five things are load-bearing:
  - **Two conditions, never one.** `token_matches` is checked *after* `control_allowed`, and
    neither replaces the other: the tests pin that a right token does not let a remote peer
    through, and that a wrong token is refused even with remote control opened up.
  - **The empty token is always refused.** `token_matches` returns `False` for an empty
    `expected` before it reaches `hmac.compare_digest` — a daemon that failed to mint one must
    not silently start accepting tokenless commands. Everything fails closed.
  - **`parse_command` always returns `kind`, `path` and `token`**, with `token: ""` when the
    frame named none (as it does for a `null`, a number or an object). Absence and emptiness
    must stay distinguishable, since the whole gate turns on the difference between the empty
    token and one that matches — so do not "tidy away" the empty key from an assertion.
  - **`inject_token` escapes for the script element, not just for JSON.** `json.dumps` then
    `<`, `>` and `&` folded to `\uXXXX`, so a token spelled as a closing script tag round-trips
    intact and leaves exactly one closing-script sequence in the page. An injection bug here
    would turn a security fix into an XSS.
  - **The browser stamps the token in `WsClient.send`**, the single chokepoint, so no call site
    can forget it; `main.ts` is unchanged. With no token available the frame carries **no
    `token` key at all**, not an empty one.
  `--dev` is the one case where the daemon never touches the HTML (Vite serves it and proxies
  `/ws`), so `start.sh` mints one token there and exports it twice: `RHIZOME_TOKEN` for the
  daemon and `VITE_RHIZOME_TOKEN` for Vite, which is the only prefix reaching
  `import.meta.env`. The prod branch exports **neither** — a `VITE_`-prefixed variable alive
  during `npm run build` is substituted into `dist/`, shipping a stale token inside the bundle.
  An existing `RHIZOME_TOKEN` is honoured verbatim, which is how a probe reaches the same
  daemon; `./start.sh --print-token` prints it and starts nothing. A mint that fails is
  tolerated rather than fatal (the `python` stub in the older `start.sh` tests answers every
  call with silence, and prod does not need the variable at all) — it warns on stderr in
  `--dev`, where the cost is that every command is refused.
- **A `.gitignore` decides what is drawn.** The graph could never show a project's committed
  `.claude/` or `.github/`: `tree.py` pruned every dotted name unconditionally, and the one file
  that actually says what is not worth drawing was never opened at all. `rhizome_graph/gitignore.py`
  now compiles git's pattern syntax in pure Python — it forks nothing, because `git check-ignore`
  costs a process on a walk that asks the question 20 000 times and again on the watcher's
  per-event path, says nothing about a root that is not a repository or about a workspace of
  checkouts, and `git` is Recommends rather than Depends in the `.deb`. Nine things are
  load-bearing:
  - **A `.gitignore` at or above a directory governs it; where none does, every dotted directory
    is pruned.** The fallback is not a legacy leftover kept out of caution — dropping it takes
    `$HOME` from 12 500 files to 20 000, which *is* `DEFAULT_MAX_FILES`: the seed silently
    truncated and the graph no longer the tree. 13 044 of the files gained are `.vscode-server`,
    `.cache`, `.local`, `.config` and `.npm`, which no `.gitignore` will ever name.
  - **The presence of the file is the switch, not the rules it contributed.** An empty
    `.gitignore` is the documented way to say "draw everything here", and deriving `governs` from
    "did this file produce rules" would close that hatch without a word. And `governs` is asked
    **per directory, never once per tree**: a workspace root answers `False` while each checkout
    under it answers `True`, in one walk.
  - **`.git` and generated output are hidden by name, whatever any pattern says.** Measured:
    `git check-ignore .git/config` reports *not ignored* even with `!.git` in force, because git
    never submits `.git` to the ignore machinery at all — so ours is a deliberate divergence, not
    an imitation of git. Both rules live in the **caller**: `gitignore.py` answers git's question
    and no rhizome policy, which is exactly what lets it be tested against real git rather than
    against our taste.
  - **Two entry points, one rule, and `tests/test_ignore_agreement.py` is the only thing binding
    them.** `ignored_child` is the walk's — leaf only, because pruning `dirnames` in place *is*
    git's rule that nothing under an excluded directory can be re-included. `ignored` is the
    watcher's — the whole ancestor chain, paid for because one inotify path has no walk behind it.
    They give **different answers on purpose**: with `out/` followed by `!out/keep.txt` the chain
    stops at `out/` and the flat leaf test reaches the negation, so collapsing the two into one
    call is the simplification to refuse. The binding property is therefore **one-way** — every
    path the walk kept is not `ignored`, never the converse — because a pruned path falls into
    three categories and only one of them is this module's: pruned by a *pattern* is `True`,
    pruned *structurally* (`.git`, `node_modules`) is `False`, and pruned by the *dotted fallback*
    is `False`. Two out of three is the story a reader invents alone.
  - **In the watcher, `_refused_by_name` runs before `rules.ignored`,** and reading that line as
    "`tree.is_ignored` first" ships the very bug this feature exists to fix: that predicate carries
    the dotted fallback unconditionally, so a governed `.claude/agents/a.md` would be seeded at
    boot, flash once, and never update again.
  - **The refusals, each with its price.** No `.git/info/exclude` and no `core.excludesFile`, so a
    user who keeps local-only or global ignores sees those files on the graph. No ignore file
    *above* the observed root, so pointing the daemon at a subdirectory of a checkout leaves that
    subtree governed by nothing and the fallback applies — which is today's behaviour, so nothing
    regresses. No POSIX bracket classes: `re` reads one as an ordinary class of the letters inside
    it and matches the wrong thing *silently*, which is worse than not matching, so a pattern
    containing one is refused whole and its files are shown. Byte-exact case, so on a
    case-insensitive filesystem a lower-case pattern misses a capitalised directory. The direction
    of every failure is the same: a refused rule, an unreadable ignore file or a cap reached shows
    **more**, never less, because showing more is what this feature is for.
  - **Two `.gitignore` traps, both measured and neither obvious.** Reading a `.gitignore` is itself
    watched — the daemon's own load emits `opened` and `closed_no_write` carrying that basename, so
    invalidating on *any* event with that name throws away precisely the memoization those reads
    exist to fill. And an atomic save moves `.gitignore.tmp` onto `.gitignore`, so only the move's
    **destination** carries the name.
  - **The cost is known, named, and two of the four figures miss the plan's own ceiling.**
    `scan_tree` goes 3.2 ms → 6.8 ms on this checkout (ceiling ~6.5 ms), 13.5 ms → 52.9 ms on
    `~/projects` (ceiling 40.3 ms) and 294.7 ms → 591.5 ms on `$HOME` (ceiling 461 ms); the
    watcher's per-event path goes 2.90 µs → 30.29 µs (ceiling 12.43 µs). The excess is in one place
    in each case and it is **not the caching failing**: `ignored` re-walks `ignored_child` once per
    ancestor, which is quadratic in depth, and `ignored_child` re-splits the directory into
    segments once per *entry* rather than once per directory. What it buys stays bounded — `$HOME`
    still lands at 12 517 files, well under `DEFAULT_MAX_FILES`, so the seed does not truncate — and
    the cost is paid off the event loop: all four `scan_tree` callers already run on a thread, and
    the hook's hot path imports nothing from `tree` or `gitignore`.
  - **Two prices are known and deliberately unpaid,** each noted with its trigger in
    `docs/features/done/2026-08-26-18-43-gitignore-visibility.md`. A deliberately committed
    `dist/` stays invisible, because the structural set overrules an explicit `.gitignore` (the
    alternative is a second interaction between two rule systems, and the unbounded case is a
    repository whose `.gitignore` omits `node_modules`). And a repository with no `.gitignore`
    at all keeps its `.claude/` hidden, since the presence of the file is the switch — the
    answer to give first is the empty file, not a trigger on `.git`, which on this repository
    alone would draw 1 114 files of vendored Python.
- **Frontend** (`web/`): 1856/1856 vitest green, `tsc` + `vite build` clean. `shiki` (pinned to
  3.23.0 — 4.x needs Node ≥ 20 and this machine has 18) is the first runtime dependency added
  since `d3-force`; note that `npm install` under npm 10 strips the `libc` fields from
  `package-lock.json`, so check `git diff` on the lock after touching dependencies. Gource-style WebGL
  renderer (three.js force layout + `UnrealBloomPass` + per-agent figure and beams), pure
  `simulation.ts` model, typed `parseEvent`, auto-reconnecting `wsClient.ts`. Label placement
  lives in pure `labels.ts` (like `view.ts`) because `renderer.ts` needs a GL context and
  cannot be unit-tested: sizes are constant in **pixels** (the camera spans halfHeight
  2..4000, so a world-sized label is either sub-pixel or screen-filling), and file names go
  only to touched files plus — past a zoom threshold — the idle ones still on screen, capped
  at a 48-sprite pool whose slots stay bound to a path so a new event does not repaint every
  canvas. `updateLabels` runs **every frame**: positioning labels only on topology change
  left them stranded while the force layout kept moving the nodes.
- **Pointing at a dot names it.** With the tree framed whole every rule above conspires to
  keep the node under the pointer anonymous — it is cold (that is *why* the user is asking)
  and the camera is past the zoom threshold — so the only way to ask "what is that one?" was
  to click it and open a viewer over the graph. `hoverTarget` (pick.ts) is a thin guard
  around `pickFile`: it answers `null` while the pointer is off the canvas or a drag is in
  progress (a pan moves the tree *under* the pointer instead of inspecting it), and otherwise
  returns the click's own answer — same `PICK_RADIUS_PIXELS`, because what you see named must
  be what a click would open. `selectFileLabels` and `fileLabelOpacity` take the hovered path
  and exempt it from the cold-plus-far cut, ahead of the search matches (a hover is the
  question being asked right now; a query is a standing one) but still inside the cull and the
  48-slot cap. The renderer records the position on every `pointermove` and resolves the hover
  **every frame**, from the label candidate list it has just refilled: the force layout never
  settles, so a node slides under a pointer that has not moved, and the camera changes what is
  under it too. Only `pointerType === "mouse"` counts — a touchscreen has no hover, and a
  finger would leave a name stuck where it last landed. The cursor follows (`pointer` over a
  file, `grab` otherwise, `grabbing` untouched during a drag).
- **A file an agent is reading wears a violet ring.** The fourth event type, `R`, exists
  because the graph used to stay dark through the half of an agent's work that explains the
  other half: it read six files, then wrote one, and only the write was on camera. A write is
  a *flash that decays*; a read is a *ring that pulses* — a different shape, not a different
  shade, so the two never blur together through the bloom. Five things carry it:
  - **`reading` is a channel of its own** on `SimNode`, decayed at `READING_DECAY_PER_SEC`
    (0.5/s against the highlight's 0.9/s — reads arrive in bursts and need to stay legible).
    `applyEvent` routes `R` to `readFile` *before* `touchFile` is ever reached, so a read
    raises `reading` and `opacity` and never touches `highlight` or `color`.
  - **A file first seen by a read enters cold** — no highlight, the neutral colour
    directories get. A read must never masquerade as a write.
  - **The ring is sized in pixels** via `labelMetrics.worldPerPixel`, like every label: the
    camera spans halfHeight 2..4000, so a world-sized ring is either sub-pixel or
    screen-filling. It lives in the main scene, not `overlayScene` — unlike text, a glow
    through the bloom is exactly what is wanted — with 24 pooled sprites whose slots stay
    bound to a path, and `updateReadMarkers` runs after `updateLabels` because it needs that
    frame's metrics.
  - **The read beam is short** (0.6 s against the write beam's 1.2). `MAX_BEAMS` is a fixed
    512 and reads come in bursts, so a long-lived read beam would crowd the write beams out
    of the buffer.
  - **Reads stay out of the recent-changes list.** That panel is a list of *changes*, and an
    agent reads roughly ten times more than it writes, so reads would push every real edit off
    the top within seconds. The drop sits before the fold, so a read cannot inflate the top
    entry's count either. The label candidates carry `max(highlight, reading)`, which is what
    names a file while it is being read with `labels.ts` unchanged.
- **Search (`ctrl+F`)** follows the same split: every decision is pure and tested —
  `search.ts` (substring match on the file name, or on the whole path once the query
  contains `/`; the walk `F3` takes over the matches; and `frameMatches`, which returns the
  camera target: one match is approached at `SEARCH_FOCUS_HALF_HEIGHT`, several are framed
  together with a margin) and `searchKeys.ts` (what a keystroke means). The renderer only
  paints: cyan nodes, a ring on the active one, and `focusOn` — the one camera transform
  that ignores `manual`, because a search is a direct order. Two things are load-bearing:
  the camera target is recomputed **every frame** from live positions (the force layout
  never stops moving, so a frame chosen once slides its matches off screen), and a live
  tree needs `refreshMatches`, not `setQuery`, to fold new events into an open search —
  `setQuery` restarts the walk by contract, which would throw an `F3` walk back to the
  overview every time a file was written. Touching the wheel disarms the camera without
  dropping the highlights; the next query or `F3` rearms it. `interpretSearchKey` answers
  **`null` for a shifted `ctrl+F`** and `SearchKeyEvent.shiftKey` is **optional**: the chord
  belongs to the content search below, and a required field would have turned a one-line semantic
  change into a compile error across a pinned test file.
- **Enter opens the file the walk is resting on.** The walk put the camera on a file and
  stopped there, so seeing what was *inside* the file just found meant abandoning the
  keyboard to aim at a dot in a force layout that never stops moving. `Enter` now goes
  through the same `openFile` in `main.ts` that a click in the graph and a row in the git
  status panel go through — one way into the panel, not three. Four things carry it:
  **`frame === "active"` is the operational meaning of "focused"**, since `nextMatch` is the
  only transition that sets it, so a freshly typed query (`frame: "all"`) focuses nothing and
  `Enter` keeps its old meaning there — the key never goes dead. **Walking must never become
  opening:** `F3` answers `"next"` whatever is focused, or stepping through a query would
  throw a modal over the graph on every single step. **`focusedFilePath` refuses a path that
  is no longer in the tree, or is a directory** — the graph is live, so a file can leave
  between the walk and the keystroke, and the click path only ever opens files. And the
  command is named `openFile` because `open` was already taken by the search box itself. The
  box stays open behind the panel and only the *focus* moves (`SearchHud.blur`, not `close`):
  the highlights are still wanted, and `F3` keeps stepping because the listener is on
  `window`, not on the field.
- **Content search (`ctrl+shift+F`) reads what is inside the files.** `ctrl+F` answers "where is
  `renderer.ts`?"; this one answers "who calls `resolve_inside`?", which the page could not ask at
  all, because the browser cannot read the disk. The bar is submitted with `Enter`, the daemon
  greps, the matching nodes light up through the very same renderer channel `ctrl+F` uses, and
  `F3` walks **occurrence by occurrence, across files** — each step that crosses into another file
  moves the camera to its node and opens that file in the panel **docked to the right**, matches
  tinted, the active one stronger, scrolled to its row. The staged plan it was built from is
  `docs/features/done/2026-08-23-02-51-content-search.md`. Eleven things are load-bearing:
  - **The fold is ASCII-only, and that is a correctness rule, not a shortcut.** `str.lower()` on
    the Latin capital I with a dot above (U+0130) yields **two** characters, in Python and in
    JavaScript alike, so a Unicode fold changes the length of the text and invalidates every
    offset computed against it. Folding only `A-Z` also makes the byte-level pass and the
    character-level pass **the same rule** rather than a heuristic plus a check, since an ASCII
    byte never occurs inside a UTF-8 continuation. Stated price: a word spelled with an accented
    capital does not match the same word spelled with an accented lowercase.
  - **Two implementations of that rule, one fixture table.** `content_search.py` and
    `matchRanges.ts` share no code — there is no code path between the two languages — so they
    share a table of `(text, query, ranges)` triples asserted in both suites in the same order,
    every character inside the BMP on purpose (outside it, UTF-16 indices and code-point indices
    would disagree about the same match). Same precedent as pinning `xxd` against the installed
    binary rather than against a written spec.
  - **The grep forks nothing and imports no `re`**, both asserted over the parsed source the way
    `checkouts.py`'s "starts no process" is. `git grep` was the obvious answer and is wrong three
    times over: it misses untracked files, it has nothing to say about a root that is not a
    repository, and it cannot answer for a workspace of checkouts. The `re` half is what makes
    "no regex from the network" structural rather than a promise in a docstring.
  - **`MAX_FILE_BYTES` IS `file_view.DEFAULT_MAX_BYTES`, imported, never a second literal of the
    same value.** The panel shows the first 256 KiB and the search counts over the first 256 KiB,
    so the browser's own recount of the panel's text equals the daemon's count. Two constants that
    happen to be equal is the bug waiting to happen. The cap that actually binds is the new
    `MAX_TOTAL_BYTES` (64 MiB) — 20 000 files at 256 KiB is 5 GiB — with `MAX_MATCH_FILES` 500 and
    `MAX_TOTAL_MATCHES` 5000 beside it. About 3 s worst case, all of it inside `asyncio.to_thread`,
    for the same reason `scan_tree` runs there.
  - **Two passes, because the numbers say so.** Byte matching runs at 514 MB/s and decoding at
    98 MB/s on this host, so the byte pass runs over everything and the decoded pass only over the
    files that hit. The decoded pass is the **authority**: on malformed UTF-8 the two can disagree,
    and the decoded one is the text the panel will actually receive.
  - **`safe_read.py` exists because `scan_tree` filters symlinks but not FIFOs** — `os.path.islink`
    is false for a named pipe. A search opening thousands of files with a bare `open()` parks a
    worker thread on a writerless pipe permanently: the executor is shared with `scan_tree` and
    `file_view`, workers cannot be cancelled, and shutdown joins them, so the daemon eventually
    cannot even exit. The defence already existed inside `file_view`; it was private, and a
    chokepoint reachable from one caller and duplicated for the other is not a chokepoint.
  - **`Enter` submits; the search is not live per keystroke.** The name search recomputes from an
    in-memory node list, this one reads the disk, and a round trip per keystroke means a debounce,
    a supersede rule and an in-flight cancellation — three mechanisms to get right, to save one key
    press. **There is no debounce anywhere in this feature.** What survives of the race is one
    rule: an answer about an abandoned root is still **answered**, with an empty frame and a
    reason, unlike `publish_status`, which drops it. A dropped reply strands the browser's
    `pending` flag with no second reply coming.
  - **The result frame carries `[{path, count}]` and nothing else** — no lines, no columns, no
    preview. The browser recomputes the ranges from the text the existing `{"kind":"file"}` round
    trip already gives it, which removes the byte-offset-versus-UTF-16 problem and the second
    definition of "where the matches are". The cost is a window where the file changed between the
    grep and the click: the walk **clamps** to the last range actually found while the counter
    keeps the daemon's numbers. A stated degradation, not a silent one.
  - **The panel had to be able to answer with TEXT, and that is the sharpest conflict in the
    feature.** `file_view` returns the diff of a dirty file, and `git diff` prints hunks with three
    lines of context, so most matched lines are not in the diff at all — a step onto line 220 of a
    400-line file would open a document that does not contain it, under a counter reading
    `7 / 213`. Hence `prefer: "text"` on the **existing** `file` command rather than a new command
    kind: a second read route would be a second place a path from the network becomes an open
    descriptor. Only the exact string has an effect (absent, `"diff"`, junk all mean today's
    diff-first chain, so the worst case is a diff where text was wanted), and the branch sits
    **before** the fork, so asking for text costs no `git` at all. Under it a deleted file reaches
    `no such file` rather than its removal diff, and that is correct — the search never matched a
    file that is not on disk. The status-panel click keeps the default and keeps its removal diff.
  - **The marks are an ARGUMENT to `buildDoc`, never state.** The query and the active occurrence
    belong to the search; copied onto `FileViewState` they would have two owners and a
    synchronisation bug the first time an answer landed late. `DocMarking` is therefore declared in
    `fileDoc.ts`, so the search imports the panel and never the reverse, and `buildDoc(state)` with
    one argument is byte for byte what it always was. The splitter cuts at the **union** of token
    boundaries and match boundaries, slicing out of `row.text` rather than out of the tokens, and
    its invariant is the new axis of the one `fileDoc` already lives by:
    `spans.map(s => s.text).join("") === row.text`. `MAX_MARKS_PER_DOC` is 2000, past which only
    the active row is split — a one-letter query over a 4 000-line file is ~40 000 spans in a panel
    rebuilt every paint, sharing a frame budget with a force layout that never settles.
  - **Walking OPENS the file here, inverting `searchKeys.ts`'s own stated rule, on purpose.** That
    rule exists because a modal over the graph on every `F3` step buries the thing being stepped
    through — and the docked placement is precisely that condition being removed. Both halves had
    to ship together: a content `F3` that opened the *modal* would reproduce the exact failure the
    old rule prevents. Two smaller rules hold the rest up. **Only one search is armed at a time**
    (opening either closes the other), which is what lets `renderer.setSearch` stay a single
    channel with no mode and lets each binding keep answering `null` while its own box is closed.
    And **`pointer-events: none` on the docked container is the load-bearing CSS line**: without it
    the full-window flex box keeps eating clicks meant for file dots and the graph is as dead as it
    is under the modal, with nothing on screen to explain why. The canvas is deliberately **not**
    resized — `frameMatches` gained an `occludedRight` fraction instead, clamped below 0.9 and
    applied *after* the `MIN`/`MAX` clamp, and the renderer passes a **measurement** of the panel
    rather than a copy of its `40vw`.
- **F7 paints the graph by file size, and the scale is the observed project's own.** Colour here
  had always been a pure function of one path — an extension in `colors.ts`, an author's hash for a
  flash — evaluated in the per-frame loop. This is the other kind: a **round trip**. The browser
  cannot stat the disk, so F7 asks, `rhizome_graph/sizes.py` walks the tree and answers a whole
  distribution, and the browser turns that into one colour per node before the next frame is drawn;
  F7 again restores the extension colours. The staged plan is
  `docs/features/done/2026-08-25-22-17-size-mode.md`. Nine things are load-bearing:
  - **The ramp is a written-down stop table, and it never passes through green.** `hslToInt` is one
    import away and `hslToInt(240 - 240 * t)` runs straight through green *at the median* — where
    green is already the `A` flash that says a file was created. So five stops are interpolated per
    channel and the invariant is `g < max(r, b)` everywhere. Near the middle the margin is ~2/255,
    and that thinness is inherent: any blue-to-red ramp through a light neutral has to pass a
    near-tie. What keeps it from reading as green is that the near-tie is **neutral**, not that the
    margin is wide.
  - **The scale is hinged at the median, not symmetric.** p10 / p50 / p90 of `log1p(bytes)`, each
    half divided by its own spread, each spread guarded above zero. A single spread of
    `max(hi, lo)` empties its own coldest fifth over a home directory, where the file median is 41
    bytes and the p90 is hundreds of kilobytes. The stated price is that the ramp is no longer a
    ratio scale — red means "far up THIS project's own distribution", never "twice as big" — which
    is exactly why the legend prints the three byte anchors rather than a bare gradient.
  - **Two scales, files and directories, built independently.** A directory is the sum of its files,
    so on the files' scale two thirds of the directories land in the hottest fifth and the colour
    says only "directories are big", which is not information. The directories are aggregated in
    `sizeMode.ts` from the file entries' ancestor paths and **deliberately not** from the live node
    list: the answer describes the tree the daemon walked, so a directory the browser has and the
    walk never measured gets no colour at all, which is the correct statement.
  - **The set measured is the set drawn, by identity.** `sizes.MAX_FILES` **is**
    `tree.DEFAULT_MAX_FILES`, the same object, and the walk is `scan_tree`'s own — its ignore rules,
    its symlink drop, its sort, and its cap asked one entry above what is served so that "there was
    more" is the walk's answer rather than a second count of the same tree. Two constants that
    happen to both be 20 000 would surface as a tail of grey dots nobody could explain.
  - **`os.lstat`, and it never raises.** `scan_tree` already drops symlinked files, so the two agree
    in ordinary operation; what `lstat` buys is the window between the walk and the stat, where a
    path that became a link reports the link's own size instead of the size of whatever it now
    points at. A file that vanished inside that window drops its entry: a partial answer is a
    partial colouring, while an exception is a dead command with the browser holding a `pending`
    flag nothing will clear.
  - **`sizes` is the one command that turns no string from the network into anything,** and that is
    the whole of its security story: it names no field, so there is nothing it can be refused for
    and no containment check to add. It parses with `path: ""` — the echo field both gates quote in
    their refusal — and returns from its own branch in the dispatch, so a stray key from an older
    page costs nothing instead of the whole mode. Like `search` and unlike `publish_status`, an
    answer about an abandoned root is still **answered**, empty and with the reason, because a
    dropped reply strands the browser's `pending` flag with no second reply coming. It needs the
    root re-read more than the search does: a `sizes` frame carries no echo field by which a late
    answer could be recognized.
  - **A late answer is refused by identity, and the toggle is unconditional.** `applySizes` returns
    the **same reference** unless the phase is `pending` — the `applyView` idiom, where
    `if (next !== state)` is the caller's whole adoption test — and F7 pressed while a walk is in
    flight **closes** without sending, which is what un-wedges a mode whose request was refused and
    will never be answered. A `reset` closes it too: the colour map is keyed by the paths of a
    project the user has left.
  - **F7 sits first in the keydown chain, above the modal's Escape, and that position is earned.**
    It is the only binding on the page that is unconditional — the mode has to toggle with the file
    panel open, with the root bar focused and with either search bar taking keystrokes — so it takes
    no part in an argument that is only ever about contested keys. `interpretSizeKey` declines every
    modified F7 and every **repeating** one: held down it repeats at roughly 30 Hz, and every second
    repeat would be another walk of the whole tree in the executor shared with `scan_tree`,
    `file_view` and `content_search`. `preventDefault`, because Firefox binds F7 to caret browsing.
  - **The size colour replaces the base colour and nothing else.** The write flash, the read tint,
    the idle fade and the point size all still apply on top, so a file being written still flashes
    amber over its size colour; a search match stays cyan, because the matched branch sits above the
    size branch in the renderer on purpose. `sizeColors` answering `null` **is** "the mode is off",
    so the renderer needs no second boolean and the two cannot get out of step, and the per-frame
    cost is one `Map.get`. An armed mode with no answer for a node paints the grey it already wore
    (`UNMEASURED_COLOR` **is** `NEUTRAL_NODE_COLOR`, imported rather than respelled — a second
    near-grey beside the directory grey would be the least legible pair this page could contain).
    The legend is an element of its own, top-right, and may **not** join `#bottom-bar`: that row is
    one grid whose two side reserves were measured in a browser, so a fourth box there would change
    what the centre caption may spend with nothing on screen saying so. Its gradient is built from
    `RAMP_STOPS`, never respelled in CSS.
- **An agent's life is on camera now, not only its edits.** Three hook events join the five
  tools: `Notification` (Claude Code needs permission, or has gone idle), `Stop` and
  `SubagentStop`. They are not tool calls and they name no path, so nothing about them rides
  the event wire — `rhizome_graph/agentstate.py` classifies the payload, the hub keeps one
  `agentState` slot, and the browser gets the whole current picture per agent. The staged plan
  is `docs/features/done/2026-08-26-20-56-agent-lifecycle-events.md`. Ten things are
  load-bearing:
  - **The three event names are ASSUMPTIONS, and they are constants for exactly that reason.**
    Nothing in this repository has ever captured a `Notification`, `Stop` or `SubagentStop`
    payload — the `PostToolUse` shape was "settled by capture, not by reasoning" and these were
    not. So `agentstate.py` declares `EVENT_KEY`, `NOTIFICATION`, `STOP`, `SUBAGENT_STOP`, both
    settings files and the installer read `LIFECYCLE_EVENTS`, and **every test is written
    against the constants, never against the literals**: a real capture corrects four strings
    and changes no test. The one question that could not be deferred this way is whether a
    permission prompt is distinguishable from an idle timeout, so that test is not written at
    all rather than guessed — see the outstanding-capture note below.
  - **Only a tool call says who is at work.** `ingest_line` used to stamp `_last_hook` from
    `actor_of(payload)` before it knew what the payload was, which cost nothing while only tool
    calls arrived and inverts the moment these three do: an agent **blocked waiting for a
    human** would become the author of whatever changed on disk in the next
    `ATTRIBUTION_WINDOW_SECONDS`, very likely the editor of the human who is at that moment
    reading the prompt — and a `Stop` would hand five seconds of changes to the agent that just
    left. The gate is a pure `refreshes_actor` in `normalize.py`, beside `actor_of` and for the
    same reason it is shared: the socket loop and the normalizer must not hold two opinions
    about what a tool call is. It is keyed on a **usable `tool_name`**, so a `Grep` the
    normalizer draws nothing for still stamps (a glob-expanding `cp` is still that agent's
    doing) while `{"tool_name": 123}` does not.
  - **It is a new frame KIND, not a fifth `EventType`.** `"W"` in `EVENT_TYPES` looks cheaper
    and is wrong three times: `Event.path` becomes a mandatory field with no meaning, the
    closed-set docstring exists precisely to stop the set being widened for convenience, and
    `applyEvent` with `path: ""` reaches `touchFile("")` — where `""` is the layout's `ROOT_ID`,
    the pinned centre every top-level node hangs from — growing **a phantom clickable file on
    the origin of the graph**. The price is one more parser, one more route and one more sink;
    obstacle 3 alone is worth it.
  - **A slot, not a transient — because a read is a flash and a wait is a state.** The
    mechanism is `set_status`'s, copied: the whole current picture rather than a delta (a delta
    needs an ordering guarantee across a reconnect and a rule for a client that missed one),
    deduped on the **encoded** message, cleared by `reset`, and placed in `replay_messages`
    after the status and **before the seed** — `register` sends the replay in order and the
    client draws as it arrives, so a waiting ring behind twenty thousand seed events appears
    seconds late on a graph that has already settled. `_broadcast_transient` is the argument for
    what it must not touch and *not* the mechanism: a client connecting one second after the
    notification must be told, or it draws a working figure over a blocked agent.
  - **`SubagentStop` requires an `agent_id`; `Notification` does not, and the asymmetry is the
    point.** `actor_of` falls back to `session_id`, which is the **orchestrator's** key — so a
    `SubagentStop` that fell back would retire the orchestrator's figure every time any
    specialist finished, the figure most likely to still be working. It answers `None` instead,
    and the feature degrades to "departure works for the orchestrator, via `Stop`": half the
    value and never wrong. A `Notification` may fall back, because a permission prompt blocks
    the session as a whole, so crediting it to the session is approximately true rather than
    backwards.
  - **A wait is cleared by the agent's own next tool call, never by a timer.** A human can be
    away from the keyboard for an hour with the agent genuinely still blocked, so a timeout
    reports *false progress* — a lie the user cannot detect. What a clock decides is only how an
    **old** fact is drawn, and that lives in `agentState.ts` as a pure function of `(state,
    now)`: no timer, no stored flag, testable with a number. Two refinements the plan did not
    ask for and both are right: a `working` answer for an agent that was never blocked is
    dropped (its events already say it is working, and publishing it would create a figure from
    nothing), and an entry differing from the one held **only in its timestamp** is dropped
    before the dedupe sees it — a notification repeated while the human is still away is one
    fact told twice, and a moving timestamp would defeat the dedupe entirely. So `ts` means
    *when this state began*, which is also the honest answer to the question the browser asks
    of it.
  - **An actor with no file event was invisible, and that was fatal to the best half.**
    `PostToolUse` fires *after* a tool runs, so an agent blocked on the permission prompt for
    its **first** tool call has fired no hook, has no `ActorView`, and `updateActors` hides any
    actor whose `hasPos` is false. That is not an edge case, it is the commonest shape of the
    exact situation this feature exists to show. `setAgentStates` therefore creates the figure
    and places it at `layout.position("")` — the pinned centre, which `sync` always keeps live.
    `renderer.actors` is now the union of two inputs, so the `?? 0` on `sim.getActor(...)` is
    load-bearing and must not be tidied into a non-null assertion.
  - **Nothing ever removed an actor before this.** `ACTOR_DECAY_PER_SEC` is a dimming, not a
    departure: `alpha = 0.4 + 0.6 * intensity`, so after 12.5 s an idle figure sits at 40%
    opacity **for the life of the page**, and an afternoon of subagents ends as a field of dim
    strangers in front of the two that are working. `DEPARTURE_SECONDS = 2.5` is the first
    mechanism that deletes one, and it is not free tuning: it must outlive the longest beam
    (1.2 s) and a full write flash (~1.1 s), or a subagent that stops mid-flash vanishes and
    orphans a lit beam claiming it as author. That relation is **asserted**, which is why
    `BEAM_LIFE_SECONDS` had to leave `renderer.ts` for a pure `beams.ts` — a module that needs a
    GL context cannot be imported by a test, and two literals in two files pin nothing. The
    departure rides **on top of** the decay and does not replace it: the decay stays the floor
    for every fact that never arrives.
  - **The waiting marker is a SHAPE, not a sixth colour.** The page already spends five semantic
    colours (add, modify, delete, read, search) and a sixth is where a colour vocabulary stops
    being readable. So: a **broken ring** — arcs with gaps — against `searchMarker`'s one thick
    continuous ring and `readMarker`'s two thin ones, painted in the actor's own
    `hashColor("actor:" + agent)` so that with three agents on screen it says *which* one is
    blocked without anybody reading a caption. The colour is an **argument** and never derived.
    A known risk is inherited rather than discovered: a gap and a thin stroke are the same
    artefact at low sampling, so a broken ring is *more* exposed to the fade-out `CLAUDE.md`
    already flags for the read marker — hence the arcs are never thinner than `readMarker`'s
    `OUTER_WIDTH`, now exported rather than respelled. While waiting, the alpha floor is lifted
    to 1: a blocked agent is the one you most want to see, and dimming it by idle decay is
    precisely backwards.
  - **`ts` is when the state BEGAN, and that forces the staleness constant off a human scale.**
    An entry differing from the one held only in its timestamp is dropped before the dedupe can
    look at it, so no fresher stamp ever arrives for a fact that has not changed. Combine that
    with a ten-minute staleness cut and a genuinely still-blocked agent loses its ring while the
    daemon is still reporting it `waiting` — decision 5's own failure mode, *reporting false
    progress*, relocated from the daemon to the browser. Staleness exists for an agent **killed**
    while blocked, not for a slow human, and `ts` alone cannot tell the two apart, so the page
    names `LONGEST_HUMAN_ABSENCE_SECONDS` (8 h: a lunch, a meeting, a night) and requires
    `STALE_WAIT_SECONDS` strictly above it (12 h). **The relation is asserted and the values are
    not**, with an anti-degeneracy jaw underneath — the absence must clear the hour the hub's own
    docstring names, or the relation could be satisfied by declaring one second.
  - **A `waiting` marker never gets a usable-looking agent it should not have.** `parseAgentStates`
    required a `string`, which admits `""` — an entry that then enters the model under an empty
    key and earns a ring around the actor `CLAUDE.md` says must never exist. The daemon cannot
    send one (`_usable_text` strips before `actor_of` answers), and **the parser is exactly where
    that guarantee stops**, because the frame came off the network. Empty and blank now drop the
    entry alone, its neighbours surviving. A non-blank agent is *not* trimmed: the string is the
    identity, and rewriting it would be the parser holding a second opinion about who is who —
    which is also why `agentState.ts` re-validates nothing and `protocol.ts` owns the closed set.
  - **The doctor learned to read the new keys, and the price of the cheap version is stated.**
    `diagnose` read `PostToolUse` alone, so a rotted absolute path under `Stop` would error on
    every agent stop while `rhi --doctor` reported `installed` — the rot `CLAUDE.md` says fails
    louder and worse than absence, made invisible again. Now **ours** is looked for under every
    event key while a **stranger** is still only counted under `PostToolUse`: `FOREIGN` means a
    contest over our own capture array, not the mere presence of somebody else's hook, and a
    desktop notification bound to `Notification` is the likeliest thing a person already has.
    What this does **not** notice is a *partial* install — our command under `PostToolUse` and
    absent under `Notification` still reads `installed`, and the symptom is a graph with no
    waiting rings, which looks exactly like nobody being blocked. Trigger for the per-event
    verdict: the first `--doctor` saying `installed` while the page shows no ring during a
    session that was demonstrably blocked. The hook itself is **unchanged** — it forwards the
    payload and classifies nothing, which is the whole reason a new matcher costs no hot-path
    logic, only one more ~40 ms process per firing, and these three fire at a rate bounded by
    *human* actions rather than by tool calls.
- **The graph says when an agent touches something it should not.** The user declares path
  patterns in a file — `.github/workflows/`, `package.json`, `.claude/settings.json`, lockfiles,
  or `*` / `!src/` / `!src/**` for "anything outside `src/`" — and an event landing on a match
  wears a bracket on the graph and opens a row in a top-left panel. It is a **supervision
  signal, not a security control**: `PostToolUse` fires *after* the tool ran, so the file is
  already written, and nothing in the UI may read as prevention. The staged plan is
  `docs/features/done/2026-08-26-20-56-attention-rules.md`. Eleven things are load-bearing:
  - **`gitignore.py`'s PURE layer is reused; `IgnoreRules` is refused.** `compile_rule` and
    `match_rules` buy git's syntax, which every user of this tool already knows — `!` negation is
    the only reason "anything outside `src/`" is three lines rather than a new pattern language,
    and `dir_only` is what makes `.github/workflows/` reach the files under it with nothing
    added. `IgnoreRules` is the other half and every part of it is about a rule file living
    *inside* the tree it governs: per-directory `governs`, the memoized load, `invalidate`, and
    the two measured traps of watching an ignore file. Attention rules are **one file, at the
    root, read once**, so adopting it would import a governance model with nothing to govern.
  - **The direction of failure INVERTS on reuse, and that is the whole reason `refused` exists.**
    In `gitignore.py` a refused pattern, an unreadable file or a cap reached shows **more** files
    and is safe by construction. Here the same refusal alarms **less**: the user wrote a rule
    about `*.pem`, `compile_rule` could not translate it correctly, and the graph then reports
    the silence that means "nothing has happened". A supervision feature whose failure mode is
    indistinguishable from success is not a supervision feature. So `attention.py` compiles line
    by line and **keeps the refusals verbatim** rather than calling `parse_patterns`, which drops
    them silently.
  - **`matches` asks the matcher TWICE and only an agreement counts.** `match_rules` takes an
    `is_dir` flag and an event carries no such fact. Under `*` / `!src/` / `!src/**` the entry
    `src` answers `True` as a file — `!src/` is `dir_only`, so the negation applies to the
    directory while `*` matched it first — and `False` as a directory. And `_expand` turns a
    directory deletion into its children *followed by the directory's own path*, so `rm -rf src/`
    really does put `src` through the matcher: the one directory the user wrote two lines to
    exclude would alarm. Short-circuiting, so a path matching nothing — almost every path — still
    pays for exactly one pass. Asking twice is a rule of the **caller**, the same split that keeps
    `.git` and `node_modules` in `tree.py` rather than in the matcher.
  - **The seed exemption is STRUCTURAL, not a filter, and it is what makes this feature cheap.**
    There are three fan-out sites and `seed_paths` builds its own message, never touching
    `_publish` or `_broadcast_transient`. `_observe` sits on those two and on nothing else, so
    "the boot snapshot never alarms" is a consequence of the existing shape rather than a
    condition anyone has to remember. On a home directory that is 12 524 events at ~5.35 us each
    — 67 ms of matching for a snapshot in which nobody did anything — never paid. The obvious
    "consistency" refactor is to route the seed through `_observe` too; a test guards it.
  - **One call site for one policy.** `_publish` and `_broadcast_transient` both come through
    `_observe`, asserted over the parsed source (scoped to the `EventHub` class body, because
    `completion_response` already has a local named `matches`). Two call sites is how a later
    "reads should not alarm" change lands in one of them and not the other — a build where a read
    alarms and the next where it does not, invisible to any single test.
  - **The wire key is CONDITIONAL and `_encode` had to stop being a bare `asdict`.**
    `"attention": true` is present only when the answer is true. `asdict` emits every field
    unconditionally, so an `attention: bool = False` field on `Event` would put
    `"attention":false` on all 12 524 seed events; the verdict is therefore a key `_encode` adds
    or does not, and `Event` gained no field at all. `parseEvent` reads an absent key as `false`
    by the `label` rule, and a non-boolean truthy value — `"yes"`, `1` — degrades to `false` too:
    the fail-safe direction here is **silence**, because a page that alarms on a malformed frame
    from a daemon of another version alarms on nothing the user wrote.
  - **Reads alarm, and only the latch makes that survivable.** An agent *reading* `.env` is the
    case this feature exists for. But reads arrive roughly ten times more often than writes, so
    the alarm list is a **SET, not a stream**: forty touches of one path are one alarm with
    `count: 40` whether or not something else alarmed in between. That is a deliberate divergence
    from `eventLog.ts`, which folds into the **top** entry only because folding into an older one
    would reorder the list under the reader's eye — here the reader is being asked "what needs
    looking at", not "what happened last". The entry keeps its **first** timestamp for ordering
    and its last for the count line. State it in the docstring or the next reader "fixes" it back.
  - **Acknowledgement clears; a new event does not.** An alarm has no natural end — the file
    stays modified — so it is dismissed by clicking the row, or by clear-all. It does **not**
    clear on a new event for the same path, and acknowledging does not suppress: a later event
    opens a **fresh** alarm at `count: 1`, because an alarm that keeps re-arming must not look
    like one that was handled. It clears on `reset`, in `main.ts`'s single `onReset`, because the
    paths belong to a project the user has left. The dismissal gets **no key**: Escape is
    contested three ways in the chain already and this panel does not cover the graph.
  - **The marker is a BRACKET, and the alarm is exempt from the idle fade.** The colour channel
    is spoken for four times over and the last of them is the write flash, which fires at exactly
    the moment an alarm is raised — an alarm painted as a base colour is repainted amber by its
    own cause. So it is a third *shape*, and deliberately **not** a third ring: the graph already
    carries the read ring and the search's active ring, and a third would inherit the read
    marker's sparse-sampling risk plus a discrimination problem on top of it. The one renderer
    expression that changed is the idle fade, and it moved out of `renderer.ts` into the pure
    `nodeFade.ts` rather than being asserted over untestable source — this project's own move,
    "when asked to specify something that lives in the renderer, specify the pure module it
    should be extracted into". An alarm that fades out over the next minute is an alarm nobody
    sees.
  - **The panel is visible when it has SOMETHING TO SAY, which is not the same as having a row.**
    `statusList.ts`'s rule is that visibility derives from the entry count and never from a flag,
    and copying it literally shipped finding 5 anyway: the header — the rule source, the in-force
    count, the refused patterns — was on screen only once something *unrelated* had alarmed, so a
    user whose `*.pem` rule was dropped saw nothing, and the nothing was indistinguishable from a
    clean session. So `visible` is true for a row **or** a non-zero refusal count **or**
    `truncated`. A truncated rule file counts for a sharper version of the same reason: there is
    no malformed pattern for the user to spot in their own file, so they cannot tell which of
    their patterns fell off the end of the cap. A quiet session over clean rules is still an
    absent panel, and `rules === null` — nothing heard from the daemon yet — is still absent,
    because claiming "no rule file was found" before anyone read a disk is a statement about a
    disk nobody read.
  - **NO new command kind, and no rule ever arrives over the socket.** The temptation is a
    `setAttention` so the page can edit the rules; it is refused for the reason
    `content_search.py` "imports no `re`" is asserted over its parsed source. A pattern from the
    network is compiled by `compile_rule` into a `re.Pattern` — a regex built from a string a
    browser sent, bounded only by caps written against a file the user owns. `sizes` is the one
    command in this protocol that turns no string from the network into anything; this feature
    adds a second surface with that property by **adding no surface at all**, which is a stronger
    position than adding one carefully. The price is stated rather than hidden: changing a rule
    needs an editor and a `ctrl+L`, and there is no in-page rule editor.
  - **Configuration: `--attention-rules PATH` / `RHIZOME_ATTENTION`, verbatim, and the refusal
    rule applies.** The value stays a **string** and is never expanded or resolved in `cli.py` —
    `web_dist`'s rule, since deciding which candidate exists is a filesystem question and that
    value is built without a filesystem. `Session` joins it to the root at the moment somebody
    asks, so the **default** (`<root>/.rhizome-attention`) moves with a `ctrl+L` and an explicit
    path does not. An explicit path that is not a readable file **refuses at boot** — rc 1, one
    line, before a port is bound — because someone who typed a path and got silence cannot tell
    it from "nothing has alarmed yet", which is the worst reading this feature can produce. An
    absent **default** is the normal case and degrades to no rules. One surprise is stated rather
    than fixed: an explicit rule file keeps naming the same file across a switch but its patterns
    are re-anchored to the *new* root, which a pattern language whose meaning depends on a
    switchable root cannot avoid; the panel naming the file it loaded is what makes it visible.
  - **A load that read nothing arms nothing and announces nothing.** The hub already matches
    against no rules, so only the *header* is withheld — and an unconditional frame put
    `{"kind":"attention","source":""}` into the replay of every session, breaking five baseline
    assertions that pin a fresh client's kinds exactly. Nothing the report exists for is lost: a
    rule file that was read and asked for nothing still names itself, which is the case a typo in
    `RHIZOME_ATTENTION` produces, and an explicit path that cannot be read never reaches the
    session at all. The load needs **no `asyncio.to_thread`**, deliberately: one capped read of
    at most 256 KiB plus ~130 us of compilation, against a `scan_tree` that runs to 623 ms and is
    already threaded. Saying so is cheaper than the next reader wondering why the thread is
    missing.
  - **The caps, and why one of them is this feature's own.** `MAX_BYTES` **is**
    `gitignore.MAX_IGNORE_BYTES`, imported by identity rather than respelled — the
    `content_search.MAX_FILE_BYTES IS file_view.DEFAULT_MAX_BYTES` precedent. But
    `MAX_RULES_PER_FILE` is 1000, and 1000 rules is ~320 us per event by linear extrapolation,
    ten times today's whole per-event path. So `MAX_ATTENTION_RULES` is **64**: a rule file with
    more than 64 patterns is not a supervision policy, it is a second `.gitignore`.
- **F8 says what each agent actually did this session.** One row per agent: distinct files
  touched, reads against writes, the file it returned to most, how many directories it worked
  in, and the span between the first and last moment it was seen. The staged plan is
  `docs/features/done/2026-08-26-20-56-session-stats-panel.md`. Ten things are load-bearing:
  - **The counting is DAEMON-side, and that is the decision the whole feature turns on.** The
    browser cannot count what it was never shown: a client is replayed `reset`, `meta`,
    `status`, the seed and the last **200** events, and nothing in the replay marks the loss.
    A browser-side counter is therefore not merely approximate, it is **silently** approximate,
    and two tabs opened five minutes apart disagree about the same session with no way for
    either to know. A panel whose numbers depend on when you opened the tab is not a summary.
    The security audit recommended the browser side and this went the other way deliberately;
    the argument is written down in decision 2 of the plan.
  - **It hangs off `_observe`, the seam the attention rules already built,** and adds no second
    hook point. Both fan-out paths come through that one method, so a later "reads should not
    count" or "deletions count double" cannot land in one of them and not the other -- the
    symptom of which would be a total that is right for hook events and wrong for watcher ones,
    invisible to any single test.
  - **The seed exemption is structural, inherited rather than re-argued.** `seed_paths` builds
    its own message and never touches `_observe`, so the counters are never offered a seed
    event at all and `session_stats.py` deliberately does **not** filter for one -- a filter
    there would hide a wiring mistake instead of failing on it. **12 524 phantom "files
    touched" on this host's home directory is what that buys**, and a test guards the obvious
    "consistency" refactor that would route the seed through it.
  - **Reads are counted, kept apart from writes, and never summed.** `eventLog.ts` drops `R`
    outright because that list is a list of *changes*; this panel inverts that on purpose --
    "it read 340 files and wrote 12" is the single most informative line it produces, and an
    agent filtered out for having written nothing is an agent that spent the session reading
    and vanished from the report of it. The inversion is in the module docstring, or the next
    reader folds it back into `eventLog`'s rule. `D` counts as a write; `A` and `M` are not
    distinguished, because that is already the graph's own colour.
  - **A poll in a slot, not a publish per event.** The counters move on every event; the frame
    does not have to. Per event it would be a fresh `json.dumps` and a broadcast to every
    client for every keystroke of an agent's work. So: a task of its own on
    `STATS_POLL_INTERVAL_SECONDS` (5 s, or `RHIZOME_STATS_INTERVAL`, or `--stats-interval`;
    <= 0 disables it and creates no task), deduped on the **encoded** string in a replaceable
    slot exactly as `_status` is -- and here the dedupe is what makes the poll affordable, since
    an idle session frames a byte-identical table every 5 s for hours. The panel is up to 5 s
    behind, which is the opposite trade from the recent-changes list beside it; that one is
    instant and lossy. **Two panels on one page with opposite freshness guarantees is a real
    inconsistency**, and what makes it survivable is that this one is a summary.
  - **`publish_stats` needs no root check, and that asymmetry is the point.** `publish_status`
    re-reads `self.root` after its await and drops an answer about an abandoned root, because
    its fork outlives the read. Nothing here forks or awaits, so nothing can be overtaken by a
    `ctrl+L`; what answers the switch is `EventHub.reset` emptying the counters synchronously,
    before the new project's first event arrives. The in-flight flag is still set and cleared,
    so the first `await` added is already covered rather than having to be remembered.
  - **The key is `agent`, the text is `label`, and the empty agent gets a row.** `CLAUDE.md`'s
    "an event with `agent: \"\"` must never create an actor" is about a figure and a beam; a
    stats row is neither. An unattributed change is real work by nobody on camera, and hiding
    it would make the totals not add up -- so it gets **one** row, sorted **last regardless of
    its counts**, carrying **no swatch**, because the swatch is the actor's identity and there
    is no actor. Getting this wrong in either direction is the likeliest misreading this
    feature invites, so it is a test rather than a comment. **The frame's order is not the
    panel's**: the daemon sorts by writes descending, and "unattributed last" is the browser's
    sort alone.
  - **Every counter is capped, and the most-visited answer degrades rather than lying.**
    `MAX_AGENTS` 32, `MAX_TRACKED_PATHS` 2 000 per agent, and the rule at the cap is **stop
    adding new keys, keep incrementing existing ones**, then set `truncated`. Under it the
    most-visited file is exact whenever the winner appeared among the first 2 000 distinct
    paths -- overwhelmingly likely for a file an agent returns to, and **not** guaranteed. LRU
    eviction was rejected for the sharper reason: it can evict the winner and makes the answer
    wrong *without saying so*. The per-path map is a `dict[str, int]` whose length **is** the
    distinct-file count, because two counters that must agree are two counters that can drift.
  - **F8, not `Tab`, and the refusal has three separate costs behind it.** `Tab` is focus
    traversal across four focusable things, and vitest here is `environment: "node"` with no
    jsdom, so **no test on this host could catch** a binding that took it away; `Tab` is
    already claimed conditionally by `interpretRootKey`, so a stats binding would have to be
    conditional on another box's state; and to be unconditional it would have to read
    `document.activeElement`, putting a raw DOM read into the composition root. F8 costs none
    of that and sits beside F7 at the top of the chain for `sizeKeys.ts`'s own stated reason --
    a binding that contests nothing takes no part in an argument about contested keys.
    `interpretStatsKey` declines every modified and every **repeating** F8: held down it
    repeats at ~30 Hz, and a panel flickering at 30 Hz is its own defect. **Escape does not
    close it** -- Escape is contested three ways already, and this is a corner overlay rather
    than a cover, so it needs no escape hatch. A second F8 closes it.
  - **It reports FIRST and LAST and refuses "time active".** `last - first` calls an agent that
    worked ten seconds and idled an hour "active for an hour". The honest version needs a gap
    threshold, and the only interval in this codebase that resembles one is
    `ATTRIBUTION_WINDOW_SECONDS`, which means something else entirely -- borrowing it would be
    a number chosen because it existed. So the panel prints both timestamps and the elapsed
    span, **labelled as a span and not as activity**. The reader does the arithmetic, and the
    span over-reports for an idle agent; stated on screen rather than hidden.
- **The figure says what the agent thinks it is doing.** The graph answered *where* an agent
  was working and never *why*; `TodoWrite` is the tool an agent writes its own plan with, and
  the one item it marks `in_progress` is the cheapest sentence there is about *why*. It is
  captured, derived into a caption, and painted as a second line above the figure, under the
  agent's name. It rides the `agentState` frame the life-cycle feature already built -- one
  per-agent slot for both facts about one actor, never a second frame kind. The staged plan is
  `docs/features/done/2026-08-26-20-56-todo-caption.md`, and its "As built" section records
  where the implementation departed from it. Ten things are load-bearing:
  - **The daemon sends the derived caption, never the list.** Shipping `todos` and letting the
    browser choose is 1 337 bytes against a few dozen, re-sent on every `TodoWrite` -- worth
    having, and not the reason. The reason is that "which item is in progress" would then have
    **two implementations**, the browser's running against a list it also has to validate item
    by item. This is `content_search.py`'s rule one feature smaller: its frame "carries
    `[{path, count}]` and nothing else" precisely so the browser is not a second definition of
    where the matches are. The stated price is R12: the page cannot show the *rest* of the plan
    without a second round trip.
  - **`caption_of` is a TRI-STATE, and that is the whole of what makes a caption last longer
    than a keystroke.** `_record_agent_state` publishes a `working` state on *every* tool call
    from a known agent, so a `caption_of` answering `""` for an ordinary `Write` would wipe the
    sentence milliseconds after the `TodoWrite` set it. `None` means *this payload was not about
    the plan at all* and the hub carries the caption forward; `""` means *this is a `TodoWrite`
    and nothing is in progress* and the hub clears it. Collapsing the two is the change to
    refuse. The persistence lives in the **hub** rather than in the classifier, because a
    caption surviving across payloads is state.
  - **No in-progress item is an empty caption, never a fabricated one.** Not "idle", not the
    last completed item, not the first pending one -- an empty caption hides the line and the
    figure keeps its name. Inventing text is how a graph starts lying quietly: "idle" would be
    read as a fact about the agent when what actually happened is that the model marked nothing.
    It is `_parse_bash`'s "when the parser would have to guess, it stays silent", applied to a
    sentence instead of a path. And the empty caption is **published, not withheld** -- withheld,
    the browser would keep drawing the previous one forever, which looks exactly like a working
    feature while describing work that finished an hour ago.
  - **An agent that has said what it is doing is not nothing.** `_record_agent_state` dropped a
    `working` state for an agent it had never seen, because publishing it would create a figure
    from nothing. A `TodoWrite` produces no event at all, so under that rule an agent whose first
    act is to write down its plan would never reach a client -- which is a common shape, not an
    edge case. The clause is "carries a caption", never "is a `TodoWrite`": an *empty* caption
    still is nothing.
  - **The fold and the cap run TWICE, on one path, and that is not belt and braces.** Two
    conditions on one path, never two paths: `safe_caption` bounds the wire and protects a
    browser of another version, `safeCaption` bounds the canvas and protects the page from a
    *daemon* of another version -- reached by `ssh -L`, through a proxy, or from a different
    release. Both are written as **removals** rather than replacements, which is what makes them
    idempotent; a fold that is not idempotent turns defence in depth into a caption mangled once
    per layer it passes, and that is discovered on a screen rather than in a suite.
  - **The fold strips controls and bidi, in that order, and is not an ASCII filter.** A C0/C1
    control folds to a **space** (`fillText` does not break lines: a newline comes back as a
    missing-glyph box or as nothing, and removing it outright would glue two words the model
    wrote separately); a bidi mark, embedding, override or isolate is **removed outright**, since
    those are zero-width and sit inside words. The reason to remove them at all is that the
    caption sits directly under the agent's **name**, the one string on this page a user trusts
    to say who is acting, and a RIGHT-TO-LEFT OVERRIDE reverses everything after it. They are
    spelled one by one, because that is the class a later "simplify the fold" drops first. A jaw
    pins that accented Latin, CJK and emoji pass through **unchanged** -- reach for
    `str.isprintable()` and it fails. **No HTML escaping and no quoting**, deliberately: the sink
    is a canvas and `fillText` cannot execute markup, and a defence against an absent sink is how
    a reader concludes the real one was never thought about.
  - **One rule, two languages, one fixture table.** `agentstate.py` and `agentCaption.ts` share
    no code, so they share `CAPTION_FOLD_CASES` -- the same `(input, folded)` pairs asserted in
    both suites in the same order, the `matchRanges` / `content_search` device. It carries three
    **boundary** cases or it pins nothing: exactly `MAX_CAPTION_CHARS`, one past it, and an
    astral run at an odd offset so a UTF-16 `slice` would land inside a surrogate pair. The cap
    counts **code points** in both languages; `60` is never restated in the browser, it is
    implied by the table. One measured divergence is kept and stated: JavaScript counts U+FEFF as
    whitespace and Python does not, so a BOM is dropped in the browser and survives on the wire
    -- zero-width either way, and matching exactly would mean hand-spelling a whitespace class.
  - **A character cap does not bound a canvas, so there are two caps.** `makeLabelTexture` sized
    `canvas.width` from `ctx.measureText` with **no `Math.min` anywhere** -- a 4 000-character
    caption asks for 52 012 px at 2x DPR and 78 020 px at 3x, past every browser's maximum
    dimension and past a typical WebGL `MAX_TEXTURE_SIZE`, allocating 7.5 to 17.5 MiB on the way.
    Pre-existing, unreachable until this feature (file names come from paths and the agent's name
    is capped at 24), and worth fixing even if the caption had been dropped. The bound is
    `MAX_LABEL_TEXTURE_PX` (4 096, the WebGL2 floor) applied in the pure `labelCanvasWidth`, in
    `makeLabelTexture` **itself** and not in the caption path -- a bound only the caption honours
    is a bound the next caller will not. **Not a measure-and-retry loop**: that is a loop over
    untrusted input, in the module with no tests, to compute what one clamp bounds outright. A
    non-finite measurement contributes **0**, not the bound: a measurement that told us nothing
    is no reason to allocate the largest texture the platform allows. `MAX_CAPTION_CHARS` x
    `MAX_FONT_PIXELS` at a full-width glyph plus padding is 3 872 px, and the two limits are
    asserted **against each other** so neither is retuned alone -- which is also why the audit's
    proposed 64-character cap was refused: 4 128 px breaks the same assertion.
  - **The sink is a second sprite in `overlayScene`, and three other candidates lose.** Not a DOM
    element: the figure moves every frame and the camera moves independently, so it would mean
    projecting world to screen per agent per frame, from `renderer.ts`, through a new seam that
    hands screen coordinates out of the one module with no tests. Not the 48-sprite file-label
    pool: its slots are bound to **paths** and its selection is by heat and zoom, so a caption
    would vanish exactly when 48 files are hot -- which is when the user most wants to know what
    the agent thinks it is doing. Not `avatar.ts`: its sprite is in the **bloomed** scene, where
    text gets the additive halo that closes the counters of its letters. A sibling of the name is
    outside the bloom **by construction**, is repainted only when its text changes (the
    `renameActor` rule -- a repaint costs a canvas and a texture upload), and costs one more
    `placeLabel` per frame. `applyAgentStates` reuses an entry object nobody changed, which is
    what keeps those uploads proportional to real changes rather than to frames.
  - **`TodoWrite` is the one matcher whose rate scales with the AGENT's work, not a human's.**
    ~40 ms of Python process per firing, at an estimated 20-60 firings a session -- 0.8 to 2.4 s
    of agent-loop latency, in 40 ms pieces at moments when the model has just finished a step.
    The dedupe is on the **wire** and cannot touch it: the process has been spent before the
    daemon saw anything, and there is no cheaper place to be -- the hook forwards the envelope and
    classifies nothing, a filter there would put a `tool_input` parse on the hot path, a
    `PreToolUse` matcher would fire *more* often, and batching is unavailable because the hook is
    a process per call by construction. If a real capture says 500 firings, the matcher is to be
    **reconsidered rather than optimised**. The prose in both settings files that previously said
    a matcher scaling with the agent's work is a different trade was corrected rather than left
    contradicting the block beneath it.
- **F9 makes the session audible, and everything about it is a refusal to be clever.** A short
  click per write, in a pitch derived from the same hash that gives the agent its colour, off
  by default and silent until somebody presses the key in *this* tab. The staged plan is
  `docs/features/done/2026-08-26-20-56-ambient-sound.md`. Nine things are load-bearing:
  - **The split is FORCED, not chosen, and it is the whole shape of the feature.**
    `web/vitest.config.ts` runs the front end with `environment: "node"`: there is no audio API
    in it, and this project's doctrine adds no mock to invent one -- "mock-free, jsdom-free and
    fast" is the stated reason the shiki boundary exists. So `sound.ts` holds every *decision*
    and is tested, `audio.ts` holds every *API call* and is not, and `AudioContext` is named in
    exactly one module, asserted over the source the way "no shiki outside `highlight.ts`" is.
    **Not one line of `audio.ts` is executed by any test, and none ever will be.** The suite can
    prove the model asks for the right thing and can never prove the right thing was done.
  - **Four silence rules, independent, and none is the safety net for the others.** Seeds
    silent, reads silent, a 40 ms floor (`MIN_VOICE_INTERVAL_MS`) and an 8-voice budget
    (`MAX_CONCURRENT_VOICES`) -- together they take 200 000 events to 1 961. The seed rule is
    not the rate limiter's job: a 40 ms floor over a 12 524-event backdrop is not silence, it is
    twenty-five clicks a second for eight minutes.
  - **The seed check runs BEFORE the limiter, and that ordering is a test of its own.** The
    cheap integer comparison first is faster and is what an optimiser would do; under that order
    the first seed sounds, stamps `lastVoiceMs`, and the real change three milliseconds later is
    swallowed by a floor that backdrop set. Being silent must cost the limiter nothing.
  - **A dropped event is dropped, never queued.** There is no pending slot in `SoundState` and
    no exported function that could drain one -- the export set is pinned at exactly fourteen
    names, which is the structural half of that rule. A queue turns a burst into a drone that
    outlives the work it describes, the same lie about "right now" that keeps read flashes out
    of the daemon's replay buffer.
  - **A root switch clears the limiter and NOT the toggle, which is the one place this page
    contradicts its own strongest pattern.** `onReset` clears eight things and every one of them
    is a fact about the old project; the toggle is a fact about the person in the chair.
    Silencing it on `ctrl+L` would mean re-enabling sound every time the user changes what they
    are watching. The clock goes, because the new project's first change must not be swallowed
    by a floor the old project's last change set. Say both halves, or the next reader assumes
    "reset clears everything" -- and the behaviour is pinned by `resetLimiter`'s own test, not
    by the source scan beside it.
  - **The pitch and the colour are two projections of ONE hash.** `colors.ts` now exports
    `actorHash` (the raw 32-bit FNV-1a of `actor:<agent>`) and `colorFromHash`, with
    `actorColor` their composition; a pitch taken from `actorColor(agent) % 15` would be hash
    mod 360 mod 15, a double reduction correlating pitch with hue by arithmetic accident. **The
    claim is "the same agent always sounds the same", never "you can tell agents apart by
    ear"** -- six agents get about five distinct pitches from fifteen notes, and no table size
    fixes it. An unattributed change gets `DEFAULT_VOICE`, a named constant, never
    `actorVoice("")`: computing one would invent an identity for somebody who has none.
  - **The toggle IS the gesture.** No context exists at boot; F9 constructs it *inside* the
    keydown handler, because a context built outside a gesture starts suspended and is refused a
    resume. F9 again `suspend()`s, never `close()`s -- a closed context cannot be reopened.
    `visibilitychange` routes through the pure `shouldRun(enabled, hidden)`. **A window behind
    another window is not hidden**, so a user who switches applications keeps hearing the
    session, which is arguably the whole point; a backgrounded *tab* goes quiet.
  - **`audio.ts` never throws, and gives the budget slot back on every path.** A refused
    `resume()`, a context the browser will not build, a voice scheduled after suspension: each
    is silence, and each still calls `onEnded`, or the model wedges silent after eight events.
    `wsClient.send`'s reason applies unchanged -- this is called straight from a key handler,
    and an exception thrown out of it leaves the page with a dead keyboard.
  - **It adds no dependency and 2 020 bytes.** WebAudio is a platform API; a synthesis library
    and a bundled sample are both refusals with reasons in the plan. The entry chunk went
    565 251 -> 567 271, half the 4 KiB budget, pinned absolutely (not as a delta) in
    `tests/test_sound_bundle_budget.py`, which skips when `web/dist` is absent.

**Not yet verified, for the ambient sound -- and here the gap is not one among several, it is
the feature.** Both suites are green and every pure decision is pinned, but **no sound has been
produced by any of this**. This host is a tty: no `DISPLAY`, no browser, no audio device. What
would settle it is somebody sitting with headphones through a real agent session of twenty
minutes or more, doing something else, and reporting whether they noticed the session's rhythm
or reached for the key -- and that judgement decides whether the work was worth doing at all.
If the answer is "turn it off", it is `sound.ts`, `audio.ts`, `soundKeys.ts` and four lines of
`main.ts`, and nothing else in the tree has changed.

Unheard judgements, every one retunable without touching a test, because the tests pin the
mapping and the relations and never the values: `MIN_VOICE_INTERVAL_MS = 40` (two figures from
the perception literature, neither measured here -- ~20 ms for two clicks to fuse, ~25/s for
clicks to become texture); `MAX_CONCURRENT_VOICES = 8` (summed-amplitude reasoning about sine
voices); the envelope's 4 ms linear attack into an exponential decay to 0.0001; the 90 ms
duration and the 0.12 gain; and all fifteen `PITCH_TABLE` offsets, minor pentatonic from A3 so
that two simultaneous voices stay consonant -- which is music theory, not a measurement of
whether the result is pleasant at twenty-five events a second.

Asserted from the specification rather than measured: that a context built outside a gesture
starts suspended, that `resume()` inside a keydown handler succeeds, and that
`visibilitychange` fires for a backgrounded tab and not for an occluded window. Vendors differ
on the first two in practice. **And one real gap with a name:** `rhi` opens a WebKitGTK webview
by default, and whether that backend has a working audio path at all is unknown -- so the
default way to run this application may be the one way this feature cannot work. It belongs in
the same spike as the WebGL questions `tools/webview_spike.py` already carries.

**F9 ships undiscoverable, like F8, and for the same reason.**
`tests/test_bottom_row_width_bounds.py` pins the shortcut legend at exactly 162 characters
because `CONTEXT_WIDTH_FRACTION = 0.34` and `MIN_SIDE_WIDTH_PX = 231` were measured in a
browser against exactly that string. This feature's `" - F9: sound"` is twelve characters and
the stats panel's entry is twenty; both land together at 194 characters, and the measurement is
taken once for both, at 1280 and 1600, by somebody with a browser.

Two findings from that plan are **noted and not built**, each with its trigger written down in
`docs/features/done/2026-08-26-20-56-ambient-sound.md`: R7, that the gain is fixed so a busy
session is louder than a quiet one -- the fix is a compressor or a gain that falls with `live`,
and the second *inverts* the signal by making a busy moment quieter per event; trigger, the
first report that a burst is startling rather than annoying, which is a different complaint
from "the whole thing is maddening" and only the first one is this finding's. And R8, that
reads are silent so half an agent's work is inaudible -- the read glow exists precisely because
"the graph used to stay dark through the half of an agent's work that explains the other half",
and this feature re-opens that gap in the audio channel deliberately; if it is ever built the
shape is **not** a click per read but a low continuous bed whose amplitude tracks the read
rate, which is a different synthesis problem and a different plan.

- **The top-right corner is a column now, and that is what keeps a summary off an alarm.**
  `#session-stats` is the second child of `#top-right-column`, with `#size-legend` first;
  `#attention` is untouched. The placement was re-decided during implementation because the
  plan's premise had expired -- it says "top-left is the only free corner", which stopped being
  true the moment the attention panel shipped there. The argument that replaced it is
  geometric, which is what made it decidable on a tty: `#attention` is `left:14px;
  max-width:32vw` so its right edge is at most `14px + 32vw`, a right-anchored `max-width:32vw`
  box's left edge is at least `68vw - 14px`, and the two can meet only below a **78 px
  viewport**. So "a summary the user opened must never cover an alarm the user did not ask
  for" is settled by the stylesheet rather than by a rule someone has to remember. A second box
  merely *pinned* near the legend was refused: `#size-legend` has **no `max-height`** and its
  error row is a daemon-supplied string, so any `top:` offset below it is a guess about a
  height nothing bounds, and sharing `top:14px; right:14px` is a deterministic total overlap
  for as long as F7 is armed. The legend is first because the box that has always owned the
  corner does not move; it lost exactly three declarations to the wrapper and kept everything
  else, including the `[hidden] { display: none }` that collapses the flex child **and** its
  gap. `pointer-events: none` on the column and `auto` on the scrolling list, `#attention`'s
  exact pair: `none` on both makes 45vh of rows unscrollable, `auto` on the box eats every drag
  across 32vw x 45vh. The wrapper sits where the legend used to, before `#file-view`, because
  **the stylesheet declares no `z-index` anywhere** -- paint order here is source order, and
  that premise is now asserted by a test.
- **Text is not part of the glow.** Labels live in a separate `overlayScene`, drawn after
  the composer with `autoClear = false`. Every glyph pixel clears the bloom's 0.05
  threshold, so a label left in the main scene gets an additive halo that closes the
  counters of its letters. Four more rules keep names sharp, and all four were once broken
  at the same time: the sprite is scaled by `spriteHeightForEm` so the requested pixel
  height applies to the **em box**, not to the padded texture canvas (that alone cost a
  third of the size); textures are rasterised at `labelFontPixels(dpr)` — constant, because
  a label is always the same CSS height on screen — so sampling is 1:1 and mipmaps are off;
  positions pass through `snapToPixelGrid` anchored on the camera centre, since a sprite
  landing between device pixels is smeared by the linear filter; and every label texture is
  marked `SRGBColorSpace`, or the gamma of each antialiased edge shifts and fattens the
  outline. Do not resize the bloom pass by hand in `resize()` — the composer already sizes
  its passes in drawing-buffer pixels, and re-setting them in CSS pixels halves them on
  HiDPI screens.
- **Integration** (verified against a live daemon): for reads, driven through the real
  `hooks/emit_event.py` over a scratch project — the `R` frame reaches a client watching at
  that moment, violet, relative to the root, carrying the subagent's id *and* its
  `agent_type`; a read of a file outside the root produces no event at all; a `Write` after a
  `Read` of the same path is still an `A`; and no `R` survives in the replay handed to a
  client that connects afterwards, while the real write does. Also: tree seeded on connect; a Write flashes
  once across both channels, whichever source wins the race (re-measured 2026-08-30, at a 0 ms,
  a 40 ms and a 150 ms gap); `cp *.md docs/` reports each file actually copied, credited to
  the agent -- and now for a better reason, since the actor is resolved when a held change
  flushes rather than when it arrived, so the hook that stamps `_last_hook` 40 ms *after* the
  copies hit disk is still in time; `rm -rf docs/` prunes the subtree, children first, every one
  of them carrying the agent; a non-agent edit appears with no actor, one settle window (0.25 s)
  after it happened; the
  meta frame arrives first and a branch switch is pushed without reconnecting; real captured
  hook payloads replayed through the daemon yield two distinct actors, the subagent's carrying
  its `agent_type` as a label. For the status panel, against a scratch repository holding one
  file of each state: the frame reaches a fresh client ahead of the seed with the four states
  correct and clean files absent; clicking the *deleted* file answers `mode: "diff"` with the
  removal; committing everything empties the list (`repo: true`, no entries); switching the
  root to a subdirectory relativizes the paths to it and drops what is outside; a root outside
  any repository answers `repo: false`.
  For the agent life cycle, against a live daemon over a scratch root, the daemon half of a path
  that has never seen a real payload: a `Notification` with only a `session_id` broadcasts one
  `agentState` naming the session `waiting`; the **same** notification again puts nothing on the
  wire and leaves the timestamp at the first one's, which is what makes `ts` mean *when this state
  began*; a second `Notification` carrying `agent_id` + `agent_type` yields **two** entries of one
  type; a file changed on disk three seconds into that wait arrives with `agent: ""` -- the blocked
  agent does not claim it, which is R1 proven rather than argued; a `Write` from the subagent turns
  **only** its own entry `working` and leaves the session `waiting`; a `SubagentStop` with **no**
  `agent_id` broadcasts nothing at all, so the orchestrator's figure survives a specialist
  finishing; the same with an `agent_id` retires that one alone; and a client connecting afterwards
  is replayed `meta, status, agentState` and *then* the tree, the position asserted by index.
  For the session-stats panel, against a live daemon over scratch roots, with real hook payloads
  on the real ingest socket: a client connecting to a daemon that has counted something is
  replayed `meta, status, agentState, attention, stats` and *then* the tree, the position
  asserted by index; a root of 41 files seeds 41 events and the first `stats` frame is still
  `{"agents":[]}` -- the boot snapshot is not work, structurally rather than by a filter; a
  subagent's `Write` produces a row keyed on its `agent_id` and labelled with its `agent_type`;
  a `Read` raises `reads` and not `writes`, while the same path is still an `A` when written
  afterwards and no `R` survives in a later client's replay; two subagents of one `agent_type`
  stay two rows; a disk change with no hook ever fired lands on the `agent: ""` row rather than
  being dropped; a 0.5 s poll over an idle session puts nothing further on the wire for five
  ticks and exactly one frame for one event; a `setRoot` resets every client and empties the
  table, and a client connecting afterwards is replayed `agents: []` and never the old
  project's numbers; `--stats-interval 0` creates no poll at all while the page is still
  served; and every frame checks field-for-field against `parseStats`'s contract, `dirs`
  crossing as an `int` -- the `set` hazard the module docstring names is genuinely closed,
  since a `set` would have reached no client at all.
  For the highlighter, the boundary that no unit test reaches was driven end to end outside the
  browser instead: the real `buildDoc → highlightChunks → applyTokens → buildDoc` path, over a
  real file and a real `git diff` from this repo, rendered both as ANSI and as HTML against the
  shipped stylesheet. That confirmed the Dark+ colours, the stripes, the numbering across
  hunks, italic/bold, and that an unknown extension still gets a gutter.
  **Not yet verified:** the actual in-browser visual (this host has no Chrome — no chromium, no
  playwright, no selenium — and a headless screenshot of an animated force layout proves
  nothing). Outstanding: whether the bottom-right status panel clears `#context` and `#hud` at
  narrow window widths, and, for the viewer, the gutter's alignment on *wrapped* lines, the new
  `#file-view-lang` span at narrow widths, how the stripes read on a real monitor, and whether
  the close button's padded hit area is comfortable to aim at and stays on the row once a long
  path has squeezed the header at narrow window widths. For the
  read ring: whether violet reads clearly against the write flash at real zoom levels, whether
  24 rings at once is calm or noisy during a read burst, whether the 0.75 tint leaves enough
  amber on a file read right after it was written, and how the ring's pulse sits next to the
  search ring when both land on the same node. One of those is a known risk, not just an
  unknown: the inner ring is a 2.24 px stroke on a 64 px texture rasterised with
  `generateMipmaps = false` and `LinearFilter` (the label doctrine), so drawn much smaller
  than 64 px it is sampled sparsely and can fade out — degrading the read marker into a single
  thin ring, which is precisely the shape it exists not to be. If that is what a real screen
  shows, thicken the inner stroke or rasterise the texture larger; the tests pin only
  relations between the radii, never their values, so retuning is free.
- **Not yet verified, for the installed application.** Everything below is green in the suite
  and unproven on a real machine. It is grouped by what would settle it, because the first
  group settles most of the rest.
  - **The spike, which gates the window's default.** `tools/webview_spike.py` on a real Linux
    desktop session (X11 *and* Wayland) and on macOS, against the running application rather
    than a synthetic demo: WebGL2 present, hardware vs software renderer, a float/half-float
    buffer for `UnrealBloomPass`, p95 frame time at ~1500 nodes, whether
    `WEBKIT_DISABLE_DMABUF_RENDERER=1` is needed, and `devicePixelRatio` against the same page
    in a browser. Its result edits `PREFERENCE_BY_PLATFORM` and the two packages' dependency
    lists, and nothing else. **This host is a tty** — no `DISPLAY`, no `WebKit2` namespace — so
    no agent here can run it.
  - **That a real window opens and a real window dies.** Not one line of `open_webview` has
    ever executed. Specifically: that `webview.start()` returning *is* the window closing; that
    `destroy()` from a worker thread tears down a WebKitGTK or WKWebView window; that
    `close_requested` is honoured at all under a native toolkit loop (the wakeup-fd path exists
    precisely because a Python signal handler may never run there, and neither path is proven);
    and that a Chromium in app mode exits on `terminate()` leaving no orphan and no profile
    directory. Snap confinement is a known suspect: `/snap/bin/chromium` with a
    `--user-data-dir` under `/tmp` may be refused, in which case the profile moves under `$HOME`.
  - **That anything is ever installed.** `dpkg -i` needs root, so no maintainer script has run,
    no dependency has been resolved by apt, `/usr/bin/rhi` has never executed from the prefix it
    was built for, and upgrade/removal/purge is untested. `debhelper` and `lintian` are missing
    here, so `debian/rules` is never exercised as a build entry point and Debian policy
    conformance is entirely unchecked. Nothing Homebrew has been executed — not `brew audit`,
    not `brew install`, not `brew test`; the formula is text that passes text assertions and has
    not even been parsed as Ruby. And `pip install` of the wheel into a clean environment is
    untested, so the console-script branch of `assets.hook_command()` is dead code as measured.
  - **That the hooks it writes actually work.** No Claude Code session has been started against
    a file `--install-hooks` produced, so nothing has put an attributed agent on the graph
    through the packaged `rhi-hook`. The doctor's central rule — that a hook in `~/.claude`
    alone fires for a session in another project — rests on Claude Code's merge behaviour and is
    asserted from documentation, not measured. A near-JSON settings file (a trailing comma, a
    `//` comment an editor tolerates) is treated as malformed and refused; correct by doctrine,
    but whether that is the common real-world shape is unmeasured.
  - **Smaller, and each with a named suspicion.** `web/dist` staleness is invisible to the build
    — it copies whatever is in the checkout, the same hazard `start.sh` has when node is missing.
    The doctor's report puts an absolute settings path and a command on one line deliberately,
    which will wrap on a narrow terminal (only ever seen at 100+ columns). `rhi --doctor` is
    pinned to bind nothing, but that a *live* daemon is undisturbed by it is not. And the
    `NO_BACKEND_NOTE` on a headless machine is the one behaviour here no test demanded — whether
    it reads as helpful or as noise is a judgement nobody has made on a real terminal.

Run, installed: `rhi /path/to/observed` — opens a window, serves the same page at
`http://localhost:8080`, and ends everything when the window closes. `rhi --no-window` for a
headless host, `--doctor` to check the hooks without starting anything, `--install-hooks` to
write them, `--attention-rules PATH` (or `RHIZOME_ATTENTION`) to name the file declaring which
paths deserve a second look — by default `<observed root>/.rhizome-attention`, in git's own
pattern syntax, absent by default and refused loudly when an explicit path names no readable
file. `--stats-interval SECONDS` (or `RHIZOME_STATS_INTERVAL`) paces the session-summary poll
behind F8, 5 s by default and `<= 0` to switch it off entirely. **F9 in the page turns on the
ambient sound** -- a click per write, off by default, per tab, and never remembered between
page loads; it is bound to no flag and to no environment variable, deliberately, because a
page that starts making noise on account of something decided in another session is the worst
failure this feature has available to it. Run, from a checkout: `RHIZOME_PROJECT_ROOT=/path/to/observed ./start.sh`. Point
the root at the project you want to *watch*, not at `rhizome-graph` — or start anywhere and
switch with `ctrl+L` in the page (the switch is global: one daemon watches one root, so every
viewer follows). Install attribution with `rhi --install-hooks`, which never writes without
being asked, or by copying the `hooks` block from `config/settings.json` into the observed
project's `.claude/settings.json` by hand — either way, hook changes only apply to sessions
started afterwards. Deps: `pip install -e '.[daemon]'`; the hook needs nothing. Rebuilding `web/dist` (or running vitest/tsc) needs Node 18+ — `start.sh` silently
serves a stale `dist` when node is missing, so a front-end change can look like it did
nothing. Debug an empty screen with `RHIZOME_DEBUG_LOG` (records hook *failures*) or
`RHIZOME_TRACE_LOG` (records every raw payload, which is how the shape of the hook JSON
gets settled on a new Claude Code version) on the hook command. A viewer that draws the graph
but refuses every `ctrl+L`, completion and file click is the control token failing, not the
page: `./start.sh --print-token` shows what the daemon expects, and `RHIZOME_TOKEN=<value>`
pins it when something outside the page has to send a command.

**A tree that updates while nobody is on camera means the hooks are not installed.** The
watcher alone gives completeness with no authorship, every event arrives with `agent: ""`,
and an empty agent never creates an actor — so the graph looks alive and unattended, which is
indistinguishable from "no agent is working right now". That ambiguity cost real hours; the
page now says so itself, in the HUD, once activity has arrived with no author. This repo has
the block installed in its own `.claude/settings.json`.

**Not yet verified, for the multi-repository panel.** Both suites are green and the whole path
was driven end to end outside pytest — a workspace of two real checkouts plus a plain directory,
where discovery answers both, the frame interleaves them, a click on a *deleted* sub-repo row
opens its removal diff, a click in the plain directory falls through to text, `a/../../../../etc/passwd`
is still refused, and observing one of the checkouts directly gives byte-for-byte the old
answer. What that does **not** settle is visual and needs a browser this host does not have:
whether sixteen repositories' worth of rows is a panel or a wall, and whether the prefix makes
`splitPath`'s dimmed directory unreadable at the panel's width. Nor is it measured against a
*hostile* tree — a network mount, a directory of 10 000 children, a symlink loop —
`MAX_SCANNED_DIRS` remains a pinned guess rather than an observed ceiling. And no real workspace
has been polled long enough to see a round approach the 20 s worst case, which is arithmetic
from the constants, not an observation.

**Not yet verified, for the content search.** Both suites are green and every pure decision is
pinned, but `main.ts` is the composition root and carries no test by doctrine, so the feature has
been exercised only through its parts. Nothing below has been seen in a browser, because this host
has none. Whether the docked panel at `40vw` leaves the stepped match inside the visible band --
`frameMatches`'s shifted centre is arithmetic nobody has watched — at a framed-whole tree and at
close zoom alike. Whether the two mark shades are distinguishable at a glance and stay legible
under Dark+ tokens, and, on the modal route (a graph click on a file that is also a match keeps
its diff and is still marked), over the diff's own translucent stripes. Whether the new bar reads
as a different box from the name search, sitting in the same slot with the same skin and a small
`in files` label to tell them apart. Whether `occludedFraction()` measures what it is meant to in
a real browser, and whether the camera stays sane across a resize with the panel docked. Escape
twice with a docked panel (panel first, then bar), `F3` stepping while it is open, and `ctrl+F` /
`ctrl+shift+F` swapping the two bars without leaving stale highlights on the graph. And no real
workspace has been searched at the caps: the ~3 s worst case is arithmetic from throughputs
measured on this host's small trees, not an observation, and `MAX_MARKS_PER_DOC` is a pinned guess
rather than an observed frame budget.

Three findings from that plan are **noted and not built**, each with its trigger written down in
`docs/features/done/2026-08-23-02-51-content-search.md`: R11, that every command refusal is
reported as a `rootError` and painted in the observed-root bar — pre-existing, and a refused
`search` is now a fourth silent case of it; R12, that results are not re-grepped as the tree
changes under them (the name search has `refreshMatches` for exactly this, and a content search
cannot re-read the disk on every event); and R14, that one client's search blocks that client's
other commands for its duration.

**Not yet verified, for the ignore rules.** The suite is green and every decision is pinned, but
the two real-tree fixtures only exercise the **governed** branch: this checkout has a root
`.gitignore`, so `REPO_ROOT` never walks a subtree where the dotted fallback is the rule in force,
and the ungoverned half rests on hand-built `tmp_path` trees alone. No hostile tree has been walked
with rules in force either — a network mount, a symlink loop, a directory of 10 000 children — so
`MAX_IGNORE_FILES` and the per-directory read cost stay pinned guesses rather than observed
ceilings, and the `$HOME` and `~/projects` timings above are this host's, on this host's trees.
Nothing in this feature has been seen in a browser: whether a project's `.claude/` and `.github/`
arriving on the graph reads as the tree filling in or as noise is a judgement nobody has made on a
real screen.

**Not yet verified, for the size colour mode.** Both suites are green and every decision in it is
pure and pinned, but nothing here has been seen on a screen — and this is the feature where that
gap matters most, because the whole of it is a judgement about colour. Whether the ~2/255 neutral
near the middle of the ramp reads as neutral rather than as a green, through the bloom and at the
few pixels a dot actually occupies. Whether the median hinge makes a real project legible or merely
puts everything mid-ramp. Whether directories at half brightness on their own scale are readable
beside the files. Whether the top-right legend collides with anything at narrow widths, and whether
a gradient strip is enough to match a dot against by eye. And whether R14 below reads as two facts
or as a bug.

Four findings from that plan are **noted and not built**, each with its trigger written down in
`docs/features/done/2026-08-25-22-17-size-mode.md`: R10, that `fileColor` is still evaluated per
node per frame in the *unarmed* case (774 µs per 1 500-node frame against 157 µs for the `Map.get`
the armed path uses — measured in the plan, on this host, in Node 18 — so the mode is *faster than
not using it*, which is an odd thing to have to explain); R11, that the measurement is a snapshot,
so a file created while the mode is armed stays grey until F7 is pressed twice; R12, that a refused
`sizes` is the fifth silent `rootError`; and R14, that file *labels* keep their extension colours
while the mode is armed, because a label texture is rasterised once when its slot binds to a path
and recolouring means re-canvassing up to 48 sprites inside one frame, twice per F7 — the dot beside
the name already carries the size, and the label's job is to say *which* file.

**Not yet verified, for the agent life cycle — and here the gap is sharper than usual, because it
is not only a screen that is missing.** Both suites are green, every pure decision is pinned, and
the daemon half was driven end to end against a live daemon (above) — but **the three payload
shapes have never been captured**, and this repository's own standard is
that a hook payload is settled by capture, not by reasoning. Nothing has answered: whether
`Notification` fires at all and carries `hook_event_name`; whether one raised for a *subagent's*
tool call carries `agent_id` or only `session_id`; whether a permission prompt is distinguishable
from an idle timeout by any field (this is why the plan's row 2.4 is deliberately **not written**
rather than guessed, and why `AgentState.caption` is declared and filled by nothing); whether
`SubagentStop` carries `agent_id` — **if it does not, the whole subagent half of departure is out
of scope by the asymmetry above**; and whether `SubagentStop` fires once per subagent when two of
the same type run in one turn, which is the assumption behind `Stop` retiring exactly one actor
and never cascading. Running it needs a scratch project with `RHIZOME_TRACE_LOG` on all four
matchers and one real session that gets blocked, goes idle, spawns two subagents of one type, and
ends its turn; **hook changes only apply to sessions started afterwards, so no session can capture
its own**. On each bad answer the plan says which step dies rather than the feature, and the
constants make a correction a four-string edit.
The visual half is the usual gap and this host is still a tty: whether a broken ring reads as
"waiting" rather than as a selection, as damage or as decoration; whether an arbitrary `hashColor`
actor colour is legible as a ring on a black field (if not, the ring takes a fixed light tint and
the *shape* keeps doing the distinguishing — the fallback is written down so it is not re-argued);
whether three arcs survive the sparse-sampling artefact the read marker already flags, the floor
being set but its sufficiency being a real screen's answer; whether a figure standing at the
layout's pinned centre reads as "this agent has not started yet" or as one stuck in the middle of
the tree, which is the placement decision its author was least sure of; and whether a 2.5 s fade
reads as leaving or as a glitch. `WAIT_MARKER_PIXELS`, the pulse rate and depth, and the ring's z
are guesses nobody has looked at, and the two staleness constants are values the tests deliberately
do not pin — they pin the relation between them, so retuning is free once somebody has watched a
real session run long enough to reach either.

Three findings from that plan are **noted and not built**, each with its trigger written down in
`docs/features/done/2026-08-26-20-56-agent-lifecycle-events.md`: R11, **lineage** — a birth edge
from parent to child, gated on whether a `Task` payload carries an id of the subagent it spawned
or a subagent's own payload carries a parent id, because the only field plausibly on both sides is
`agent_type` and joining on it is the rule this repository states twice ("never key an actor on
the label"), while a wrong edge has no watcher to correct it and stays on screen forever; R12, that
the actor map is still unbounded for an agent that never reports a `Stop` (a killed process, a
crashed session), R7 having fixed only the common case; and R13, that nothing counts the blocked
agents in *text* for a user whose camera is framed elsewhere — `#bottom-bar` is closed to it,
because that row is one grid whose two side reserves were measured in a browser.

**Not yet verified, for the attention rules.** Both suites are green and every decision in the
feature is pure and pinned, but this host is a tty and **nothing here has been seen on a screen**
— which matters more than usual, because the feature's whole product is a judgement about whether
a signal reads as a signal. Whether the bracket says "look at this" rather than "this is
selected", "this is damaged" or "this is decoration; whether it survives at four device pixels
the sparse-sampling artefact `CLAUDE.md` already flags for the read ring, since a bracket is
corners and gaps and that is the same artefact from the same direction; whether the red it
borrows from the `D` flash is distinguishable from a delete happening right now, or whether the
shape carries that alone; and whether a bracket, a read ring and the search's active ring on
three neighbouring dots are three things or one mess. Whether the top-left panel collides with
`#log` at a short viewport, the bargain `#size-legend` already accepts. Whether the header fits
the panel's width once it carries a rule path, a count and a quoted refused pattern — the file
viewer's header solved the same problem by **removing** something, and that trade has not been
made here yet. And, sharpest: **the panel appearing on its own, holding a header, `0 alarms` and
an empty list, because a pattern was refused** — the state the R7 visibility fix deliberately
creates. Whether that reads as "your rule was dropped" or as an empty box that appeared for no
reason is exactly the bet that fix makes, and it is the one thing the suite cannot answer.

Nor is any of it measured against a real session. The per-event figures — 5.35 us at 11 rules,
64.1 us at 200, ~17 us at the 64-rule cap — are the plan's, taken with `time.perf_counter` on a
warm single-threaded interpreter and compared against a 30.29 us baseline measured by somebody
else on another day; the 64-rule number is a **linear extrapolation**, not an observation, and
the burst that would make it matter is roughly 3 000 events per second, which nothing here has
ever produced. No hostile rule file has been fed through this path either: `gitignore.py`'s own
suite covers the patterns one at a time, and what is unmeasured is 64 of the worst of them at
once on the per-event path. `MAX_ALARMS` (100) and the marker tuning in `renderer.ts` —
`MAX_ALARM_MARKERS = 12`, `ALARM_MARKER_PIXELS = 44`, the constant opacity, the z between the
read ring and the search ring — are pinned guesses; the tests pin only **relations**, never
values, so retuning is free once somebody has looked.

Four findings from that plan are **noted and not built**, each with its trigger written down in
`docs/features/done/2026-08-26-20-56-attention-rules.md`: R8, the browser **notification** — a
secondary opt-in, ranked `next` because the graph marker and the panel are the product and a
notification adds a real availability matrix (`http://localhost` and an SSH-forwarded
`localhost:9000` are secure contexts, the `http://192.168.x.x` origin `start.sh` serves by
default is **not**, and `window.Notification` may be absent there entirely), a permission prompt
and a rate limit — with the audit's H4 attached to it, that a notification renders in OS chrome
and survives in the notification centre, so anything that can put an event on the wire would be
writing on the user's desktop unless the text is a fixed template with only the path substituted;
trigger: the first time someone says they missed an alarm because they were in another window.
R9, that the rule file is read once and never again, so editing it needs a `ctrl+L` or a restart
— a watcher on one file walks straight into the two measured `.gitignore` traps (the daemon's own
read is itself watched, and an atomic save carries the name only on the move's destination) and a
poll is a fourth task on a file that changes once a month. R11, that rules cannot be edited from
the page and are **one policy per daemon**, so two people watching one daemon share one policy —
kept that way deliberately, and the shape that would avoid the whole question is the page sending
**no pattern**, only a path already on the graph, which `resolve_inside` already contains. And
the pre-existing R12/rootError case: a refused command is painted in the observed-root bar, which
this feature adds no sixth instance of, because it adds no command.

**Not yet verified, for the TodoWrite caption -- and the gap here has the same two halves the
life-cycle feature has.** Both suites are green, every pure decision is pinned, and the fold was
cross-checked between the two languages beyond the shared table (the transpiled `agentCaption.ts`
run against `safe_caption` over 15 table pairs and 17 off-table strings -- NBSP, ideographic
space, U+200B, C0 separators, a 200-character cut, a 70-rocket astral run, an override mid-word --
agreeing everywhere except the stated U+FEFF case). But **no `TodoWrite` payload has ever been
captured**, and this repository's own standard is that a payload shape is settled by capture, not
by reasoning. Nothing has answered: whether `tool_input.todos` exists and is a list of objects;
whether those objects carry `content`, `status` and `activeForm`; what the exact `status` values
are; and -- the one that decides whether the feature lands on the right figure -- **whether a
subagent's `TodoWrite` carries `agent_id`**. If it does not, its caption falls back to
`session_id` and lands on the **orchestrator's** figure, which is wrong in the way the life-cycle
feature's `SubagentStop` asymmetry exists to prevent; the plan says to derive no caption at all in
that case rather than caption the orchestrator with a subagent's sentence, and that refusal is
**not built**, because writing it would be guessing at the answer. The five payload strings are
constants for exactly this reason: a real trace is a five-string edit that moves no test.

The visual half is the usual gap and this host is still a tty. Whether a second line of text under
every figure is information or clutter, with three agents on a force layout that never settles --
the fallback, written down so nobody re-derives it, is to caption only the most recently active
agent, or only on hover. Whether `ACTOR_CAPTION_PIXEL_HEIGHT = 10` against the name's 13 reads as
*secondary* rather than as *illegible*, through the sharpness discipline `labels.ts` maintains
(at a device pixel ratio of 1 the raster is clamped to `MIN_FONT_PIXELS = 12` and sampled down to
10, so the caption really is smaller on screen -- but a ~0.83 downsample is exactly the softness
that discipline exists to avoid). Whether `ACTOR_CAPTION_LINE_GAP = 0.65` reads as one stacked
block or as two floating strings. And whether **the name jumping by one line the first time a
caption arrives** is acceptable -- it is the price of placing every sprite exactly where it was
before when the caption is `""`, so that an installation without the `TodoWrite` matcher sees no
change at all; the fix, if it is not, is to reserve the line for actors that have *ever* had a
caption rather than unconditionally. Whether 60 characters is the right cap is arithmetic from a
rasterised width, not a judgement made against a real graph at a real zoom. **The tests pin the
relations and never the values** -- the fold runs before the cap, the two languages agree, the
pixel bound never clips an in-policy caption -- so retuning any of it is free.

Two more things are asserted from specification rather than measured. That `ctx.fillText` honours
bidirectional controls, which is why decision 10 does not depend on the answer: the fold costs one
character class either way. And every canvas figure above -- 52 012 px, 7.54 MiB, 4 096 -- is
computed from `makeLabelTexture`'s arithmetic and published engine limits. The **absence** of the
`Math.min` was a fact about the file; that a 52 012 px canvas fails rather than succeeding slowly
is an inference from documentation.

Four findings from that plan are **noted and not built**, each with its trigger written down in
`docs/features/done/2026-08-26-20-56-todo-caption.md`: R10, that a caption outlives the work it
describes when a model finishes without a final `TodoWrite` -- deliberately left to the sibling
feature's `stopped` state rather than given a second staleness mechanism, since two rules about one
figure is the outcome to refuse; R11, that the ~40 ms hook cost cannot be deduped away and the only
lever is the matcher itself, with the trigger being a real firing count high enough that somebody
notices; R12, that the browser sees one line of a plan it cannot otherwise read -- a panel listing
an agent's todos is the obvious next feature and this one deliberately does not build toward it,
and if it is built the list should ship on **request**, a command kind like `sizes`, rather than
being pushed on every `TodoWrite`; and R13, that a caption is invisible to both searches and to the
recent-changes list, so "which agent was working on the parser" is not a question the page can
answer -- both searches are keyed on **paths**, and matching an agent would mean a match that is
not a node, a camera frame for a figure rather than a file, and a third meaning for `F3`.

**One edit, two events -- fixed on 2026-08-30, and kept here as the record of the
measurement.** The dedupe between the two capture sources used to be **one-directional**:
`ingest_fs_change` skipped a path `_recently_hooked` said a hook had just reported, but
`ingest_line` stamped `_hook_paths` and published unconditionally, never consulting `_fs_paths`.
So the suppression only worked when the **hook arrived first** -- and it usually did not.
`PostToolUse` fires *after* the tool ran, so the file is already on disk when the hook process
starts, and that process is a ~40-56 ms spawn. Driven through the real `hooks/emit_event.py`,
three edits by one agent produced **six** events and a table reading `writes: 5` for that agent
plus a phantom `agent: ""` row carrying the first edit -- the watcher's `A`, credited to
`_active_agent()` (the *previous* agent, or nobody at the start of a session), followed by the
hook's `M`, which was an `M` because the watcher's publish had already put the path in
`known_paths`.

**What fixed it: the watcher no longer publishes on sight.** A change it sees is held for
`FS_SETTLE_SECONDS` (0.25 s, `daemon/server.py`), and a hook event for the same path inside that
window is not a second event -- it is the same change, better described, and it **supersedes** the
pending one. A change nobody claims is published at the end of the window, attributed by
`_active_agent()` read **at flush time**. Five things are load-bearing:

  - **The `A`-then-`M` inversion is not fixed by a mechanism; it is fixed by the absence of the
    pollution.** Under deferral the watcher never reaches `_known_paths` before the hook
    normalizes, so `normalize_event` computes `A` for a genuine creation with no new rule at all.
  - **The cancel sits AFTER the `R` branch returns in `ingest_line`, never before it.**
    Read-then-Edit is the commonest thing an agent does; cancelling at the top would have a read
    swallow a pending write -- a change that happened on disk, was never drawn, and has no watcher
    correction coming, because the watcher is the source that was silenced.
  - **A hook deletion cancels the pending subtree AND expands over it.** Cancelling the watcher's
    held per-child `D`s is only safe because the hook's own `D` now carries them, through the same
    `_expand`, children first, each credited to the hook's agent. Shipping the cancel without the
    expansion left `gone/a.txt` and `gone/b.txt` in `_known_paths` and on every later client's
    graph forever -- the unit suite was green and only the browser measurement found it.
  - **`schedule=None` keeps the immediate publish**, which is what leaves ~40 existing call sites
    untouched; `Session` passes a *lazy* `loop.call_later` so constructing one needs no loop.
    `reset` cancels every pending handle, or a callback fires after a `ctrl+L` and publishes an
    abandoned project's path into an emptied `_known_paths`, drawn as an add and clickable.
  - **The values are not pinned, the relation is:** `FS_SETTLE_SECONDS < COALESCE_WINDOW_SECONDS
    < DEDUPE_WINDOW_SECONDS`, the idiom `STALE_WAIT_SECONDS > LONGEST_HUMAN_ABSENCE_SECONDS`
    already uses. `tests/test_fs_settle_integration.py` runs in the default suite deliberately: it
    is the only test that can catch the window set too *short*, since every other assertion drives
    a fake scheduler by hand and would pass at a window of one millisecond.

**Verified in a browser, against a live daemon** (2026-08-30, headless Chromium): a disk-first
edit is one event carrying its agent; a new file written disk-first is one event, typed `A`,
carrying its agent; the watcher-alone and hook-first orderings are unchanged at one event each;
three edits by one agent give `3 written` on a clean daemon with **no `unattributed` row**; an
`rm -rf` over a held edit publishes the edit, then the subtree children-first, and the node set a
fresh client draws for that subtree is empty; a read-then-write of a new path is still one `A`;
and an unclaimed human edit arrives 0.281 s after it happened.

**Stated and not fixed.** The window is a guess about a race: where the hook spawn exceeds 0.25 s
the defect returns *silently*, with the old symptom. Watcher events nobody claims are still
attributed by time, so two agents at once can still credit one to the other. And `writes` is still
a count of events for Bash-driven changes -- a `cp` of 40 files is 40 writes, which is what the
panel means.

**Not yet verified, for the session statistics panel.** Both suites are green -- backend 1772,
frontend 1768 -- and every pure decision is pinned, but this host is a tty and **nothing here
has been on a screen**. Whether the top-right column reads as one corner or as two boxes
stacked. Whether 20 agent rows in a 45vh box is a panel or a wall. Whether a row's three lines
survive `max-width: 32vw` with a long agent id and a long path. Whether the `truncated` caveat
reads as informative or as clutter -- "files touched: 2 000" with the flag set is a **floor**,
not a count, and a reader who misses the flag has a wrong number. Whether the panel and `#log`
meet at a short viewport, and whether the column meets the centred search bars at a narrow one.
And, sharpest because no test can reach it at all: **whether `#size-legend` renders
pixel-for-pixel as it did before it was wrapped** -- the wrapper carries no padding, border,
margin or background precisely so that it does, and that is an instruction, not an assertion.

Nor is any of it measured against a real session. The daemon-side per-event cost is an
**estimate**: 2.17 us is the *browser's* accumulator measured in Node 18 on this host, and the
Python equivalent was asserted to be of the same order rather than shown. `MAX_TRACKED_PATHS`
(2 000), `MAX_AGENTS` (32), `statsPanel.DEFAULT_MAX_ROWS` (20) and the 5 s poll interval are all
pinned guesses -- no session here has been long enough to reach any of them, and nothing
measured the interval against how often a reader actually looks. `DEFAULT_MAX_ROWS` is
deliberately **not** 32: that is the daemon's `MAX_AGENTS`, and two constants that merely happen
to be equal is the failure this file names elsewhere.

**F8 ships undiscoverable, and that is the single largest known cost of this feature.** R9 of
its plan is the legend entry, and it **cannot be closed on this host**: adding
`" - F8: session stats"` grows the shortcut legend from 162 to 182 characters, a 12% growth in
the widest thing in `#bottom-bar`, and `CONTEXT_WIDTH_FRACTION = 0.34` is a *browser
measurement* against exactly that 162-character string at 1280 and 1600. What was built instead
is a jaw in `tests/test_bottom_row_width_bounds.py` pinning the legend at exactly 162
characters -- passing today on purpose, its docstring saying the number may only be changed by
re-measuring in a browser and writing the new one down with the date. It converts "somebody
will remember to re-measure" into "the suite stops you". If
`docs/features/todo/2026-08-26-20-56-ambient-sound.md` ever ships, both entries land at once
(194 characters) and the measurement is taken once.

Two findings from that plan are **noted and not built**, each with its trigger written down in
`docs/features/done/2026-08-26-20-56-session-stats-panel.md`: R10, a sessionized "time active"
-- gaps longer than N seconds split the work into sessions and active time is their sum, where
N is a constant with nothing behind it, chosen by looking at a real event stream nobody has
captured; trigger, the first time someone compares two agents' spans and draws a wrong
conclusion. And R11, that the counters die with the daemon -- no persistence, no export, no
comparison across sessions, and no way to click a row and see only that agent's work on the
graph; each is a feature rather than a step, and the filtering one is a real prospect, since
many agents at once is the whole point of the tool.

Not yet built: per-repository grouping in the panel (R5 in
`docs/features/done/2026-08-17-16-21-multi-repo-git-status.md` — the `repo` field exists on
`StatusEntry` and is deliberately *not* serialized, which is what keeps the frame's pinned shape
untouched), custom avatar *images* per agent, recorded-session replay/export. Attribution of
*watcher* events is time-based, so simultaneous agents can be credited to one of them — hook
events themselves are attributed exactly. Label textures are rasterised once at the pixel ratio
the renderer had at construction, so dragging the window to a monitor of a different DPI leaves
the names slightly soft until a reload.
