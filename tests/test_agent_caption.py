"""Contract tests (RED) for the caption an agent writes about its own work.

Motivation: the graph answers **where** an agent is working and never **why**.
A figure moves, a file flashes, a beam is drawn -- and a viewer still cannot
tell a refactor from a bug hunt. `TodoWrite` is the tool by which an agent
writes down its own plan and marks exactly one item `in_progress`, so that one
item is the cheapest sentence that answers *why*: already written, already in a
payload the hook forwards untouched.

Two functions and nothing else live here, deliberately apart:

  * `caption_of(payload)` answers **what this payload says** about the agent's
    current work, and
  * `safe_caption(text)` answers **what may be drawn**.

Keeping them apart is the whole reason this file can be read in two halves: the
first is a derivation over an assumed payload shape, the second is the security
surface of the feature. This is the first thing in this program that takes a
string a language model wrote and rasterises it, so the second half is written
as if the string were hostile, because in the only sense that matters it is:
nothing in this repository bounds it, folds it, or knows what is in it.

**`caption_of` is a tri-state, and the third state is the one that matters.**

  * `None` -- "this payload says nothing about a caption". The `tool_name` is
    absent, unusable, or names another tool. The hub carries forward whatever
    caption it already holds.
  * `""` -- "this is a `TodoWrite` and there is nothing in progress". The hub
    clears the caption.
  * the text otherwise.

Answering `""` for an ordinary `Write` would be the quiet defect: the hub
publishes a `working` state on every tool call, so a caption set by a
`TodoWrite` would be wiped by the very next file the agent touched, a few
milliseconds later. The distinction between "nothing to say" and "nothing is in
progress" is therefore not a nicety; it is what makes a caption last longer than
one tool call.

**Every test here is written against the module's constants, never against the
string literals they hold.** Nothing in this repository has ever captured a
`TodoWrite` payload -- this project's standard is that a payload shape is
"settled by capture, not by reasoning", and the `PostToolUse` shape was measured
while this one was not. So `TODO_WRITE`, `TODOS`, `ACTIVE_FORM`, `CONTENT` and
`IN_PROGRESS` are constants of `rhizome_graph.agentstate`, and a real trace
correcting any of the five is a five-string edit that moves no test below. Row
1.7 of the plan -- what a `TodoWrite` carrying no `agent_id` means -- is
deliberately **not written here**: it branches on the answer to that same
capture, and writing it from an assumption is exactly what "settled by capture"
forbids.

**Every character that cannot be seen is spelled as an escape.** A raw control
or a raw bidirectional mark in a fixture is invisible in a diff, in a terminal
and in a review -- which is precisely why those characters are dangerous in the
first place -- and a fixture nobody can read is a fixture somebody deletes.

Style: Arrange-Act-Assert, one property per test.
"""

from __future__ import annotations

import importlib

import pytest

SESSION = "sess-abc"

#: The event name every tool call already carries. Measured, unlike the five
#: constants above, which is why it is spelled here as a literal.
POST_TOOL_USE = "PostToolUse"

#: Statuses that are not `in_progress`. Only `in_progress` carries meaning --
#: everything else is "not the item being worked on" -- so these two are
#: literals rather than constants: a capture correcting their spelling changes
#: no answer this module gives.
PENDING = "pending"
COMPLETED = "completed"

#: The ellipsis `labels.ts` already uses in `actorDisplayName`, and the same
#: rule with it: `text[:MAX - 1] + ELLIPSIS`, so a cut caption is exactly the
#: cap long rather than one character under it.
ELLIPSIS = "…"

# ---------------------------------------------------------------------------
# The three boundary strings of the shared fixture table.
#
# They are named rather than inlined because one test below pins
# `MAX_CAPTION_CHARS` *through* them: a shared table only pins a cap if it
# contains the boundary, and a table of short strings would let the two
# languages disagree about the number while agreeing about every pair in it.
# ---------------------------------------------------------------------------

