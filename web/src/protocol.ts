/**
 * Wire protocol for events pushed from the backend over the WebSocket.
 *
 * STUB written by the tester agent for the RED phase of TDD. The `AgentEvent`
 * type fixes the shared contract; `parseEvent` is left unimplemented so the
 * specifying tests fail for the right reason. Implementation belongs to
 * `developer-frontend`.
 */

/**
 * Operation kind: Added, Modified, Deleted, Read.
 *
 * `R` is not a change — nothing on disk moved — but it is what an agent spends
 * most of its tool calls doing, and a graph that ignores it shows a dead tree
 * while an agent walks a package it never writes to. It travels the same socket
 * with the violet `AA66FF`, and every layer downstream keeps it apart from the
 * three kinds that DO alter the project.
 */
export type EventType = "A" | "M" | "D" | "R";

/**
 * What produced the event.
 *
 * `hook`  — a Claude Code tool call: live activity with a known agent.
 * `seed`  — part of the project tree snapshot the daemon sends on connect.
 *           Backdrop: it must not flash, and it belongs to no agent.
 * `watch` — a change the filesystem watcher saw. Real activity, but the agent
 *           may be empty when it could not be attributed to one.
 */
export type EventOrigin = "hook" | "seed" | "watch";

/**
 * A single activity event as received from the backend.
 *
 * Matches the JSON broadcast contract:
 * `{ ts, agent, type, path, color }` where `color` is a hex string without `#`.
 */
export interface AgentEvent {
  /** Unix time in seconds (float). */
  ts: number;
  /** Actor id (the backend's session-derived agent); `""` when unattributed. */
  agent: string;
  /** Operation kind. */
  type: EventType;
  /** Path relative to the observed project root. */
  path: string;
  /** Hex color without a leading `#` (A->33FF33, M->FFAA00, D->FF3333). */
  color: string;
  /** Where the event came from. Absent on the wire means `"hook"`. */
  origin: EventOrigin;
  /**
   * Human-readable name of the actor (the hook's `agent_type`, e.g.
   * `"developer-backend"`), for DISPLAY only. Never an identity: `agent`
   * remains the actor key and the seed of its color, so two subagents of the
   * same type stay two figures. Absent on the wire means `""`, which is also
   * the legitimate orchestrator case (its payload carries no `agent_type`).
   */
  label: string;
  /**
   * Whether this path matched the user's attention rules, as the DAEMON judged
   * it: the rules live in a file under the observed root, are compiled there,
   * and never travel to the browser. The verdict rides the event that already
   * names the path, because a second frame would have to name it again and
   * would arrive out of order, turning this page into a join.
   *
   * The key is CONDITIONAL on the wire, present only when it is `true`, so
   * "absent" is the overwhelmingly common case and degrades to `false` here.
   */
  attention: boolean;
}

/**
 * The four valid operation kinds, used for runtime validation.
 *
 * The set stays CLOSED: `R` was added as a member, not by relaxing the check
 * into "any single letter". A lowercase `r`, a `READ`, or a stray `"R "` from a
 * daemon speaking another dialect must still be refused, or the junk reaches the
 * simulation and grows a node in the graph.
 */
const EVENT_TYPES: ReadonlySet<string> = new Set<EventType>(["A", "M", "D", "R"]);

/** Valid origins. Anything else on the wire degrades to `"hook"`. */
const EVENT_ORIGINS: ReadonlySet<string> = new Set<EventOrigin>(["hook", "seed", "watch"]);

