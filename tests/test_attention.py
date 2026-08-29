"""Contract tests (RED) for rhizome_graph.attention -- the rules a user declares.

Motivation: nothing in this project holds a pattern somebody wrote *about* a
project. `Settings` carries ten fields and none of them is a policy about paths;
`gitignore.py`'s rules are always discovered per directory from a file inside the
tree being walked; `normalize.py` is pure and on the hook's hot path and cannot
read anything. So "tell me when an agent touches `package.json`" has nowhere to
live.

This module is that missing place: one file, at the observed root, read once,
compiled by `gitignore.py`'s **pure** layer -- `compile_rule` and `match_rules`,
which carry git's syntax and no rhizome policy at all. `IgnoreRules` is refused
in the same breath: everything in it is about a rule file that lives *inside* the
tree it governs, per-directory governance and an invalidation problem this
feature does not have.

Four properties carry the file and each is a test below.

  * **The caps are the matcher's own, by identity.** `MAX_BYTES` **is**
    `gitignore.MAX_IGNORE_BYTES`, the same object, for the reason
    `content_search.MAX_FILE_BYTES` **is** `file_view.DEFAULT_MAX_BYTES`: two
    constants that happen to be equal is the bug waiting to happen. On top of it
    this module adds one cap of its own, because 1 000 rules at the measured
    linear cost is ten times the whole of today's per-event path.
  * **The direction of failure inverts, and that is the finding of the plan.** In
    `gitignore.py` a refused pattern, an unreadable file or a cap reached shows
    **more** -- and its docstring says so. Reused here the same refusal alarms
    **less**: the user wrote a rule about `*.pem`, the module could not translate
    it, and the graph reports the silence that means "nothing has happened". So a
    refusal is *recorded* rather than dropped: `refused` exists so the panel has
    something to quote, and `source` exists so "no rule file" and "an empty rule
    file" stay two different facts.
  * **It never raises.** A missing file, a directory, a mode of `0o000` and a
    named pipe all answer `EMPTY`. A daemon that will not boot because a rule
    file is odd is worse than one that boots without rules and says so.
  * **It opens exactly one path, through `safe_read`.** A rule file at a path the
    user typed can be a FIFO, and a bare `open()` parks a worker thread the
    daemon's shutdown then joins.

On `matches` having no `is_dir` parameter. The plan argued that events name files,
so the section-0 wart is unreachable; the measurement below says the opposite --
the wart lives at `is_dir=False`, which is the mode the plan chose, and
`EventHub._expand` publishes a deleted directory's **own path** last, so a
`rm -rf src/` really does ask about `src`. `matches` therefore asks the matcher
twice, as a file and as a directory, and answers only when both agree. That is a
rule of this caller, not of git -- the same split `CLAUDE.md` records for `.git`
and `node_modules`.

Every verdict asserted here was measured against the real `rhizome_graph.gitignore`
before it was written down.

Style: Arrange-Act-Assert, one property per test.
"""

from __future__ import annotations

import ast
import inspect
import os
import threading
from pathlib import Path

import pytest

from rhizome_graph import gitignore

# The module does not exist yet: this import failing IS the first RED, and it is
# why every test below reports at once instead of one at a time.
from rhizome_graph import attention

#: Eleven patterns of the shape the feature exists for -- the workflow directory,
#: the manifests, the lockfiles, the secrets, the packaging. Every verdict in
#: `REALISTIC_VERDICTS` was measured against the real matcher.
REALISTIC_PATTERNS = """\
.github/workflows/
package.json
package-lock.json
pyproject.toml
setup.py
.claude/settings.json
*.pem
.env
Dockerfile
*.lock
debian/
"""

#: What those eleven answer, path by path. `debian` is the one worth reading
#: twice: the *directory entry itself* does not alarm, while everything under it
#: does -- see `test_a_directory_delete_does_not_alarm_on_a_directory_only_rule`.
REALISTIC_VERDICTS = (
    ("package.json", True),
    ("web/package.json", True),
    ("pyproject.toml", True),
    ("key.pem", True),
    ("certs/key.pem", True),
    (".env", True),
    ("debian/control", True),
    ("debian", False),
    ("web/src/renderer.ts", False),
    ("README.md", False),
    (".github/workflows/ci.yml", True),
    (".claude/settings.json", True),
    ("poetry.lock", True),
)

