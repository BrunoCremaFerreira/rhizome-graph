# Security audit: the surface five planned features ADD

- **Audited:** 2026-08-26, branch `development`, at `fd0f34e`.
- **Scope:** the new attack surface of five features that do not exist yet, measured against
  the defences that do. No production code, no tests, no fixes were written; nothing in the
  tree was modified.
- **Method:** reading, plus four local probes — a daemon I started myself on `127.0.0.1:8765`
  with its own scratch root and its own ingest socket, and three in-process probes of
  `EventHub` and `asyncio.start_unix_server`. Nothing live was touched.

Note on notation: this report never writes a bidirectional-override character literally. Where
one appeared in a probe's output it is spelled `U+202E` below.

---

## 0. The baseline, measured

Everything in this section is a fact about the code as it stands today. The findings below
are ranked against it.

### 0.1 The ingest socket is writable by more than the hook

```
$ python3 -c "measure the mode asyncio.start_unix_server leaves on the socket file"
mode: 0o775   umask: 0o2
```

and, in the end-to-end probe against a real daemon:

```
socket mode: 0o775
```

`daemon/server.py:1170` creates the socket with `asyncio.start_unix_server(..., path=socket_path)`
and never `chmod`s it. The mode is therefore `0o777 & ~umask`. On this host `umask` is `0002`,
so the file is `rwxrwxr-x`: **every member of the user's primary group can `connect(2)` to it**,
and on a machine with a shared group (`staff`, `developers`, a container image that puts users
in one group) that is a different human. Under the more common `umask 022` it is `0755` and
only the owner can connect.

Either way, the set of writers is far larger than "our hook":

- **Any process running as the same user.** That includes every `Bash` tool call the agent
  itself makes. An agent that has been prompt-injected by a file it read can write a forged
  event with one line of shell.
- **Any local user, before the daemon starts.** `/tmp` is `drwxrwxrwt`. `run()` calls
  `socket_is_live(socket_path)` (`daemon/server.py:1163`) and *refuses to start* if something
  answers there. So any local user can (a) deny the daemon its socket permanently and (b) with
  it listening, receive every hook payload — the session id, the agent id, every file path the
  agent touches, and (with feature 2) the agent's plan in prose. `os.unlink` on a squatted
  socket in a sticky directory fails with `EPERM`, so there is no self-healing.

### 0.2 A forged ingest line is a broadcast frame, with no validation of anything

Against the daemon I started, a plain `AF_UNIX` write produced this on the WebSocket (the
`‮` is verbatim in the frame; the JSON encoder escaped it, the browser will not):

```
FRAME: '{"ts":1787788917.5989852,"agent":"attacker","type":"A",
         "path":"\\u202egpj.evil\\n<img src=x>","color":"33FF33","origin":"hook",
         "label":"XXXXXXXXXX...(300 chars)"}'
```

So today: an arbitrary actor id, an arbitrary display label of arbitrary length, and a path
containing a bidirectional override (`U+202E`) and a newline all cross the wire untouched. This
is the fact that kills the claim "the payload is trusted because it comes from our own hook."
The hook is a pipe, not a provenance.

### 0.3 The broadcast side has no gate at all

The control token gates **commands from the page** (`daemon/server.py:876`), and only after
`hub.register(websocket)` has already replayed the whole tree. My probe connected with **no
token** and received the seed, the meta frame and every subsequent event. `start.sh:307`/`316`
runs `python -m daemon.server`, whose `MODULE_ENTRY_HOST = ""` binds **every interface**; the
Vite dev server binds `host: true` and proxies `/ws`. So under the documented from-source
workflow, the event stream is readable by the whole LAN with no credential.

Today what leaks that way is a list of file paths. Three of the five features put new classes
of data on that same stream.

### 0.4 A pathless payload already steals attribution

```
after pathless payload, _last_hook = ('victim-session', '', 1219070.177651374)
active agent: ('victim-session', '')
fs event attributed to: victim-session | label:
```

`EventHub.ingest_line` (`daemon/server.py:341-349`) calls `actor_of(payload)` and stamps
`_last_hook` **before** `normalize_event` is ever consulted. A payload with no `tool_name`,
no `tool_input` and no path at all is enough. This is the sharp one the brief names, and it
is already true.

### 0.5 The wire has exactly one implicit cap: 64 KiB per ingest line

```
BIG FRAME: none (line dropped)        # 200 KB payload
MED FRAME: {"ts":...,"path":"c.txt"}  # 60 KB payload
```

`asyncio.start_unix_server` defaults to `limit=2**16`. A longer line raises inside
`reader.readline()`, is swallowed by `_handle_ingest_client`'s blanket `except`
(`daemon/server.py:911-916`), and the connection dies silently. Nothing else on the ingest
path is bounded: not the label, not the path, not the rate.

### 0.6 The DOM is clean, and the canvas is not

`grep -rn "innerHTML|insertAdjacentHTML|outerHTML|document.write" web/src/` returns **one**
hit, and it is a comment in `fileViewHud.ts:15` stating the rule. Every painter
(`eventHud.ts`, `statusHud.ts`, `contextHud.ts`, `searchHud.ts`, `contentSearchHud.ts`,
`rootHud.ts`, `sizeHud.ts`, `attributionHud.ts`, `fileViewHud.ts`) builds elements and assigns
`textContent`. **There is no test pinning this** — `grep -rn innerHTML web/tests/ tests/`
returns nothing.

The other text sink is `Renderer.makeLabelTexture` (`web/src/renderer.ts:1511-1550`), which is
not markup at all — it sizes a `<canvas>` to `Math.ceil(ctx.measureText(text).width) + 2*pad`
and calls `fillText`. That sink is immune to injection and wide open to length.

`web/index.html` carries **no** `Content-Security-Policy`, and `_http_response`
(`daemon/server.py:936`) sets none.

### 0.7 Nothing on the client side is capacity-bounded except the pools that were designed to be