#: Exactly `MAX_CAPTION_CHARS` characters. Comes back untouched.
AT_THE_CAP = "Reading the watcher and folding its events into the hub tree"

#: One character more, so the cut is by exactly one character.
ONE_PAST_THE_CAP = "Reading the watcher and folding its events into the hub trees"
ONE_PAST_THE_CAP_CUT = (
    "Reading the watcher and folding its events into the hub tre" + ELLIPSIS
)

#: The trap the shared table exists for. Ten astral characters past the
#: boundary: Python counts code points and JavaScript counts UTF-16 units, so a
#: cut on units lands *inside* a surrogate pair and hands back a lone surrogate,
#: while a cut on code points keeps three whole rockets.
ASTRAL_PAST_THE_CAP = (
    "Rewriting the ingest loop so a held change is never lost" + "\U0001f680" * 10
)
ASTRAL_PAST_THE_CAP_CUT = (
    "Rewriting the ingest loop so a held change is never lost"
    + "\U0001f680" * 3
    + ELLIPSIS
)

# ---------------------------------------------------------------------------
# THE SHARED FIXTURE TABLE.
#
# `web/tests/agentCaption.test.ts` holds these same pairs, in this same order,
# with the same expectations. THE TWO FILES ARE EDITED TOGETHER -- a pair added
# here and not there, or reordered in one of them, silently stops pinning the
# thing the table exists for.
#
# There is no code path between Python and TypeScript, so a rule implemented in
# both languages has nothing but a table to keep it honest. This is the device
# `content_search.py` and `matchRanges.ts` already share, reused for the same
# reason and against the same trap: every character below is inside the BMP
# except where an astral one is the point, and where it is, it is there to make
# a code-point cap and a UTF-16 cap disagree loudly instead of quietly.
#
# Deliberately NOT in the table: the "fold runs before the cap" case, which
# needs a run of two hundred controls. Written out as a literal it is unreadable
# in both languages and impossible to transcribe by eye, so it is a test of its
# own below.
# ---------------------------------------------------------------------------

CAPTION_FOLD_CASES = (
    # Nothing in, nothing out.
    ("", ""),
    # An ordinary caption is not touched at all.
    ("Rewriting the beam pool", "Rewriting the beam pool"),
    # Runs of whitespace collapse, and the ends are stripped.
    ("   Updating   the   plan   ", "Updating the plan"),
    # A control is a SEPARATOR, never a joiner: two words either side of a
    # newline come back as two words.
    ("Reading\nthe watcher", "Reading the watcher"),
    # The rest of the C0 set a model actually types.
    ("Writing\ttests\r\nfor\x00the hub", "Writing tests for the hub"),
    # A C1 control: NEXT LINE, U+0085.
    ("Deleting\u0085stale nodes", "Deleting stale nodes"),
    # A right-to-left override, which would otherwise reverse the visual order
    # of everything after it -- directly under the one string on the page that
    # says WHO is acting. Spaces either side, so the table says nothing about
    # whether a bidi control leaves a separator behind; that is pinned below.
    ("Renaming \u202e the parser", "Renaming the parser"),
    # Only controls and whitespace: the caption is empty and the sprite hides.
    ("  \n\t\u200e  ", ""),
    # The jaw. This is a fold of dangerous characters, not an ASCII filter: a
    # caption a model wrote about a file named in another language is ordinary
    # text and comes back exactly as written.
    ("Renaming café.txt and naïve.py", "Renaming café.txt and naïve.py"),
    ("設定ファイルを読んでいます", "設定ファイルを読んでいます"),
    ("Shipping the release \U0001f680", "Shipping the release \U0001f680"),
    # The three boundary cases, without which the table pins no cap at all.
    (AT_THE_CAP, AT_THE_CAP),
    (ONE_PAST_THE_CAP, ONE_PAST_THE_CAP_CUT),
    (ASTRAL_PAST_THE_CAP, ASTRAL_PAST_THE_CAP_CUT),
)