#: "Anything outside `src/`", in git's own syntax and in three lines. It is the
#: hardest of the user's named targets and it needs no new pattern language,
#: which is the single strongest argument for reusing the matcher.
OUTSIDE_SRC = "*\n!src/\n!src/**\n"

#: What `matches` must answer for those three lines.
OUTSIDE_SRC_VERDICTS = (
    ("src/a.ts", False),
    ("src/deep/b.ts", False),
    ("docs/x.md", True),
    ("package.json", True),
    ("src", False),
)

#: The same three lines put to `gitignore.match_rules` directly, `is_dir` and all:
#: `(path, is_dir, answer)`, measured, not summarised. The third row is **the
#: wart**: the directory entry `src` answers `True` as a *file*, because `!src/`
#: is `dir_only` and the negation applies to the directory while `*` matched it
#: first at the same level. It is recorded here rather than described because the
#: plan's own summary of it was backwards, and the next reader should meet the
#: measurement.
SECTION_ZERO = (
    ("src/a.ts", False, False),
    ("src/deep/b.ts", False, False),
    ("docs/x.md", False, True),
    ("package.json", False, True),
    ("src", False, True),  # <-- the wart: True as a file
    ("src", True, False),  # ... and False as a directory, which is what saves us
)

#: A POSIX bracket class. `re` reads this spelling as an ordinary class of the
#: punctuation and letters inside it and matches the wrong thing *silently*, so
#: `compile_rule` refuses it whole -- verified: it really does answer `None`.
#: Under `gitignore.py` that shows one more file; here it alarms one file less,
#: which is the whole of R7.
REFUSED_PATTERN = "[[:alpha:]].pem"

#: Names that start a process. A rule file is read and nothing else is done with
#: it; the precedent is `checkouts.py`'s "starts no process", asserted the same
#: way over the parsed source.
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
    "create_subprocess_exec",
    "create_subprocess_shell",
    "gitcmd",
)


def _rule_file(directory: Path, text: str, name: str = ".rhizome-attention") -> str:
    """Write `text` as a rule file under `directory` and return its path."""
    target = directory / name
    target.write_text(text, encoding="utf-8")
    return str(target)


# --- 1. the caps are the matcher's own -------------------------------------


def test_the_byte_cap_is_the_matchers_own_constant_and_not_a_copy_of_it():
    """`is`, not `==`: a second literal of the same value is what drifts.

    The precedent is stated in `CLAUDE.md` for `content_search.MAX_FILE_BYTES`
    **is** `file_view.DEFAULT_MAX_BYTES`, and the reason is the same one here: the
    rule file is read by this module and its size is bounded by the module that
    knows what a pattern file costs.
    """
    assert attention.MAX_BYTES is gitignore.MAX_IGNORE_BYTES


def test_the_rule_cap_is_this_modules_own_and_is_far_below_the_matchers():
    """64, and the number is a budget rather than a formality.

    Measured on the plan's host: 11 rules cost 5.35 us per event and 200 cost
    64.1 us, against a watcher path that costs 30.29 us in total. At
    `MAX_RULES_PER_FILE` (1 000) the matching alone would be ten times the whole
    of today's path. A rule file with more than 64 patterns is not a supervision
    policy, it is a second `.gitignore`.
    """
    assert attention.MAX_ATTENTION_RULES == 64
    assert attention.MAX_ATTENTION_RULES < gitignore.MAX_RULES_PER_FILE


def test_the_default_rule_file_is_named_once_and_is_a_basename():
    """The default lives *under the observed root*, so it moves with a `ctrl+L`.

    A basename rather than a path: `Session` joins it to the root it currently
    observes, which is what makes the default follow a switch while an explicit
    `--attention-rules` does not.
    """
    assert attention.DEFAULT_RULE_FILE == ".rhizome-attention"
    assert os.path.basename(attention.DEFAULT_RULE_FILE) == attention.DEFAULT_RULE_FILE


# --- 2. reading a rule file -------------------------------------------------


def test_a_realistic_rule_file_yields_one_rule_per_pattern(tmp_path: Path):
    path = _rule_file(tmp_path, REALISTIC_PATTERNS)

    rules = attention.load_rules(path)

    assert len(rules.rules) == 11