`Renderer.actors` (`web/src/renderer.ts:308`) is a `Map` that only ever grows until `reset()`.
Each entry allocates an avatar and a label texture. `Simulation.nodes` has no cap either. The
things that *are* bounded — `MAX_BEAMS = 512`, `MAX_FILE_LABELS = 48`, 24 read-marker sprites,
`MAX_ACTOR_LABEL_CHARS = 24` — are bounded because someone thought about them. Two of the five
features add per-agent resources to the unbounded side.

---

## Findings

Ranked. One critical, five high, seven medium, then a noted list.

---

### C1 — Feature 2 puts model-authored prose on an unauthenticated, LAN-reachable broadcast

**Severity: critical.** Reachable by someone who is not on the host, and it is not data from
the observed root at all.

**Location (sites that would change):** `rhizome_graph/normalize.py` (the new payload branch),
`daemon/server.py:341` `ingest_line` and `:428` `_publish` / `:406` `_broadcast_transient`,
`daemon/server.py:206` `replay_messages`, `start.sh:307`,
`rhizome_graph/cli.py:77` `DEFAULT_HOST` vs `daemon/server.py:1240` `MODULE_ENTRY_HOST`.

**Reach.** The in-progress todo item is the agent's plan, written by the model: ticket numbers,
customer names, the path of a credential it is about to rotate, the sentence a user typed into
the prompt. `TodoWrite` is a `PostToolUse` matcher, so the text arrives on the ingest socket and
is broadcast. The broadcast side asks for nothing: my probe connected without a token and got
the full replay (0.3). Under `./start.sh` — the workflow `CLAUDE.md` documents for a checkout —
the listener binds every interface. So anyone who can reach `:8080` reads the agent's plan as it
is written. Today the same connection yields file paths, which is bad and known; prose is a
different class of secret, and this is the feature that introduces it.

Second half of the same finding: **where the caption is stored decides who else sees it.** If
the caption rides `Event` through `_publish`, it lands in `_recent` (200 entries) and is
replayed to every client that connects **later**, including one that connects an hour after the
agent finished. That is the exact mistake the "a read is not a change" bullet exists to prevent,
one field over.

**Evidence.** Section 0.3 above (probe output: replay received with no token);
`start.sh:307` `"$PYTHON" -m daemon.server`; `daemon/server.py:1240` `MODULE_ENTRY_HOST = ""`;
`daemon/server.py:864` `await hub.register(websocket)` precedes every gate.

**Fix plan — `developer-backend`, with a decision the plan must make in writing.**
1. The caption must **not** be an `Event` and must **not** go through `_publish`. It is a
   replaceable slot per actor, like `_meta` and `_status`, or it is transient like `R`. Pick
   one in the plan and say why. A slot means "the current todo of each live agent", which is
   what the feature describes; then it belongs in `replay_messages()` after `meta` and it must
   be cleared by `EventHub.reset` alongside `_status`.
2. The caption must be **opt-in and off by default**, or gated. The cheapest honest gate that
   fits the existing architecture: broadcast the caption **only to peers `control_allowed`
   would accept** — that is, loopback unless `RHIZOME_ALLOW_REMOTE_CONTROL=1`. That reuses a
   decision function that already exists and already has tests, and it means a LAN viewer sees
   the graph and not the prose. Do **not** invent a second address rule beside `control_allowed`.
3. Independently, the plan should record that `MODULE_ENTRY_HOST = ""` and
   `DEFAULT_HOST = "127.0.0.1"` disagree, and that this feature is the one that makes the
   disagreement expensive.

**Test to write first — `developer-tester`.**
- RED 1 (pure, `daemon/server.py` `EventHub`): after ingesting a caption payload, the messages
  a *later* client is replayed contain the caption **at most once and never inside `_recent`**;
  asserting on `hub.replay_messages()` and on the `_recent` deque directly. Today there is no
  caption at all, so write it against the intended API and let it fail on the missing method.
- RED 2 (`_handle_ws_client`, in the style of `tests/test_ws_control_token.py`): a client whose
  peer address is not loopback and for whom `allow_remote` is `False` receives every ordinary
  event frame and **no** caption frame; the same client with `allow_remote=True` receives it.
- RED 3: `EventHub.reset` clears the caption slot, asserted the way
  `tests/test_hub_reset.py` asserts `_status` is cleared.

---

### H1 — A lifecycle event must not touch `_last_hook`; today a `Stop` steals attribution

**Severity: high.** Reachable by any local process running as the user, including the agent's
own `Bash` calls, and by anything that can write the socket per 0.1.

**Location:** `daemon/server.py:341-349` (`EventHub.ingest_line`), `daemon/server.py:479`
(`_active_agent`), `rhizome_graph/normalize.py:88` (`actor_of`),
`daemon/server.py:106` (`ATTRIBUTION_WINDOW_SECONDS = 5.0`).

**Reach.** Feature 1 forwards `Notification`, `Stop`, `SubagentStop` and `Task` through the same
hook to the same socket. `ingest_line` stamps `_last_hook` from `actor_of(payload)` before it
looks at `tool_name`, so **every one of these already refreshes the active agent for five
seconds**. Two consequences, in order of sharpness:

1. **`Stop` is the exact inversion of its own meaning.** The frame that says "this agent has
   left" gives that agent ownership of the next five seconds of watcher changes. A departing
   orchestrator would be credited with the build step that runs after it.
2. **Attribution theft is a one-line forgery.** A payload of `{"session_id":"victim"}` written
   to the socket every four seconds credits **every** subsequent unattributed filesystem change
   — every manual edit, every `npm install`, every compiler output — to `victim`, for as long as
   it runs. There is no path in the payload for `_read_path` or `resolve_inside` to refuse,
   which is precisely why the pathless kinds make this cheaper than it is today.

**Evidence.** Probe output in 0.4: a payload consisting solely of
`{"session_id": "victim-session", "hook_event_name": "Stop"}` yields
`_last_hook = ('victim-session', '', ...)` and the next `ingest_fs_change("src/app.py", "M")`
publishes an event attributed to `victim-session`.