#: Every bidirectional control, named one by one -- the two marks, the two
#: embeddings, the two overrides, the three isolates and the two pops. See the
#: test that uses them for why they are spelled out rather than described.
BIDI_CONTROLS = (
    "\u200e",  # LEFT-TO-RIGHT MARK
    "\u200f",  # RIGHT-TO-LEFT MARK
    "\u202a",  # LEFT-TO-RIGHT EMBEDDING
    "\u202b",  # RIGHT-TO-LEFT EMBEDDING
    "\u202c",  # POP DIRECTIONAL FORMATTING
    "\u202d",  # LEFT-TO-RIGHT OVERRIDE
    "\u202e",  # RIGHT-TO-LEFT OVERRIDE
    "\u2066",  # LEFT-TO-RIGHT ISOLATE
    "\u2067",  # RIGHT-TO-LEFT ISOLATE
    "\u2068",  # FIRST STRONG ISOLATE
    "\u2069",  # POP DIRECTIONAL ISOLATE
)


def agentstate():
    """The module under specification -- it exists; these two functions do not.

    Reached through `importlib` inside each test rather than imported at the top
    of the file, the way `tests/test_agent_state.py` and
    `tests/test_hook_install_model.py` reach their modules: a top-level import of
    a name that is not there yet is a *collection* error, and a collection error
    replaces every test in this file with one line that says nothing about any
    of them.
    """
    return importlib.import_module("rhizome_graph.agentstate")


def _item(*, content=None, active_form=None, status=None) -> dict:
    """One todo item, carrying only the fields it was given.

    Absent is not the same as empty: an item that never had an `activeForm` and
    one that has an empty string reach different branches, and a builder filling
    in defaults would hide the difference.
    """
    module = agentstate()
    item: dict = {}
    if content is not None:
        item[module.CONTENT] = content
    if active_form is not None:
        item[module.ACTIVE_FORM] = active_form
    if status is not None:
        item["status"] = status
    return item


def _todo_payload(todos, **fields) -> dict:
    """A `TodoWrite` payload carrying `todos`, shaped as a real capture is."""
    module = agentstate()
    payload: dict = {
        "session_id": SESSION,
        module.EVENT_KEY: POST_TOOL_USE,
        "tool_name": module.TODO_WRITE,
        "tool_input": {module.TODOS: todos},
    }
    payload.update(fields)
    return payload


# ===========================================================================
# 1. What a payload says -- `caption_of`
# ===========================================================================

def test_a_todo_list_with_nothing_in_progress_says_nothing():
    """The first test of this file, and the property most at risk later.

    When the model has marked nothing in progress, the graph says nothing rather
    than inventing something. Not "idle", not the last completed item, not the
    first pending one -- an absence is a legitimate answer, the same rule
    `_parse_bash` follows when it would otherwise have to guess.

    It is first, ahead of the happy path, because it is the property somebody
    will later "improve" into showing the first pending item: that reads as
    helpful, and it is how a graph starts lying quietly, since a reader indexes
    a caption as a fact about what the agent is doing right now.
    """
    payload = _todo_payload(
        [
            _item(
                content="Read the watcher",
                active_form="Reading the watcher",
                status=COMPLETED,
            ),
            _item(
                content="Fold the events",
                active_form="Folding the events",
                status=PENDING,
            ),
        ]
    )

    assert agentstate().caption_of(payload) == ""


@pytest.mark.parametrize(
    "todos",
    [
        pytest.param([], id="empty-list"),
        pytest.param("Reading the watcher", id="string"),
        pytest.param({"content": "Reading the watcher"}, id="object"),
        pytest.param(None, id="null"),
        pytest.param(7, id="number"),
    ],
)
def test_a_todo_write_whose_list_says_nothing_answers_the_empty_caption(todos):
    """A `TodoWrite` is a `TodoWrite` however malformed its input is.

    The distinction this pins is the one the hub turns on: all of these mean
    "nothing is in progress", so clear the caption -- never "this payload is not
    about captions", which would leave the one already on screen standing.
    """
    assert agentstate().caption_of(_todo_payload(todos)) == ""


