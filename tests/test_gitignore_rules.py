"""Contract tests (RED) for `gitignore.IgnoreRules` -- the stateful half, G2.

Motivation: a rule set is not a property of a root, it is a property of a
*directory*. A nested `.gitignore` adds rules below itself and only below
itself, and until something knows that, the workspace root this project was
built for -- `rhi ~/projects`, a folder of checkouts, each keeping its ignores
at its own top level -- has no ignore rules at all. Measured on this host:
4 920 files instead of 843. Nested support is not a refinement of the feature,
it *is* the workspace case working.

`tests/test_gitignore.py` pins the pure half (G1) and says of itself that it
touches no filesystem. This file is the other half and it touches nothing else:
every case here is a real `tmp_path` tree with real `.gitignore` files in it.
Keeping them apart is what keeps that sentence true, and what keeps a pattern
bug and a stack bug from being reported by the same failure.

Four properties carry the file, and each was measured against real
`git check-ignore` (git 2.43) rather than reasoned about:

  * **A nested file's patterns are relative to ITS OWN directory.** A
    `sub/.gitignore` holding `/dist` anchors to `sub/`, so it hides `sub/dist`
    and says nothing about `sub/deeper/dist`. The implementation this rules out
    is the tempting one: concatenate every ancestor's rules into one list and
    match the root-relative path against it once. That is right for the
    leaf-name case, which is most of a `.gitignore`, and wrong for every
    anchored pattern -- so it passes the obvious test and fails in the field.
  * **`ignored` is a different traversal, not a refinement of `match_rules`.**
    With `build/` followed by `!build/keep.txt`, `git check-ignore -v
    build/keep.txt` names `build/` as the deciding pattern: git stops at the
    first excluded *ancestor* and never reaches the negation below it. A flat
    last-match-wins over the leaf answers the opposite. The walk gets this rule
    for free, because it prunes the directory and never descends; the watcher
    has no walk and must pay for it per path.
  * **Never above the root.** This daemon does not open a file outside the root
    the user pointed at, not even to decide what to draw -- the same rule
    `resolve_inside` and `_read_path` enforce for a path off the network. Git
    does read those files; the divergence is deliberate and its price is that
    observing a subdirectory of a checkout leaves that subtree ungoverned,
    which is today's behaviour, so nothing regresses.
  * **Never raises, and a failure shows MORE.** An unreadable file, a
    `.gitignore` that is a directory, a root that does not exist, bytes that are
    not UTF-8: each yields no rules, and no rules means the tree is drawn. This
    feature exists to show more, so that is the safe direction.

Two things the plan left open are decided here, and both are decisions rather
than measurements, so they are stated as such in the tests that pin them: what
the empty relative path answers, and whether a `.gitignore` that is a directory
is survivable.

One thing the plan left open is now settled by a measurement: a `.gitignore`
that is a **named pipe** hangs `git check-ignore` itself (timed out at 3 s
against git 2.43), and `scan_tree` filters symlinks but not FIFOs. The read goes
through `safe_read.read_capped`, which is word for word the rule that module's
docstring states.

Style: Arrange-Act-Assert, one property per test.
"""

from __future__ import annotations

import os
import threading

import pytest

from rhizome_graph.gitignore import (
    MAX_IGNORE_BYTES,
    MAX_IGNORE_FILES,
    IgnoreRules,
    match_rules,
    parse_patterns,
)