**Fix plan — `developer-backend`.** The decision belongs in the pure `rhizome_graph/normalize.py`,
not in the socket loop. Add a pure predicate there — call it `refreshes_actor(payload) -> bool`
— that answers `True` only for payloads whose `hook_event_name` (or `tool_name`) is evidence
that the agent is *doing* something, and `False` for `Stop`, `SubagentStop`, and `Notification`.
`ingest_line` then reads that predicate instead of stamping unconditionally. `Stop` and
`SubagentStop` should go further and **clear** `_last_hook` when it names that same actor: an
agent that has stopped owns nothing. Do not clear it for a *different* actor — a subagent
stopping must not orphan the orchestrator's changes.

The plan must also state, in one line, that the pathless kinds may touch **none** of
`known_paths`, `_recent`, `_hook_paths`, `_fs_paths` — the same four-way rule
`_broadcast_transient` already documents for `R`, and for the same reasons verbatim.

**Test to write first — `developer-tester`.**
- RED 1 (pure, `normalize.py`): `refreshes_actor({"hook_event_name": "Stop", "session_id": "s"})`
  is `False`; `refreshes_actor({"tool_name": "Write", ...})` is `True`. Fails today on the
  missing function.
- RED 2 (`EventHub`): ingest a `Stop` payload for `agent-a` immediately after a `Write` by
  `agent-a`; the next `ingest_fs_change` publishes an event with `agent == ""`. **This is the
  test that fails for the right reason today** — write it as the very first RED of feature 1,
  because the existing code passes the naive version of it by accident and fails this one.
- RED 3 (`EventHub`): after ingesting a lifecycle payload, `hub._known_paths`, `hub._recent`,
  `hub._hook_paths` and `hub._fs_paths` are all unchanged — the four-way assertion
  `tests/test_hub_read_events.py` already makes for `R`, copied kind for kind.

---

### H2 — The todo caption reaches a canvas whose width is the text's width, with no cap anywhere

**Severity: high.** The text is written by a model that may have been prompt-injected by a file
it read; that is content an agent writes, which is the rubric's definition of high.

**Location:** `web/src/renderer.ts:1511-1550` (`makeLabelTexture`), `web/src/labels.ts:264`
(`MAX_ACTOR_LABEL_CHARS = 24`) and `:288` (`actorDisplayName`), `web/src/renderer.ts:1283`
(`renameActor`), plus whatever HUD element the plan chooses.

**Reach.** `makeLabelTexture` sets `canvas.width = Math.ceil(metrics.width) + pad*2` at a font
of up to `MAX_FONT_PIXELS = 64`. The existing 24-character cap lives in `actorDisplayName` and
applies to the **actor label only** — a new caption painted through the same helper inherits
nothing. An agent whose todo item is a 4 000-character paragraph (a model does this) produces a
canvas roughly 130 000 px wide: over the browser's per-dimension limit, over the GL max texture
size, and repainted on every `renameActor`-equivalent. The failure mode is a lost context or a
multi-hundred-megabyte allocation, and it is reachable without any attacker at all — a verbose
todo is enough.

The same text in the DOM is safe from injection (0.6) and unsafe from length: a caption with no
cap in `#hud` reflows the bottom grid, whose two side reserves `CLAUDE.md` records as measured
in a browser.

**Fix plan — `developer-frontend`.** The cap is a decision, so it belongs in the pure
`web/src/labels.ts` beside `actorDisplayName`, **not** in `renderer.ts` (which no test can
reach). Add `todoCaption(text: string): string` there, and make it do four things:

1. **Length.** Cut to **64 characters**, keeping the head, with the existing `ELLIPSIS`.
   Derivation: the label is rasterised at a fixed pixel height and drawn at a fixed CSS height,
   so a 1920-px viewport fits roughly 240 characters edge to edge at that height; a caption
   that may occupy a quarter of the viewport is legible and one that spans it is not. It is
   deliberately larger than `MAX_ACTOR_LABEL_CHARS = 24`, which was derived from
   `developer-frontend` being 18 characters — a different question.
2. **Newlines.** `fillText` does not wrap; a `\n` renders as nothing or as a box and the
   caption silently becomes one run-on line, so a two-line todo displays as a lie about its own
   content. Fold every `\r`, `\n`, `\t` and every other C0/C1 control character to a single
   space **before** the length cut, so the cut is over what will actually be drawn.
3. **Bidirectional overrides.** Strip or replace `U+202A`..`U+202E`, `U+2066`..`U+2069` and
   `U+200F`. See M5 — the same rule, and it should be one function used by both.
4. **Never throw.** Same contract as `actorDisplayName`: a stale client and a future daemon may
   send anything.

Then a second, independent cap on the daemon side (`developer-backend`): the caption field is
truncated to **256 bytes** before it is put on the wire, derived from 64 displayed characters at
up to 4 UTF-8 bytes each. The daemon must never carry more than the browser can show; that is
also what keeps the caption slot from growing the replay.

**Test to write first — `developer-tester`.**
- RED (pure, `web/tests/agentLabel.test.ts` or a sibling): `todoCaption` of a 4 000-character
  string returns exactly 64 characters ending in the ellipsis; `todoCaption("a\nb")` contains no
  `\n`; `todoCaption` of a string containing `U+202E` contains no `U+202E`; `todoCaption("")` is
  `""` and `todoCaption` of a non-string does not throw.
- RED (pytest): the daemon's caption frame for a 100 000-character todo carries a `caption`
  whose UTF-8 length is `<= 256`.

---

### H3 — Three of the five features widen what a single forged ingest line can do

**Severity: high.** Local unprivileged process, same user; measured group-writable socket on
this host.

**Location:** `daemon/server.py:1170` (socket creation, no `chmod`), `:903-919`
(`_handle_ingest_client`, no rate limit, no size limit of our own), `:341` (`ingest_line`),
`rhizome_graph/hook.py:37` (`DEFAULT_SOCKET_PATH = "/tmp/rhizome-graph.sock"`).

**Reach.** Sections 0.1 and 0.2. The concrete new powers each feature grants a socket writer:

