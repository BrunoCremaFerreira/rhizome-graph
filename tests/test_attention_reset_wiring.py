"""One text scan over `web/src/main.ts`: the reset handler must clear the alarms.

**This pins a SPELLING, not a behaviour.** It asserts that the name
`resetAttention` appears inside `main.ts`'s single `onReset` handler, and that is
all a substring search can ever assert: it cannot see nesting, it cannot tell a
call from a comment mentioning one, and it cannot tell whether the value it
returns is ever used. The behaviour -- that `resetAttention` empties the alarm
list -- is pinned by `web/tests/attentionState.test.ts`'s `resetAttention` case,
in vitest, against the real module. This file is not a substitute for it and must
never be described as one.

**Why it is worth having anyway.** `main.ts` is the composition root and carries
no test by doctrine, and `main.ts:344`'s `onReset` is the single place where
every stateful thing on the page is cleared -- `sim.reset()`,
`renderer.resetScene()`, `eventHud.clear()`, `statusHud.clear()`, `closeView`,
`closeContentSearch`, `closeSizeMode`, `closeAgentStates`, `attribution.reset()`.
An alarm set left out of that list names files of a project the user has left:
the rows stay on screen, and clicking one asks the daemon for a path
`resolve_inside` refuses under the new root. There is no pure module that could
hold this decision instead -- the wiring *is* the decision -- so the choice is
this scan or nothing.

**Why the window matters and not merely the name.** `resetAttention` will also
appear at the top of the file in an `import` statement, and an import is exactly
what a scan for the bare name would be satisfied by: the page would import the
function, never call it, and this test would stay green while every alarm
survived a `ctrl+L`. So the occurrence has to sit *between* the handler's own
opening and the end of the options object -- which is as close to "inside the
handler" as a text search can get, and it is stated here rather than implied.

The upper bound is the end of the `createWsClient` call rather than "the next
top-level option key", because `onReset` is the **last** key in that object:
there is no next one. The search below still stops at a later key if one is ever
added, so a reordering that moves `onReset` up the object narrows the window
instead of breaking the test.

Style: one property, asserted once.
"""

from __future__ import annotations

from frontend_source import index_of, read_src

#: The module this scan reads. Named once, because the whole point of the file is
#: that this one module cannot be tested any other way.
COMPOSITION_ROOT = "main.ts"

#: Where the handler begins. Spelled with its arrow's empty parameter list so it
#: cannot match a mention of `onReset` in a comment.
HANDLER_OPENS = "onReset: ()"

#: The end of the `createWsClient(...)` call: the options object's closing brace
#: and the call's own closing parenthesis, at the indentation the file uses.
#: Anything after this is no longer inside any handler.
CALL_CLOSES = "\n  );"

#: The other keys of the same options object. `onReset` is last today, so none of
#: these is found after it -- they are listed so that the window still closes at
#: the right place if the object is ever reordered.
OPTION_KEYS = (
    "onMeta:",
    "onCompletion:",
    "onRootError:",
    "onFileView:",
    "onSearchResult:",
    "onSizes:",
    "onAgentStates:",
    "onStatus:",
)

#: What must be named in there. The trailing parenthesis is deliberate: a bare
#: name would also be satisfied by the import, and by a comment promising to add
#: the call later.
CLEARS_THE_ALARMS = "resetAttention("


def _handler_window(text: str) -> tuple[int, int]:
    """Where `onReset`'s body begins, and where it can no longer be.

    The end is the first of: another key of the same options object, or the close
    of the `createWsClient` call. Both are looked for *after* the handler opens,
    so the window is never inverted.
    """
    opens = index_of(text, HANDLER_OPENS)
    closes = index_of(text[opens:], CALL_CLOSES) + opens
    for key in OPTION_KEYS:
        found = text.find(key, opens, closes)
        if found >= 0:
            closes = found
    return opens, closes


def test_the_reset_handler_clears_the_alarms():
    """A spelling, in the one file that has no other kind of test.

    The behaviour is `web/tests/attentionState.test.ts`'s `resetAttention` case.
    """
    text = read_src(COMPOSITION_ROOT)

    # Presence first, so a page that never imported the function at all fails
    # with that sentence rather than with an arithmetic one about indices.
    index_of(text, "resetAttention")
    opens, closes = _handler_window(text)
    found = text.find(CLEARS_THE_ALARMS, opens, closes)

    assert found >= 0, (
        f"web/src/main.ts names resetAttention, but not between {HANDLER_OPENS!r} "
        "and the end of the createWsClient options object -- most likely it is "
        "imported and never called. The alarms belong in the one handler that "
        "clears everything else on a root switch: their paths are paths of a "
        "project the user has left, and a row that survives the switch is a row "
        "whose click the daemon refuses."
    )
