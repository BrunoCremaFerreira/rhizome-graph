"""Contract tests (RED) for capturing the hooks that are not tool calls.

Motivation: `config/settings.json` and this repository's own `.claude/settings.json`
name `PostToolUse` and nothing else, so the daemon hears about an agent only while
it is touching files. The three facts that would put an agent's *life* on camera --
it is blocked waiting for a human, its turn ended, a subagent finished -- are hooks
Claude Code already fires and nobody has ever asked for. Without them a blocked
agent looks exactly like a thinking one, and an actor never leaves the graph at all.

The capture is unusually cheap and the reason is measured: a hook invocation costs
about 40 ms, of which 20 ms is the interpreter starting, so the price of a matcher
is one more Python process per firing rather than anything it does. `Notification`
fires when the agent is *already* blocked waiting for a human, so its 40 ms is free
by definition; `Stop` fires once per turn. Against a `PostToolUse` count in the
thousands this is the cheapest capture in the program.

Two things have to move together, and the second is the one that bites:

  * **The block gains event keys.** `merge_hook_block` already iterates the block's
    own keys, so a wider block merges with no change to the merge -- and a
    stranger's hook under a key we now write into must still survive byte for byte,
    which is the whole reason this is a merge and not a write.
  * **The doctor has to learn to read them.** `diagnose` asks
    `_post_tool_use_commands` and nothing else. Once a second event key is written,
    a settings file whose `Stop` entry names a path that stopped existing reports
    `absent` -- and rot is the failure mode this module exists for, because it is
    *louder and worse* than absence: the command fails before the hook's own "exit 0
    and stay silent" rule can run, so Claude Code reports a blocking error on every
    tool call. A `--doctor` that says nothing about it is the false reassurance
    `hookinstall.py`'s own docstring calls worse than no diagnostic.

**Coverage is asserted as a subset, never as a string.** The rule
`tests/test_capture_settings.py` already sets: a matcher is an alternation and the
`hooks` object is a mapping, so reordering either, or capturing a fifth event, is
not a regression and must not fail this.

**What this file does NOT restate:** that the existing `PostToolUse` matcher covers
the five tools (`tests/test_capture_settings.py`), that the installed command names
a script that exists (same file), and the merge's own invariants
(`tests/test_hook_install_model.py`). Both were run green before this file was
written; widening the capture must leave them exactly as they are, and a second copy
of an assertion here would only mean one fact with two homes.

Style: Arrange-Act-Assert, one property per test.
"""

from __future__ import annotations

import copy
import importlib
import json
from collections.abc import Callable
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

#: The template a user copies into the observed project.
CONFIG_SETTINGS = REPO_ROOT / "config" / "settings.json"

#: This repository's own installed copy, so the project observes itself with the
#: feature on -- which is how the first trace of these payloads gets captured.
INSTALLED_SETTINGS = REPO_ROOT / ".claude" / "settings.json"

HOOK_SCRIPT = "emit_event.py"

POST_TOOL_USE = "PostToolUse"

#: The three events that carry an agent's life rather than its file edits. Spelled
#: here as literals and bound to the module's own tuple by
#: `test_this_file_names_the_events_the_installer_names`, for the same reason
#: `tests/test_hub_agent_state.py` spells them: written as an import, every test
#: below would report `AttributeError` and say nothing about the settings files.
LIFECYCLE_EVENTS = ("Notification", "Stop", "SubagentStop")

#: The exact command this repository's settings files carried after the rename,
#: and the reason `stale` exists at all: the path resolves to nothing.
ROTTED_COMMAND = "python3 /home/brn/projects/graph-agents/hooks/emit_event.py"

#: The same command at a path that does exist.
WORKING_COMMAND = f"python3 {REPO_ROOT}/hooks/emit_event.py"

#: Somebody else's `Notification` hook: a desktop notification, which is exactly
#: what a person would already have bound to this event.
FOREIGN_NOTIFICATION = {
    "hooks": [{"type": "command", "command": "notify-send 'Claude needs you'"}]
}


def hookinstall():
    """The module under specification."""
    return importlib.import_module("rhizome_graph.hookinstall")