def _write(path, text: str) -> None:
    """Create a file and every directory above it, in one line."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


# --- 2.2 a nested file governs its own subtree and no other ------------------
#
# The first test of this step, and it is first because 2.1 -- a root
# `.gitignore` and nothing else -- is satisfiable by a root-only implementation,
# which is the wrong shape and would then have to be unwound.


def test_a_nested_gitignore_governs_its_own_subtree_and_no_other(tmp_path):
    """`sub/.gitignore` speaks for `sub/`, and for nothing beside it.

    Verified against git 2.43 over the same tree: `sub/a.tmp` is ignored by
    `sub/.gitignore:1:*.tmp`, and `a.tmp` at the root is not ignored at all.
    """
    _write(tmp_path / "sub" / ".gitignore", "*.tmp\n")

    rules = IgnoreRules(str(tmp_path))

    assert rules.ignored_child("sub", "a.tmp", False) is True
    assert rules.ignored_child("", "a.tmp", False) is False


def test_a_nested_anchored_pattern_anchors_to_the_directory_that_declared_it(tmp_path):
    """The assertion a concatenating implementation cannot pass.

    `sub/.gitignore` holding `/dist` is anchored to `sub/`, so it compiles to a
    regex that matches `dist` and nothing else. Concatenate every ancestor's
    rules and match the ROOT-relative path `sub/dist` against them once and the
    answer is False: the stack has to re-relativize per level.

    The third assertion is the guard against over-correcting into "match the
    leaf name against every ancestor's rules", which would hide
    `sub/deeper/dist` too. Measured against git 2.43 over this exact tree: the
    first is ignored by `sub/.gitignore:1:/dist`, the other two are not ignored.
    """
    _write(tmp_path / "sub" / ".gitignore", "/dist\n")

    rules = IgnoreRules(str(tmp_path))

    assert rules.ignored_child("sub", "dist", True) is True
    assert rules.ignored_child("", "dist", True) is False
    assert rules.ignored_child("sub/deeper", "dist", True) is False


# --- 2.1 the root's own file ------------------------------------------------


def test_the_roots_own_gitignore_hides_a_directory_it_names(tmp_path):
    _write(tmp_path / ".gitignore", "build/\n")

    rules = IgnoreRules(str(tmp_path))

    assert rules.ignored_child("", "build", True) is True
    assert rules.ignored_child("", "src", True) is False


def test_a_directory_only_pattern_does_not_hide_a_file_of_the_same_name(tmp_path):
    """`build/` speaks about a directory. The walk asks with `is_dir` either way."""
    _write(tmp_path / ".gitignore", "build/\n")

    rules = IgnoreRules(str(tmp_path))

    assert rules.ignored_child("", "build", False) is False


# --- 2.3 the stack accumulates, parent first --------------------------------


def test_the_roots_rules_still_apply_inside_a_directory_with_its_own_file(tmp_path):
    """A nested file ADDS rules; it does not replace the ones above it.

    Measured against git 2.43: with `*.log` at the root and `*.tmp` in `sub`,
    `sub/a.log` is ignored by `.gitignore:1:*.log`.
    """
    _write(tmp_path / ".gitignore", "*.log\n")
    _write(tmp_path / "sub" / ".gitignore", "*.tmp\n")

    rules = IgnoreRules(str(tmp_path))

    assert rules.ignored_child("sub", "a.log", False) is True
    assert rules.ignored_child("sub", "a.tmp", False) is True


def test_a_nested_negation_re_includes_what_the_root_hid(tmp_path):
    """Which is what pins the ORDER: parent first, child last, last match wins.

    Concatenate the other way round and the root's `*.log` gets the final say,
    so a checkout's own `!` line stops working the moment the workspace above it
    has an ignore file. Measured against git 2.43: `sub/a.log` is decided by
    `sub/.gitignore:1:!a.log`, while its sibling `sub/b.log` is still hidden by
    the root's `*.log`.
    """
    _write(tmp_path / ".gitignore", "*.log\n")
    _write(tmp_path / "sub" / ".gitignore", "!a.log\n")

    rules = IgnoreRules(str(tmp_path))

    assert rules.ignored_child("sub", "a.log", False) is False
    assert rules.ignored_child("sub", "b.log", False) is True


# --- 2.4 governs, which is the only thing `tree` asks about the fallback -----
#
# `gitignore.py` never learns what the fallback is (decision 7). It answers
# "does any ignore file speak here", and the caller decides what that means.


def test_a_root_with_no_ignore_file_governs_nothing(tmp_path):
    (tmp_path / "sub").mkdir()

    rules = IgnoreRules(str(tmp_path))

    assert rules.governs("") is False
    assert rules.governs("sub") is False


def test_an_empty_ignore_file_still_governs(tmp_path):
    """Decision 2's escape hatch, and the reason it has to be an EMPTY file.

    A user who wants everything under a root drawn writes a `.gitignore` with
    nothing in it. Derive `governs` from "did this file contribute any rules"
    and that hatch closes silently -- so it must derive from the file existing.
    """
    _write(tmp_path / ".gitignore", "")

    rules = IgnoreRules(str(tmp_path))

    assert rules.governs("") is True


def test_a_file_at_the_root_governs_every_directory_below_it(tmp_path):
    """Governed means "an ignore file exists at or above this directory"."""
    _write(tmp_path / ".gitignore", "*.log\n")
    (tmp_path / "sub" / "deeper").mkdir(parents=True)

    rules = IgnoreRules(str(tmp_path))

    assert rules.governs("sub") is True
    assert rules.governs("sub/deeper") is True


def test_a_nested_file_governs_its_own_subtree_without_governing_the_root(tmp_path):
    """The workspace shape: `~/projects` is ungoverned, each checkout is not."""
    _write(tmp_path / "checkout" / ".gitignore", "*.log\n")

    rules = IgnoreRules(str(tmp_path))

    assert rules.governs("") is False
    assert rules.governs("checkout") is True


# --- 2.5 `ignored` walks the ancestor chain ---------------------------------


def test_ignored_answers_for_a_file_under_a_directory_no_rule_names(tmp_path):
    """The watcher's entry point: it has no walk, so it must climb.

    Nothing here names `build/x/y.txt`. What names it is its ancestor, and the
    answer must still be True or the seed and the live events disagree about
    what exists -- a node on the graph that never flashes again.
    """
    _write(tmp_path / ".gitignore", "build/\n")

    rules = IgnoreRules(str(tmp_path))

    assert rules.ignored("build/x/y.txt", False) is True


def test_a_negation_below_an_excluded_directory_does_not_re_include(tmp_path):
    """Git stops at the first excluded ancestor and never reads the line below.

    Measured against git 2.43 over this exact file: `git check-ignore -v
    build/keep.txt` answers `.gitignore:1:build/` -- the *exclusion* is the
    deciding pattern, not the negation two lines later.
    """
    _write(tmp_path / ".gitignore", "build/\n!build/keep.txt\n")

    rules = IgnoreRules(str(tmp_path))

    assert rules.ignored("build/keep.txt", False) is True


def test_ignored_is_a_different_traversal_from_a_flat_last_match_wins(tmp_path):
    """The measurement that says `ignored` cannot be `match_rules` with a stack.

    G1's `match_rules` is git's last-match-wins over one directory's rules, and
    over these two lines it answers False for `build/keep.txt` -- correctly, on
    its own terms, because the ancestor rule is the caller's half of git's rule
    and its docstring says so. Pinned side by side so nobody later "simplifies"
    `ignored` into a single call to it.
    """
    _write(tmp_path / ".gitignore", "build/\n!build/keep.txt\n")
    flat = parse_patterns("build/\n!build/keep.txt\n")

    rules = IgnoreRules(str(tmp_path))

    assert match_rules(flat, "build/keep.txt", False) is False
    assert rules.ignored("build/keep.txt", False) is True


def test_a_negation_with_no_excluded_ancestor_still_re_includes(tmp_path):
    """The chain stops at the first EXCLUDED ancestor, not at the first match.

    Refuse every negation and the rule above becomes "a `!` never works", which
    is not git's behaviour: measured, `keep.log` is decided by
    `.gitignore:2:!keep.log` while `other.log` is hidden by line 1.
    """
    _write(tmp_path / ".gitignore", "*.log\n!keep.log\n")

    rules = IgnoreRules(str(tmp_path))

    assert rules.ignored("keep.log", False) is False
    assert rules.ignored("other.log", False) is True


def test_ignored_consults_a_nested_file_on_the_way_down(tmp_path):
    """The chain is not only ancestors: each level's own rules speak for it."""
    _write(tmp_path / "sub" / ".gitignore", "*.tmp\n")

    rules = IgnoreRules(str(tmp_path))

    assert rules.ignored("sub/a.tmp", False) is True
    assert rules.ignored("a.tmp", False) is False


