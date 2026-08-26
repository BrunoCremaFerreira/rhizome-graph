"""Git's ignore syntax, and only that: does this pattern match this path?

This project has never had to answer an ignore-syntax question. `tree.py` keeps
a *name blocklist*, `repo.py` reads a dozen bytes of `HEAD`, `status.py` parses
porcelain output, `checkouts.py` looks for working trees. None of them parses a
pattern, and the consequence is the complaint this module exists for: every
dotted directory is pruned by name, so a project's committed `.claude/` and
`.github/` can never reach the graph, while the one file that actually says what
is not worth drawing is never opened at all.

**Why this is its own module.** Not `tree.py`: that is the boot snapshot, it runs
again on every root switch, on every content search and on every size pass, and
its whole docstring is about a blocklist of names. Not `repo.py`: that is the
upward walk and its "files, never `subprocess`" doctrine. Not `status.py`:
nothing here is the porcelain format. The next change to this feature is
nameable -- a locally-excluded file honoured, case-insensitive matching on a
case-insensitive filesystem, a cap raised -- and in a module of its own each of
those is one function and one constant, rather than an edit to the module three
others walk through.

**It answers git's question and no rhizome policy.** Which directories are
generated noise, and which single directory is excluded no matter what any
pattern says, are decisions that live in the *caller*: they are rules of this
application, not of git's syntax, and git never writes either of them in a
`.gitignore`. That separation is what lets this module be tested against real
git behaviour instead of against our own taste, and `tests/test_gitignore.py`
asserts it over the parsed source.

**It starts no process.** `git check-ignore --stdin` is the obvious answer and it
is wrong four times over: it costs a fork on a walk that asks the question 20 000
times and again on the watcher's per-event path; it answers nothing for a root
that is not a repository, which is a first-class case here; it answers nothing
for a workspace holding several checkouts, which is the case the multi-repository
panel exists for; and `git` is Recommends rather than Depends in the `.deb`, so
the contents of the graph would depend on whether an optional package happened to
be installed. Pure Python over text, or nothing.

The translation is hand-written and must stay so. `fnmatch.translate` is in the
standard library, it is the first thing anyone reaches for, and it is wrong three
ways at once: its `*` and its `?` both cross a path separator, and `a/**/b`
becomes a pattern that cannot match `a/b` where git succeeds. None of the three
shows up until a real project's ignore file meets a real tree.

Two structural rules carry the cost side, because the observed root -- and so the
ignore file -- can be chosen by a client holding the control token:

  * **No two unbounded quantifiers are ever emitted adjacent.** Consecutive `**`
    segments collapse to one, which is what git means by them anyway, and a run
    of `*` inside a segment collapses the same way.
  * **Four caps.** `MAX_PATTERN_LENGTH` and `MAX_DOUBLESTAR_PER_PATTERN` bound one
    pattern, `MAX_RULES_PER_FILE` and `MAX_IGNORE_BYTES` bound one file, and
    `MAX_IGNORE_FILES` bounds how many files a tree may contribute.

**A refused pattern is skipped, and skipping means the file is shown.** This
feature exists to show *more*, so the safe direction of a failure is visibility.
`compile_rule` answers `None`, the caller loses exactly one rule, and nothing
ever hides a tree because one line would not compile.

What is refused, each with the price it charges:

  * A repository's own local exclude file, which lives inside the one directory
    this feature never opens; opening it would be a special case cut through the
    caller's unconditional rule. *Price:* a user who keeps local-only ignores
    there sees those files on the graph.
  * `core.excludesFile` and the per-user ignore file. Both sit outside the
    observed root, and reading them makes the graph depend on the machine's git
    configuration rather than on the project. *Price:* the same, for a global
    list.
  * Ignore files *above* the observed root. Pointing the daemon at a
    subdirectory of a checkout does not read the checkout's file. This daemon
    does not open a file outside the root the user pointed at, not even to decide
    what to draw. *Price:* that subtree is governed by nothing, so the caller's
    fallback applies -- which is today's behaviour, so nothing regresses.
  * POSIX bracket classes. `re` reads one as an ordinary class of the letters
    inside it and matches the wrong thing *silently*, which is the one failure
    worse than not matching at all, so a pattern containing one is refused whole.
    *Price:* those files are shown.
  * Case-insensitive matching (`core.ignoreCase`). Matching is byte-exact.
    *Price:* on a case-insensitive filesystem, a pattern spelled in lower case
    does not match a directory spelled with a capital.

Everything above is pure: no filesystem, no process, no state. `IgnoreRules` is
the other half -- the one that opens files -- and it exists because a rule set is
not a property of a root but of a *directory*: a nested `.gitignore` adds rules
below itself and only below itself. Without that, `rhi ~/projects` -- a workspace
of checkouts, each keeping its ignores at its own top level -- has no ignore
rules at all: measured, 4 920 files instead of 843.

**Two entry points, because two callers know different things.**
`ignored_child` is the walk's: it is handed a directory whose ancestors are
already known clean, because the walk pruned them and never descended, so only
the leaf is tested and the cost is O(rules). `ignored` is the watcher's: it has
no walk, only a path off an inotify event, so it tests every ancestor directory
in order and stops at the first excluded one. That is not a refinement of the
first -- it is git's rule that nothing re-includes a file under an excluded
directory, and it gives a *different answer*: with `build/` followed by
`!build/keep.txt`, `git check-ignore -v build/keep.txt` names `build/` as the
deciding pattern and never reaches the negation, while a flat last-match-wins
over the leaf says the opposite. Collapsing the two into one call is the
simplification to refuse.

**The stack is per directory, and re-relativized at every level.** Patterns are
relative to the directory that declared them, so a `sub/.gitignore` holding
`/dist` hides `sub/dist` and says nothing about `sub/deeper/dist`. Concatenating
every ancestor's rules into one list and matching the root-relative path against
it once is the tempting shape: it is right for the leaf-name patterns that are
most of a `.gitignore` and wrong for every anchored one, so it passes the obvious
test and fails in the field. Order is parent first, child last, so a checkout's
own `!` line still has the final say under a workspace that also carries rules.

**Never above the root.** The stack for the root directory is the root's own
`.gitignore` and nothing else. Git climbs to the repository root; this daemon
does not open a file outside the root the user pointed at, not even to decide
what to draw -- the same rule `resolve_inside` and `_read_path` enforce for a
path off the network. The price is stated above: that subtree is governed by
nothing, so the caller's fallback applies, which is today's behaviour.

**`governs` derives from the file existing, not from what it contributed.** An
empty `.gitignore` is the documented way to say "draw everything here", and
deriving the answer from "did this file produce rules" would close that hatch
silently. What the caller then does with the answer is the caller's business:
this module never learns what the fallback is.

**The empty relative path answers `False`, deliberately diverging from git.**
Measured against git 2.43: with `*` in a root `.gitignore`, `git check-ignore -v
.` reports the root itself as ignored by that pattern. Honour that and one
ordinary line blanks the whole graph -- root, seed and all -- with nothing on
screen to say why. The root is the subject of the question, not an answer to it.
Paths *under* `*` are hidden exactly as git says.

**Every read goes through `safe_read.read_capped`, and that is a measurement.**
A `.gitignore` that is a named pipe hangs `git check-ignore` itself -- timed out
at 3 s against git 2.43 -- and `scan_tree` filters symlinks but not FIFOs. A bare
`open()` here parks a worker thread permanently: the walk runs in
`asyncio.to_thread`, a worker cannot be cancelled, the executor is shared with
`switch_root` and the content search, and shutdown joins those threads, so the
daemon eventually cannot even exit. `read_capped` opens with `O_NONBLOCK` and
refuses anything that is not a regular file, which answers `OSError` for the
FIFO, for a `.gitignore` that is a directory and for one at mode `0o000` alike --
so one blanket `except OSError` covers all three, and the refusal is per file: a
sibling ignore file elsewhere in the tree still works. **Never raises, and every
failure shows more**, which is the safe direction for a feature that exists to
show more.

Note that `tests/test_language_policy.py` scans this file, as it scans every
authored source in the project.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

from . import safe_read

#: The longest pattern that will be compiled. A `.gitignore` line longer than
#: this is not a pattern anybody typed by hand.
MAX_PATTERN_LENGTH = 512

#: How many `**` a single pattern may carry. **Counted on the pattern as
#: written, before the collapse** -- counting the survivors would make the cap
#: unreachable, since every run of `**` becomes one.
MAX_DOUBLESTAR_PER_PATTERN = 4

#: How many rules one file may contribute. Matching is linear in rules and it
#: bites: measured, 11 rules cost 2.44 us per path and 214 rules cost 63.45 us,
#: which over a 20 000-path walk is 1.3 s of seeding.
MAX_RULES_PER_FILE = 1000

#: How many ignore files one tree may contribute, nested ones included.
MAX_IGNORE_FILES = 500

#: How much of one ignore file is read. The two file caps must agree: a byte cap
#: too small for `MAX_RULES_PER_FILE` would make the rules cap read as the
#: binding one while the byte cap silently did the cutting. Sixty-four bytes is a
#: generous line, so the relation to hold is
#: `MAX_IGNORE_BYTES >= MAX_RULES_PER_FILE * 64`. The value is spelled here
#: rather than imported from the file viewer, which uses the same number for its
#: own reason: this module reaches for nothing of ours.
MAX_IGNORE_BYTES = 256 * 1024

#: Characters stripped from the end of a pattern unless a backslash escapes
#: them. Git strips trailing spaces; the tab and the carriage return are here so
#: an indented line and a file written with CRLF endings behave the same way.
_TRAILING_WHITESPACE = " \t\r"

#: The translation of a `**` that stands between two segments: any number of
#: whole directory levels, including none. This exact spelling is what
#: `tests/test_gitignore.py` counts to prove the collapse happened.
_ANY_DEPTH = "(?:[^/]+/)*"

#: The translation of a pattern that is not anchored: it may begin at any depth.
_ANY_PREFIX = "(?:.*/)?"

#: The tail every pattern carries, so a matched directory takes its subtree with
#: it. Omitted after a translation that already ends in an unbounded `.*`, which
#: covers the subtree by itself -- two unbounded quantifiers side by side is the
#: shape this module refuses to emit.
_SUBTREE_TAIL = r"(?:/.*)?\Z"


@dataclass(frozen=True)
class Rule:
    """One compiled `.gitignore` line.

    `negated` is git's `!`: the rule still *matches*, and matching means the path
    is re-included rather than ignored. `dir_only` is the trailing `/`: the rule
    speaks about a directory, so it reaches a file only through one of that
    file's ancestors.
    """

    regex: re.Pattern[str]
    negated: bool
    dir_only: bool


def compile_rule(pattern: str) -> Rule | None:
    """Compile one `.gitignore` pattern, or refuse it.

    `None` means refused, and a refused rule is one the caller drops -- so the
    paths it would have hidden are shown. Blank lines and comments are the
    parser's business, not this function's; what is refused here is a pattern
    this module cannot translate *correctly*, plus the three caps.
    """
    if not isinstance(pattern, str) or not pattern:
        return None
    if len(pattern) > MAX_PATTERN_LENGTH:
        return None
    if pattern.count("**") > MAX_DOUBLESTAR_PER_PATTERN:
        return None

    body = pattern
    negated = False
    if body.startswith("!"):
        negated = True
        body = body[1:]
    elif body.startswith("\\") and len(body) > 1 and body[1] in "!#":
        # The escape exists only to take the first character's special meaning
        # away, and it has done that by surviving this far.
        body = body[1:]

    dir_only = False
    if body.endswith("/") and not _is_escaped(body, len(body) - 1):
        dir_only = True
        body = body[:-1]

    anchored = False
    if body.startswith("/"):
        anchored = True
        body = body[1:]
    elif "/" in body:
        # A slash anywhere but at the end makes a pattern anchored to the
        # directory its file sits in. Git's rule, not an approximation of it.
        anchored = True

    if not body:
        return None

    core = _translate(body)
    if core is None:
        return None

    prefix = "" if anchored or core.startswith((_ANY_DEPTH, ".*")) else _ANY_PREFIX
    tail = r"\Z" if core.endswith(".*") else _SUBTREE_TAIL

    try:
        regex = re.compile(prefix + core + tail)
    except re.error:
        # A bracket class the caller wrote is the only way here, and the answer
        # to "this does not compile" is the same as to everything else: drop the
        # rule and show the file.
        return None

    return Rule(regex=regex, negated=negated, dir_only=dir_only)


def parse_patterns(text: str, truncated: bool = False) -> tuple[Rule, ...]:
    """Turn the text of one ignore file into rules, in the order it wrote them.

    Blank lines and comments produce nothing; a leading `#` or `!` escaped with a
    backslash is a pattern rather than a comment or a negation; trailing
    whitespace goes unless it too is escaped. A pattern this module refuses is
    skipped rather than fatal, and at most `MAX_RULES_PER_FILE` survive.

    `truncated` says the text is the front of a longer file -- the read stopped
    at `MAX_IGNORE_BYTES` -- and it drops the final line, which may be half a
    pattern. Half a pattern is never a rule: a pattern cut one character short
    hides a *different* set of files than the file on disk asks for, silently and
    for as long as the file stays that size. The line the cut left behind is the
    empty one after the last separator when the cut happened to land on a
    newline, so nothing real is ever lost by dropping it.
    """
    lines = text.split("\n")
    if truncated and lines:
        lines = lines[:-1]

    rules: list[Rule] = []
    for line in lines:
        pattern = _strip_trailing_whitespace(line)
        if not pattern or pattern.startswith("#"):
            continue
        rule = compile_rule(pattern)
        if rule is None:
            continue
        rules.append(rule)
        if len(rules) >= MAX_RULES_PER_FILE:
            break
    return tuple(rules)


def match_rules(rules: tuple[Rule, ...], relative: str, is_dir: bool = False) -> bool:
    """Is this path ignored by these rules? Last match wins.

    Git's semantics exactly: every rule is tried in file order and the last one
    that matches decides, so a negation placed after a pattern re-includes what
    it hid and a negation placed before it does not. `relative` is relative to
    the directory the rules govern and uses `/` separators.

    A rule that matches an *ancestor* of the path answers for the path too, which
    is what makes one line prune a whole tree. Git's other half of that rule --
    that a negation cannot re-include a file whose directory is excluded -- is
    not here: it belongs to the caller that owns the ancestor chain.
    """
    ignored = False
    for rule in rules:
        if _rule_matches(rule, relative, is_dir):
            ignored = not rule.negated
    return ignored


def _rule_matches(rule: Rule, relative: str, is_dir: bool) -> bool:
    """Does this one rule speak about this path, whatever it then says?

    A directory-only rule reaches a file only through the file's ancestors, so
    the question asked for a file is asked about its parent directory instead --
    which the regex's own subtree tail then answers for every level above that.
    Asking the parent rather than reading the position of the match keeps the
    answer independent of which of several possible parses the engine happened to
    choose.
    """
    target = relative
    if rule.dir_only and not is_dir:
        cut = relative.rfind("/")
        if cut <= 0:
            return False
        target = relative[:cut]
    return rule.regex.match(target) is not None


def _translate(pattern: str) -> str | None:
    """The pattern's body as a regular expression, or `None` if it is refused.

    Segment by segment, because every rule that separates this from
    `fnmatch.translate` is a rule about the separator.
    """
    segments = _collapse_doublestars(pattern.split("/"))

    out = ""
    need_separator = False
    last = len(segments) - 1
    for index, segment in enumerate(segments):
        if need_separator:
            out += "/"
        if segment == "**":
            if index == last:
                # A trailing `**` means everything inside, and nothing else --
                # not the directory itself.
                out += ".*"
            else:
                out += _ANY_DEPTH
            # Both spellings carry their own separator, so the next segment must
            # not add a second one.
            need_separator = False
            continue
        translated = _translate_segment(segment)
        if translated is None:
            return None
        out += translated
        need_separator = True
    return out


def _collapse_doublestars(segments: list[str]) -> list[str]:
    """Drop every `**` segment that follows another one.

    Semantically free -- git reads a run of them as one -- and structurally the
    point: it is what guarantees no two unbounded quantifiers are ever emitted
    side by side, whichever ignore file the observed root turns out to hold.
    """
    collapsed: list[str] = []
    for segment in segments:
        if segment == "**" and collapsed and collapsed[-1] == "**":
            continue
        collapsed.append(segment)
    return collapsed


def _translate_segment(segment: str) -> str | None:
    """One path segment's worth of glob, as a regular expression.

    Nothing emitted here can match a separator, which is the property the whole
    module turns on.
    """
    out: list[str] = []
    index = 0
    size = len(segment)
    while index < size:
        char = segment[index]
        if char == "\\":
            index += 1
            if index < size:
                out.append(re.escape(segment[index]))
                index += 1
            else:
                # A trailing backslash escapes nothing; take it literally.
                out.append(re.escape("\\"))
        elif char == "*":
            while index < size and segment[index] == "*":
                index += 1
            out.append("[^/]*")
        elif char == "?":
            out.append("[^/]")
            index += 1
        elif char == "[":
            piece, index = _translate_class(segment, index)
            if piece is None:
                return None
            out.append(piece)
        else:
            out.append(re.escape(char))
            index += 1
    return "".join(out)


def _translate_class(segment: str, start: int) -> tuple[str | None, int]:
    """A bracket class, passed through with git's `!` folded to `re`'s `^`.

    Answers `(None, ...)` twice over, and both refusals are the same refusal --
    the pattern is dropped and the paths it would have hidden are shown. A POSIX
    class, because `re` reads that spelling as an ordinary class of the
    punctuation and letters inside it, matches, and matches the wrong thing
    without complaining. And an unterminated `[`, because git matches nothing at
    all with such a pattern (measured against git 2.43: a file literally named
    with a trailing `[` is not ignored by a pattern naming it), so treating the
    bracket as a literal would hide a file git shows.
    """
    index = start + 1
    size = len(segment)
    if index < size and segment[index] in "!^":
        index += 1
    if index < size and segment[index] == "]":
        # A `]` first in the class is a member of it, not the end of it.
        index += 1
    while index < size and segment[index] != "]":
        if segment[index] == "[" and index + 1 < size and segment[index + 1] == ":":
            return None, index
        if segment[index] == "\\":
            index += 1
        index += 1
    if index >= size:
        return None, index

    body = segment[start + 1 : index]
    if body.startswith("!"):
        body = "^" + body[1:]
    return "[" + body + "]", index + 1


def _strip_trailing_whitespace(line: str) -> str:
    """Trailing spaces go, unless a backslash says the name really ends in one."""
    end = len(line)
    while end > 0 and line[end - 1] in _TRAILING_WHITESPACE:
        if _is_escaped(line, end - 1):
            break
        end -= 1
    return line[:end]


def _is_escaped(text: str, index: int) -> bool:
    """Is the character at `index` preceded by an odd number of backslashes?"""
    backslashes = 0
    cursor = index - 1
    while cursor >= 0 and text[cursor] == "\\":
        backslashes += 1
        cursor -= 1
    return backslashes % 2 == 1


#: The one file name this module opens. A repository's local exclude file lives
#: inside the one directory this feature never opens, and both the per-user and
#: the `core.excludesFile` lists sit outside the observed root, so there is
#: deliberately nothing else here.
IGNORE_FILE_NAME = ".gitignore"


class IgnoreRules:
    """The ignore files of one tree, read once each and remembered.

    Built for a root, asked about paths relative to it with `/` separators. It
    never opens a file outside that root, it never raises, and every refusal it
    makes -- an unreadable file, a cap reached, bytes that are not text -- costs
    exactly the rules of that one file, so the paths those rules would have
    hidden are shown instead.

    Two objects exist at a time by decision, not by accident: the walk builds a
    fresh one per pass and the watcher keeps one for its lifetime. They are not
    shared, and the cache is written so that sharing one would still be safe --
    a dict of immutable tuples where the same key always computes the same
    value, so two threads racing on a directory recompute it rather than see
    half of it. The one mutable thing beside it is the file counter, and a race
    there can only over-count, which lowers the cap, which shows more.
    """

    def __init__(self, root: str) -> None:
        self._root = root
        self._cache: dict[str, tuple[bool, tuple[Rule, ...]]] = {}
        self._files_read = 0

    def governs(self, directory_relative: str) -> bool:
        """Does any ignore file at or above this directory speak for it?

        True the moment one *exists*, whether or not it produced a single rule:
        an empty `.gitignore` is how a user says "draw everything here", and
        deriving this from the rules would close that hatch without a word. What
        the answer means -- which fallback it turns off -- belongs to the caller.
        """
        segments = _segments(directory_relative)
        for depth in range(len(segments) + 1):
            present, _ = self._entry("/".join(segments[:depth]))
            if present:
                return True
        return False

    def ignored_child(self, directory_relative: str, name: str, is_dir: bool) -> bool:
        """Is this one entry of this directory ignored? The walk's question.

        Only the leaf is tested, because the walk has already pruned every
        ancestor and would not be here otherwise. The stack runs parent first
        and child last so the deepest file gets the final word, and the path
        handed to each level is relativized *to that level* -- an anchored
        pattern means "here", and here is the directory that declared it.

        An empty `name` is the directory itself, which answers `False`: see
        `ignored`.
        """
        if not name:
            return False
        segments = _segments(directory_relative)
        ignored = False
        for depth in range(len(segments) + 1):
            _, rules = self._entry("/".join(segments[:depth]))
            if not rules:
                continue
            relative = "/".join(segments[depth:] + [name])
            for rule in rules:
                if _rule_matches(rule, relative, is_dir):
                    ignored = not rule.negated
        return ignored

    def ignored(self, relative: str, is_dir: bool = False) -> bool:
        """Is this path ignored, ancestors included? The watcher's question.

        A different traversal, not a refinement of the one above: each ancestor
        is tested in order *as a directory* and the first exclusion ends it,
        which is git's rule that nothing below an excluded directory can be
        re-included. The walk gets that rule for free by never descending; a
        caller holding one path off an inotify event has to pay for it.

        The empty path is the root itself and is never ignored, whatever the
        root's own file says. `is_dir` defaults to the answer that shows more:
        a directory tested as a file escapes a directory-only rule.
        """
        segments = _segments(relative)
        if not segments:
            return False
        last = len(segments) - 1
        for depth, name in enumerate(segments):
            parent = "/".join(segments[:depth])
            if self.ignored_child(parent, name, is_dir if depth == last else True):
                return True
        return False

    def invalidate(self) -> None:
        """Forget everything, including every directory found to have no file.

        Re-reading only the files already seen is the tempting half-measure and
        it fails the commonest case there is: a project's first `.gitignore` is
        *created*, not edited, and a cache that remembers only positives latches
        `governs` on `False` for the whole tree until the daemon restarts.
        """
        self._cache = {}
        self._files_read = 0

    def _entry(self, directory_relative: str) -> tuple[bool, tuple[Rule, ...]]:
        """This directory's own file: does it exist, and what did it say?"""
        cached = self._cache.get(directory_relative)
        if cached is not None:
            return cached
        entry = self._load(directory_relative)
        self._cache[directory_relative] = entry
        return entry

    def _load(self, directory_relative: str) -> tuple[bool, tuple[Rule, ...]]:
        """Read one `.gitignore`, or answer that there is nothing to read.

        `MAX_IGNORE_FILES` counts **files actually read**, so a directory that
        carries no ignore file costs nothing against the cap -- the cap bounds
        what a tree contributes, and a directory with no file contributes
        nothing. Past it the answer is "no rules", which shows more.
        """
        if self._files_read >= MAX_IGNORE_FILES:
            return False, ()

        parts = [part for part in directory_relative.split("/") if part]
        target = os.path.join(self._root, *parts, IGNORE_FILE_NAME)
        if not os.path.exists(target):
            # The overwhelmingly common answer, asked once per directory of a
            # walk that may enter five thousand of them: there is no file here.
            # Deliberately `exists` and not `isfile` -- a named pipe, a
            # directory and a mode of `0o000` all *exist*, so all three still go
            # through `read_capped` and keep the defence that refuses them the
            # only thing standing between the walk and a parked worker thread.
            # What is skipped is the one case where the open could only ever
            # have raised `ENOENT`.
            return False, ()
        try:
            data, truncated = safe_read.read_capped(target, MAX_IGNORE_BYTES)
        except OSError:
            # A missing file, a directory, a named pipe and a mode of `0o000`
            # all arrive here, and all four mean the same thing: this directory
            # contributes no rules, and its neighbours are untouched.
            return False, ()

        self._files_read += 1
        text = data.decode("utf-8", "replace")
        return True, parse_patterns(text, truncated=truncated)


def _segments(relative: str) -> list[str]:
    """A relative path as its meaningful segments, however it was spelled.

    Empty pieces and a bare `.` are dropped, so a leading or trailing separator
    names the same directory it would in a shell. Nothing here resolves `..`:
    keeping the daemon inside its root is `resolve_inside`'s job, and this
    module answers a question about text.
    """
    if not isinstance(relative, str):
        return []
    return [part for part in relative.split("/") if part and part != "."]