def test_a_rule_file_that_was_read_names_itself(tmp_path: Path):
    """`source` is what lets the panel say *which* file it is enforcing.

    It also makes an explicit `--attention-rules` visible after a root switch,
    where its patterns are silently re-anchored to the new root.
    """
    path = _rule_file(tmp_path, REALISTIC_PATTERNS)

    assert attention.load_rules(path).source == path


def test_a_rule_file_that_fits_refuses_nothing_and_is_not_truncated(tmp_path: Path):
    path = _rule_file(tmp_path, REALISTIC_PATTERNS)

    rules = attention.load_rules(path)

    assert (rules.refused, rules.truncated) == ((), False)


def test_a_rule_file_that_produced_no_rules_still_names_itself(tmp_path: Path):
    """"No rule file" and "an empty rule file" are two different facts.

    This is R7's central property on the daemon side. The panel has to be able to
    say "I read this file and it asks for nothing" rather than showing the same
    empty corner it shows when no file was found at all -- and that distinction
    can only be made if `source` survives a file that contributed no rules. It is
    also the documented way to say "watch nothing here", exactly as an empty
    `.gitignore` is the documented way to say "draw everything here".
    """
    path = _rule_file(tmp_path, "# nothing but a comment\n\n   \n")

    rules = attention.load_rules(path)

    assert (rules.rules, rules.source) == ((), path)


def test_the_empty_answer_names_no_file(tmp_path: Path):
    """The other half of the sentence above: `EMPTY` means nobody was read."""
    assert attention.EMPTY == attention.AttentionRules((), "", (), False)
    assert attention.EMPTY.source == ""


# --- 3. what the rules answer ----------------------------------------------


def test_the_realistic_patterns_answer_as_measured(tmp_path: Path):
    """The eleven-pattern fixture, path by path, against the real matcher."""
    rules = attention.load_rules(_rule_file(tmp_path, REALISTIC_PATTERNS))

    answers = {path: attention.matches(rules, path) for path, _ in REALISTIC_VERDICTS}

    assert answers == dict(REALISTIC_VERDICTS)


def test_anything_outside_src_is_three_lines_of_gits_own_syntax(tmp_path: Path):
    """The hardest target the user named, and it needs no new pattern language."""
    rules = attention.load_rules(_rule_file(tmp_path, OUTSIDE_SRC))

    answers = {path: attention.matches(rules, path) for path, _ in OUTSIDE_SRC_VERDICTS}

    assert answers == dict(OUTSIDE_SRC_VERDICTS)


def test_a_directory_only_pattern_reaches_the_files_under_it(tmp_path: Path):
    """`.github/workflows/` naming `ci.yml` is the matcher's ancestor rule.

    It is what makes a directory pattern useful to this feature with nothing
    added, and it is measured: `.github/x.md`, which is *not* under it, answers
    `False`.
    """
    rules = attention.load_rules(_rule_file(tmp_path, ".github/workflows/\n"))

    assert (
        attention.matches(rules, ".github/workflows/ci.yml"),
        attention.matches(rules, ".github/x.md"),
    ) == (True, False)


def test_the_section_zero_table_is_recorded_as_measured(tmp_path: Path):
    """The raw matcher answers, `is_dir` included, including the wart.

    Not an assertion about `attention` at all: it is the measurement this
    module's shape is a response to, written into the suite so that a later
    reader arguing about `is_dir` argues with a fixture rather than with a
    summary. If `gitignore.py` ever changes its answer for `("src", False)`, the
    reason `matches` asks twice has gone, and this test is where that shows up.
    """
    rules = attention.load_rules(_rule_file(tmp_path, OUTSIDE_SRC))

    answers = [
        (path, is_dir, gitignore.match_rules(rules.rules, path, is_dir))
        for path, is_dir, _ in SECTION_ZERO
    ]

    assert answers == list(SECTION_ZERO)


# --- 4. no `is_dir`, and what that has to mean ------------------------------


def test_matches_exposes_no_is_dir_parameter_at_all():
    """The signature is the test; adding the flag is the obvious "improvement".

    A caller that could pass `is_dir` would have to decide, per event, what a
    path *is* -- and an event carries no such fact. The module answers one
    question about one string.
    """
    parameters = list(inspect.signature(attention.matches).parameters)

    assert "is_dir" not in parameters
    assert len(parameters) == 2, (
        f"attention.matches takes {parameters}. It answers one question about "
        "one path: the rules, and the path."
    )