# --- the empty relative path: the root itself -------------------------------
#
# The plan left this open. It is DECIDED here, and it is a decision rather than
# a measurement, because git's own answer is unusable: with `*` in the root
# `.gitignore`, `git check-ignore -v .` reports `.` as ignored by that pattern
# (measured, git 2.43). Honour that and a single common line blanks the entire
# graph -- root, seed and all -- with nothing on screen to say why.


def test_the_root_itself_is_never_ignored_by_a_file_inside_it(tmp_path):
    """A rule file cannot un-observe the root the user pointed at.

    `*` in a root `.gitignore` is an ordinary thing to write. The paths under it
    are hidden, exactly as git says; the root is not, because the root is the
    subject of the question and not an answer to it.
    """
    _write(tmp_path / ".gitignore", "*\n")

    rules = IgnoreRules(str(tmp_path))

    assert rules.ignored("", True) is False
    assert rules.ignored("", False) is False
    assert rules.ignored_child("", "", True) is False


def test_the_paths_under_a_star_are_still_hidden(tmp_path):
    """The other half, or the rule above would read as "`*` does nothing"."""
    _write(tmp_path / ".gitignore", "*\n")

    rules = IgnoreRules(str(tmp_path))

    assert rules.ignored("sub/a.txt", False) is True
    assert rules.ignored_child("", "sub", True) is True


