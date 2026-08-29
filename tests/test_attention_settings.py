"""Contract tests (RED) for naming a rule file in the configuration.

Motivation: `rhizome_graph.attention` can read a rule file, and nothing can tell
it which one. `Settings` is frozen and complete and holds no path-as-policy, and
`daemon/server.py`'s `main()` is the **only** place in the daemon that may touch
`os.environ` -- `tests/test_daemon_environment_boundary.py` pins that with no
exemptions, and its definition of "reads the environment" is wide enough to catch
`default_web_dist(os.environ)` passed as an argument. So the rule file's path can
be read in exactly one place, `cli.py`, inside the existing pure
`argv + environ + cwd -> Settings`.

Two rules already written down decide the shape, and both are quoted rather than
re-derived:

  * **The value stays a string, and stays exactly the string it was given.**
    `web_dist`'s rule, for `web_dist`'s reason: "deciding which candidate exists
    is a filesystem question, and this value is built without a filesystem". So
    `~/rules` is stored as `~/rules`, unexpanded and unresolved; `Session`
    resolves it, because `Session` is the thing that knows the root and the thing
    that changes it. Empty means "use the default under the observed root".
  * **A default may be adjusted; an explicit request may not.** An explicit
    `--attention-rules` naming something that is not a readable file refuses at
    boot -- rc 1, one line, no traceback -- exactly as an explicit `--port` that
    is taken does. A person who typed a path and got silence has been lied to,
    and here the silence is *indistinguishable from the feature working*: an
    empty alarm panel is what a well-behaved session looks like. The **default**
    being absent is the ordinary case and degrades to no rules at all.

**The regression jaw for this row is `tests/test_daemon_environment_boundary.py`,
and it is deliberately not copied here.** A new `Settings` field is exactly the
kind of change that tempts a reader to have the daemon fetch it from the air; the
existing test already fails loudly if it does, and a second copy of it would be a
second thing to keep in step.

Style: Arrange-Act-Assert, one property per test.
"""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

import pytest
from rhi_process import (
    REPO_ROOT,
    URL,
    clean_environment,
    entry_argv,
    free_port,
    start,
)

import rhizome_graph.cli as cli
from rhizome_graph.cli import build_parser, settings_from

CWD = "/work/project"

#: The variable the flag falls back to. Spelled as a literal in the environments
#: below on purpose: an environment is a plain mapping of strings, and a test
#: that built its keys from the constant it is checking would pass whatever the
#: constant said. One test binds the two.
ATTENTION_VARIABLE = "RHIZOME_ATTENTION"

#: How long a refusal is given before the test concludes that `rhi` started a
#: daemon instead of refusing. Generous: this is a Python interpreter start plus
#: an import, on a machine that may be running the rest of the suite.
REFUSAL_TIMEOUT_SECONDS = 60.0

#: How long a daemon is given to announce its URL.
STARTUP_TIMEOUT_SECONDS = 60.0


def _args(*argv: str) -> argparse.Namespace:
    """One command line, parsed by the parser the CLI actually ships."""
    return build_parser().parse_args(list(argv))


# --- 1. the setting exists, and defaults to "no override" -------------------


def test_no_flag_and_no_variable_means_no_rule_file_was_named():
    """Empty is "use the default under the observed root", not "no rules".

    The two are different: the default file usually does not exist, and that is
    the ordinary state of every project that has not asked for this feature.
    """
    assert settings_from(_args(), {}, CWD).attention_rules == ""


def test_the_flag_beats_the_variable_which_beats_the_default():
    """One precedence rule for every field, so a second front door can rely on it."""
    environ = {ATTENTION_VARIABLE: "/from/environ"}

    assert (
        settings_from(_args("--attention-rules", "/from/flag"), environ, CWD)
        .attention_rules
        == "/from/flag"
    )
    assert settings_from(_args(), environ, CWD).attention_rules == "/from/environ"
    assert settings_from(_args(), {}, CWD).attention_rules == ""


def test_the_environment_variable_is_named_beside_the_others():
    """The name lives as a constant, where `WEB_DIST_ENV` and `ROOT_ENV` live.

    A literal buried in `settings_from` is one nobody can grep for from the
    documentation, and this variable is the only way a wrapper script can point
    the daemon at a rule file.
    """
    assert getattr(cli, "ATTENTION_ENV", None) == ATTENTION_VARIABLE


def test_an_exported_variable_left_blank_reads_as_unset():
    """`export RHIZOME_ATTENTION=` is a wrapper saying "I did not choose"."""
    assert settings_from(_args(), {ATTENTION_VARIABLE: ""}, CWD).attention_rules == ""