def test_a_directory_delete_does_not_alarm_on_a_directory_the_rules_excluded(
    tmp_path: Path,
):
    """`rm -rf src/` under "anything outside `src/`" must stay silent.

    Reachable, and not an edge case: `EventHub._expand` turns a directory
    deletion into `[*children, path]`, so the directory's **own** path is the
    last event published. Asked as a file -- the only mode this module has --
    `src` answers `True` (the wart in `SECTION_ZERO`), and the panel would alarm
    on the one directory the user wrote two lines to exclude.

    A straight delegation to `match_rules(rules.rules, relative)` fails here,
    which is the point of the test. The answer belongs to this caller, the same
    way `.git` and `node_modules` belong to `tree.py` rather than to
    `gitignore.py`.
    """
    rules = attention.load_rules(_rule_file(tmp_path, OUTSIDE_SRC))

    assert attention.matches(rules, "src") is False


def test_a_directory_delete_does_not_alarm_on_a_directory_only_rule(tmp_path: Path):
    """The same property from the other side: `debian/` speaks about the files.

    `debian/control` alarms and the entry `debian` does not, which is the answer
    the rule asks for: a directory-only pattern reaches a file through its
    ancestors, and the ancestor itself is not a file anybody edited.
    """
    rules = attention.load_rules(_rule_file(tmp_path, REALISTIC_PATTERNS))

    assert attention.matches(rules, "debian") is False


def test_matching_against_no_rules_at_all_is_quiet_rather_than_an_error():
    """`EMPTY` is the boot state and the answer for every unreadable file."""
    assert attention.matches(attention.EMPTY, "package.json") is False
    assert attention.matches(attention.EMPTY, "") is False


# --- 5. a refused pattern is recorded, never dropped ------------------------


def test_a_pattern_the_matcher_refuses_is_recorded_verbatim(tmp_path: Path):
    """Verbatim, so the report can quote the line the user actually typed.

    Normalised, stripped or re-spelled, it stops being findable in the file the
    reader has open, which is the one thing the report exists to help with.
    """
    path = _rule_file(tmp_path, f"package.json\n{REFUSED_PATTERN}\n*.lock\n")

    rules = attention.load_rules(path)

    assert rules.refused == (REFUSED_PATTERN,)


def test_a_refused_pattern_is_absent_from_the_rules_in_force(tmp_path: Path):
    """It is refused because `re` would match the *wrong* thing, silently."""
    path = _rule_file(tmp_path, f"package.json\n{REFUSED_PATTERN}\n*.lock\n")

    rules = attention.load_rules(path)

    assert len(rules.rules) == 2


def test_the_patterns_around_a_refused_one_still_work(tmp_path: Path):
    """One bad line costs one rule, never the file.

    And the price of that line is stated rather than hidden: `key.pem` does
    **not** alarm, which is the direction of failure this whole feature has to
    report out loud.
    """
    path = _rule_file(tmp_path, f"package.json\n{REFUSED_PATTERN}\n*.lock\n")

    rules = attention.load_rules(path)

    assert (
        attention.matches(rules, "package.json"),
        attention.matches(rules, "poetry.lock"),
        attention.matches(rules, "key.pem"),
    ) == (True, True, False)


def test_four_good_patterns_and_one_refusal_leave_four_rules(tmp_path: Path):
    """R7 step 7.1, in the shape the panel's header reports it."""
    path = _rule_file(
        tmp_path,
        f"package.json\npyproject.toml\n.env\nDockerfile\n{REFUSED_PATTERN}\n",
    )

    rules = attention.load_rules(path)

    assert (len(rules.rules), rules.refused) == (4, (REFUSED_PATTERN,))


# --- 6. it never raises -----------------------------------------------------


def test_a_rule_file_that_is_not_there_answers_empty(tmp_path: Path):
    """The ordinary case: no project has one until somebody writes one."""
    assert attention.load_rules(str(tmp_path / "nothing-here")) == attention.EMPTY


def test_a_directory_where_a_rule_file_was_named_answers_empty(tmp_path: Path):
    directory = tmp_path / "rules-dir"
    directory.mkdir()

    assert attention.load_rules(str(directory)) == attention.EMPTY


