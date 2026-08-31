"""Two measurements over the built front end: the entry chunk's ceiling, and what is not in it.

**BOTH ARE JAWS, NOT REDS. They pass today and they must pass after the ambient
sound ships** -- that is the whole of what they say. The feature's selling point
is that it adds nothing: WebAudio is a platform API, so there is no dependency,
no chunk and no lazy import to arrange, and the only way that claim can quietly
stop being true is a later change that reaches for a library and a bundle nobody
weighed afterwards.

**Why absolute and not a delta.** A delta needs a stored baseline the suite does
not have, and `web/dist` is gitignored -- 9.4 MB of build output that exists on a
machine where somebody has run `npm run build` and nowhere else, which is the
fact `tests/test_distribution_front_end.py`'s whole docstring is about. So both
assertions are absolute, both skip when the front end has not been built, and the
baseline lives in this file where a reader can see when it was taken.

**The baseline, and it must be re-measured rather than nudged.**

    web/dist/assets/index-B0ArcHBu.js   565 251 bytes   measured 2026-08-30

The ceiling below is that number plus a 4 KiB budget for the whole feature: two
small modules, one key binding and four lines of wiring. **The budget is a guess
and the baseline is a measurement**, and they must not be confused: if the
ceiling is ever hit, the answer is to find out what was added, not to raise the
number. Raising it is a decision about what this page costs to load, and it
belongs in a commit that says so.

The precedent is shiki's, quoted in `CLAUDE.md`: "measured: +5 KB, and
`grep -c shikijs dist/assets/index-*.js` is 0". A dependency that must not be in
the entry chunk is asserted by looking in the entry chunk.

**What this cannot say.** Nothing about whether the built page works, nothing
about whether `web/dist` is current -- the build copies whatever is there, so a
stale front end is measured here as silently as it ships -- and nothing about the
lazily loaded chunks, which are the grammars and are not this feature's business.

Style: one property, asserted once.
"""

from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

#: The built front end as it sits in a checkout, and the only input there is.
CHECKOUT_WEB_DIST = REPO_ROOT / "web" / "dist"

#: The entry chunk, hashed by Vite, so it is found by shape rather than by name.
ENTRY_GLOB = "assets/index-*.js"

#: Measured 2026-08-30 at b6f1357, on a build produced from a clean `npm run
#: build`: 565 251 bytes.
MEASURED_BASELINE_BYTES = 565_251

#: The whole feature's allowance: two small modules and four lines of wiring.
FEATURE_BUDGET_BYTES = 4_096

#: What the entry chunk may weigh once the feature has landed.
CEILING_BYTES = MEASURED_BASELINE_BYTES + FEATURE_BUDGET_BYTES

#: The refusals of decision 14, spelled as they would appear in a bundle. A
#: synthesis library would be a third runtime dependency, larger than shiki, for
#: four oscillators and an envelope; a bundled sample would be bytes in `dist/`
#: for a sound that a 90 ms sine with an exponential decay already makes.
#: `data:audio` catches the second family, which arrives as an inlined asset
#: rather than as a package name.
REJECTED = ("tone.js", "@tonejs", "howler", "pizzicato", "wavesurfer", "soundfont", "data:audio")


def _entry_chunk() -> Path:
    """The one hashed entry chunk, or a skip when nothing has been built."""
    if not CHECKOUT_WEB_DIST.is_dir():
        pytest.skip("web/dist is not built here; there is no bundle to weigh")
    chunks = sorted(CHECKOUT_WEB_DIST.glob(ENTRY_GLOB))
    if not chunks:
        pytest.skip(f"web/dist holds no {ENTRY_GLOB}; the build produced no entry chunk")
    assert len(chunks) == 1, f"expected one entry chunk, got {[c.name for c in chunks]}"
    return chunks[0]


def test_the_entry_chunk_stays_under_its_measured_ceiling() -> None:
    """The page a user waits for does not grow by more than the feature is worth.

    Green on arrival, and that is the point: it is the jaw that closes if the
    ambient sound is built out of a library instead of out of the platform.
    """
    chunk = _entry_chunk()

    size = chunk.stat().st_size

    assert size <= CEILING_BYTES, (
        f"{chunk.name} is {size} bytes, over the {CEILING_BYTES}-byte ceiling "
        f"({MEASURED_BASELINE_BYTES} measured on 2026-08-30 plus a "
        f"{FEATURE_BUDGET_BYTES}-byte budget). Find out what was added before "
        "touching this number: raising it is a decision about what this page "
        "costs to load."
    )


def test_no_audio_library_or_sample_is_bundled() -> None:
    """WebAudio is a platform API, and this feature depends on nothing.

    Green on arrival and after the feature, exactly like the shiki assertion it
    copies. It is not a RED: it guards a decision (no dependency, no sample)
    against being reversed quietly, at the one place where the reversal would be
    visible.
    """
    chunk = _entry_chunk()

    text = chunk.read_text(encoding="utf-8", errors="replace").lower()
    found = [name for name in REJECTED if name in text]

    assert found == [], (
        f"{chunk.name} carries {found}. A synthesis library is a third runtime "
        "dependency, larger than shiki, for four oscillators and an envelope, "
        "and a bundled sample is bytes in dist/ for a sound a 90 ms sine "
        "already makes. If one of them has become the right answer, it is a "
        "dependency this repository requires to name what it replaces and what "
        "it costs."
    )