/** Type guard narrowing an unknown value to a plain (non-array) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is a real finite number (rejects NaN and strings). */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate and parse a raw WebSocket message into an {@link AgentEvent}.
 *
 * Contract (see tests/protocol.test.ts):
 *   - Returns a fully-typed `AgentEvent` for a well-formed message.
 *   - Returns `null` for a non-object, a missing/mistyped field, or an invalid
 *     `type` value.
 *   - An absent or unrecognized `origin` degrades to `"hook"` rather than
 *     rejecting the event, so a page served from a newer or older daemon than
 *     the one broadcasting still draws everything it receives.
 *   - An absent or mistyped `attention` degrades to `false` by the same rule,
 *     and the direction is deliberate. The fail-safe direction of an alarm is
 *     the loud one, but a page that alarmed on a malformed frame would alarm
 *     about nothing the user ever wrote, which is worse than silence: it
 *     teaches the reader to ignore the marker. A truthy non-boolean (`"yes"`,
 *     `1`) is therefore `false`, and the frame itself is never dropped over it
 *     — the event is a real change to a real file.
 *   - An absent or mistyped `label` degrades to `""` for the same reason: it is
 *     display text, never a reason to drop a frame. A page built against the
 *     daemon that broadcasts it still draws every event from one that does not
 *     (and vice versa) — just without a readable name for the actor.
 *   - NEVER throws: bad input from the network must be handled gracefully.
 *
 * @param raw The value received from the socket (already JSON-parsed or not).
 */
export function parseEvent(raw: unknown): AgentEvent | null {
  if (!isRecord(raw)) return null;

  const { ts, agent, type, path, color, origin, label, attention } = raw;

  if (!isFiniteNumber(ts)) return null;
  if (typeof agent !== "string") return null;
  if (typeof path !== "string") return null;
  if (typeof color !== "string") return null;
  if (typeof type !== "string" || !EVENT_TYPES.has(type)) return null;

  const resolvedOrigin =
    typeof origin === "string" && EVENT_ORIGINS.has(origin)
      ? (origin as EventOrigin)
      : "hook";

  return {
    ts,
    agent,
    type: type as EventType,
    path,
    color,
    origin: resolvedOrigin,
    label: typeof label === "string" ? label : "",
    attention: typeof attention === "boolean" ? attention : false,
  };
}

/**
 * What the daemon is observing, announced on the same socket as the events.
 *
 * Discriminated from {@link AgentEvent} by a `kind: "meta"` field the events do
 * not carry, so neither parser can accept the other's frame.
 */
export interface DaemonMeta {
  /** The observed project root, as the daemon wants it displayed. */
  root: string;
  /** Current git branch, or `null` when the root is not a git repository. */
  branch: string | null;
}

/**
 * Validate and parse a raw WebSocket message into a {@link DaemonMeta}.
 *
 * Contract (see tests/meta.test.ts):
 *   - Returns `null` for a non-object, for a missing/mistyped `root`, and for
 *     anything whose `kind` is not exactly `"meta"` (which is what keeps an
 *     activity event out).
 *   - A missing or mistyped `branch` degrades to `null` instead of rejecting
 *     the frame: `null` is the legitimate not-a-git-repo case anyway, and a
 *     page served by an older daemon must still show the path.
 *   - NEVER throws.
 *
 * @param raw The value received from the socket (already JSON-parsed or not).
 */
export function parseMeta(raw: unknown): DaemonMeta | null {
  if (!isRecord(raw)) return null;

  const { kind, root, branch } = raw;

  if (kind !== "meta") return null;
  if (typeof root !== "string") return null;

  return { root, branch: typeof branch === "string" ? branch : null };
}

/**
 * The daemon's answer to a Tab in the root bar.
 *
 * The browser cannot read the disk, so completion is a round trip: the reply
 * lands milliseconds later, while the user keeps typing. `path` is the text the
 * reply ANSWERS, and it is what lets the client recognise a stale one instead of
 * overwriting the characters typed in between.
 */
export interface RootCompletion {
  /** The text that was sent to be completed. */
  path: string;
  /** What it expands to (unchanged when nothing more is unambiguous). */
  completed: string;
  /** Directories the prefix still allows. A hint: may legitimately be empty. */
  matches: string[];
}

/** The daemon switched roots: empty the graph, the new tree is coming. */
export interface RootReset {
  /** The root now being observed; `""` when the frame did not name one. */
  root: string;
}

/** The daemon refused a typed root, with a reason to show the user. */
export interface RootError {
  /** The path that was refused. */
  path: string;
  /** Why, as the daemon put it; `""` when it did not say. */
  reason: string;
}

