"""Contract tests (RED) for rhizome_graph.gitignore -- the pattern matcher.

Motivation: this project has never had to answer an ignore-syntax question.
`tree.py` carries a *name blocklist*, `repo.py` reads `.git/HEAD`, `status.py`
parses porcelain output, `checkouts.py` looks for `.git` directories. Nothing
anywhere parses a pattern. The consequence is the complaint this feature exists
for: every dotted directory is pruned by name, so `.claude/` and `.github/` --
7 files and 33 KiB in this very checkout -- can never appear on the graph, while
a project's own `.gitignore`, the file that actually says what is not worth
drawing, is never opened at all.

This module is the missing question, and only that question: *given a pattern
out of a `.gitignore`, does this relative path match?* It answers git's question
and no rhizome policy -- it must not know what `IGNORED_DIRS` is, and it must
not know that `.git` is special (decision 1 puts that rule in the caller). The
stack of files, the per-directory rules and the walk are steps G2 and beyond.

Four properties here are the ones a later change is most likely to break, so
each is pinned by name:

  * **A wildcard does not cross a path separator.** `*` is `[^/]*` and `?` is
    `[^/]`, which is exactly what the obvious implementation --
    `re.compile(fnmatch.translate(pattern))` -- gets wrong. The measurement of
    that wrongness is pinned here beside the rule, so nobody "simplifies" the
    translation back into `fnmatch` later.
  * **Consecutive `**` segments collapse to one.** That is what git means by
    them anyway, and it is the structural half of the ReDoS defence: two
    unbounded quantifiers can never be emitted adjacent, whatever `.gitignore`
    a `setRoot`-holding client points the daemon at. `MAX_DOUBLESTAR_PER_PATTERN`
    and `MAX_PATTERN_LENGTH` are the other half.
  * **A refused pattern is skipped, and skipping means the file is SHOWN.**
    This feature exists to show more, so the safe direction of a failure is
    visibility. `compile_rule` answers `None`, the caller loses one rule, and
    nothing ever hides a tree because one line would not compile.
  * **Half a pattern is never a rule.** The read of a `.gitignore` is capped at
    `MAX_IGNORE_BYTES`, so the text `parse_patterns` receives can end mid-line.
    A truncated read drops its final line rather than compiling it -- `*.tm`
    left over from `*.tmp` would hide a different set of files than the file on
    disk asks for, silently and forever.

The module boundary is asserted structurally at the end of this file, in the
same spirit as `tests/test_checkouts.py` and the "no shiki outside
`highlight.ts`" rule on the front end.

Style: Arrange-Act-Assert, one property per test. Everything here is pure: no
display, no network, no daemon, and -- unlike G2's `IgnoreRules` -- no
filesystem either.
"""

from __future__ import annotations

import ast
import fnmatch
import re
from pathlib import Path

from rhizome_graph import gitignore
from rhizome_graph.gitignore import (
    MAX_DOUBLESTAR_PER_PATTERN,
    MAX_IGNORE_BYTES,
    MAX_IGNORE_FILES,
    MAX_PATTERN_LENGTH,
    MAX_RULES_PER_FILE,
    compile_rule,
    match_rules,
    parse_patterns,
)


def _matches(pattern: str, relative: str, is_dir: bool = False) -> bool:
    """Does this one pattern ignore this path?

    Goes through `match_rules` rather than poking at `Rule.regex`, so the tests
    read as statements about the answer and not about the translation. Used
    only for patterns that are not negated, where "the rule matched" and "the
    path is ignored" are the same sentence.
    """
    rule = compile_rule(pattern)
    assert rule is not None, f"compile_rule({pattern!r}) refused a valid pattern"
    return match_rules((rule,), relative, is_dir)


# --- 1.1 a wildcard does not cross a separator ------------------------------


def test_a_star_matches_within_a_segment_at_any_depth_but_never_crosses_one():
    """`*.py` is `[^/]*\\.py`, unanchored -- so depth is free and `.pyc` is not."""
    assert _matches("*.py", "a.py") is True
    assert _matches("*.py", "src/a.py") is True
    assert _matches("*.py", "a.pyc") is False