| Feature | What one forged line buys today | What it buys after |
| --- | --- | --- |
| 1 lifecycle | attribution theft (H1) | a permanent "waiting for permission" alarm on any agent; a fabricated parent/child edge between two agents that never met; an actor that never departs |
| 2 caption | nothing | arbitrary text under any agent's figure, and on the LAN broadcast (C1) |
| 3 attention | nothing | the ability to *fire* the alarm and choose the notification's text (H4) |
| 4 stats | a skewed counter | a fabricated "most-visited file" naming any path the attacker chooses |
| 5 sound | nothing | an audible click per forged event; see M4 |

The `Task` payload deserves a line of its own. `PostToolUse` on `Task` carries the parent's
`session_id` and the `tool_input`, which includes the **subagent prompt** — potentially
kilobytes of it — and does **not** carry the child's `agent_id`. So a parent/child link derived
from it is inference, and a forged `Task` frame asserts an arbitrary edge. If the plan draws
that edge, it must say what it does when the same child id is claimed by two parents.

**Fix plan — `developer-backend`.** Three changes, none of them large, and the first two are
cheap enough that not doing them is a decision the plan should record explicitly.

1. **`chmod` the ingest socket to `0o600` immediately after `start_unix_server` returns.** That
   removes the group from the writer set on this host and everywhere else. Nothing legitimate
   loses: the hook runs as the same user by construction. If a plan wants a multi-user daemon,
   that is a separate feature with a separate credential.
2. **Bound the line explicitly** rather than inheriting `asyncio`'s 64 KiB by accident: pass
   `limit=` to `start_unix_server` and log at `debug` when a line is dropped. See M7 first —
   the number must be measured with `RHIZOME_TRACE_LOG` before it is chosen, because the
   accidental cap may already be dropping real `Write` payloads.
3. **Bound the rate.** One state change per actor per **0.25 s** (a third of the existing
   `COALESCE_WINDOW_SECONDS = 0.75`, and below what a viewer can perceive), and a hard ceiling
   of **50 lifecycle/caption frames per second** across all actors, derived from a 60 Hz frame
   budget: more than one visual state change per frame is invisible by construction, so
   anything above that ceiling is pure wire and GPU cost.

**Test to write first — `developer-tester`.**
- RED (pytest, `tests/test_ingest_socket_guard.py` is the neighbour): after `run()` reports
  ready, `stat.S_IMODE(os.stat(settings.socket_path).st_mode) == 0o600`. This fails today and
  is one line to fix.
- RED (pure, on whichever module owns the rate decision — it must be a pure
  `(now, last, kind) -> bool`, not a branch inside `ingest_line`): 100 lifecycle payloads for
  one actor within 100 ms yield exactly one broadcast frame.

---

### H4 — Feature 3 lets whoever can put one event on the wire choose the text of a desktop notification

**Severity: high.** Local unprivileged process, or content an agent writes; the damage happens
outside the page's chrome.

**Location:** the new notification painter (a `*Hud.ts`), and whichever pure module decides
whether a rule matched.

**Reach.** A `Notification` is rendered by the operating system, in OS chrome, with the browser
or the page's origin as the only provenance the user sees, and it survives in the notification
centre after the page is gone. If the title or body is built from event data, then anything
that can put an event on the wire — the agent's own `Bash`, an npm postinstall script, a
same-group user (0.1) — writes text onto the user's desktop. Combined with feature 2 that text
is free-form. A notification reading "rhizome-graph: your session expired, re-authenticate at
..." is a phishing primitive delivered through a channel the user has already granted
permission to.

Facts the plan needs, all of which constrain the design:

- **Secure context.** `Notification.requestPermission()` requires a secure context. `localhost`
  and `127.0.0.1` are treated as potentially trustworthy, so a local viewer and an
  SSH-forwarded `localhost:9000` both qualify. A LAN viewer on `http://192.168.x.x:8080` —
  which `start.sh` serves by default (0.3) — does **not**. So on that origin `window.Notification`
  may be `undefined` entirely. The feature must degrade to the on-screen alarm without throwing,
  and the plan should say so rather than discovering it in a browser this host does not have.
- **User activation.** Permission must be requested from a real user gesture (a click on a
  toggle), never at page load. A page that prompts on load gets denied once and permanently.
- **Markup.** Title and body are plain text; there is no XSS here. Length, newlines and bidi
  are the live issues, exactly as in H2.
- **`icon`.** Never build the icon URL from event data; that is an outbound request to an
  attacker-chosen host, from the page's origin, with no CSP to stop it (0.6).
- **`tag`.** Use a constant `tag` so a burst collapses into one notification instead of
  stacking; `renotify` off.

**Fix plan — `developer-frontend`.** Split it the way this project splits everything:

- A pure `attention.ts` deciding **whether** a rule matched and **what the notification says** —
  a `{title, body}` built from a fixed template, where the only variable part is the path,
  passed through the same control-character and bidi rule H2/M5 define, and capped at 100
  characters (a longer body is truncated by the OS anyway, on every platform, so a longer cap
  only buys a truncation we do not control).
- A thin painter that calls `new Notification(...)` and does nothing else, guarded by
  `"Notification" in window && Notification.permission === "granted"`.
- A rate limit in the pure module: **at most one notification per 10 seconds**, and a burst of
  matches within that window collapses to a count. Derived from the OS side rather than from
  us: GNOME, macOS and Windows all queue and stack notifications, and ten per minute is already
  the point at which a user turns the permission off.
- Default **off**, enabled from a control in the page, and the on-screen alarm must be complete
  on its own — a user who never grants permission must lose nothing but the desktop popup.

**Test to write first — `developer-tester`.**
- RED (pure): `notificationFor(event, rule)` returns a body containing no `\n`, no `U+202E`, and
  at most 100 characters, for an event whose path contains all three.
- RED (pure): the rate limiter yields one notification for 50 matches inside 10 s, and its
  body carries the count.
- RED (pure): with `Notification` absent from the injected environment, the decision function
  still returns the on-screen alarm and the painter is never asked to fire.

---

### H5 — Attention rules must not become a regex, or a file an agent can write

**Severity: high** in the shapes described below; **medium** if the plan takes the safe shape
and says so.

**Location:** wherever the rule set is decided — `rhizome_graph/cli.py` `Settings` if it is a
flag, a new module if it is a file, `daemon/server.py:494` `COMMAND_KINDS` if it is a command.