/**
 * Validate and parse a raw WebSocket message into a {@link RootCompletion}.
 *
 * Contract (see tests/rootProtocol.test.ts):
 *   - `kind` must be exactly `"completion"`, which is what keeps every other
 *     frame on this socket out.
 *   - `path` and `completed` are required: without `completed` there is nothing
 *     to adopt, and without `path` the reply cannot be matched to the field.
 *   - `matches` is a HINT, so it degrades to `[]` when absent or not an array,
 *     and non-string items are dropped one by one — a candidate that is not a
 *     string reaches the DOM as "[object Object]", but the rest of the list is
 *     still worth showing, and the `completed` path is worth adopting either way.
 *   - NEVER throws.
 */
export function parseCompletion(raw: unknown): RootCompletion | null {
  if (!isRecord(raw)) return null;

  const { kind, path, completed, matches } = raw;

  if (kind !== "completion") return null;
  if (typeof path !== "string") return null;
  if (typeof completed !== "string") return null;

  const candidates = Array.isArray(matches)
    ? matches.filter((item): item is string => typeof item === "string")
    : [];

  return { path, completed, matches: candidates };
}

/**
 * Validate and parse a raw WebSocket message into a {@link RootReset}.
 *
 * Contract (see tests/rootProtocol.test.ts):
 *   - Only `kind: "reset"` is accepted; anything else returns null, so an
 *     activity event never wipes the graph and a `meta` frame (one word away,
 *     and it also carries a `root`) never does either.
 *   - A missing or mistyped `root` degrades to `""` instead of rejecting the
 *     frame. This is stronger than `parseMeta`'s degradation and deliberate:
 *     dropping a reset leaves the old project's nodes on screen while the new
 *     project's tree streams in on top of them — two trees in one graph, with no
 *     event that will ever delete the first. Clearing under a nameless root is
 *     recoverable (the next `meta` names it); not clearing is not.
 *   - NEVER throws.
 */
export function parseReset(raw: unknown): RootReset | null {
  if (!isRecord(raw)) return null;
  if (raw.kind !== "reset") return null;

  return { root: typeof raw.root === "string" ? raw.root : "" };
}

/**
 * Validate and parse a raw WebSocket message into a {@link RootError}.
 *
 * Contract (see tests/rootProtocol.test.ts):
 *   - `kind` must be exactly `"rootError"` and `path` must be there: a refusal
 *     that names no attempt cannot be matched to what the user typed.
 *   - A missing or mistyped `reason` degrades to `""` rather than swallowing the
 *     refusal — dropping it would close the bar as if the root had been
 *     accepted, leaving the graph on the old project pretending to be the new.
 *   - NEVER throws.
 */
export function parseRootError(raw: unknown): RootError | null {
  if (!isRecord(raw)) return null;

  const { kind, path, reason } = raw;

  if (kind !== "rootError") return null;
  if (typeof path !== "string") return null;

  return { path, reason: typeof reason === "string" ? reason : "" };
}

/**
 * How the daemon chose to render the file it was asked for.
 *
 * The fallback chain: the `git diff` of the file, else its text, else a hex dump
 * when it is binary.
 */
export type FileViewMode = "diff" | "text" | "hex";

/** The three modes the panel knows how to draw. Anything else degrades to text. */
const FILE_VIEW_MODES: ReadonlySet<string> = new Set<FileViewMode>(["diff", "text", "hex"]);

/**
 * The daemon's answer to a click on a file.
 *
 * The browser cannot read the disk, so the content is a round trip on the same
 * socket the events arrive on. `path` is the file the frame ANSWERS, and it is
 * what lets the client recognise a reply for a file it has stopped showing.
 */
export interface FileView {
  /** The file this answer is about, relative to the observed root. */
  path: string;
  /** How to render {@link content}. */
  mode: FileViewMode;
  /** The diff, the text or the hex dump; `""` when the read failed. */
  content: string;
  /** Whether the daemon cut the output short. */
  truncated: boolean;
  /** Why the daemon could not show the file, or `""` when it could. */
  error: string;
}

