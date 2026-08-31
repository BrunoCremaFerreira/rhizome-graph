"""Text scans over `web/src/main.ts` and `web/src/sound.ts`: where the sound is wired in.

**THESE PIN SPELLINGS, NOT BEHAVIOURS**, with all the limits
`tests/frontend_source.py` states: a substring search cannot see nesting, cannot
tell a call from a comment mentioning one, and cannot tell whether a value it
finds is ever used. The behaviours are pinned elsewhere and named per test:
`web/tests/soundKeys.test.ts` says what F9 means, and `web/tests/sound.test.ts`
says what the model decides -- including, at the row this file's reset scan is
about, that a reset clears the limiter's clock and keeps the toggle.

**Why they are worth having anyway.** `main.ts` is the composition root and
carries no test by doctrine; there is no pure module that could hold any of these
decisions, because in each case the wiring *is* the decision. The choice is this
scan or nothing, which is the judgement `tests/test_attention_reset_wiring.py`
and `tests/test_stats_panel_wiring.py` already made for the two halves of the
same handler, and this file reuses their window rather than inventing a third.

The properties, and what each costs when it is wrong:

  * **The context is constructed inside the key handler.** An `AudioContext`
    built anywhere but inside a user gesture starts suspended, and `resume()`
    away from a gesture is refused. So the toggle IS the gesture: this is the one
    moment a gesture is guaranteed, and the scan for the call inside the branch
    is the only assertion available that it happens there.
  * **The sound follows the model.** `sim.applyEvent` first, so a click never
    describes a state the page has not reached.
  * **A root switch takes the clock and leaves the toggle.** This is the one
    place the feature contradicts the page's strongest pattern -- `onReset`
    clears eight things, and every one of them is about the OLD PROJECT, while
    the audio toggle is about the person in the chair. Silencing it on `ctrl+L`
    means re-enabling sound every time you change what you are watching.
  * **There is nothing to call that would silence it.** The scan above pins a
    spelling; the export-set jaw below removes the temptation structurally, which
    is what the tester review asked for instead of a scan for the absence of a
    name in a handler (a spelling is evaded by an inline object literal, and
    substituting one for a behaviour makes a missing test look present).

Style: one property, asserted once.
"""

from __future__ import annotations

import re

from frontend_source import index_of, read_src

#: The composition root, and the module the first four scans read.
COMPOSITION_ROOT = "main.ts"

#: The pure module the last scan reads.
MODEL = "sound.ts"

#: EVERY NEEDLE IN THIS FILE IS A CALL FORM, never a bare name, and the trailing
#: parenthesis is the whole of the reason. A bare name is satisfied by the import
#: line at the top of the module -- which sits thousands of characters above
#: every ordering this file asserts -- and by any comment that happens to mention
#: it. Two of these scans are ordering assertions and one searches inside a
#: window a comment can reach, so both mistakes are live here. It is the
#: correction `tests/test_sound_module_boundary.py` already carries for
#: `performance.now` and `Date.now`, applied one file over.
#:
#: A call form is also indifferent to HOW the callee was imported, which is the
#: point: `voiceFor(...)` and `sound.voiceFor(...)` both satisfy it, so the scan
#: has no opinion about the import style of the module it reads. See
#: `test_the_sound_follows_the_model_it_describes` for what happened when it did.
SOUND_BRANCH = "interpretSoundKey("
MODAL_BRANCH = "interpretFileViewKey("

#: The sink's first consumer, and the one everything else must follow. The
#: comment beside the sound line names it too, in prose.
MODEL_UPDATE = "sim.applyEvent("

#: The decision this feature adds to that sink.
SOUND_DECISION = "voiceFor("

#: What a reset does to the limiter -- and, by its absence elsewhere, what it
#: does not do to the toggle. The handler's own comment explains the asymmetry
#: in words, so only a call counts.
LIMITER_RESET = "resetLimiter("

#: The lifecycle rule of decision 12. The listener is found by its registration
#: rather than by the event name alone, because the paragraph above it in
#: `main.ts` discusses both the event and the decision by name.
VISIBILITY_LISTENER = 'addEventListener("visibilitychange"'
VISIBILITY_DECISION = "shouldRun("

#: Where the reset handler begins, and where it can no longer be. Copied from
#: `tests/test_stats_panel_wiring.py` deliberately: two different windows over
#: one handler would let a change pass one file and fail the other.
HANDLER_OPENS = "onReset: ()"
CALL_CLOSES = "\n  );"
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

#: A call of the shape `something.start()`. A text scan cannot say whose `start`
#: it is; what it can say is that the branch calls one, which is the whole of
#: what is available about a construction inside a gesture.
STARTS_THE_SINK = re.compile(r"\.start\(\s*\)")

#: An exported declaration, in the four forms this project's modules use.
EXPORTED = re.compile(
    r"^export\s+(?:declare\s+)?(?:const|let|function|interface|type|class|enum)\s+"
    r"([A-Za-z0-9_$]+)",
    re.MULTILINE,
)