def exists_only(*commands: str) -> Callable[[str], bool]:
    """A `command_exists` that recognises exactly the commands it was given."""
    known = set(commands)
    return lambda command: command in known


def our_entry(command: str) -> dict:
    """A hooks entry running `command`, spelled the way ours is."""
    return {"hooks": [{"type": "command", "command": command}]}


def _events_running_our_hook(settings_file: Path) -> set[str]:
    """Every event key whose entries run this project's hook, in that file."""
    settings = json.loads(settings_file.read_text(encoding="utf-8"))
    hooks = settings.get("hooks", {})
    covered: set[str] = set()
    for event, entries in hooks.items():
        if not isinstance(entries, list):
            continue
        commands = " ".join(
            str(hook.get("command", ""))
            for entry in entries
            if isinstance(entry, dict)
            for hook in entry.get("hooks", [])
            if isinstance(hook, dict)
        )
        if HOOK_SCRIPT in commands:
            covered.add(event)
    return covered


def _block_commands(block: dict, event: str) -> list[str]:
    return [
        hook.get("command")
        for entry in block.get(event, [])
        for hook in entry.get("hooks", [])
    ]


# ===========================================================================
# 1. The template a user copies
# ===========================================================================

def test_this_file_names_the_events_the_installer_names():
    """The one binding point between these literals and the installer's tuple.

    A real capture may correct any of the three names, and when it does this is
    the only test here that has to change.
    """
    assert tuple(hookinstall().LIFECYCLE_EVENTS) == LIFECYCLE_EVENTS


def test_the_template_captures_every_lifecycle_event():
    """Subset, never equality: capturing a fourth event is not a regression."""
    covered = _events_running_our_hook(CONFIG_SETTINGS)

    assert set(LIFECYCLE_EVENTS) <= covered, (
        "config/settings.json is what a user copies into the observed project; "
        "an event missing from it is captured nowhere and reports nothing -- and "
        "the symptom is a graph with no waiting rings, which looks exactly like "
        f"nobody being blocked. Missing: {sorted(set(LIFECYCLE_EVENTS) - covered)}"
    )


def test_this_repository_captures_every_lifecycle_event_for_itself():
    """This project observes itself, which is how the first trace gets captured."""
    covered = _events_running_our_hook(INSTALLED_SETTINGS)

    assert set(LIFECYCLE_EVENTS) <= covered, (
        f"{INSTALLED_SETTINGS} runs the hook for "
        f"{sorted(covered)} only. Missing: "
        f"{sorted(set(LIFECYCLE_EVENTS) - covered)}"
    )


# ===========================================================================
# 2. What the installer writes
# ===========================================================================

def test_the_installed_block_names_every_event_worth_capturing():
    block = hookinstall().hook_block(WORKING_COMMAND)

    assert {POST_TOOL_USE, *LIFECYCLE_EVENTS} <= set(block), (
        "the installer and the template must read one list, or `--install-hooks` "
        "writes a setup the documented copy-paste does not."
    )


def test_every_event_in_the_installed_block_runs_the_same_command():
    """One command, four keys. Two spellings would rot independently."""
    block = hookinstall().hook_block(WORKING_COMMAND)

    assert {
        event: _block_commands(block, event)
        for event in (POST_TOOL_USE, *LIFECYCLE_EVENTS)
    } == {event: [WORKING_COMMAND] for event in (POST_TOOL_USE, *LIFECYCLE_EVENTS)}


def test_merging_the_wider_block_twice_is_the_same_as_merging_it_once():
    """Idempotence, re-asserted against a block that names four events.

    Somebody unsure whether they already installed will install again -- that is
    what unsure means -- and a duplicated entry fires the hook twice per firing.
    """
    module = hookinstall()
    block = module.hook_block(WORKING_COMMAND)

    once = module.merge_hook_block({}, block)
    twice = module.merge_hook_block(once, block)

    assert twice == once