/**
 * Validate and parse a raw WebSocket message into a {@link FileView}.
 *
 * Contract (see tests/fileViewProtocol.test.ts):
 *   - `kind` must be exactly `"fileView"` and `path` must be a string: an answer
 *     naming no file cannot be matched to the click that asked for it, and
 *     `applyView` would paint one file's diff under another file's name.
 *   - everything else DEGRADES rather than costing the frame, as `parseMeta`'s
 *     `branch` does. An unusable `mode` from a newer daemon falls back to
 *     `"text"` — the one rendering that is never actively wrong — a missing
 *     `content` or `error` to `""`, and a non-boolean `truncated` to `false`, so
 *     an "output cut" notice never lands on content that is whole. Dropping the
 *     frame instead would leave the panel spinning on `loading` forever, because
 *     no second reply is coming for that click.
 *   - NEVER throws.
 */
export function parseFileView(raw: unknown): FileView | null {
  if (!isRecord(raw)) return null;

  const { kind, path, mode, content, truncated, error } = raw;

  if (kind !== "fileView") return null;
  if (typeof path !== "string") return null;

  return {
    path,
    mode: typeof mode === "string" && FILE_VIEW_MODES.has(mode) ? (mode as FileViewMode) : "text",
    content: typeof content === "string" ? content : "",
    truncated: truncated === true,
    error: typeof error === "string" ? error : "",
  };
}

/**
 * One file the daemon found the query in, and how often.
 *
 * `count` is the daemon's number, not the browser's: the walk indexes into it
 * and the counter sums it, so it is a non-negative integer or the entry is not
 * worth having (see {@link parseSearchResult}).
 */
export interface FileMatchCount {
  /** Path relative to the observed root. */
  path: string;
  /** How many occurrences the daemon counted in that file. */
  count: number;
}

/**
 * The daemon's answer to a content search, pushed on the same socket as events.
 *
 * The browser cannot read the disk, so "which files mention this?" is a ROUND
 * TRIP: the page submits a query and this frame comes back. `query` is the
 * submission this frame ANSWERS, and it is what lets the state machine drop an
 * answer to a query the user has already typed over.
 */
export interface SearchResult {
  /** The query this answer is about; `""` is a value the daemon really sends. */
  query: string;
  /** The files it matched, in the order the daemon walked them. */
  files: FileMatchCount[];
  /** Whether the daemon cut the walk short. */
  truncated: boolean;
  /** Why the daemon could not answer, or `""` when it could. */
  error: string;
}

/** Whether `value` is a count the walk can index with: a non-negative integer. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Validate and parse a raw WebSocket message into a {@link SearchResult}.
 *
 * Contract (see tests/searchProtocol.test.ts):
 *   - `kind` must be exactly `"searchResult"`. The gate is load-bearing in both
 *     directions, as `parseStatus`'s is: an answer routed as activity would grow
 *     a node called "searchResult" in the graph, and an activity event mistaken
 *     for an answer would replace the counts of a real submission.
 *   - `query` is the one field whose absence costs the frame, exactly as `path`
 *     costs {@link parseFileView} its frame. An answer naming no query cannot be
 *     matched to the submission that asked for it, and the supersede guard IS
 *     that comparison. `""` is a legitimate value, not an absence.
 *   - `files` DEGRADES the way `parseStatus`'s `entries` does: absent or
 *     mistyped becomes `[]`, and a junk item is dropped ONE AT A TIME. An entry
 *     needs a string `path` (a row naming no file cannot be opened) and a count
 *     that is a non-negative integer — half an occurrence has no position to
 *     walk to, and a negative or non-finite one shifts every later file's global
 *     index, sending the walk to the wrong FILE rather than the wrong line.
 *   - `truncated` and `error` fall back to `false` and `""`. Dropping the frame
 *     over them would leave the bar pending forever on a reply that did arrive.
 *   - Order is preserved; the walk belongs to `contentSearch.ts`.
 *   - NEVER throws: this comes off the network.
 */