**Reach.** Three shapes were offered, and they are not equally safe.

1. **Rules in the page only** — a pure matcher in TypeScript over frames the browser already
   has. No new daemon surface, no new command kind, no new file read. A pathological pattern
   costs one tab. **This is the shape to take.**
2. **Rules in a config file the daemon reads.** Two new problems. *Where* the file lives decides
   who writes it: if it lives inside the observed project (`.rhizome/attention.json` and the
   like), a prompt-injected agent writes it, because writing files in the observed project is
   the agent's whole job. That turns "content an agent writes" into "a pattern the daemon
   compiles". And the read itself is a path the project did not construct, so it must go
   through `rhizome_graph/safe_read.py` — the FIFO rule — not through a bare `open()`. Note
   this would be the **first** file the daemon reads as configuration; `settings_from` is pure
   today.
3. **Rules as a command from the page.** That is a sixth `COMMAND_KIND`. The gates in
   `_handle_ws_client` are applied to every parsed command uniformly, so the kind inherits both
   by construction **provided** it is added to `COMMAND_KINDS` and returns from its own branch
   in `parse_command` — see M6 for the refusal path and echo field it owes.

Across all three: **do not compile a user pattern with `re`.** `rhizome_graph/content_search.py`
imports no `re` at all, and that is asserted over its parsed source precisely so that "no regex
from the network" is structural rather than a promise. A pattern evaluated on the per-event path
— which runs for every watcher event, on the daemon's event loop — with catastrophic
backtracking stalls every connected viewer. The project already owns a hand-written, bounded
glob compiler in `rhizome_graph/gitignore.py`; that is the syntax users already know from
`.gitignore`, and reusing it means one pattern language in the product instead of two.

**Fix plan.** `developer-frontend` if shape 1; if the plan insists on shape 2 or 3, then
`developer-backend`, and:
- the matcher is a pure module that imports no `re` and starts no process, asserted over its
  parsed source the way `tests/test_content_search.py` and `tests/test_checkouts.py` assert
  theirs;
- the rule count is capped at **64** (more rules than a human maintains, and it bounds the
  per-event cost at 64 glob matches, the same order as the per-directory ignore cost the
  watcher already pays);
- each pattern is capped at **256 characters**;
- the config file, if there is one, is read through `safe_read.read_capped` with a **64 KiB**
  cap (256 characters times 64 rules, plus JSON overhead, rounded up) and lives **outside** the
  observed root by default.

**Test to write first — `developer-tester`.**
- RED (source-level, the `test_content_search.py` precedent): the attention module's parsed
  source contains no `import re` and no `subprocess`.
- RED (pure): 65 rules are refused down to 64; a 300-character pattern is refused whole, and
  the direction of the refusal is **fewer alarms, never more** — say which in the test name.
- RED (pytest, only if the file shape is taken): a `.rhizome/attention.json` that is a FIFO does
  not block the daemon.

---

### M1 — Any new frame kind must be routed before `parseEvent`, or it grows a node in the graph

**Severity: medium.** Needs no attacker; it is a mistake the code invites.

**Location:** `web/src/wsClient.ts` (`handleMessage`), `web/src/protocol.ts:100`
(`parseEvent`).

**Reach.** `parseEvent` **ignores `kind` entirely**. It accepts any object with `ts`, `agent`,
`type`, `path` and `color`. `wsClient.handleMessage` routes `meta`, `reset`, `completion`,
`rootError`, `fileView`, `status`, `searchResult` and `sizes` **before** it, and consumes each
**whether or not a sink was provided** — the comments there say exactly why. A lifecycle frame,
a caption frame or a stats frame added without that treatment falls through to `parseEvent` on
any page built before the frame existed, and grows a node in the graph named after it.
`Simulation` has no node cap (0.7), so the node is permanent.

**Fix plan — `developer-frontend`.** Every new frame gets: a `parseX` in the pure
`web/src/protocol.ts` with `kind` as its one hard gate; a route in `handleMessage` **above**
`parseEvent`; and consumption regardless of sink. The degradation rules in `parseSizes`'s
docstring are the precedent to copy — a missing optional field degrades, only `kind` and the
echo field cost the frame.

**Test to write first — `developer-tester`.** For each new kind, in the
`web/tests/wsClientStatus.test.ts` style: a client constructed with **no** sink for the new
kind, handed the new frame, calls `onEvent` **zero** times. That is the assertion that catches
the fall-through, and it fails today for any kind that does not yet exist.

---

### M2 — `rhi --doctor` is blind to the lifecycle hook blocks feature 1 installs

**Severity: medium.** No attacker; the damage is a blocking error on every agent stop, which is
the loud failure mode `--doctor` was written to catch.

**Location:** `rhizome_graph/hookinstall.py:65` (`POST_TOOL_USE`), `:100-120` (`diagnose`),
`:209` (`_post_tool_use_commands`), `:167` (`hook_block`), `config/settings.json`.

**Reach.** `Notification`, `Stop` and `SubagentStop` are separate hook **events** in Claude
Code, not `PostToolUse` matchers, so feature 1 adds new top-level keys to the hooks block.
`merge_hook_block` is already generic over events (`for event, entries in block.items()`), so
installing works. `diagnose` is **not**: it reads `_post_tool_use_commands(settings)` only. A
stale absolute path in the `Stop` array therefore errors on every single agent stop while
`--doctor` reports `installed`. `CLAUDE.md` states plainly that rot fails "louder and worse than
a missing hook"; this is a way to make rot invisible again.

Second, smaller half: `HOOK_MATCHER` is `"Write|Edit|MultiEdit|Bash|Read"`. Feature 2 adds
`TodoWrite` to it. `_entry_is_ours` recognises our entries by the command name, not by the
matcher, so a re-install replaces the old entry cleanly — but a user who hand-copied the block
from `config/settings.json` before the change keeps the old matcher and never sees a caption,
with `--doctor` saying `installed`. Worth one line in the plan.

**Fix plan — `developer-backend`.** Generalise `diagnose` from "the `PostToolUse` commands" to
"the commands under **every** event key this project installs", named by a single tuple beside
`POST_TOOL_USE`. Keep the verdict precedence exactly as it is — one broken command beside a
working one is still broken, and that rule is what makes the generalisation safe.