def test_a_question_mark_matches_one_character_that_is_not_a_separator():
    """The assertion the obvious implementation fails.

    `fnmatch.translate("x?y")` yields a `.` that happily eats the separator, so
    a pattern meant to name one file swallows a whole directory level.
    """
    assert _matches("x?y", "xay") is True
    assert _matches("x?y", "x/y") is False


# --- 1.2 the measurement that rules `fnmatch.translate` out ------------------
#
# Pinned rather than merely written down in the plan. `fnmatch.translate` is the
# first thing anyone reaches for, it is in the standard library, and it is wrong
# three separate ways -- none of which shows up until a real project's
# `.gitignore` is pointed at a real tree. A test that names the loser is what
# keeps the translation from being "simplified" back into it.


def test_fnmatch_translate_lets_a_question_mark_cross_a_separator_and_ours_does_not():
    assert re.match(fnmatch.translate("x?y"), "x/y")

    assert _matches("x?y", "x/y") is False


def test_fnmatch_translate_lets_a_star_cross_a_separator_and_ours_does_not():
    """The path is chosen so no *ancestor* matches either.

    `s*c` against `src/abc` proves nothing: git ignores it, because the
    directory `src` matches `s*c` on its own and takes its subtree with it
    (verified against `git check-ignore`). `sx/yc` has no such ancestor, so the
    only way to match it is by letting the `*` eat the separator.
    """
    assert re.match(fnmatch.translate("s*c"), "sx/yc")

    assert _matches("s*c", "sx/yc") is False


def test_fnmatch_translate_cannot_match_zero_directories_between_two_segments():
    """`a/**/b` becomes `a/.*/b`, which needs at least one separator's worth.

    Git matches `a/b` with it; `fnmatch`'s translation cannot, so a `**` rule
    would silently miss the shallowest thing it is written for.
    """
    assert re.match(fnmatch.translate("a/**/b"), "a/b") is None

    assert _matches("a/**/b", "a/b") is True


# --- 1.3 anchoring, and directories only ------------------------------------


def test_a_leading_slash_anchors_the_pattern_to_the_files_own_directory():
    assert _matches("/dist", "dist/x") is True
    assert _matches("/dist", "a/dist/x") is False


def test_an_inner_slash_anchors_the_pattern_too():
    """No leading slash needed: a slash anywhere but the end makes it anchored."""
    assert _matches("doc/x", "doc/x") is True
    assert _matches("doc/x", "a/doc/x") is False


def test_a_trailing_slash_matches_a_directory_and_never_a_file_of_that_name():
    rule = compile_rule("build/")
    assert rule is not None

    assert rule.dir_only is True
    assert match_rules((rule,), "build", True) is True
    assert match_rules((rule,), "build", False) is False


def test_a_bracket_class_matches_its_members_and_a_leading_bang_is_a_negated_class():
    """Decision 4 puts `[...]` in scope, with git's `!` folded to `re`'s `^`."""
    assert _matches("[abc].txt", "a.txt") is True
    assert _matches("[abc].txt", "d.txt") is False
    assert _matches("[!abc].txt", "d.txt") is True
    assert _matches("[!abc].txt", "a.txt") is False


# --- 1.4 `**` in its three positions ----------------------------------------


def test_a_leading_doublestar_matches_the_name_at_any_depth():
    assert _matches("**/node_modules", "node_modules", True) is True
    assert _matches("**/node_modules", "a/node_modules", True) is True
    assert _matches("**/node_modules", "a/b/c/node_modules", True) is True


def test_a_trailing_doublestar_matches_everything_below_but_not_the_directory():
    """Git's "a trailing `/**` matches everything inside", exactly."""
    assert _matches("a/**", "a/b") is True
    assert _matches("a/**", "a/b/c") is True
    assert _matches("a/**", "a", True) is False


def test_a_doublestar_between_two_segments_matches_zero_directories_as_well_as_many():
    """The case `fnmatch` gets wrong, stated as our own requirement."""
    assert _matches("a/**/b", "a/b") is True
    assert _matches("a/**/b", "a/x/y/b") is True