export function parseSearchResult(raw: unknown): SearchResult | null {
  if (!isRecord(raw)) return null;
  if (raw.kind !== "searchResult") return null;
  if (typeof raw.query !== "string") return null;

  const files: FileMatchCount[] = [];
  if (Array.isArray(raw.files)) {
    for (const item of raw.files) {
      if (!isRecord(item)) continue;
      const { path, count } = item;
      if (typeof path !== "string") continue;
      if (!isCount(count)) continue;
      files.push({ path, count });
    }
  }

  return {
    query: raw.query,
    files,
    truncated: raw.truncated === true,
    error: typeof raw.error === "string" ? raw.error : "",
  };
}

/**
 * One file the daemon measured, and how many bytes it holds.
 *
 * `bytes` is a non-negative integer for the same reason {@link FileMatchCount}'s
 * `count` is: it is fed to a logarithmic scale and a colour ramp, so half a byte
 * has no meaning and a negative or non-finite one poisons the percentiles the
 * whole ramp is hinged on — one bad entry would recolour every file in the tree.
 */
export interface FileSizeEntry {
  /** Path relative to the observed root. */
  path: string;
  /** The file's size on disk, in bytes. */
  bytes: number;
}

/**
 * The daemon's answer to "how big is everything?", pushed on the event socket.
 *
 * The browser cannot stat the disk, so the size mode is a ROUND TRIP: the page
 * asks and this frame comes back. Unlike {@link SearchResult} it echoes NOTHING
 * — there is no query to supersede — which is why it has no hard field beyond
 * its kind.
 */
export interface SizesResult {
  /** The files it measured, in the order the daemon walked them. */
  files: FileSizeEntry[];
  /** Whether the daemon cut the walk short. */
  truncated: boolean;
  /** Why the daemon could not answer, or `""` when it could. */
  error: string;
}

/**
 * Validate and parse a raw WebSocket message into a {@link SizesResult}.
 *
 * Contract (see tests/sizeProtocol.test.ts):
 *   - `kind` must be exactly `"sizes"`, load-bearing in both directions like
 *     {@link parseSearchResult}'s: an answer routed as activity would grow a
 *     node called "sizes" in the graph — once per press, permanently — and an
 *     activity event mistaken for an answer would recolour the whole tree from
 *     a single path.
 *   - THERE IS NO HARD FIELD BEYOND `kind`, and that is the one deliberate
 *     difference from {@link parseSearchResult}. That parser requires a string
 *     `query` because the comparison IS its supersede guard; a `sizes` answer
 *     echoes nothing, so nothing's absence should cost the frame. A frame with
 *     an empty `files` is a real answer — an empty project — and dropping it
 *     would leave the mode pending forever, with nothing left on screen to
 *     explain why the key does nothing.
 *   - `files` DEGRADES as `parseStatus`'s `entries` does: absent or mistyped
 *     becomes `[]`, and a junk item is dropped ONE AT A TIME. An entry needs a
 *     string `path` (a size naming no file colours nothing) and a `bytes`
 *     validated by the EXISTING {@link isCount} — it already means exactly "a
 *     non-negative integer", and a second predicate beside it would be a second
 *     definition of the same rule, free to drift.
 *   - `truncated` and `error` fall back to `false` and `""`. Dropping the frame
 *     over them would wedge the mode on a reply that did arrive.
 *   - Order is preserved; the scale and the ramp belong elsewhere.
 *   - NEVER throws: this comes off the network.
 */
export function parseSizes(raw: unknown): SizesResult | null {
  if (!isRecord(raw)) return null;
  if (raw.kind !== "sizes") return null;

  const files: FileSizeEntry[] = [];
  if (Array.isArray(raw.files)) {
    for (const item of raw.files) {
      if (!isRecord(item)) continue;
      const { path, bytes } = item;
      if (typeof path !== "string") continue;
      if (!isCount(bytes)) continue;
      files.push({ path, bytes });
    }
  }

  return {
    files,
    truncated: raw.truncated === true,
    error: typeof raw.error === "string" ? raw.error : "",
  };
}

