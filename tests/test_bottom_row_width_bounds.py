"""The bottom row's shrink-proof boxes must bound their own width.

Motivation, measured in a browser against the shipped build. The bottom row is
now one `#bottom-bar` grid -- `minmax(0, 1fr) auto minmax(0, 1fr)`, `padding: 0
12px`. Two boxes in it can grow wider than the track they sit in, and **one
change deleted the cap on both of them**, as four "dead" width caps were swept
out while the grid was built. Neither was dead.

`#status`, at 600 px, overlapping `#context` by **6 px**:

    #context rendered width      126   (already at the MIN_ROOT_CHARS floor)
    #status natural width        231
    side track each              (600 - 126 - 24) / 2 = 225
    shortfall                    231 - 225 = 6

`#log`, with a **single** entry in the recent-changes list (one real watcher
event for a long path), overlapping at every width, not only narrow ones:

    viewport   #hud used width   its track   #hud x #context   #hud x #status
      1280           448            412           +36              clear
       600           448            225          +126               +103

The mechanism is one mechanism. A log row and a status row are both paths and
both `white-space: nowrap`, so the box's min-content is a whole line of text; a
grid item's shrink-to-fit width floors at min-content, so the item overflows its
track toward the centre however the track is sized. `justify-self: start` and
`justify-self: end` do not save it, and neither would a floor on the track: a
track floor makes the track wider, it does not make the box narrower, and at
600 px there is no width left to hand out. Only a bound on the *used* width
clamps below min-content -- and both boxes already carry the `overflow-x:
hidden` that absorbs what such a clamp cuts off. That is why this policy asks
for the bound on each box's own rule.

For `#log` specifically, the bound may not be moved up to `#hud`, which is the
grid item that actually overflows. `#hud` is a column flex with `align-items:
flex-start` and no overflow clipping, so its children are shrink-to-fit and a
clamped `#hud` would simply be painted over by a `#log` that is still a whole
path wide. The clipping lives on `#log`, so the bound has to live there too.

Why the caps looked dead, which is the lesson worth keeping. Both were `vw`
caps, and **a `vw` cap is dead only above the viewport width where it crosses
the content's natural size**. `#status { max-width: 32vw }` exceeds that
panel's 231 px only above **~722 px** (231 / 0.32 = 721.9); every width that had
been measured sat above the crossover, so the cap looked inert. The deletion
reviewed neither box's crossover. Before deleting a cap on any of these boxes,
compute the viewport at which it starts to bind, not only the viewports already
measured. **This is the second time the `#status` fact has been lost**, which is
why it is written here rather than in a commit message.

The `#log` defect also survived a verification that reported the row clean at
every width, and the reason it did is worth recording: that measurement ran
against a freshly started daemon whose recent-changes list was **empty** -- seed
events are dropped from that panel -- and an empty `#log` has no min-content to
speak of, so the caption wrapped to its track and everything looked fine. The
list is empty for exactly as long as nobody is working, which is the one
condition under which nobody is looking at this tool. Measure this row with real
activity in it.

`#attribution` is deliberately NOT in this policy, judged on the same rule that
excludes `#status .op`: bound only what can actually exceed its track. It lost
a `max-width: 40vw` in the same deletion, but its content is a fixed sentence
that wraps -- no `nowrap`, no path, nothing an event can grow -- so its
min-content is its longest word, of the same order as the longest token in the
uncapped shortcut legend beside it (`ctrl+shift+F`). It cannot overflow a track
that the legend does not already overflow, so an assertion about it would be
green whatever the stylesheet said, and a vacuous assertion is worse than none.

The spelling is deliberately free. `max-width: 32vw` is the shape both caps had,
but a `ch` cap, a `calc()`, a `min()`, a plain `width`, the logical
`max-inline-size`, or any of them inside a `@media` query all satisfy this
policy and all keep the box off its neighbour. What is pinned is the property:
each of these boxes bounds its own horizontal size. What this file cannot check
is whether the *value* chosen is tight enough -- that is a browser measurement,
and the table above is the one to reproduce, with the list non-empty.

Two things this file deliberately does NOT do:

* It does not mirror the caps into `bottomRow.ts`. A constant in TypeScript
  claiming what the stylesheet does, with nothing asserting the two agree, is
  the second layout engine that module was written to avoid being.
* It does not extend the share invariant in `web/tests/bottomRow.test.ts` down
  to 600 px. That invariant cannot hold there by construction: `MIN_ROOT_CHARS`
  wins over the arithmetic below some viewport, and 600 px is below that line.
  The centre is already at its floor at 600 px; the shortfall is on the sides.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
STYLESHEET = REPO_ROOT / "web" / "src" / "style.css"


@dataclass(frozen=True)
class Box:
    """One bottom-row box whose min-content is a line of text it cannot shrink."""

    #: The rule this policy reads, and the element the bound must sit on.
    selector: str
    #: A vertical bound the box really carries, which the reader is proved on.
    known_bound: tuple[str, str]
    #: What is measured to happen when the horizontal bound is missing.
    overflow: str


#: The boxes this policy covers. `#attribution` is excluded on purpose; the
#: module docstring says why, and says it there so that adding it later is a
#: decision rather than an oversight.
OVERFLOWING_BOXES = (
    Box(
        selector="#log",
        known_bound=("max-height", "30vh"),
        overflow=(
            "one entry for a long path makes #hud 448px wide, which overflows "
            "its 412px track at 1280 (+36 over #context) and its 225px track "
            "at 600 (+126 over #context, +103 over #status)"
        ),
    ),
    Box(
        selector="#status",
        known_bound=("max-height", "40vh"),
        overflow=(
            "at 600 the panel keeps its 231px natural width inside a 225px "
            "grid track and overlaps #context by 6px; a cap here binds below "
            "~722px of viewport and does nothing above it"
        ),
    ),
)

#: Properties that bound a box horizontally. Logical forms included because
#: `max-inline-size` is the same statement in a different vocabulary, and
#: `width` because a fixed width bounds just as firmly as a maximum.
BOUNDING_PROPERTIES = ("max-width", "max-inline-size", "width", "inline-size")

#: Values that name one of those properties without bounding anything: they
#: either remove the bound or restate the width the box already wanted.
UNBOUNDED_VALUES = frozenset(
    {
        "",
        "none",
        "auto",
        "100%",
        "100vw",
        "max-content",
        "fit-content",
        "inherit",
        "initial",
        "unset",
        "revert",
        "revert-layer",
    }
)

_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_COMBINATOR = re.compile(r"[\s>+~]+")
_ATTRIBUTE_OR_PSEUDO = re.compile(r"\[[^\]]*\]|:{1,2}[A-Za-z-]+(?:\([^)]*\))?")


def _declaration_blocks(css: str) -> list[tuple[str, str]]:
    """Every `prelude { declarations }` pair, at any nesting depth.

    Brace-aware rather than a split on `}`, so a bound written inside a
    `@media` query is found exactly like one written at the top level.
    """
    text = _COMMENT.sub("", css)
    blocks: list[tuple[str, str]] = []
    stack: list[tuple[str, int]] = []
    cursor = 0

    for index, character in enumerate(text):
        if character == "{":
            stack.append((text[cursor:index].strip(), index + 1))
            cursor = index + 1
        elif character == "}":
            if not stack:  # unbalanced source; nothing useful to report here
                continue
            prelude, start = stack.pop()
            body = text[start:index]
            if "{" not in body:
                blocks.append((prelude, body))
            cursor = index + 1

    return blocks


def _is_subject(selector: str, element: str) -> bool:
    """True when `selector` styles `element` itself, not a descendant of it.

    `#log .op { width: 0.9em }` and `#status .op { width: 0.9em }` are real
    declarations in the stylesheet and are exactly the trap this guards: each
    names a bounding property, mentions the box, and says nothing whatsoever
    about the box's width. Pseudo-elements are excluded for the same reason --
    `#status::-webkit-scrollbar` is not the box.
    """
    compound = _COMBINATOR.split(selector.strip())[-1]
    if "::" in compound:
        return False
    return _ATTRIBUTE_OR_PSEUDO.sub("", compound) == element


def _declarations_of(element: str) -> dict[str, str]:
    """The declarations that apply to `element` itself, later wins."""
    found: dict[str, str] = {}

    for prelude, body in _declaration_blocks(STYLESHEET.read_text(encoding="utf-8")):
        if prelude.startswith("@"):
            continue
        if not any(_is_subject(part, element) for part in prelude.split(",")):
            continue
        for declaration in body.split(";"):
            name, separator, value = declaration.partition(":")
            if not separator:
                continue
            found[name.strip().lower()] = value.replace("!important", "").strip().lower()

    return found


def _horizontal_bounds(element: str) -> dict[str, str]:
    """Every declaration on `element` that limits how wide it may be drawn."""
    declarations = _declarations_of(element)

    return {
        name: declarations[name]
        for name in BOUNDING_PROPERTIES
        if name in declarations and declarations[name] not in UNBOUNDED_VALUES
    }


@pytest.mark.parametrize("box", OVERFLOWING_BOXES, ids=lambda box: box.selector)
def test_the_stylesheet_reader_sees_the_boxs_own_declarations(box: Box) -> None:
    """A guard on the tool, so the policy below cannot pass over the wrong rule.

    Two halves. Each box really carries a `max-height` today -- it is bounded on
    the axis that overlaps nothing -- so a reader that found nothing would be
    broken rather than reporting an absence. And the `width` on the box's `.op`
    glyph must not be credited to the box itself: that descendant declaration
    would make the policy vacuously green while the caption is still painted
    over.
    """
    property_name, value = box.known_bound
    declarations = _declarations_of(box.selector)

    assert declarations.get(property_name) == value, (
        f"the reader no longer finds {box.selector}'s own declarations, so this "
        f"policy would assert over nothing: {sorted(declarations)}"
    )
    assert declarations.get("width") != "0.9em", (
        f"a descendant's width was credited to {box.selector}; the policy below "
        "would then pass without the box being bounded at all"
    )


@pytest.mark.parametrize("box", OVERFLOWING_BOXES, ids=lambda box: box.selector)
def test_a_box_that_cannot_shrink_bounds_its_own_width(box: Box) -> None:
    """Nothing in this row may be free to grow into the box beside it.

    Both boxes hold nowrap lines of path text, so neither shrinks to its track;
    without a bound each overflows toward the centre and paints over the
    observed root, which is the exact failure the grid was built to end. Any
    spelling that bounds the horizontal size satisfies this.
    """
    bounds = _horizontal_bounds(box.selector)

    assert bounds, (
        f"{box.selector} carries no horizontal width bound, so {box.overflow}. "
        f"Declarations found: {sorted(_declarations_of(box.selector))}"
    )


# ---------------------------------------------------------------------------
# The shortcut legend's own length, which is an INPUT to a browser measurement.
#
# Nothing above reads `web/index.html`; this section does, and it is a different
# kind of statement from the rest of the file. Everything above is a policy about
# the stylesheet. This is a jaw on a number that was measured in a browser and
# written down in TypeScript, against a string that lives in the HTML -- three
# places, and only one of them ever gets edited.
#
# `web/index.html` is spelled here rather than imported so this section stands on
# its own; it is the same path `tests/test_bottom_row_containment.py` names.

INDEX_HTML = REPO_ROOT / "web" / "index.html"

#: The legend itself: the `.keys` span inside the bottom row's `.about` block.
LEGEND = re.compile(r'<span class="keys">(.*?)</span>', re.DOTALL)

#: What it measured, on 2026-08-29, with whitespace collapsed the way a browser
#: collapses it. Changing this number is a decision, and the docstring below says
#: which measurement has to be redone before it may be changed.
MEASURED_LEGEND_LENGTH = 162


def _legend_text() -> str:
    """The legend as one line, collapsed the way HTML collapses it.

    The source wraps the string across two lines for readability, and a browser
    renders that as single spaces. Counting the source bytes instead would make
    the number depend on where the file happens to be wrapped.
    """
    found = LEGEND.search(INDEX_HTML.read_text(encoding="utf-8"))
    assert found is not None, (
        "web/index.html no longer carries a <span class=\"keys\"> legend, so this "
        "jaw guards nothing -- and the constant it guards is still in bottomRow.ts"
    )
    return " ".join(found.group(1).split())


def test_the_shortcut_legend_has_not_grown_since_it_was_measured_in_a_browser() -> None:
    """A JAW, not a RED: it passes today, and that is what it is for.

    There is no behaviour here to specify. `CONTEXT_WIDTH_FRACTION = 0.34` in
    `web/src/bottomRow.ts` is not arithmetic -- it is a browser measurement, and
    its own comment says what it was measured against: "0.34 keeps the shortcut
    legend at two lines at both 1280 and 1600, where 0.40 wraps it to three at
    1280 and 0.50 to three at 1600. The legend is the widest thing in the row, so
    it is what pays for a greedy centre." `MIN_SIDE_WIDTH_PX = 231` is pinned to
    that same measurement rather than merely bounded by it.

    So the legend's length is an INPUT to two constants that live in another
    file, and nothing anywhere connects them. Growing the legend moves the width
    at which it wraps to a third line and neither constant has any idea. The
    session-stats panel wants ` - F8: session stats` here, which is 20 characters
    -- a 12% growth in the widest thing in the row -- and the ambient-sound plan
    wants another twelve beside it.

    **The only way to change this number is to re-measure.** Open the built page
    at 1280 and at 1600, check the legend is still on two lines with the centre
    caption legible, and write the new length here with the date of that
    measurement. Lowering `CONTEXT_WIDTH_FRACTION` instead squeezes the centre
    caption at widths where nothing ever overlapped, and shortening an existing
    entry is the other choice -- decide by measurement, not by taste.

    This host is a tty, so nobody here can take that measurement; the F8 entry is
    deliberately NOT added by the test that asks for it. What this converts is
    "somebody will remember to re-measure" into "the suite stops you".
    """
    legend = _legend_text()

    assert len(legend) == MEASURED_LEGEND_LENGTH, (
        f"the shortcut legend is now {len(legend)} characters, not "
        f"{MEASURED_LEGEND_LENGTH}:\n  {legend}\n"
        "CONTEXT_WIDTH_FRACTION = 0.34 and MIN_SIDE_WIDTH_PX = 231 in "
        "web/src/bottomRow.ts were measured in a browser against the 162-character "
        "string, at 1280 and 1600, where the legend sits on two lines. Re-measure "
        "at both widths, then write the new length above with the date."
    )