def test_a_todo_write_with_no_list_at_all_answers_the_empty_caption():
    module = agentstate()
    payload = {
        "session_id": SESSION,
        module.EVENT_KEY: POST_TOOL_USE,
        "tool_name": module.TODO_WRITE,
        "tool_input": {},
    }

    assert module.caption_of(payload) == ""


@pytest.mark.parametrize(
    "tool_input",
    [
        pytest.param(None, id="null"),
        pytest.param("todos", id="string"),
        pytest.param(["todos"], id="array"),
    ],
)
def test_a_todo_write_with_an_unusable_tool_input_answers_the_empty_caption(tool_input):
    module = agentstate()
    payload = {
        "session_id": SESSION,
        module.EVENT_KEY: POST_TOOL_USE,
        "tool_name": module.TODO_WRITE,
        "tool_input": tool_input,
    }

    assert module.caption_of(payload) == ""


def test_a_todo_write_that_carries_no_tool_input_answers_the_empty_caption():
    module = agentstate()
    payload = {
        "session_id": SESSION,
        module.EVENT_KEY: POST_TOOL_USE,
        "tool_name": module.TODO_WRITE,
    }

    assert module.caption_of(payload) == ""


def test_the_active_form_of_the_item_in_progress_is_the_caption():
    """The happy path: one item marked, and its present-continuous form drawn.

    `activeForm` rather than `content`, because it is the field Claude Code asks
    the model to write in the form a reader wants under a figure -- "Reading the
    watcher" rather than "Read the watcher".
    """
    module = agentstate()
    payload = _todo_payload(
        [
            _item(
                content="Read the watcher",
                active_form="Reading the watcher",
                status=COMPLETED,
            ),
            _item(
                content="Fold the events",
                active_form="Folding the events",
                status=module.IN_PROGRESS,
            ),
            _item(
                content="Draw the ring",
                active_form="Drawing the ring",
                status=PENDING,
            ),
        ]
    )

    assert module.caption_of(payload) == "Folding the events"


def test_the_first_item_in_progress_wins_when_several_are_marked():
    """A well-formed list has one; a confused model writes several.

    "The first" is a rule rather than a guess, and answering nothing for an
    ambiguous list would hide the caption exactly when the model is confused --
    which is when it is most worth reading.
    """
    module = agentstate()
    payload = _todo_payload(
        [
            _item(active_form="Folding the events", status=module.IN_PROGRESS),
            _item(active_form="Drawing the ring", status=module.IN_PROGRESS),
        ]
    )

    assert module.caption_of(payload) == "Folding the events"


def test_an_item_in_progress_with_no_active_form_falls_back_to_its_content():
    """The degradation decision 2 names: an instruction beats silence.

    If the capture finds no `activeForm` at all, the feature still works off
    `content` and the caption reads as an instruction rather than as an
    activity. That is a degradation, not a blocker, and it is why the fallback
    is specified before anybody has seen a payload.
    """
    module = agentstate()
    payload = _todo_payload(
        [_item(content="Fold the events", status=module.IN_PROGRESS)]
    )

    assert module.caption_of(payload) == "Fold the events"


def test_an_item_with_no_usable_text_is_skipped_and_a_later_one_is_still_found():
    """A `continue`, never a `return`: an unusable item is not an answer.

    The scan is looking for something to say. An item marked in progress that
    carries no text says nothing, and stopping at it would throw away the item
    below it that does.
    """
    module = agentstate()
    payload = _todo_payload(
        [
            _item(status=module.IN_PROGRESS),
            _item(active_form="Drawing the ring", status=module.IN_PROGRESS),
        ]
    )

    assert module.caption_of(payload) == "Drawing the ring"