/**
 * How git sees a path that is not committed yet.
 *
 * The four words this page knows how to draw. A newer daemon reporting a fifth
 * (a rename, say) is not an error — the row is simply dropped, see
 * {@link parseStatus}.
 */
export type GitStatusState = "untracked" | "modified" | "added" | "deleted";

/** The four states, for runtime validation. Anything else drops its row. */
const GIT_STATUS_STATES: ReadonlySet<string> = new Set<GitStatusState>([
  "untracked",
  "modified",
  "added",
  "deleted",
]);

/** One uncommitted path, exactly as the daemon reported it. */
export interface GitStatusEntry {
  /** Path relative to the observed root; not normalized here. */
  path: string;
  /** What git says about it. */
  state: GitStatusState;
}

/**
 * The working tree's uncommitted changes, pushed on the same socket as events.
 *
 * The browser cannot read the disk (nor run `git`), so "what is dirty right
 * now?" is answered by the daemon and repolled. Discriminated from every other
 * frame on this socket by `kind: "status"`.
 */
export interface GitStatus {
  /** Whether the observed root is a git repository at all. */
  repo: boolean;
  /** Whether the daemon cut the list short. */
  truncated: boolean;
  /** The dirty paths, in the order the daemon walked them. */
  entries: GitStatusEntry[];
}

/**
 * Validate and parse a raw WebSocket message into a {@link GitStatus}.
 *
 * Contract (see tests/statusProtocol.test.ts):
 *   - `kind` must be exactly `"status"`. The gate matters in both directions: a
 *     status frame routed as activity would grow a node called "status" in the
 *     graph, and an activity event mistaken for a status frame would repaint the
 *     whole panel from one file save.
 *   - `entries` DEGRADES, as `parseCompletion`'s `matches` does: absent or
 *     mistyped it becomes `[]`, and a junk item is dropped ONE AT A TIME rather
 *     than costing the frame. This is the load-bearing choice here. A newer
 *     daemon that adds a fifth state would otherwise blank the panel for the
 *     four files this page does understand — and an empty panel does not read as
 *     "I could not parse one row", it reads as "the tree is clean", which is a
 *     bigger lie than a partial list.
 *   - `repo` and `truncated` are booleans or they are `false`: a truthy
 *     non-boolean would claim the output was cut when it was whole, or claim a
 *     git repository where there is none.
 *   - Order is preserved; sorting and capping belong to `statusList.ts`.
 *   - NEVER throws: this comes off the network.
 */
export function parseStatus(raw: unknown): GitStatus | null {
  if (!isRecord(raw)) return null;
  if (raw.kind !== "status") return null;

  const entries: GitStatusEntry[] = [];
  if (Array.isArray(raw.entries)) {
    for (const item of raw.entries) {
      if (!isRecord(item)) continue;
      const { path, state } = item;
      if (typeof path !== "string") continue;
      if (typeof state !== "string" || !GIT_STATUS_STATES.has(state)) continue;
      entries.push({ path, state: state as GitStatusState });
    }
  }

  return { repo: raw.repo === true, truncated: raw.truncated === true, entries };
}

/** Marker standing in for the elided middle of a truncated string. */
const ELISION = "…";

/**
 * Shorten `text` to at most `max` characters by eliding its MIDDLE.
 *
 * Clipping the tail (what CSS ellipsis does) would throw away the segment that
 * names the project — every checkout under `~/projects` renders identically.
 * Head and tail both survive here; the cut lands between them.
 *
 * When it has to cut, the result is exactly `max` characters long. `max <= 0`,
 * `NaN`, and empty text all yield `""` rather than throwing.
 */
export function truncateMiddle(text: string, max: number): string {
  if (text.length === 0) return "";
  if (!Number.isFinite(max) || max <= 0) return "";

  const limit = Math.floor(max);
  if (text.length <= limit) return text;
  if (limit <= ELISION.length) return text.slice(0, limit);

  const keep = limit - ELISION.length;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;

  return text.slice(0, head) + ELISION + (tail > 0 ? text.slice(text.length - tail) : "");
}

