"""One text scan over `web/src/renderer.ts`: the `actor:` hash prefix is spelled once.

**A JAW, not a RED: it passes today.** `actorColor` already exists in
`web/src/colors.ts` and `renderer.ts` already calls it, so the defect this
guards is fixed and what is missing is the thing that keeps it fixed. The
behaviour -- that `actorColor(x)` is `hashColor("actor:" + x)` -- is pinned in
`web/tests/colors.test.ts`. This file pins only that the prefix is not respelled
in the module no test can reach.

**This pins a SPELLING, not a behaviour**, with all the limits
`tests/frontend_source.py` states: it cannot see whether a literal it finds is
in a comment, and it cannot see what any of it computes.

**Why it is worth having.** `renderer.ts` needs a GL context and therefore
carries no test at all, which is exactly why the prefix was a literal inside it
for as long as it was. `hashColor` colours directories too, so the prefix is
what keeps an agent called `src` apart from the directory `src`; a second
spelling of it, or a typo in one, is a page where the swatch beside an agent's
name and the figure standing in the graph are two different colours, with nothing
on screen saying which one is lying. Three surfaces now want an agent's colour --
the alarm rows, the session-stats swatch, and the per-agent timbre of the
ambient-sound plan -- so the pressure to respell it is only going up.

Style: one property, asserted once.
"""

from __future__ import annotations

import re

from frontend_source import index_of, read_src

#: The module that owns the figure, and that no test can import.
RENDERER = "renderer.ts"

#: The prefix, in any of the three ways a TypeScript file can write a string.
#: `actor:` also appears in this file as an object KEY (`actor: string`), which
#: is a different thing entirely -- hence the quote, and hence a regex rather
#: than a substring search.
PREFIX_LITERAL = re.compile(r"""["'`]actor:""")

#: The one function that may hold it.
SHARED_SPELLING = "actorColor("


def test_the_renderer_asks_for_an_actors_colour_rather_than_spelling_the_prefix() -> None:
    """The prefix lives in `colors.ts` and nowhere else.

    The behaviour is `web/tests/colors.test.ts`; this is the jaw that keeps the
    one spelling from becoming two.
    """
    text = read_src(RENDERER)

    # Presence first, so a renderer that stopped colouring its figures at all
    # fails with that sentence rather than passing for having no literal.
    index_of(text, SHARED_SPELLING)

    found = PREFIX_LITERAL.search(text)

    assert found is None, (
        f"web/src/{RENDERER} spells the actor hash prefix itself, at offset "
        f"{found.start() if found else -1}. It belongs to `actorColor` in "
        "colors.ts: this module carries no test, so a typo here is a figure and "
        "a swatch in two different colours with nothing on screen saying which "
        "of them is wrong."
    )