# --- 1.5 negation, and the escape that makes `!` literal ---------------------


def test_a_later_negation_re_includes_a_file_an_earlier_rule_ignored():
    rules = parse_patterns("*.log\n!keep.log")

    assert match_rules(rules, "keep.log", False) is False
    assert match_rules(rules, "other.log", False) is True


def test_the_last_matching_rule_wins_whichever_way_the_file_is_ordered():
    """Order is the whole semantics: the same two lines reversed hide the file."""
    rules = parse_patterns("!keep.log\n*.log")

    assert match_rules(rules, "keep.log", False) is True


def test_a_backslash_escapes_a_leading_bang_into_a_literal_name():
    rule = compile_rule("\\!literal")
    assert rule is not None

    assert rule.negated is False
    assert match_rules((rule,), "!literal", False) is True


# --- 1.6 what a file of text becomes ----------------------------------------


def test_blank_lines_and_comments_produce_no_rules():
    assert parse_patterns("\n   \n# a comment\n\t\n#\n") == ()


def test_a_backslash_escapes_a_leading_hash_into_a_pattern():
    rules = parse_patterns("\\#notacomment")

    assert len(rules) == 1
    assert match_rules(rules, "#notacomment", False) is True


def test_trailing_whitespace_is_stripped_from_a_pattern():
    assert match_rules(parse_patterns("a.txt   "), "a.txt", False) is True


def test_an_escaped_trailing_space_is_kept():
    """`a\\ ` names a file whose name really does end in a space."""
    rules = parse_patterns("a\\ ")

    assert match_rules(rules, "a ", False) is True
    assert match_rules(rules, "a", False) is False


# --- 1.7 an ignored directory ignores its subtree ---------------------------


def test_an_ignored_directory_ignores_everything_beneath_it():
    """The `(?:/.*)?\\Z` tail, which is what makes one rule prune a whole tree.

    The path asked about is a *file* several levels down, and no rule names it:
    what matches is its ancestor, and the answer must still be True.
    """
    assert match_rules(parse_patterns("build/"), "build/x/y.txt", False) is True


# --- 1.8 the four refusals --------------------------------------------------
#
# A refused pattern is `None`, the caller drops it, and the file it would have
# hidden is shown. That direction is deliberate and stated in decision 3.


def test_a_posix_bracket_class_is_refused_whole():
    """`re` reads `[[:alpha:]]` as a class of `[`, `:`, `a`, `l`, `p`, `h`.

    It matches, and it matches the wrong thing, silently -- which is the one
    failure mode worse than not matching at all.
    """
    assert compile_rule("[[:alpha:]].txt") is None


def test_a_pattern_longer_than_the_cap_is_refused():
    assert compile_rule("a" * MAX_PATTERN_LENGTH) is not None
    assert compile_rule("a" * (MAX_PATTERN_LENGTH + 1)) is None


def test_a_pattern_with_more_doublestars_than_the_cap_is_refused():
    """Counted on the pattern as written, not on the collapsed translation.

    Counting after the collapse would make the constant unreachable, since
    every run of `**` becomes one -- and the cap exists precisely because the
    `.gitignore` may have been chosen by whoever sent `setRoot`.
    """
    at_cap = "/".join(["a"] + ["**"] * MAX_DOUBLESTAR_PER_PATTERN + ["b"])
    over_cap = "/".join(["a"] + ["**"] * (MAX_DOUBLESTAR_PER_PATTERN + 1) + ["b"])

    assert compile_rule(at_cap) is not None
    assert compile_rule(over_cap) is None


def test_parse_patterns_stops_at_max_rules_per_file():
    text = "\n".join(f"pattern{index}" for index in range(2 * MAX_RULES_PER_FILE))

    assert len(parse_patterns(text)) == MAX_RULES_PER_FILE


# --- 1.9 the collapse, which is where the ReDoS defence lives ---------------


