"""The paths a user asked to be told about, and the one file that declares them.

Nothing else in this project holds a pattern somebody wrote *about* a project.
``Settings`` carries configuration and no policy about paths; ``gitignore.py``'s
rules are always discovered per directory from a file inside the tree being
walked; ``normalize.py`` is pure and sits on the hook's hot path, so it can read
nothing. So "tell me when an agent touches ``package.json``" has nowhere to live,
and this module is that place: **one file, at the observed root, read once.**

**Why this is not part of** :mod:`rhizome_graph.gitignore`. That module answers
*git's* question and carries no rhizome policy at all, which is exactly what
lets it be tested against the installed ``git`` rather than against our taste --
the same reason ``.git`` and ``node_modules`` are hidden by ``tree.py`` and not
by the matcher. A supervision policy living inside it would retire that
property, and it would land in the function ``scan_tree`` calls twenty thousand
times per boot and the watcher calls on every inotify event. What *is* reused is
that module's **pure** layer -- ``compile_rule`` and ``match_rules`` -- because
it buys git's syntax, which every user of this tool already knows: ``!``
negation is the only reason "anything outside ``src/``" is three lines rather
than a new pattern language, and ``dir_only`` is what makes ``.github/workflows/``
reach the files under it with nothing added.

**Why not** ``IgnoreRules``. Everything in that class is about a rule file that
lives *inside* the tree it governs: ``governs`` asked per directory, the
memoized per-directory load, ``invalidate``, and the two measured traps of
watching an ignore file (reading it is itself watched, and an atomic save
carries the name only on the move's destination). Attention rules are one file,
at the root, read once. Adopting it would import a per-directory governance
model with nothing to govern and an invalidation problem this feature does not
have.

**Why a refused pattern is recorded rather than dropped.** This is the finding
this module exists for. In ``gitignore.py`` a refused pattern, an unreadable
file or a cap reached shows **more** files, and that is safe by construction --
its own docstring says so. Reused here the very same refusal alarms **less**:
the user wrote a rule about ``*.pem``, this module could not translate it
correctly, and the graph then reports the silence that means "nothing has
happened". A supervision feature whose failure mode is indistinguishable from
success is not a supervision feature. So ``refused`` keeps the patterns that
were dropped, verbatim, so a panel can quote the line the reader has open, and
``source`` survives a file that produced no rules at all, so "no rule file was
found" and "a rule file that asks for nothing" stay two different sentences.

**The read goes through** :mod:`rhizome_graph.safe_read`, never a bare open. A
rule file sits at a path a person typed, so it can be a named pipe, and
``open(2)`` on a writerless FIFO blocks forever in a worker thread that cannot
be cancelled and that shutdown then joins.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import gitignore, safe_read

#: How many patterns of one rule file are put in force. This module's own cap,
#: far below `gitignore.MAX_RULES_PER_FILE`, and it is a budget rather than a
#: formality: matching is linear in rules and runs on every hook and watcher
#: event. Measured on the plan's host, 11 rules cost 5.35 us per event and 200
#: cost 64.1 us, against a per-event path that costs 30.29 us in total -- so at
#: 1 000 rules the matching alone would be ten times the whole of that path. A
#: rule file with more than 64 patterns is not a supervision policy, it is a
#: second `.gitignore`.
MAX_ATTENTION_RULES = 64

#: How much of a rule file is read. **The matcher's own constant, by identity
#: and never a second literal of the same value** -- the precedent is
#: `content_search.MAX_FILE_BYTES` being `file_view.DEFAULT_MAX_BYTES`. Two
#: constants that happen to be equal is the bug waiting to happen.
MAX_BYTES = gitignore.MAX_IGNORE_BYTES

#: What the file is called when nobody named one. A basename, deliberately:
#: `Session` joins it to the root it currently observes, which is what makes the
#: default follow a `ctrl+L` while an explicit `--attention-rules` does not.
DEFAULT_RULE_FILE = ".rhizome-attention"


@dataclass(frozen=True)
class AttentionRules:
    """One rule file, as far as this daemon could read and translate it.

    ``source`` is the file the rules came from and is empty when none was read
    -- the distinction the panel needs, since a file that produced no rules is a
    user saying "watch nothing here", exactly as an empty `.gitignore` is the
    documented way to say "draw everything here".

    ``refused`` holds the patterns ``compile_rule`` would not translate, spelled
    exactly as the file spells them so a report can quote them. ``truncated``
    says that not everything in the file is in force, whether the byte cap or
    the rule cap did the cutting: the reader's question is "is what I wrote
    being enforced", not "which of your two limits stopped first".
    """

    rules: tuple[gitignore.Rule, ...]
    source: str
    refused: tuple[str, ...]
    truncated: bool


#: No rule file was read. The boot state of every project that has never heard
#: of this feature, and the answer for every file that could not be read.
EMPTY = AttentionRules((), "", (), False)


def load_rules(path: str) -> AttentionRules:
    """Read one rule file, and never raise whatever is at that path.

    A missing file, a directory, a mode of ``0o000`` and a named pipe all answer
    :data:`EMPTY`: a daemon that will not boot because a rule file is odd is a
    worse bug than one that boots without rules and says so on screen.

    Compiled line by line with ``compile_rule`` rather than through
    ``parse_patterns``, which drops a refusal silently. Dropping it silently is
    correct where a refusal shows more files and wrong here, where it alarms
    less -- see this module's docstring.
    """
    if not isinstance(path, str) or not path:
        return EMPTY

    try:
        data, cut = safe_read.read_capped(path, MAX_BYTES)
    except (OSError, ValueError):
        # A missing file, a directory, a named pipe and a mode of `0o000` all
        # arrive here, and all four mean the same thing: no rules, and the
        # daemon starts anyway.
        return EMPTY

    lines = data.decode("utf-8", "replace").split("\n")
    if cut and lines:
        # The read stopped mid-file, so the last line may be half a pattern --
        # and half a pattern is never a rule: cut one character short it alarms
        # about a *different* set of files than the one on disk asks for.
        lines = lines[:-1]

    rules: list[gitignore.Rule] = []
    refused: list[str] = []
    truncated = cut
    for line in lines:
        # Git's own trailing-whitespace rule, escapes included, taken from the
        # module that owns the syntax rather than re-spelled here.
        pattern = gitignore._strip_trailing_whitespace(line)
        if not pattern or pattern.startswith("#"):
            continue
        if len(rules) >= MAX_ATTENTION_RULES:
            truncated = True
            break
        rule = gitignore.compile_rule(pattern)
        if rule is None:
            refused.append(pattern)
            continue
        rules.append(rule)

    return AttentionRules(
        rules=tuple(rules),
        source=path,
        refused=tuple(refused),
        truncated=truncated,
    )


def matches(rules: AttentionRules, relative: str) -> bool:
    """Does this path deserve a second look? Asked twice, answered once.

    **Not a straight delegation to** ``match_rules``, and the obvious
    simplification into one is wrong. The matcher takes an ``is_dir`` flag, and
    an event carries no such fact -- so the question is asked in both modes and
    only an agreement counts.

    That is what makes the wart reachable through neither. Under ``*`` /
    ``!src/`` / ``!src/**`` the entry ``src`` answers ``True`` as a *file*,
    because ``!src/`` is ``dir_only`` and the negation applies to the directory
    while ``*`` matched it first at the same level; as a directory it answers
    ``False``. And ``EventHub._expand`` turns a directory deletion into its
    children *followed by the directory's own path*, so ``rm -rf src/`` really
    does put ``src`` through here -- the one directory the user wrote two lines
    to exclude would alarm. The mirror case is the same property from the other
    side: ``debian/`` speaks about the files under it, so ``debian/control``
    alarms and the entry ``debian`` does not.

    Short-circuiting, so a path that matches nothing -- which is almost every
    path -- still pays for exactly one pass over the rules.

    Asking twice is a rule of *this caller*, not of git, the same split that
    keeps ``.git`` and ``node_modules`` in ``tree.py`` rather than in the
    matcher.
    """
    return gitignore.match_rules(rules.rules, relative, False) and gitignore.match_rules(
        rules.rules, relative, True
    )
