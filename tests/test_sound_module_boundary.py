"""Three text scans: the platform's audio API has exactly one door, and the model has none.

**THESE PIN SPELLINGS, NOT BEHAVIOURS.** A substring search cannot see nesting,
cannot tell a call from a comment mentioning one, and cannot tell whether a name
it finds is inside a string. Every assertion here is about where a name appears
in a file, with all the limits `tests/frontend_source.py` states. The behaviours
are pinned elsewhere and named per test: `web/tests/sound.test.ts` says what the
model decides and proves that the clock is a parameter by driving it, and
`web/tests/soundVoice.test.ts` says which voice an agent gets.

**Why the scans are worth having anyway.** `web/vitest.config.ts` runs the front
end's suite with `environment: "node"`: there is no `AudioContext` in it, no
`window` and no `document`, and this project's doctrine adds no mock to invent
one -- keeping the suite "mock-free, jsdom-free and fast" is the stated reason
the shiki boundary exists at all. So the audio module is code that no assertion
in this repository will ever execute, and the only defence available for it is
the negative one: that there are very few lines in it and that none of them
decides anything. That is the same defence `highlight.ts` has ("no shiki outside
`highlight.ts`, not even `import type`"), and the same shape as
`checkouts.py`'s "starts no process", `content_search.py`'s "imports no `re`",
`sizes.py`'s "opens nothing" and `window.py`'s "never sees a token".

The three properties, and what each costs when it is wrong:

  * **The decision module names no clock and no platform.** A `sound.ts` that
    called `performance.now()` itself could not be tested without owning time,
    and one that touched `AudioContext` could not be imported by a test at all --
    which would take every assertion in `web/tests/sound.test.ts` with it. The
    clock arrives as a parameter, the way the viewport arrives as a parameter in
    `labels.ts` and `bottomRow.ts`.
  * **`AudioContext` is named in exactly one module.** Two modules naming it is
    two lifecycles for one platform resource, and a context is not a state field:
    it is constructed once, inside a user gesture, and a browser will refuse to
    create very many of them.
  * **The audio module cannot see an event.** A module that can see an
    `AgentEvent` is a module that can start deciding things about one, and every
    decision it took would be a decision no test could reach.

Style: one property, asserted once.
"""

from __future__ import annotations

import re

from frontend_source import WEB_SRC, read_src

#: The pure module: every decision, and nothing that can be called.
MODEL = "sound.ts"

#: The impure module: every call, and nothing that decides.
SINK = "audio.ts"

#: The CALL forms, never the bare words. `performance` and `window` are ordinary
#: English and will appear in a docstring about a performance budget or about the
#: window a limiter uses; `Date` alone is a word too. What is forbidden is a
#: module reaching for a clock or for the platform, and a reach is spelled with a
#: dot or with `new`.
FORBIDDEN_IN_MODEL = (
    "Date.now",
    "performance.now",
    "new AudioContext",
    "window.",
)

#: Both spellings of the platform API, the vendor-prefixed one included: a Safari
#: fallback written as `webkitAudioContext` in a second module is a second door.
AUDIO_API = re.compile(r"\b(?:webkitAudioContext|AudioContext)\b")

#: Application modules `audio.ts` may not import. Not an allow-list: a text scan
#: cannot resolve an import graph, so this names the two that matter. The
#: positive half -- that it imports the `Voice` type from `sound.ts` -- is proved
#: by `tsc`, which already runs in this project's build.
FORBIDDEN_IMPORTS = ('from "./protocol"', 'from "./simulation"')


def test_the_decision_module_reaches_for_no_clock_and_no_platform() -> None:
    """`sound.ts` takes its time as a parameter and never names the audio API.

    The behaviour -- that the same state and the same clock always give the same
    answer -- is `web/tests/sound.test.ts`, which drives the clock by hand
    through a hundred-event burst. This says only that no other clock is spelled
    in the file.
    """
    text = read_src(MODEL)

    found = [name for name in FORBIDDEN_IN_MODEL if name in text]

    assert found == [], (
        f"web/src/{MODEL} names {found}. It is the module every decision about "
        "the sound lives in, and it is testable only for as long as it owns "
        "neither a clock nor a platform object: the front end's suite runs with "
        "`environment: \"node\"`, so a module that touches either cannot be "
        "imported by a test at all."
    )


def test_the_audio_api_is_named_in_exactly_one_module() -> None:
    """One door onto `AudioContext`, and it is `audio.ts`.

    There is no behavioural test of this and there never will be: the API does
    not exist in the environment the front-end suite runs in. This scan is the
    whole of the contract, exactly as it is for shiki in `highlight.ts`.
    """
    holders = sorted(
        path.name
        for path in WEB_SRC.glob("*.ts")
        if AUDIO_API.search(path.read_text(encoding="utf-8"))
    )

    assert holders == [SINK], (
        f"the audio API is named in {holders or 'no module at all'}, and it "
        f"belongs in exactly one: web/src/{SINK}. A second holder is a second "
        "lifecycle for a platform resource that must be constructed once, inside "
        "a user gesture -- and a module naming it is a module no test in this "
        "repository can import."
    )


def test_the_audio_module_cannot_see_an_event() -> None:
    """It receives a resolved voice and plays it; it is told nothing else.

    The behaviours it must not take are pinned in `web/tests/sound.test.ts`: the
    seed rule, the read rule, the rate floor and the voice budget all live in the
    module that can be tested. This says only that the untestable one is not
    given the material to re-take any of them.
    """
    text = read_src(SINK)

    found = [name for name in FORBIDDEN_IMPORTS if name in text]

    assert found == [], (
        f"web/src/{SINK} imports {found}. A module that can see an `AgentEvent` "
        "is a module that can start deciding whether one is worth hearing, and "
        "every such decision would be one no test could reach. It takes a "
        "`Voice` and plays it; if a condition appears in that file, it is in the "
        "wrong file."
    )