def test_a_payload_for_another_tool_says_nothing_about_the_caption():
    """The tri-state's third state, and the whole reason it exists.

    `None`, not `""`. The hub publishes a `working` state on every tool call, so
    a `Write` that answered "there is nothing in progress" would clear a caption
    a `TodoWrite` set milliseconds earlier, and no caption would ever survive
    long enough to be read. The tool decides, never the shape of its input: this
    payload carries a well-formed list and is still not a `TodoWrite`.
    """
    module = agentstate()
    payload = {
        "session_id": SESSION,
        module.EVENT_KEY: POST_TOOL_USE,
        "tool_name": "Write",
        "tool_input": {
            "file_path": "/proj/src/app.py",
            module.TODOS: [
                _item(active_form="Folding the events", status=module.IN_PROGRESS)
            ],
        },
    }

    assert module.caption_of(payload) is None


@pytest.mark.parametrize(
    "tool_name",
    [
        pytest.param(None, id="null"),
        pytest.param("", id="empty"),
        pytest.param("   ", id="blank"),
        pytest.param(123, id="number"),
        pytest.param({"name": "TodoWrite"}, id="object"),
        pytest.param(["TodoWrite"], id="array"),
    ],
)
def test_a_payload_with_no_usable_tool_name_says_nothing_about_the_caption(tool_name):
    """Absence and emptiness both mean "not about captions", never "clear it"."""
    module = agentstate()
    payload = {
        "session_id": SESSION,
        "tool_name": tool_name,
        "tool_input": {module.TODOS: []},
    }

    assert module.caption_of(payload) is None


def test_a_payload_that_is_not_an_object_says_nothing_about_the_caption():
    """Total, like `actor_of`: what arrives over a socket is not a promise."""
    module = agentstate()

    assert [module.caption_of(x) for x in (None, [], "TodoWrite", 7)] == [None] * 4


@pytest.mark.parametrize(
    "todos",
    [
        pytest.param([None, 7, "Folding the events"], id="items-are-not-objects"),
        pytest.param([{"status": {"state": "in_progress"}}], id="status-is-an-object"),
        pytest.param([{"status": ["in_progress"]}], id="status-is-an-array"),
    ],
)
def test_garbage_at_every_level_answers_the_empty_caption_and_raises_nothing(todos):
    """It never raises, and the reason is one step sharper than usual here.

    The ingest loop's own `except` logs at DEBUG and drops the connection, so an
    exception on this path is not a visible failure -- it is a hook connection
    that silently stopped working, and a graph that quietly stopped updating.
    """
    assert agentstate().caption_of(_todo_payload(todos)) == ""


def test_an_item_whose_active_form_is_not_text_falls_back_to_its_content():
    """A field of the wrong type is not usable text and must not be drawn.

    Rendered as it arrived, a list would reach the canvas as its own repr --
    brackets, quotes and all -- under an agent's name.
    """
    module = agentstate()
    payload = _todo_payload(
        [
            _item(
                content="Fold the events",
                active_form=["Folding the events"],
                status=module.IN_PROGRESS,
            )
        ]
    )

    assert module.caption_of(payload) == "Fold the events"


# ===========================================================================
# 2. What may be drawn -- `safe_caption`
# ===========================================================================

@pytest.mark.parametrize(
    "control",
    BIDI_CONTROLS,
    ids=[f"U+{ord(control):04X}" for control in BIDI_CONTROLS],
)
def test_no_bidirectional_control_survives_the_fold(control):
    """The first test of this half: a caption cannot reorder the text around it.

    `ctx.fillText` runs the platform's bidirectional algorithm, so a
    right-to-left override inside a caption reverses the visual order of
    everything after it -- and the caption sits directly under the agent's own
    name, which is the one string on this page a user trusts to say who is
    acting. The blast radius is a graph and not a credential, which is why this
    is a fold rather than an alarm; it costs one character class to remove and
    there is no case for keeping it.

    Every code point is named individually, because this is the class a later
    "simplify the regex" drops first, and because writing them out forces
    whoever takes this green to name the class rather than reach for
    `str.isprintable()`, which would also drop the legitimate text the jaw
    further down protects.

    It is first because it is the assertion whose absence would never be
    noticed: the naive implementation -- a cap and a strip -- passes the cap
    tests and fails this one.
    """
    module = agentstate()

    folded = module.safe_caption(f"Renaming {control} the parser")

    assert control not in folded
    assert folded == "Renaming the parser"


