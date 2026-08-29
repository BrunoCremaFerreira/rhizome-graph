"""Two text scans over `web/src/main.ts`: where F8 is answered, and what a root switch clears.

**THESE PIN SPELLINGS, NOT BEHAVIOURS.** A substring search cannot see nesting,
cannot tell a call from a comment mentioning one, and cannot tell whether a value
it finds is ever used. Every assertion here is about where a name appears in a
file. The behaviours are pinned elsewhere and named per test:
`web/tests/statsKeys.test.ts` says what F8 means, and
`web/tests/statsPanel.test.ts` says what an empty summary looks like. This file
is not a substitute for either and must never be described as one.

**Why it is worth having anyway.** `main.ts` is the composition root and carries
no test by doctrine -- there is no pure module that could hold either of these
decisions, because in both cases the wiring *is* the decision. The choice is this
scan or nothing, which is the judgement `tests/test_attention_reset_wiring.py`
already made for the alarm panel's half of the same handler, and this file is
that one's shape with its reader (`tests/frontend_source.py`) reused rather than
re-invented.

The two properties, and what each costs when it is wrong:

  * **F8 is answered above the modal and below nothing.** `interpretStatsKey`
    takes no `open` parameter and is conditional on nothing, exactly as
    `interpretSizeKey` is: the panel has to toggle with the file viewer open,
    with the root bar focused and with either search bar taking keystrokes. That
    is what earns first position -- the chain below is ordered by CONTESTED keys,
    and a binding that contests nothing takes no part in that argument. Placed
    lower, the toggle goes dead in exactly the states a reader is most likely to
    be in when they want a summary.
  * **A root switch clears the panel.** `onReset` is the one place everything
    stateful on the page is emptied. A table left behind counts work done in a
    project the user has left, under a caption naming the new one -- and unlike a
    stale alarm row it does not even look wrong, because a count is a number
    nobody can check by eye.
"""

from __future__ import annotations

import re

from frontend_source import index_of, read_src

#: The module both scans read. Named once, because the whole point of the file is
#: that this one module cannot be tested any other way.
COMPOSITION_ROOT = "main.ts"

#: The three bindings whose relative order is the property. Spelled with their
#: opening parenthesis so an import line cannot satisfy the search.
SIZE_BRANCH = "interpretSizeKey("
STATS_BRANCH = "interpretStatsKey("
MODAL_BRANCH = "interpretFileViewKey("

#: Where the reset handler begins. Spelled with its arrow's empty parameter list
#: so it cannot match a mention of `onReset` in a comment.
HANDLER_OPENS = "onReset: ()"

#: The end of the `createWsClient(...)` call: the options object's closing brace
#: and the call's own closing parenthesis, at the indentation the file uses.
CALL_CLOSES = "\n  );"

#: The other keys of the same options object. `onReset` is last today, so none of
#: these is found after it -- they are listed so the window still closes in the
#: right place if the object is ever reordered.
OPTION_KEYS = (
    "onMeta:",
    "onCompletion:",
    "onRootError:",
    "onFileView:",
    "onSearchResult:",
    "onSizes:",
    "onAgentStates:",
    "onAttentionRules:",
    "onStatus:",
    "onStats:",
)

#: A call on anything whose name mentions the summary. Deliberately not one
#: spelling: `closeStats`, `resetStats`, `showStats(closeStats(...))` are all the
#: same decision, and this file has no business choosing between them. What it
#: refuses is a handler that never mentions the panel at all.
CLEARS_THE_SUMMARY = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*[Ss]tats[A-Za-z0-9_$]*\s*\(")


def _handler_window(text: str) -> tuple[int, int]:
    """Where `onReset`'s body begins, and where it can no longer be.

    The end is the first of: another key of the same options object, or the close
    of the `createWsClient` call. Both are looked for *after* the handler opens,
    so the window is never inverted. Mirrors
    `tests/test_attention_reset_wiring.py`'s window, deliberately: two different
    windows over one handler would let a change pass one file and fail the other.
    """
    opens = index_of(text, HANDLER_OPENS)
    closes = index_of(text[opens:], CALL_CLOSES) + opens
    for key in OPTION_KEYS:
        found = text.find(key, opens, closes)
        if found >= 0:
            closes = found
    return opens, closes


def test_f8_is_answered_between_the_size_mode_and_the_modal() -> None:
    """The binding sits at the top of the chain, beside F7 and above Escape.

    The behaviour -- that it claims F8 and nothing else -- is
    `web/tests/statsKeys.test.ts`. This says only where the branch is written.

    Below `interpretFileViewKey` the toggle would be swallowed while the viewer
    is open; below the root bar it would be swallowed while the bar is focused.
    Both are states a reader is *more* likely to be in when they want a summary,
    not less, so a binding that works only on a quiet page is a binding that
    works only when nobody needs it.
    """
    text = read_src(COMPOSITION_ROOT)

    size = index_of(text, SIZE_BRANCH)
    stats = index_of(text, STATS_BRANCH)
    modal = index_of(text, MODAL_BRANCH)

    assert size < stats < modal, (
        f"web/src/main.ts answers {STATS_BRANCH} at {stats}, outside the window "
        f"between {SIZE_BRANCH} at {size} and {MODAL_BRANCH} at {modal}. F8 "
        "contests nothing and is conditional on nothing, so it belongs beside F7 "
        "above the chain rather than inside the precedence argument."
    )


def test_the_f8_branch_takes_the_key_outright() -> None:
    """`preventDefault`, the way F7's branch does.

    Some browsers and some window managers bind the function-key row, and F7's
    branch sets the precedent for claiming the key rather than sharing it. A scan
    can only say that the call is written inside the branch's own stretch of the
    file, between the branch and the modal's.
    """
    text = read_src(COMPOSITION_ROOT)

    stats = index_of(text, STATS_BRANCH)
    modal = index_of(text, MODAL_BRANCH)

    assert text.find("preventDefault", stats, modal) >= 0, (
        "the F8 branch does not call preventDefault before the modal's branch "
        "begins, so the key is left to whatever the browser or the window "
        "manager does with it"
    )


def test_a_root_switch_clears_the_summary() -> None:
    """The table belongs to the project it counted, and that project is gone.

    The behaviour -- that a closed or empty panel is not on screen at all -- is
    `web/tests/statsPanel.test.ts`. This says only that the summary is named
    among the things `onReset` clears.

    The window matters and not merely the name: whatever the panel's state is
    called, it will also appear at the top of the file in an import and in the
    keydown branch above, and a scan for the bare name would be satisfied by
    either. So the call has to sit between the handler's own opening and the end
    of the options object, which is as close to "inside the handler" as a text
    search can get.
    """
    text = read_src(COMPOSITION_ROOT)

    opens, closes = _handler_window(text)
    found = CLEARS_THE_SUMMARY.search(text, opens, closes)

    assert found is not None, (
        "web/src/main.ts's onReset handler never mentions the session-stats "
        "panel, so a table counted over the old project survives the switch. It "
        "belongs in the one handler that clears everything else -- the daemon "
        "resets its own counters on a root switch, so the browser holding the "
        "previous project's numbers under the new project's caption is a "
        "disagreement with the daemon that nobody can see by eye."
    )