**Test to write first — `developer-tester`.** In `tests/test_hook_install_model.py`: a settings
file whose `PostToolUse` command resolves and whose `Stop` command does **not** diagnoses as
`STALE`. It passes as `INSTALLED` today, which is the wrong answer for the right reason.

---

### M3 — Feature 1 and feature 5 add per-agent resources to an unbounded map

**Severity: medium.** Needs a forged writer or a pathological session.

**Location:** `web/src/renderer.ts:308` (`actors`), `:1234` (`ensureActor`), and the new audio
module.

**Reach.** `ensureActor` allocates an avatar and a label texture per distinct `agent` string and
never evicts. Today an actor requires an event with a path, which at least implies a real tool
call. A pathless lifecycle event makes an actor free — one forged line per actor. Feature 5
attaches a voice per agent, so each forged actor also becomes an `AudioNode` graph; browsers cap
concurrent audio nodes far lower than they cap textures, and an exhausted `AudioContext` is not
recoverable without a reload.

**Fix plan — `developer-frontend`.** Cap the actor map at **32** and evict the least recently
active. Derivation: an orchestrator plus roughly eight concurrent specialists is the largest
realistic fan-out this project has ever produced, 32 is four times that, and it stays the same
order as the existing 48-slot file-label pool so the two pools together remain one budget rather
than two. The eviction decision is pure and belongs beside `selectFileLabels` in `labels.ts`,
not inside `ensureActor`. Voices are allocated from a pool of the same size and never per actor
directly, on the model of the existing 24 read-marker sprites.

**Test to write first — `developer-tester`.** RED (pure): given 200 actors with distinct
last-active timestamps, the selector returns exactly 32, and the most recently active is among
them. Fails today on the missing selector.

---

### M4 — Feature 5 will play 20 000 clicks on connect, and will be refused by the autoplay policy

**Severity: medium.** User acting against themselves, but they cannot see it coming.

**Location:** `web/src/eventLog.ts` (the existing drop rule), the new audio module,
`daemon/server.py:206` (`replay_messages`).

**Reach.** A connecting client is replayed the **whole seed** — up to `DEFAULT_MAX_FILES =
20 000` `A` events, all with `origin: "seed"`, all arriving within a second. A "click per write"
that does not drop seed fires 20 000 times. `eventLog.push` already drops seed before the fold,
and `CLAUDE.md` states why in the read bullet; the sound sink must inherit that rule, and it
must also drop `R` (an agent reads roughly ten times more than it writes).

Second: `AudioContext` starts `suspended` under every current autoplay policy and resumes only
inside a user gesture. Off by default is the right call and also the only workable one; the
toggle is the gesture.

Third: a burst of legitimate writes (a `MultiEdit`, a formatter run) is dozens of events in a
frame. Cap at **8 voices concurrently** and **20 clicks per second**, derived from the same
60 Hz budget as H3 — beyond a few per frame the ear hears a buzz, not events.

**Fix plan — `developer-frontend`.** The gate (`origin !== "seed" && type !== "R"`), the voice
cap and the rate limit are pure decisions in a `sound.ts`-shaped module; the `AudioContext`
lives in a painter that does nothing but play what the pure module returned.

**Test to write first — `developer-tester`.** RED (pure): 20 000 seed events yield zero clicks;
100 write events in one tick yield at most 8 voices and at most 20 clicks in that second.

---

### M5 — Bidirectional overrides and control characters already cross the wire, and three features widen where they land

**Severity: medium.** Reachable by an agent writing a file with a crafted name, or by any socket
writer; the damage is a display lie, not code execution.

**Location:** `rhizome_graph/normalize.py` (paths pass through untouched),
`web/src/eventHud.ts:70-77`, `web/src/statusHud.ts:44-56` (`item.title = row.path`),
`web/src/labels.ts:288` (`actorDisplayName` trims but does not strip),
`web/src/renderer.ts:1529` (`fillText`).

**Reach.** Measured in 0.2: a path containing `U+202E` and `\n` reaches the browser verbatim. In
the DOM, `U+202E` reverses the rendering of everything after it, so a file named
`report` + `U+202E` + `gpj.evil` displays as `reportlive.jpg` — a filename spoof in the
recent-changes list and in the status panel's `title`. This is real today and low-damage today,
because a path is at least a real path. It becomes worth acting on when the text is (feature 2)
an arbitrary model-written sentence, or (feature 3) an OS notification the user reads outside
the page.

**Fix plan — `developer-frontend`.** One pure `sanitizeDisplayText(text)` — fold C0/C1 controls
to a space, strip `U+202A`..`U+202E` / `U+2066`..`U+2069` / `U+200F`, never throw — living
beside `splitPath` in `eventLog.ts` or in `labels.ts`, whichever the plan makes the home of
display text. Applied by `actorDisplayName`, by the new `todoCaption`, by the notification
builder, and by the event and status rows. **Not** applied to the path used as a key, an
identity or a request argument: sanitising a path before sending it back to the daemon would
break the file click for a legitimately odd filename.

**Test to write first — `developer-tester`.** RED (pure): `sanitizeDisplayText` of a string
containing `U+202E`, `U+2066`, a newline and a form feed returns a string containing none of
them, of the same or shorter length; and a plain ASCII path round-trips byte for byte.

---

### M6 — A stats command needs a refusal path and an echo field named now, not later

**Severity: medium.** Design, not exploit; getting it wrong produces a wedged panel and a silent
`rootError`.

**Location:** `daemon/server.py:494` (`COMMAND_KINDS`), `:498-552` (`parse_command`),
`:757-810` (`handle_command`), `web/src/protocol.ts`.

**Reach.** If feature 4 is answered by the daemon, it is a sixth `COMMAND_KIND`. The gates in
`_handle_ws_client` are applied uniformly to every parsed command, so the kind inherits both
gates **for free** — provided it is added to `COMMAND_KINDS` and returns from its own branch in
`parse_command`. That is the one thing to get right. Concretely:

- **Echo field.** A `stats` request names nothing, exactly like `sizes`, so it parses with
  `path: ""` and returns from its own branch **before** the `path` check — never through the
  `setRoot` tail, and never reusing `path` for a filter, because both gates echo
  `command["path"]` in their refusal and the user would be shown a filter quoted as the path
  that was refused.
- **Refusal path.** Two refusals exist and both are `rootError` frames carrying `path: ""` —
  `"remote control disabled"` and `"invalid or missing control token"`. `CLAUDE.md` already
  records that a refused `search` is the fourth silent `rootError` and a refused `sizes` the
  fifth; a refused `stats` is the sixth, and the plan should say so rather than rediscover it.
- **Late answers.** Follow `search`/`sizes`, not `publish_status`: an answer about an abandoned
  root is still **answered**, empty and with a reason. A dropped reply strands the browser's
  `pending` flag with no second reply coming.

**Alternatively — and this is the recommendation — accumulate the stats in the browser.** Every
input the panel needs is already on the wire. That adds **no** command kind, **no** daemon
surface, **no** new frame, and the counters are pure and testable. The only thing it costs is
that a reconnecting client restarts its counters, which is honest: the replay buffer is 200
entries, so a daemon-side counter and a browser-side counter would disagree anyway.

If it is accumulated in the browser: cap the per-agent counter map at the same **32** actors as
M3, and the "most-visited file" tally at **512 paths per agent** with least-recently-seen
eviction — derived from `MAX_BEAMS = 512`, this codebase's existing "how much per-actor history
is worth keeping" number — because a counter keyed on every path an agent ever touched is an
unbounded map fed by the network.

**Test to write first — `developer-tester`.**
- If daemon-side: `parse_command('{"kind":"stats","token":"t"}')` returns
  `{"kind":"stats","path":"","token":"t"}` — exact equality, the way the five existing kinds are
  pinned — and a `stats` frame with a stray `path` parses **identically**.
- If browser-side: RED (pure) the counter map holds at most 32 agents and at most 512 paths per
  agent after 10 000 events, and the most-visited file is still correct for the agent that was
  most recently active.

---

### M7 — The accidental 64 KiB ingest cap may already be dropping real `Write` payloads

**Severity: medium.** Pre-existing, introduced by none of the five, and it constrains H3's
number so the plans need it.

**Location:** `daemon/server.py:1170` (`start_unix_server`, no `limit=`), `:903-919`
(`_handle_ingest_client`).

**Reach.** Measured in 0.5: a 200 KB payload is silently dropped, a 60 KB one is not. A
`PostToolUse` payload for `Write` carries `tool_input`, which for a `Write` plausibly includes
the file's full content. If it does, then **writing a file larger than about 64 KiB produces no
hook event at all** — the write appears only through the watcher, unattributed, and the agent's
figure does not fire a beam for the biggest thing it did. That would be invisible in every test
in the suite, because every fixture payload is small.

I could not settle whether real payloads cross the threshold: this host has no captured payload
with a `content` field, and `RHIZOME_TRACE_LOG` is the instrument `CLAUDE.md` names for exactly
this question.

**Fix plan — `developer-backend`.** Measure first with `RHIZOME_TRACE_LOG` against a real
session writing a large file. Then pass an explicit `limit=` to `start_unix_server` set above
the measured maximum, and log a `debug` line when a line is dropped so the failure stops being
silent. Do not choose the number from arithmetic.

**Test to write first — `developer-tester`.** RED (pytest): a hook payload of N bytes, where N
is above the chosen limit, produces no event **and** produces a log record at `debug` naming the
drop. The second half is the point — the current behaviour is indistinguishable from a daemon
that is not running.

---

## Noted, not worth a change (yet)

- **No `Content-Security-Policy` on the served page.** `_http_response` sets `Content-Type`,
  `Content-Length` and `Cache-Control` only, and `web/index.html` carries no meta CSP. This is
  theoretical today: there is no `innerHTML` sink anywhere in `web/src/` (0.6), and the one
  script the daemon injects is the token. It becomes worth doing the day a painter builds
  markup, and a `default-src 'self'; script-src 'self' 'unsafe-inline'` would also stop H4's
  attacker-chosen `icon` URL. Cheap, but it is hardening, not a reachable defect.
- **No test pins "`textContent`, never `innerHTML`".** The rule is written in a comment in
  `fileViewHud.ts` and followed everywhere. The project pins "no shiki outside `highlight.ts`"
  and "`checkouts.py` starts no process" over parsed source; this rule has the same shape and
  none of the enforcement. Worth a source-level test at the moment feature 2 lands, and not
  before.
- **Socket squatting in `/tmp`.** Any local user can pre-create `/tmp/rhizome-graph.sock`,
  which both denies the daemon its socket (`socket_is_live` raises `IngestSocketInUseError`) and
  captures every hook payload. The sticky bit stops us from unlinking it. Real, pre-existing,
  and the honest fix is a socket under `$XDG_RUNTIME_DIR` — a change with its own compatibility
  story (`RHIZOME_SOCKET` is spelled in every installed settings file), which is a plan of its
  own rather than a rider on any of these five.
- **`Simulation.nodes` and `Renderer.dirLabels` have no cap.** Bounded in practice by
  `DEFAULT_MAX_FILES = 20 000` on the seed, unbounded against a forged event stream. M3 covers
  the actor half, which is the half these features touch.
- **`gitignore.py` compiles `re` from patterns on disk.** A `.gitignore` is a file an agent
  writes, so a pattern with pathological backtracking is reachable by a prompt-injected agent.
  The translation is hand-written and the constructs it emits are mostly linear, and I did not
  find a backtracking blow-up in the time I had. Stated so the next audit can start here rather
  than rediscover it.
- **The label crosses the wire at any length.** Measured: a 5 000-character `agent_type` is
  stored in `_last_hook` and stamped onto every attributed watcher event. `actorDisplayName`
  caps the *display* at 24 characters, so nothing on screen breaks; the cost is wire and
  memory. H2's 256-byte daemon-side cap should be applied to `label` at the same time, since it
  is the same rule.

---

## Per feature, in one paragraph each