def test_a_strangers_notification_hook_survives_the_merge():
    """The clobber this design exists to prevent, on the key we now write into.

    A desktop notification bound to `Notification` is the likeliest thing already
    there, and it must come out of the merge byte for byte.
    """
    module = hookinstall()
    settings = {"hooks": {"Notification": [copy.deepcopy(FOREIGN_NOTIFICATION)]}}

    merged = module.merge_hook_block(settings, module.hook_block(WORKING_COMMAND))

    assert FOREIGN_NOTIFICATION in merged["hooks"]["Notification"]


# ===========================================================================
# 3. What the doctor sees
# ===========================================================================

def test_a_rotted_command_under_a_lifecycle_event_is_stale():
    """Rot is loud: it errors on every tool call, and it is invisible today.

    `diagnose` reads `PostToolUse` alone, so a settings file whose only entry for
    our hook names a path that stopped existing reports `absent` -- a doctor
    reporting a missing hook over a broken one, which sends the reader to
    `--install-hooks` for a file that already claims to have it.
    """
    module = hookinstall()
    text = json.dumps({"hooks": {"Stop": [our_entry(ROTTED_COMMAND)]}})

    answer = module.diagnose(text, WORKING_COMMAND, exists_only(WORKING_COMMAND))

    assert answer.state == module.STALE


def test_the_doctor_names_our_command_once_however_many_events_run_it():
    """`--doctor` is a report a human reads, and the command is half its answer.

    `Diagnosis.commands` exists because "there is a hook" is half an answer and
    which one is the other half -- the rot this module is pointed at is a *path*
    problem. Since the block gained event keys, one command is found four times
    over, so without a dedupe the doctor prints the same absolute path four
    times over and the reader has to compare four identical lines to learn that
    there is one hook. Every other assertion about `commands` in this suite uses
    a fixture with a single event key, so nothing notices.
    """
    module = hookinstall()
    text = json.dumps(
        {
            "hooks": {
                event: [our_entry(WORKING_COMMAND)]
                for event in (POST_TOOL_USE, *LIFECYCLE_EVENTS)
            }
        }
    )

    answer = module.diagnose(text, WORKING_COMMAND, exists_only(WORKING_COMMAND))

    assert answer.commands == (WORKING_COMMAND,)


def test_the_doctor_still_names_two_different_commands_of_ours_separately():
    """The jaw: deduping is not "keep the first one".

    Two installs from two checkouts are both ours by program name, and the whole
    point of carrying the commands is that one of them is the one that rotted.
    Collapsing them would hide the broken path behind the working one, which is
    the failure `stale` exists to report.
    """
    module = hookinstall()
    text = json.dumps(
        {
            "hooks": {
                POST_TOOL_USE: [our_entry(WORKING_COMMAND)],
                "Stop": [our_entry(ROTTED_COMMAND)],
            }
        }
    )

    answer = module.diagnose(text, WORKING_COMMAND, exists_only(WORKING_COMMAND))

    assert sorted(answer.commands) == sorted([WORKING_COMMAND, ROTTED_COMMAND])


def test_a_strangers_hook_under_another_event_is_not_a_contest_over_ours():
    """The jaw: `foreign` means contest, and a stranger elsewhere is not one.

    Widening the walk over the events is exactly the change that could turn this
    file's verdict from `installed` into `foreign`, and a person told their setup
    is contested when it works ignores the next report too.
    """
    module = hookinstall()
    text = json.dumps(
        {
            "hooks": {
                POST_TOOL_USE: [our_entry(WORKING_COMMAND)],
                "Notification": [copy.deepcopy(FOREIGN_NOTIFICATION)],
            }
        }
    )

    answer = module.diagnose(text, WORKING_COMMAND, exists_only(WORKING_COMMAND))

    assert answer.state == module.INSTALLED