def test_consecutive_doublestars_collapse_to_one_unbounded_quantifier():
    """Two adjacent `(?:[^/]+/)*` are what a crafted `.gitignore` would want.

    Pinned on the regex source rather than on behaviour alone, because the
    behaviour of `a/**/**/**/b` and `a/**/b` is identical by definition -- the
    collapse is invisible except in what gets compiled, and that is the half
    that costs CPU.
    """
    rule = compile_rule("a/**/**/**/b")
    assert rule is not None

    assert rule.regex.pattern.count("(?:[^/]+/)*") == 1
    assert match_rules((rule,), "a/b", False) is True
    assert match_rules((rule,), "a/x/y/b", False) is True


# --- the caps, by name and by value -----------------------------------------


def test_the_caps_are_the_values_the_plan_names():
    """Pinned like `checkouts.MAX_DEPTH`: these are a budget, not a detail.

    A big `.gitignore` is linear in rules and it bites -- 11 rules cost 2.44 us
    per path and 214 rules cost 63.45 us, which at 20 000 paths is 1.3 s of
    seed.
    """
    assert MAX_PATTERN_LENGTH == 512
    assert MAX_DOUBLESTAR_PER_PATTERN == 4
    assert MAX_RULES_PER_FILE == 1000
    assert MAX_IGNORE_FILES == 500


# --- the capped read, and the half line it can leave behind -----------------


def test_the_capped_read_has_a_constant_big_enough_for_the_rules_cap():
    """`MAX_IGNORE_BYTES` bounds one `.gitignore`; the two caps must agree.

    A byte cap so small that `MAX_RULES_PER_FILE` can never be reached would
    make one of the two constants a lie, and it would be the *rules* cap that
    reads as the binding one while the byte cap silently did the cutting. Sixty
    bytes a line is a generous pattern; a thousand of them is 64 KiB.
    """
    assert isinstance(MAX_IGNORE_BYTES, int)
    assert MAX_IGNORE_BYTES >= MAX_RULES_PER_FILE * 64


def test_a_truncated_read_drops_its_final_incomplete_line():
    """Half a pattern must never become a rule.

    `parse_patterns` is handed text, not a file, so it cannot know the read was
    cut -- the caller that owns the cap tells it. The default is False, so
    every other call site in this project spells `parse_patterns(text)` exactly
    as it does today.
    """
    cut_mid_pattern = "*.log\n*.tm"

    assert match_rules(parse_patterns(cut_mid_pattern, truncated=True), "a.tm") is False
    assert match_rules(parse_patterns(cut_mid_pattern, truncated=True), "a.log") is True
    assert match_rules(parse_patterns(cut_mid_pattern), "a.tm") is True


def test_a_truncation_landing_on_a_line_boundary_loses_no_rule():
    """The cap falling exactly after a newline cut nothing, so nothing is dropped.

    The incomplete final line is the empty one after the last separator. Drop
    "the last line" without noticing that and every `.gitignore` big enough to
    be truncated loses its last real rule as well.
    """
    assert match_rules(parse_patterns("*.log\n", truncated=True), "a.log") is True


# --- 1.10 the module boundary, over the parsed source -----------------------

#: The packages that are ours. An import whose head is one of these is a layer
#: decision; everything else is the standard library, which this module is free
#: to use (it needs `os`, `re` and `dataclasses`).
OUR_PACKAGES = frozenset({"rhizome_graph", "daemon", "hooks"})

#: `safe_read` and nothing else. G2's `IgnoreRules` opens `.gitignore` files it
#: walked out of the observed root, which is word for word the rule
#: `safe_read.py`'s docstring states: a path this project did not construct
#: names a file of unknown *type*, and `open(2)` on a FIFO called `.gitignore`
#: under `$HOME` parks a worker thread permanently -- the thread cannot be
#: cancelled and shutdown joins it. A second `open()` written here to avoid the
#: import is exactly that parked worker, because "a chokepoint reachable from
#: one caller and duplicated for the other is not a chokepoint". It costs
#: nothing structurally: `safe_read` is a leaf (errno, fcntl, os, stat, and
#: nothing of ours), so no cycle can form through it.
FIRST_PARTY_IMPORTS_ALLOWED = frozenset({"safe_read"})