def test_a_caption_written_to_reverse_what_follows_comes_back_in_written_order():
    """The property the class above exists for, asserted once as a sentence."""
    module = agentstate()

    folded = module.safe_caption("Deleting \u202e/etc/passwd\u202c now")

    assert folded == "Deleting /etc/passwd now"


def test_a_caption_longer_than_the_cap_is_cut_to_exactly_the_cap():
    module = agentstate()
    raw = "abcdefghij" * 50

    folded = module.safe_caption(raw)

    assert len(folded) == module.MAX_CAPTION_CHARS


def test_a_cut_caption_keeps_its_head_and_ends_in_the_ellipsis():
    """Head-kept, never a middle cut: in a clause the head is the verb.

    `truncateMiddle` exists for paths, where both ends carry information. A
    caption is a clause, and what it is for is the verb and its object -- the
    same reasoning `actorDisplayName` records for the agent's own name.
    """
    module = agentstate()
    raw = "abcdefghij" * 50

    folded = module.safe_caption(raw)

    assert folded == raw[: module.MAX_CAPTION_CHARS - 1] + ELLIPSIS


def test_a_caption_exactly_at_the_cap_is_untouched():
    """The off-by-one jaw: at the cap nothing is lost and no ellipsis appears."""
    module = agentstate()

    assert module.safe_caption(AT_THE_CAP) == AT_THE_CAP


@pytest.mark.parametrize(
    "raw, expected",
    [
        pytest.param("Reading\nthe watcher", "Reading the watcher", id="newline"),
        pytest.param(
            "Reading\rthe watcher", "Reading the watcher", id="carriage-return"
        ),
        pytest.param("Reading\tthe watcher", "Reading the watcher", id="tab"),
        pytest.param("Reading\x00the watcher", "Reading the watcher", id="nul"),
        pytest.param("Reading\x0bthe watcher", "Reading the watcher", id="vertical-tab"),
        pytest.param("Reading\u0085the watcher", "Reading the watcher", id="c1-nel"),
        pytest.param("Reading\u009bthe watcher", "Reading the watcher", id="c1-csi"),
    ],
)
def test_a_control_character_leaves_a_separator_and_never_glues_two_words(raw, expected):
    """`fillText` does not break lines, and a caption is one line by construction.

    A newline handed to the platform shaper comes out as a missing-glyph box or
    as nothing at all, depending on the platform, and either way the caption
    silently stops being one line of legible text. So a control is not a
    formatting request, it is noise -- but it is noise *between* words, so
    removing it outright would join two words into one the model never wrote. It
    leaves a separator behind, and the collapse makes that exactly one space.
    """
    assert agentstate().safe_caption(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        pytest.param("     ", id="spaces"),
        pytest.param("\n\t\r\n", id="controls"),
        pytest.param("\u200e\u202e", id="bidi"),
        pytest.param("", id="empty"),
    ],
)
def test_a_caption_with_nothing_left_in_it_comes_back_empty(raw):
    """The strip after the collapse, so that R3 then draws nothing at all.

    Without it, a caption of pure whitespace is a wide empty texture hanging
    under a figure, which reads as a rendering fault rather than as silence.
    """
    assert agentstate().safe_caption(raw) == ""


def test_the_fold_runs_before_the_cap():
    """Two hundred controls and ten letters come back as those ten letters.

    Capping first would count characters that are about to be removed and hand
    back an ellipsis over a caption that was never too long -- the sentence
    replaced by a cut of its own leading noise.
    """
    module = agentstate()

    folded = module.safe_caption("\n" * 200 + "Folding it")

    assert folded == "Folding it"