# ===========================================================================
# 4. The tool that says what an agent is doing
# ===========================================================================
#
# `TodoWrite` is a tool call and so belongs to the `PostToolUse` matcher rather
# than to a key of its own: it is the tool by which an agent writes down its own
# plan and marks one item `in_progress`, and that item is the only sentence
# anywhere in this program that answers *why* an agent is touching a file.
#
# **It is the one matcher in either plan whose firing rate scales with the
# agent's own work rather than with a human's**, which is why it is argued for
# separately from the three events above. The price is the same ~40 ms process
# per firing; the estimate is 20-60 firings in a working session, and step 0's
# trace is what would replace that estimate with a count.
#
# Coverage is a **subset**, never a string: the matcher is an alternation, so
# reordering it or capturing a seventh tool is not a regression. That is the rule
# `tests/test_capture_settings.py` sets in its own docstring, and the reason two
# of this section's planned rows are not written here at all -- they say "run the
# existing test", and `tests/test_capture_settings.py` and
# `tests/test_hook_install_model.py` were both run green before this section was
# added. A second copy of an assertion would only be one fact with two homes.

#: The tool, spelled here as a literal and bound to the classifier's constant by
#: one test below -- the same device this file already uses for the three event
#: names, and for the same reason: written as an import, every assertion here
#: would report `AttributeError` and say nothing about the settings files.
TODO_WRITE = "TodoWrite"


def _capture_matchers(settings_file: Path) -> set[str]:
    """Every tool matched by a `PostToolUse` entry of that file that runs our hook.

    The union over the entries, so splitting the block in two stays legal.
    """
    settings = json.loads(settings_file.read_text(encoding="utf-8"))
    covered: set[str] = set()
    for entry in settings.get("hooks", {}).get(POST_TOOL_USE, []):
        commands = " ".join(
            str(hook.get("command", "")) for hook in entry.get("hooks", [])
        )
        if HOOK_SCRIPT not in commands:
            continue
        matcher = str(entry.get("matcher", ""))
        covered |= {part.strip() for part in matcher.split("|") if part.strip()}
    return covered


def _block_matchers(block: dict, event: str) -> set[str]:
    """Every tool the installer's own block matches under `event`."""
    covered: set[str] = set()
    for entry in block.get(event, []):
        matcher = str(entry.get("matcher", ""))
        covered |= {part.strip() for part in matcher.split("|") if part.strip()}
    return covered


def test_this_file_names_the_tool_the_classifier_names():
    """The one binding point between this literal and the classifier's constant.

    Nothing here has ever captured a `TodoWrite` payload, so the tool's name is
    a constant of `rhizome_graph.agentstate` that a real trace may correct. When
    it does, this is the only test in this file that has to change.
    """
    agentstate = importlib.import_module("rhizome_graph.agentstate")

    assert agentstate.TODO_WRITE == TODO_WRITE


def test_the_template_captures_the_tool_that_says_what_an_agent_is_doing():
    """Subset, never equality: capturing a seventh tool is not a regression."""
    covered = _capture_matchers(CONFIG_SETTINGS)

    assert {TODO_WRITE} <= covered, (
        "config/settings.json is what a user copies into the observed project; a "
        "tool missing from the matcher is captured nowhere and reports nothing. "
        "The symptom here is a graph whose figures carry no caption at all, "
        f"which looks exactly like agents that never write a plan. Covered: "
        f"{sorted(covered)}"
    )


def test_the_installed_block_captures_the_tool_that_says_what_an_agent_is_doing():
    """The installer and the template must read one list of tools, not two.

    `--install-hooks` writing a narrower matcher than the documented copy-paste
    would give two users of the same release two different features, with
    nothing on screen telling either of them which one they have.
    """
    block = hookinstall().hook_block(WORKING_COMMAND)

    assert {TODO_WRITE} <= _block_matchers(block, POST_TOOL_USE), (
        "the installed block's PostToolUse matcher is "
        f"{sorted(_block_matchers(block, POST_TOOL_USE))}"
    )


def test_this_repository_captures_its_own_agents_plans():
    """This project observes itself, which is how the first trace gets captured.

    Step 0 of the plan needs a real `TodoWrite` payload and no agent on this host
    can obtain one from a session that was started before the matcher existed --
    Claude Code reads the settings at session start. Installing it here is what
    makes the next session able to answer the question.
    """
    covered = _capture_matchers(INSTALLED_SETTINGS)

    assert {TODO_WRITE} <= covered, (
        f"{INSTALLED_SETTINGS} matches {sorted(covered)} only"
    )