#: Re-export forms a text scan cannot resolve. Their presence is the failure.
OPAQUE_EXPORTS = ("export {", "export *", "export default")

#: Everything `sound.ts` may export, and nothing else.
#:
#: Eleven names are the model itself and three (`PITCH_TABLE`, `actorVoice`,
#: `DEFAULT_VOICE`) are the per-agent voice. The list is exhaustive on purpose:
#: adding an export has to be a deliberate edit here, because the export this
#: jaw exists to forbid is the plausible one -- a `closeSound` or `disableSound`
#: beside `closeSizeMode` and `closeContentSearch`, which a later "consistency"
#: pass through `onReset` would then call, silencing the listener's own
#: preference every time they switched project.
ALLOWED_EXPORTS = frozenset(
    {
        "MIN_VOICE_INTERVAL_MS",
        "MAX_CONCURRENT_VOICES",
        "PITCH_TABLE",
        "DEFAULT_VOICE",
        "Voice",
        "SoundState",
        "createSound",
        "toggleSound",
        "voiceFor",
        "actorVoice",
        "noteStarted",
        "noteEnded",
        "resetLimiter",
        "shouldRun",
    }
)


def _handler_window(text: str) -> tuple[int, int]:
    """Where `onReset`'s body begins, and where it can no longer be."""
    opens = index_of(text, HANDLER_OPENS)
    closes = index_of(text[opens:], CALL_CLOSES) + opens
    for key in OPTION_KEYS:
        found = text.find(key, opens, closes)
        if found >= 0:
            closes = found
    return opens, closes


def test_f9_is_answered_above_the_modal() -> None:
    """The toggle works with a panel over the graph, which is when it is wanted most.

    The behaviour -- that the binding claims F9 and declines everything else --
    is `web/tests/soundKeys.test.ts`. This says only where the branch is written.

    Below `interpretFileViewKey` the toggle would be swallowed while the viewer
    is open, and below the root bar while the bar is focused. Those are states a
    listener is *more* likely to be in when a noise has stopped being welcome,
    not less.
    """
    text = read_src(COMPOSITION_ROOT)

    sound = index_of(text, SOUND_BRANCH)
    modal = index_of(text, MODAL_BRANCH)

    assert sound < modal, (
        f"web/src/main.ts answers {SOUND_BRANCH} at {sound}, below "
        f"{MODAL_BRANCH} at {modal}. F9 contests nothing and is conditional on "
        "nothing, so it belongs beside F7 and F8 above the chain rather than "
        "inside the precedence argument."
    )


def test_the_f9_branch_takes_the_key_outright() -> None:
    """`preventDefault`, the way F7's and F8's branches do.

    Browsers and window managers bind the function-key row; F7's branch set the
    precedent for claiming the key rather than sharing it. A scan can only say
    that the call is written inside the branch's own stretch of the file.
    """
    text = read_src(COMPOSITION_ROOT)

    sound = index_of(text, SOUND_BRANCH)
    modal = index_of(text, MODAL_BRANCH)

    assert text.find("preventDefault(", sound, modal) >= 0, (
        "the F9 branch does not call preventDefault before the modal's branch "
        "begins, so the key is left to whatever the browser or the window "
        "manager does with it"
    )


def test_the_audio_context_is_started_inside_the_key_branch() -> None:
    """The toggle is the gesture, and there is no second moment that would do.

    A context constructed outside a user gesture starts suspended under every
    current autoplay policy, and `resume()` away from a gesture is refused. So it
    cannot be built at boot and enabled later: the construction happens in the
    keydown handler or it does not work at all. No test can execute that code --
    `web/vitest.config.ts` runs with `environment: "node"` -- so this scan is the
    only assertion available about it, and it is a weak one: it cannot tell
    whose `start` is being called, only that the branch calls one.
    """
    text = read_src(COMPOSITION_ROOT)

    sound = index_of(text, SOUND_BRANCH)
    modal = index_of(text, MODAL_BRANCH)
    found = STARTS_THE_SINK.search(text, sound, modal)

    assert found is not None, (
        "the F9 branch never starts the audio sink, so either nothing "
        "constructs the context or something constructs it outside the one "
        "moment a user gesture is guaranteed -- in which case it starts "
        "suspended and the toggle does nothing on the first press"
    )