@pytest.mark.skipif(os.getuid() == 0, reason="root reads a mode 0o000 file anyway")
def test_a_rule_file_nobody_may_read_answers_empty(tmp_path: Path):
    """A daemon that will not boot because a rule file is odd is the worse bug."""
    path = Path(_rule_file(tmp_path, REALISTIC_PATTERNS))
    path.chmod(0o000)

    try:
        assert attention.load_rules(str(path)) == attention.EMPTY
    finally:
        path.chmod(0o600)


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="no FIFOs on this platform")
def test_a_rule_file_that_is_a_named_pipe_does_not_park_the_thread(tmp_path: Path):
    """The reason the read must go through `safe_read`, and not a bare `open`.

    Nothing is ever written to the pipe, deliberately: a writerless FIFO is
    exactly the shape that blocks `open(2)` forever. `read_capped` opens with
    `O_NONBLOCK` and refuses anything that is not a regular file, which answers
    `OSError` for the pipe, for a directory and for a mode of `0o000` alike.

    Run on a daemon thread with a bounded join, so a regression reports a failure
    instead of hanging the suite.
    """
    path = str(tmp_path / ".rhizome-attention")
    os.mkfifo(path)
    answer: list[object] = []

    worker = threading.Thread(
        target=lambda: answer.append(attention.load_rules(path)), daemon=True
    )
    worker.start()
    worker.join(timeout=5.0)

    assert not worker.is_alive(), (
        "loading a rule file that is a named pipe blocked for 5 s. The read must "
        "go through safe_read.read_capped: this daemon's executor is shared with "
        "scan_tree and the content search, a worker cannot be cancelled, and "
        "shutdown joins them -- so one FIFO eventually means a daemon that "
        "cannot even exit."
    )
    assert answer == [attention.EMPTY]


# --- 7. the caps bind, and say that they did --------------------------------


def test_a_rule_file_past_the_cap_keeps_exactly_the_cap(tmp_path: Path):
    path = _rule_file(tmp_path, "".join(f"p{index}.txt\n" for index in range(200)))

    rules = attention.load_rules(path)

    assert len(rules.rules) == attention.MAX_ATTENTION_RULES


def test_a_rule_file_past_the_cap_says_it_was_cut(tmp_path: Path):
    """`truncated` means "not everything in this file is in force".

    Which is the fact the panel needs, and it is true whether the byte cap or the
    rule cap did the cutting: the reader's question is "is what I wrote being
    enforced", not "which of your two limits stopped first".
    """
    path = _rule_file(tmp_path, "".join(f"p{index}.txt\n" for index in range(200)))

    assert attention.load_rules(path).truncated is True


# --- 8. the module's boundary, over its parsed source -----------------------


def _source() -> str:
    return Path(attention.__file__).read_text(encoding="utf-8")


def _identifiers(module: ast.Module) -> set[str]:
    """Every name the code *uses*: bare names, attributes and imported modules.

    Identifiers rather than raw text, the technique `tests/test_checkouts.py`
    uses and for its reason: this module's docstring is expected to say that it
    forks nothing and opens one path through `safe_read`, and a substring search
    would then fail on the promise instead of on a breach of it.
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


def test_attention_never_starts_a_process():
    """No `git`, no shell, by construction rather than by convention.

    Asserted over every identifier in the parsed source, so a late
    `import subprocess` inside a function -- the form this leaks back in, because
    it changes no import block a reviewer skims -- reads the same as a lone
    `os.popen`.
    """
    used = _identifiers(ast.parse(_source()))

    offenders = sorted(used & set(FORKING_NAMES))

    assert offenders == [], (
        f"rhizome_graph/attention.py names {offenders}. It reads one file the "
        "user wrote and compiles patterns; there is nothing here to fork."
    )


def test_attention_opens_nothing_itself():
    """The read is `safe_read`'s, and there is no second way in.

    A rule file sits at a path a person typed, so it can be a FIFO, and the
    defence against that is a chokepoint or it is nothing: a module that reaches
    it through one caller and re-implements it for another has no chokepoint.
    """
    used = _identifiers(ast.parse(_source()))

    assert "open" not in used, (
        "rhizome_graph/attention.py names `open`. The one read here goes through "
        "safe_read.read_capped, which opens with O_NONBLOCK and refuses anything "
        "that is not a regular file -- the whole reason that module exists."
    )
    assert "safe_read" in used, (
        "rhizome_graph/attention.py never names safe_read, so either it does not "
        "read the rule file at all or it found another way to do it."
    )