**1. Agent lifecycle events — the riskiest of the five.** New untrusted input: four new payload
shapes crossing the ingest socket, none carrying a path, all reaching `_last_hook` today (0.4).
The attacker is the agent itself (prompt-injected by a file it read, and able to run `Bash`) or
any process running as the user. The control token is irrelevant — this data flows toward the
page, not from it — and nothing replaces it, so the only defences available are structural: the
pathless kinds must touch none of `known_paths`, `_recent`, `_hook_paths`, `_fs_paths` or
`_last_hook` (H1), the frame must be routed above `parseEvent` (M1), the actor map must be
bounded (M3), and `--doctor` must learn to read the new hook event keys (M2). No new command
kind. No new file descriptor, no fork, no regex.

**2. TodoWrite caption — the highest-severity single finding.** New untrusted input: arbitrary
model-authored prose, on the socket, on the broadcast, into a canvas. The DOM is safe by
existing practice (`textContent` everywhere, no `innerHTML` in `web/src/`, verified) but that
practice is unpinned; the canvas is unsafe by length, not by markup. The token is irrelevant
again, and here that is the finding: the broadcast has no gate at all and binds every interface
under `start.sh` (C1). Caps: 64 displayed characters, 256 bytes on the wire, controls folded,
bidi stripped. The caption is a per-actor slot, never an `Event`, never in `_recent`.

**3. Attention rules — the feature whose shape decides its severity.** Page-side rules add
nothing to the daemon and are the recommendation. A daemon-side config file is a new file read
(FIFO rule, cap, and it must not live where an agent writes) and a new pattern language; a
page-side command is a sixth `COMMAND_KIND` that inherits both gates by construction. The
notification is the sharp part: it renders outside the page, the attacker chooses its text, and
the secure-context requirement silently removes it for LAN viewers. Rate-limit it, template it,
and never build an `icon` URL from event data.

**4. Session stats — nearly a non-event if kept in the browser.** Every input is already on the
wire. Daemon-side it becomes a sixth command with a refusal path and an echo field to get right
(M6); browser-side it is two bounded maps and a pure reducer. The one real risk either way is
unbounded counters keyed on network-supplied strings.

**5. Ambient sound — the non-event, with two sharp edges.** No new input crosses any boundary;
everything it consumes is already parsed and validated. The edges are the 20 000-event seed
replay (M4) and the per-agent voice on an unbounded actor map (M3). Both are ordinary capacity
bugs with numbers attached, and neither is a security property.

---

## What I checked and found clean

- **`rhizome_graph/token.py`.** `token_matches` refuses the empty expected token before
  `compare_digest`, refuses non-`str` and `bool`, and catches the `TypeError` a non-ASCII `str`
  raises. `inject_token` escapes `<`, `>` and `&` after `json.dumps`. Nothing in the five
  features touches it, and nothing in them needs a second credential.
- **`parse_command` and the two gates.** The gates in `_handle_ws_client` are applied to every
  parsed command uniformly, before dispatch, so a new kind added to `COMMAND_KINDS` inherits
  both by construction. There is no per-kind gate to forget. The one way to get this wrong is
  to answer a frame *outside* `handle_command`, and nothing in the five features needs to.
- **`resolve_inside` and `_read_path`.** Untouched by all five: none of these features carries
  a path from the network into an open descriptor. Feature 3 is the only one that could, if its
  rule config becomes a file the daemon reads (H5), and that is the one route to close.
- **`gitcmd.py`.** No feature here forks `git`. Argv construction, the `--` separators and the
  kill-close-wait timeout path are unchanged and I found nothing new against them.
- **`safe_read.py`.** The FIFO defence is correct and is the right chokepoint for H5's config
  file. `read_capped` opens `O_NONBLOCK`, checks the type on the **descriptor**, clears the flag
  and reads one byte past the cap.
- **The DOM painters.** All ten set `textContent`; there is no HTML sink in `web/src/`. Feature
  2 is not an XSS unless someone introduces one, and the fix plan says the rule out loud so the
  plan carries it.
- **`_resolve_static_file`.** Unquotes, joins, `resolve()`s and checks containment with a
  `parents` test; unchanged by these features.
- **`merge_hook_block`.** Already generic over hook events and already idempotent, so feature 1's
  new event keys install and re-install cleanly. Only `diagnose` is behind (M2).

---

## What I did not cover

- **I ran neither suite.** `pytest` is not importable from `/usr/bin/python3` or from
  `.venv/bin/python` on this host, so I have no observation of the 1498 backend tests or the
  1287 frontend ones. Every claim about current behaviour above is either a line I read or a
  probe I ran; none of it is "the suite says so".
- **Nothing was seen in a browser.** This host has none, as `CLAUDE.md` records. Everything
  about the notification surface (H4) — secure-context behaviour, the user-activation
  requirement, how a truncated body renders on each platform — is read from the specifications
  and from the served origin, not observed. The canvas-width failure in H2 is arithmetic from
  `makeLabelTexture` plus known browser limits; I did not reproduce a lost GL context.
- **The real hook payload shapes are unmeasured.** I have no captured `PostToolUse` payload
  carrying a `content` field, and no `Notification` / `Stop` / `SubagentStop` / `Task` payload
  at all. Every claim about what those carry is from `CLAUDE.md`'s own measured note plus the
  documented hook events. M7 in particular cannot be settled without `RHIZOME_TRACE_LOG` on a
  real session, and feature 1's whole payload shape should be re-measured that way before the
  plan freezes any field name.
- **I did not read or audit the five plan documents.** They were being written in parallel; this
  audit is against the feature descriptions I was given.
- **Dependency trees were not re-read.** `npm ls` and `npm audit` were not run; the lockfile
  `libc`-stripping note in `CLAUDE.md` stands unverified for this branch. None of the five
  features as described adds a runtime dependency, which is why I spent the time elsewhere — but
  feature 5 (WebAudio) and feature 3 (notifications) are exactly the kind of feature a developer
  reaches for a library for, and the hook remains stdlib-only by rule, so any import added to
  `rhizome_graph/hook.py` for feature 1 or 2 is both a performance and a supply-chain finding on
  its own.