/**
 * What an agent is doing right now, as the daemon spells it on the wire.
 *
 * A closed set of three, and `working` is a VALUE rather than an absence: "the
 * agent was waiting and is not any more" has to be sayable, or a frame deduped
 * on its encoding could never report the end of a wait.
 */
export type AgentStateWord = "working" | "waiting" | "stopped";

/** The three words, for runtime validation. Anything else degrades to `working`. */
const AGENT_STATE_WORDS: ReadonlySet<string> = new Set<AgentStateWord>([
  "working",
  "waiting",
  "stopped",
]);

/**
 * One agent, exactly as the daemon reported it.
 *
 * Keeps the WIRE's word in `state`, the way {@link GitStatusEntry} does: the
 * translation into the model's own vocabulary belongs to `agentState.ts`, so a
 * parser stays a parser and holds no second opinion about what a phase is.
 */
export interface AgentStateEntry {
  /** The actor key — identity, and the seed of the figure's colour. */
  agent: string;
  /** The readable agent type, for DISPLAY only; `""` for the orchestrator. */
  label: string;
  /** What the daemon says the agent is doing. */
  state: AgentStateWord;
  /** A short line about what it is doing, or `""` when the daemon sent none. */
  caption: string;
  /** Wall-clock seconds when the daemon last heard from this agent. */
  ts: number;
}

/**
 * The daemon's whole picture of its actors, pushed on the event socket.
 *
 * Cumulative, never a delta: what the frame does not name is not there. A delta
 * would need an ordering guarantee across a reconnect and a rule for a client
 * that missed one; a full picture in a deduped slot needs neither.
 */
export interface AgentStates {
  /** The agents it knows about, in the order the daemon listed them. */
  agents: AgentStateEntry[];
}

/**
 * Validate and parse a raw WebSocket message into an {@link AgentStates}.
 *
 * Contract (see tests/agentStateProtocol.test.ts):
 *   - `kind` must be exactly `"agentState"`, load-bearing in both directions
 *     like {@link parseSizes}'s: an answer about actors routed as activity
 *     would grow a node called "agentState" in the tree, and an activity event
 *     mistaken for an answer would repaint every figure from one file save.
 *   - THERE IS NO HARD FIELD BEYOND `kind`. A frame naming no agents is a real
 *     answer — nobody is waiting, everybody has left — and dropping it would
 *     leave the last picture's rings latched on figures the daemon has stopped
 *     reporting.
 *   - `agents` DEGRADES as `parseStatus`'s `entries` does: absent, `null` or
 *     mistyped becomes `[]`, and a junk item is dropped ONE AT A TIME. An entry
 *     needs a USABLE `agent` — a string that is not empty and not blank, since
 *     it is the identity the whole model is keyed on and an empty one must
 *     never create an actor — and a finite `ts` (staleness is computed from it, and a `NaN` compares
 *     false against every cut, so such an entry would be neither fresh nor
 *     stale — a ring nothing could ever retire). Either one missing drops that
 *     entry ALONE.
 *   - An unrecognised `state` degrades to `"working"` rather than dropping the
 *     entry: a daemon one version newer naming a fourth phase still tells the
 *     truth about who that agent IS and when it was last heard from.
 *   - `label` and `caption` are display text and degrade to `""`. `caption` is
 *     declared by this feature and filled by the sibling todo-caption one, so
 *     its absence must cost nothing today.
 *   - Order is preserved: it is the daemon's statement about its own actors,
 *     and re-sorting here would be a second opinion held by the parser.
 *   - NEVER throws: this comes off the network.
 */