@pytest.mark.parametrize(
    "raw",
    [
        pytest.param("Renaming café.txt and naïve.py", id="accented-latin"),
        pytest.param("設定ファイルを読んでいます", id="cjk"),
        pytest.param("Shipping the release \U0001f680", id="emoji"),
    ],
)
def test_ordinary_text_in_any_language_passes_through_unchanged(raw):
    """The jaw against `str.isprintable()` and against an ASCII filter.

    This is a fold of *dangerous* characters, not a filter on unfamiliar ones. A
    caption naming a file with an accent in it, or written in the language the
    user was speaking, is legitimate text somebody wants to read, and a fold
    that quietly deleted it would be discovered on a screen rather than here.
    """
    assert agentstate().safe_caption(raw) == raw


@pytest.mark.parametrize(
    "raw",
    [
        pytest.param(None, id="null"),
        pytest.param(7, id="number"),
        pytest.param(["Folding the events"], id="array"),
        pytest.param({"activeForm": "Folding"}, id="object"),
    ],
)
def test_a_caption_that_is_not_text_comes_back_empty_and_raises_nothing(raw):
    """The type guard, for the same reason the derivation has one.

    This function is the last thing between a payload field and the wire, so it
    is total: anything that is not text is nothing to draw.
    """
    assert agentstate().safe_caption(raw) == ""


def test_the_fold_is_idempotent():
    """Folding twice costs nothing, which is what makes two conditions free.

    The browser applies the same rule again over the wire, because this daemon
    is not the only thing that could ever send the frame. A fold that was not
    idempotent would turn defence in depth into "the caption is mangled once for
    every layer it passes", and that would be found on a screen.
    """
    module = agentstate()

    for raw, expected in CAPTION_FOLD_CASES:
        assert module.safe_caption(expected) == expected, raw


@pytest.mark.parametrize(
    "raw, expected",
    CAPTION_FOLD_CASES,
    ids=[f"case-{index:02d}" for index in range(len(CAPTION_FOLD_CASES))],
)
def test_the_shared_fold_table_holds(raw, expected):
    """The table `web/tests/agentCaption.test.ts` holds pair for pair.

    There is no code path between the two languages, so nothing but this table
    keeps one rule implemented twice from becoming two rules. Same device as the
    `content_search.py` / `matchRanges.ts` table, and against the same trap: a
    cap counted in code points and a cap counted in UTF-16 units disagree about
    exactly one kind of string, and the table is where that disagreement is made
    loud instead of quiet.
    """
    assert agentstate().safe_caption(raw) == expected


def test_the_cap_is_pinned_by_the_table_rather_than_restated():
    """The number lives in the table's boundary case, in one place, once.

    Restating `60` in a Python test and again in a TypeScript one is two
    constants that merely happen to be equal -- this repository's own name for
    the bug that follows. The boundary case is exactly the cap long, so the
    table itself is what says what the cap is, in both languages at once.
    """
    module = agentstate()

    assert module.MAX_CAPTION_CHARS == len(AT_THE_CAP)
    assert len(ONE_PAST_THE_CAP) == module.MAX_CAPTION_CHARS + 1


def test_an_astral_caption_is_cut_on_code_points_and_never_mid_character():
    """The one case a UTF-16 cap gets wrong, spelled out as well as tabled.

    It is in the table too, but it is written here on its own because the
    failure is invisible in a diff: a cut inside a surrogate pair produces a
    lone surrogate that a browser draws as a replacement character, and the
    string either side of it looks identical to a correct one until it is
    rendered.
    """
    module = agentstate()

    folded = module.safe_caption(ASTRAL_PAST_THE_CAP)

    assert folded == ASTRAL_PAST_THE_CAP_CUT
    assert len(folded) == module.MAX_CAPTION_CHARS