def test_the_sound_follows_the_model_it_describes() -> None:
    """`sim.applyEvent` first, then the voice.

    The behaviour of the decision itself is `web/tests/sound.test.ts`; this says
    only that the composition root offers the event to the simulation before it
    offers it to the speakers, so a click never describes a state the page has
    not reached.

    **The needle is `voiceFor(` and not `voiceFor`, and that is not tidiness.**
    An ordinary `import { voiceFor } from "./sound";` puts the first occurrence
    of the bare name at the top of the file, thousands of characters above
    `sim.applyEvent`, so this test failed against a sink written in exactly the
    right order. It was first worked around in the source -- `main.ts` was given
    the only namespace import it has, `import * as sound`, so that every call
    read `sound.voiceFor(...)` and the bare name appeared nowhere near the
    imports. A scan is not allowed to dictate an import style: it exists to
    report a fact about the wiring, and a fact that can be satisfied by moving an
    import is not the fact anybody wanted. The call form is satisfied by
    `voiceFor(...)` and by `sound.voiceFor(...)` alike, and by no import line.
    """
    text = read_src(COMPOSITION_ROOT)

    applied = index_of(text, MODEL_UPDATE)
    heard = index_of(text, SOUND_DECISION)

    assert applied < heard, (
        f"web/src/main.ts names {SOUND_DECISION!r} at {heard}, before "
        f"{MODEL_UPDATE!r} at {applied}: the page would be heard reacting to an "
        "event before it has been seen reacting to it"
    )


def test_a_root_switch_clears_the_limiters_clock() -> None:
    """The clock belongs to the old project's last event; the toggle does not.

    The behaviour -- that `resetLimiter` clears the floor and keeps `enabled` --
    is `web/tests/sound.test.ts`. This says only that the reset handler names it,
    so the new project's first event is not suppressed by a floor the old
    project's last event set.

    The window matters and not merely the name: whatever the state is called it
    will also appear at the top of the file in an import and in the keydown
    branch above, and a scan for the bare name would be satisfied by either.
    """
    text = read_src(COMPOSITION_ROOT)

    opens, closes = _handler_window(text)

    assert text.find(LIMITER_RESET, opens, closes) >= 0, (
        f"web/src/main.ts's onReset handler never names {LIMITER_RESET!r}. The "
        "limiter's clock was set by an event in a project nobody is watching any "
        "more, and the first change in the new one would be swallowed by it."
    )


def test_the_page_stops_the_sound_when_its_tab_goes_away() -> None:
    """One listener, routed through the pure decision rather than through a guess.

    The behaviour -- what `shouldRun(enabled, hidden)` answers -- is
    `web/tests/sound.test.ts`. This says only that a `visibilitychange` listener
    exists and that its body asks that question, rather than suspending or
    resuming on a condition spelled inline in the composition root where nothing
    could test it.

    Browsers already throttle audio in background tabs, inconsistently; doing it
    explicitly makes the behaviour ours rather than the vendor's.

    Both needles are call forms, and here the window is why: the paragraph of
    comment above the listener explains the rule and names both the event and
    the decision, so a scan for bare words would be answered by the explanation
    of the code rather than by the code.
    """
    text = read_src(COMPOSITION_ROOT)

    listener = index_of(text, VISIBILITY_LISTENER)
    following = text.find("addEventListener(", listener + len(VISIBILITY_LISTENER))
    closes = following if following >= 0 else len(text)

    assert text.find(VISIBILITY_DECISION, listener, closes) >= 0, (
        f"web/src/main.ts registers {VISIBILITY_LISTENER!r} without calling "
        f"{VISIBILITY_DECISION!r} before the next listener begins, so the "
        "decision it takes is one no test can reach"
    )


def test_the_model_exports_no_way_to_silence_itself() -> None:
    """A structural jaw, and the reason it is structural rather than a scan.

    The behaviour it protects -- that the toggle survives a reset and only the
    limiter's clock is cleared -- is pinned in `web/tests/sound.test.ts`. What is
    left over is a temptation: `onReset` clears eight things, seven of them
    through a `close*`-shaped call, and the natural ninth line is
    `closeSound(sound)` beside `closeSizeMode(sizeMode)`. Scanning the handler
    for the ABSENCE of such a call would pin a spelling in place of a behaviour
    and would be evaded by an inline object literal; refusing to export anything
    with that shape removes the line the refactor would write.

    The list is exhaustive, so widening the module's surface is a deliberate edit
    here. That friction is the feature, not a side effect.
    """
    text = read_src(MODEL)

    opaque = [form for form in OPAQUE_EXPORTS if form in text]
    assert opaque == [], (
        f"web/src/{MODEL} uses {opaque}, which a text scan cannot resolve into "
        "names. The module's surface has to be readable from its declarations "
        "for this jaw to mean anything."
    )

    exported = set(EXPORTED.findall(text))
    unexpected = sorted(exported - ALLOWED_EXPORTS)
    missing = sorted(ALLOWED_EXPORTS - exported)

    assert unexpected == [], (
        f"web/src/{MODEL} exports {unexpected}, which this file does not allow. "
        "If one of them is a way to turn the sound off, it is the line a later "
        "consistency pass through `onReset` will call, and the listener's own "
        "preference dies with every root switch. If it is something else, add it "
        "here on purpose."
    )
    assert missing == [], (
        f"web/src/{MODEL} does not export {missing}; the surface this feature is "
        "built on is incomplete."
    )