export function parseAgentStates(raw: unknown): AgentStates | null {
  if (!isRecord(raw)) return null;
  if (raw.kind !== "agentState") return null;

  const agents: AgentStateEntry[] = [];
  if (Array.isArray(raw.agents)) {
    for (const item of raw.agents) {
      if (!isRecord(item)) continue;
      const { agent, label, state, caption, ts } = item;
      if (typeof agent !== "string") continue;
      // An empty — or blank — agent never creates an actor: it would enter the
      // model under an empty key and, if it said `waiting`, earn a ring on a
      // figure nobody is behind. The daemon cannot name one either, since
      // `normalize._usable_text` strips before `actor_of` answers. It does not
      // send one today; this parser is where that guarantee stops, because what
      // arrives here came off the network. Drops this entry ALONE, the way a
      // non-finite `ts` does.
      if (agent.trim() === "") continue;
      if (!isFiniteNumber(ts)) continue;
      agents.push({
        agent,
        label: typeof label === "string" ? label : "",
        state:
          typeof state === "string" && AGENT_STATE_WORDS.has(state)
            ? (state as AgentStateWord)
            : "working",
        caption: typeof caption === "string" ? caption : "",
        ts,
      });
    }
  }

  return { agents };
}

/**
 * Which attention rules the daemon loaded, and which it could not.
 *
 * This frame exists for one failure mode, and it is the sharpest one in the
 * feature. The matcher refuses a pattern it cannot translate correctly — a
 * POSIX bracket class, an over-long pattern, anything the regex engine will not
 * compile — and where that refusal shows MORE files in the module it was
 * written for, here it shows LESS: a user protecting private keys writes a
 * bracket class, the pattern is dropped, and the panel then stays empty, which
 * is the same picture as a well-behaved session. A supervision feature whose
 * failure mode is indistinguishable from success is not a supervision feature.
 *
 * So the daemon states, always and not only on failure, which file the rules
 * came from, how many are in force, and which patterns it refused. `source` is
 * `""` when no rule file was found at all — a case that must stay tellable from
 * a file that was found and held nothing.
 */
export interface AttentionRulesFrame {
  /** The rule file the daemon read, or `""` when it found none. */
  source: string;
  /** How many patterns are actually in force. */
  count: number;
  /** The patterns it refused, verbatim, so the panel can quote them. */
  refused: string[];
  /** Whether the rule file was longer than the daemon would read. */
  truncated: boolean;
}

/**
 * Validate and parse a raw WebSocket message into an {@link AttentionRulesFrame}.
 *
 * Contract (see tests/attentionProtocol.test.ts):
 *   - `kind` must be exactly `"attention"`, load-bearing in both directions
 *     like {@link parseSizes}'s: a rule report routed as activity would grow a
 *     node called "attention" in the graph, and an activity event mistaken for
 *     a rule report would rewrite the panel's header from one file save.
 *   - THERE IS NO HARD FIELD BEYOND `kind`, as in {@link parseAgentStates}. A
 *     frame naming no source IS the answer this feature most needs to show, and
 *     dropping it would leave the panel unable to tell "no rule file" from "a
 *     file full of rules that matched nothing".
 *   - `count` must be a non-negative integer or it is `0`: it is a statement
 *     about how much supervision is in force, and a `NaN` or a string would be
 *     printed at the reader as if it meant something.
 *   - `refused` DEGRADES as `parseStatus`'s `entries` does: absent or mistyped
 *     becomes `[]`, and a junk item is dropped ONE AT A TIME. A partial list is
 *     worth more than none here, because an empty refusal list does not read as
 *     "I could not parse one item", it reads as "nothing was refused" — exactly
 *     the lie this frame exists to prevent. Order is the daemon's.
 *   - `truncated` is a boolean or it is `false`.
 *   - NEVER throws: this comes off the network.
 */
export function parseAttentionRules(raw: unknown): AttentionRulesFrame | null {
  if (!isRecord(raw)) return null;
  if (raw.kind !== "attention") return null;

  const refused: string[] = [];
  if (Array.isArray(raw.refused)) {
    for (const item of raw.refused) {
      if (typeof item === "string") refused.push(item);
    }
  }

  return {
    source: typeof raw.source === "string" ? raw.source : "",
    count: isCount(raw.count) ? raw.count : 0,
    refused,
    truncated: raw.truncated === true,
  };
}