FORKING_NAMES = (
    "subprocess",
    "multiprocessing",
    "popen",
    "system",
    "fork",
    "execv",
    "execvp",
    "spawnv",
    "spawnl",
    "gitcmd",
)


def _source() -> str:
    return Path(gitignore.__file__).read_text(encoding="utf-8")


def _first_party_imports(module: ast.Module) -> set[str]:
    """The names `gitignore.py` pulls out of this project, however spelled.

    All four forms collapse to the same answer, because all four are how this
    boundary would most naturally be crossed: `from rhizome_graph import tree`,
    `from rhizome_graph.tree import IGNORED_DIRS`, `import rhizome_graph.tree`
    and the relative `from .tree import IGNORED_DIRS`.
    """
    imported: set[str] = set()
    for node in ast.walk(module):
        if isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level == 0 and base.split(".")[0] not in OUR_PACKAGES:
                continue
            tail = base.split(".")[-1] if base else ""
            if tail and tail not in OUR_PACKAGES:
                imported.add(tail)
            else:
                imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                parts = alias.name.split(".")
                if parts[0] in OUR_PACKAGES:
                    imported.add(parts[-1])
    return imported


def _identifiers(module: ast.Module) -> set[str]:
    """Every name the code *uses*: bare names, attributes and imported modules.

    Identifiers rather than raw text on purpose. The module's own docstring is
    expected to say that it forks nothing and knows no rhizome policy -- the
    plan asks for exactly those sentences -- and a substring search over the
    source would then fail on the promise instead of on a breach of it.
    """
    names: set[str] = set()
    for node in ast.walk(module):
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.Attribute):
            names.add(node.attr)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                names.update(alias.name.split("."))
                if alias.asname:
                    names.add(alias.asname)
        elif isinstance(node, ast.ImportFrom):
            names.update((node.module or "").split("."))
            names.update(alias.name for alias in node.names)
    return names


def _string_constants(module: ast.Module) -> set[str]:
    """Every string literal, docstrings included.

    Asked for as constants rather than as a substring of the file so that a
    docstring naming `.gitignore` -- which this module's must -- is not read as
    a breach; only a literal that *is* `.git` counts.
    """
    return {
        node.value
        for node in ast.walk(module)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    }


def test_gitignore_reaches_for_safe_read_and_nothing_else_of_ours():
    """The boundary written down, not merely intended."""
    imported = _first_party_imports(ast.parse(_source()))

    assert imported <= FIRST_PARTY_IMPORTS_ALLOWED, (
        "rhizome_graph/gitignore.py imports "
        f"{sorted(imported - FIRST_PARTY_IMPORTS_ALLOWED)} from this project. "
        "It answers git's question about a pattern and a path; the only thing "
        "it may reach for is the one capped, FIFO-safe read."
    )


def test_gitignore_never_starts_a_process():
    """No `git`, by construction rather than by convention.

    Asserted over every identifier in the parsed source, so a late
    `import subprocess` inside a function -- the form this leaks back in,
    because it changes no import block a reviewer skims -- is caught the same
    as a lone `os.popen`.
    """
    used = _identifiers(ast.parse(_source()))

    offenders = sorted(used & set(FORKING_NAMES))

    assert offenders == [], (
        f"rhizome_graph/gitignore.py names {offenders}. The matcher is pure "
        "Python over text: shelling out to `git check-ignore` would fork once "
        "per path on a walk of 20 000, and gitcmd stays the one place in this "
        "project where a process is started."
    )


def test_gitignore_knows_no_rhizome_policy():
    """It answers git's question. Which directories are noise is not its business.

    `IGNORED_DIRS` is about generated output and `.git` is a rhizome rule that
    git itself never writes in a `.gitignore` -- decision 1 keeps it in the
    caller, ahead of any negation. Either of them appearing here means the two
    filters have started to merge, and the next person to raise a cap or add
    `.git/info/exclude` is editing the module three others walk through.
    """
    parsed = ast.parse(_source())

    assert "IGNORED_DIRS" not in _identifiers(parsed)
    assert ".git" not in _string_constants(parsed)