# --- 2. the value is carried verbatim ---------------------------------------


@pytest.mark.parametrize(
    "given",
    ["~/rules", "../rules/attention", "rules.txt", "/etc/rhizome/attention"],
)
def test_the_path_is_carried_exactly_as_it_was_written(given: str):
    """Unexpanded and unresolved -- `web_dist`'s rule, for `web_dist`'s reason.

    `~` and a relative path both need a home and a working directory to mean
    anything, and this function has neither by contract. Resolving here would
    also fix the path to the root the daemon booted with, which is precisely what
    an explicit rule file must *not* do when `ctrl+L` moves the root.
    """
    assert settings_from(_args("--attention-rules", given), {}, CWD).attention_rules == given
    assert settings_from(_args(), {ATTENTION_VARIABLE: given}, CWD).attention_rules == given


def test_settings_stays_frozen_with_the_new_field():
    """Configuration read twice must not be able to differ between the reads."""
    settings = settings_from(_args("--attention-rules", "/x"), {}, CWD)

    with pytest.raises(Exception):
        settings.attention_rules = "/y"  # type: ignore[misc]


# --- 3. an explicit path that is not a readable file refuses at boot --------


@pytest.mark.parametrize("kind", ["missing", "directory"])
def test_an_explicit_rule_file_that_cannot_be_read_refuses_to_start(
    tmp_path: Path, kind: str
):
    """rc 1, one line naming the path, no traceback, and no daemon.

    The refusal belongs beside the port and socket refusals in `cli.main()`,
    before anything is bound: refusing after a port is open leaves a daemon to
    tear down for a mistake that was visible before it started.

    The silence this replaces is the sharpest failure this feature can produce.
    A mistyped `--attention-rules` would leave the graph running with no rules at
    all, and an alarm panel that never alarms looks exactly like a project where
    nothing has gone wrong.
    """
    if kind == "missing":
        target = tmp_path / "no-such-rules"
    else:
        target = tmp_path / "rules-dir"
        target.mkdir()

    try:
        completed = subprocess.run(
            entry_argv(
                (
                    str(tmp_path),
                    "--no-window",
                    "--attention-rules",
                    str(target),
                    "--port",
                    str(free_port()),
                    "--socket",
                    str(tmp_path / "ingest.sock"),
                )
            ),
            cwd=str(REPO_ROOT),
            env=clean_environment(),
            capture_output=True,
            text=True,
            timeout=REFUSAL_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        pytest.fail(
            "`rhi --attention-rules <unreadable>` started a daemon instead of "
            "refusing. An explicit request may not be adjusted, and a rule file "
            "nobody can read is an explicit request that cannot be honoured."
        )

    assert completed.returncode == 1, completed.stderr
    assert "Traceback" not in completed.stderr, completed.stderr
    assert str(target) in completed.stderr, completed.stderr
    assert len([line for line in completed.stderr.splitlines() if line.strip()]) == 1, (
        "the refusal is one line: this is a typo in a flag, not an incident "
        f"report.\n--- stderr ---\n{completed.stderr}"
    )
    assert URL.search(completed.stdout) is None, (
        "`rhi` announced a URL before refusing, so something was bound: the "
        f"check belongs before the port is chosen.\n--- stdout ---\n{completed.stdout}"
    )
    assert not (tmp_path / "ingest.sock").exists()


def test_a_default_rule_file_that_is_absent_starts_normally(tmp_path: Path):
    """The ordinary case: almost no project has one, and that is not an error.

    **This one is the jaw, and it is green today** -- said out loud, the way the
    plan says 4.2 must be, because a test that was never red is a test whose
    purpose is invisible six months later. It exists so that the refusal above
    cannot be implemented as "refuse whenever the rule file is missing", which
    would take every project that has never heard of this feature offline.
    `<root>/.rhizome-attention` is deliberately not created here.
    """
    root = tmp_path / "observed"
    root.mkdir()
    (root / "hello.txt").write_text("hello\n", encoding="utf-8")
    assert not (root / ".rhizome-attention").exists()

    running = start(
        (
            str(root),
            "--no-window",
            "--port",
            str(free_port()),
            "--socket",
            str(tmp_path / "ingest.sock"),
        )
    )
    try:
        running.wait_for_line(URL, STARTUP_TIMEOUT_SECONDS)
        alive = running.is_alive()
    finally:
        running.stop()

    assert alive