# --- 2.6 never above the root -----------------------------------------------


def test_an_ignore_file_above_the_root_is_not_read(tmp_path):
    """Decision 4's security-shaped half, and a deliberate divergence from git.

    Measured against git 2.43: run from `sub/`, `git check-ignore -v keep.txt`
    answers `.gitignore:1:keep.txt` -- git climbs to the repository root. This
    daemon does not open a file outside the root the user pointed at, not even
    to decide what to draw. The price is stated in the module docstring: that
    subtree is governed by nothing, so the caller's fallback applies, which is
    today's behaviour.
    """
    _write(tmp_path / ".gitignore", "keep.txt\n")
    (tmp_path / "sub").mkdir()

    rules = IgnoreRules(str(tmp_path / "sub"))

    assert rules.ignored_child("", "keep.txt", False) is False
    assert rules.ignored("keep.txt", False) is False
    assert rules.governs("") is False


# --- 2.7 never raises, and every failure shows more --------------------------


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads a 0o000 file anyway")
def test_an_unreadable_ignore_file_yields_no_rules_and_raises_nothing(tmp_path):
    target = tmp_path / ".gitignore"
    _write(target, "*.log\n")
    target.chmod(0o000)

    rules = IgnoreRules(str(tmp_path))

    assert rules.ignored_child("", "a.log", False) is False


def test_an_ignore_file_that_is_a_directory_is_survivable(tmp_path):
    """The plan left this open; it is decided as "yes, and it contributes none".

    Not hypothetical -- `mkdir .gitignore` is what a botched `cp` leaves behind.
    Measured against git 2.43 over exactly this tree: `a.log` is not ignored and
    `git status` reports it untracked, so git reads the directory as no rules
    rather than as an error. `safe_read.read_capped` refuses a non-regular file
    with `EINVAL`, so the blanket `except OSError` is already the right catch;
    what this pins is that the refusal is per file and does not take the object
    with it.
    """
    (tmp_path / ".gitignore").mkdir()
    _write(tmp_path / "sub" / ".gitignore", "*.tmp\n")

    rules = IgnoreRules(str(tmp_path))

    assert rules.ignored_child("", "a.log", False) is False
    assert rules.ignored_child("sub", "a.tmp", False) is True


def test_a_root_that_does_not_exist_answers_and_raises_nothing(tmp_path):
    """`scan_tree`'s own rule: a missing root is an empty answer, not a failure."""
    rules = IgnoreRules(str(tmp_path / "gone"))

    assert rules.governs("") is False
    assert rules.ignored("a.log", False) is False
    assert rules.ignored_child("", "a.log", False) is False


def test_an_ignore_file_that_is_not_utf8_raises_nothing(tmp_path):
    """Bytes off a disk this project did not write are bytes, not text.

    Only the safe direction is asserted -- the file is not hidden -- because
    whether the undecodable line is replaced or the whole file dropped is the
    implementation's choice, and both show more rather than less.
    """
    target = tmp_path / ".gitignore"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"*.log\n\xff\xfe not text\n")

    rules = IgnoreRules(str(tmp_path))

    assert rules.ignored_child("", "keep.txt", False) is False


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="no FIFOs on this platform")
def test_an_ignore_file_that_is_a_named_pipe_does_not_park_the_thread(tmp_path):
    """The FIFO defence, which the plan left for this step to decide.

    Measured: `git check-ignore` ITSELF hangs on this tree -- killed at 3 s
    against git 2.43 -- so the hazard is real and not a theory about our own
    code. A plain `open()` here parks a worker permanently: the walk runs in
    `asyncio.to_thread`, a worker cannot be cancelled, the executor is shared
    with `switch_root` and the content search, and shutdown joins those threads,
    so the daemon eventually cannot even exit. `safe_read.read_capped` opens
    with `O_NONBLOCK` and refuses anything that is not a regular file, which is
    word for word the rule its own docstring states for a path this project did
    not construct -- and `scan_tree` filters symlinks but not FIFOs.

    Run on a daemon thread with a bounded join, so a regression reports a
    failure instead of hanging the suite.
    """
    os.mkfifo(str(tmp_path / ".gitignore"))
    answer: list[bool] = []

    def ask() -> None:
        answer.append(IgnoreRules(str(tmp_path)).ignored_child("", "a.log", False))

    worker = threading.Thread(target=ask, daemon=True)
    worker.start()
    worker.join(timeout=5.0)

    assert not worker.is_alive(), (
        "loading a `.gitignore` that is a named pipe blocked for 5 s. The read "
        "must go through safe_read.read_capped, which opens with O_NONBLOCK and "
        "refuses a non-regular file; a bare open(2) on a writerless FIFO parks "
        "a worker thread that can never be cancelled."
    )
    assert answer == [False]


# --- the byte cap, and the half pattern it can leave behind ------------------


def test_the_read_is_capped_and_its_final_incomplete_line_is_dropped(tmp_path):
    """Both halves of the capped read, pinned by one file.

    The file is built so the cut lands inside its last pattern, four characters
    into `*.tmp`. Three assertions, each failing for its own reason: `a.log`
    proves the front of the file survived; `a.tm` proves `truncated=True` was
    forwarded into `parse_patterns`, since the leftover `*.tm` would otherwise
    compile into a rule that hides a DIFFERENT set of files than the file on
    disk asks for; and `a.tmp` proves there is a cap at all.
    """
    head = "*.log\n"
    tail = "*.tmp\n"
    padding = "#" + "a" * (MAX_IGNORE_BYTES - len(head) - len("*.tm") - 2) + "\n"
    _write(tmp_path / ".gitignore", head + padding + tail)

    rules = IgnoreRules(str(tmp_path))

    assert rules.ignored_child("", "a.log", False) is True
    assert rules.ignored_child("", "a.tm", False) is False
    assert rules.ignored_child("", "a.tmp", False) is False


# --- 2.8 how many files one tree may contribute ------------------------------


def test_past_the_file_cap_no_further_ignore_file_is_loaded(tmp_path):
    """`MAX_IGNORE_FILES` bounds a tree the way `MAX_RULES_PER_FILE` bounds a file.

    Asserted at the two ends rather than at the exact boundary, so it holds
    whichever way the implementation counts a directory that has no ignore file
    at all. What must not happen is that the cap is missing, or that reaching it
    raises: the answer past it is "no rules", which shows more.
    """
    for index in range(MAX_IGNORE_FILES + 1):
        _write(tmp_path / f"d{index:04d}" / ".gitignore", "*.tmp\n")

    rules = IgnoreRules(str(tmp_path))
    answers = [
        rules.ignored_child(f"d{index:04d}", "a.tmp", False)
        for index in range(MAX_IGNORE_FILES + 1)
    ]

    assert answers[0] is True
    assert answers[-1] is False


# --- 2.9 the memo, and what clears it ----------------------------------------


def test_a_directorys_rules_are_read_once_and_kept(tmp_path):
    """The memo, asserted through what it guarantees rather than through a spy.

    A count of loader calls pins an implementation; this pins the behaviour that
    count exists for -- one object gives one answer for the lifetime it is held.
    It matters because the walk builds a fresh object per call while the watcher
    keeps one for its lifetime, and a walk that re-read every directory would
    turn 173.6 us of loading into a per-path cost.
    """
    target = tmp_path / ".gitignore"
    _write(target, "*.tmp\n")
    rules = IgnoreRules(str(tmp_path))
    assert rules.ignored_child("", "a.tmp", False) is True

    target.write_text("*.log\n", encoding="utf-8")

    assert rules.ignored_child("", "a.tmp", False) is True
    assert rules.ignored_child("", "a.log", False) is False


def test_invalidate_makes_the_next_question_read_the_file_again(tmp_path):
    """What the watcher calls when it sees a write whose basename is `.gitignore`.

    Without it, editing an ignore file has no effect until the daemon restarts,
    and the graph disagrees with the project for as long as the session lasts.
    """
    target = tmp_path / ".gitignore"
    _write(target, "*.tmp\n")
    rules = IgnoreRules(str(tmp_path))
    assert rules.ignored_child("", "a.tmp", False) is True

    target.write_text("*.log\n", encoding="utf-8")
    rules.invalidate()

    assert rules.ignored_child("", "a.tmp", False) is False
    assert rules.ignored_child("", "a.log", False) is True


def test_invalidate_picks_up_an_ignore_file_that_did_not_exist_before(tmp_path):
    """A negative answer must be forgotten too, or `governs` latches on False.

    A project's first `.gitignore` is created, not edited, and after G4 that is
    the write that switches the dotted fallback off for the whole tree.
    """
    (tmp_path / "sub").mkdir()
    rules = IgnoreRules(str(tmp_path))
    assert rules.governs("sub") is False

    _write(tmp_path / ".gitignore", "*.log\n")
    rules.invalidate()

    assert rules.governs("sub") is True
    assert rules.ignored_child("sub", "a.log", False) is True
