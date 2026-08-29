"""The summary panel and the size legend must be laid out against each other.

The session-stats panel (F8) needs a corner. The plan it comes from says
top-left, on the grounds that "top-left is the only free corner"; that was true
when it was written and is false now. `#attention`, the alarm panel of the
attention-rules feature, has occupied `top: 14px; left: 14px` with
`max-width: 32vw; max-height: 45vh` since it shipped. So the summary goes
**top-right**, and `#attention` changes in no way.

The geometry that settles it, and the reason it is settled here rather than in a
rule somebody has to remember: `#attention`'s right edge is at most
`14px + 32vw`, and a right-anchored box of `max-width: 32vw` has its left edge at
`68vw - 14px` at the least. Those meet only below a 78px viewport. **The alarm
panel and the summary panel are therefore non-overlapping by construction** --
"a summary the user opened must never cover an alarm they did not ask for" is a
property of the stylesheet, not a promise.

**Why a wrapper, and not simply a second box pinned near the legend.**
`#size-legend` has no `max-height` at all, and its `.error` row carries a
daemon-supplied string, so any `top:` offset chosen to sit below it is a guess
about a height nothing bounds. Sharing `top: 14px; right: 14px` outright is a
deterministic, total overlap for as long as F7 is armed -- the exact defect
`tests/test_bottom_row_containment.py` was written about, one corner over. A
column that owns both boxes is what makes the overlap unrepresentable instead of
merely absent today.

These assertions are the structural jaw, exactly as the bottom row's are. They
say nothing about *how* the column shares its space -- that is CSS, and no unit
test can assert it -- only that the two boxes are laid out against each other
rather than against the page, that the summary is bounded on both axes, and that
neither box eats the canvas underneath.

**Deliberately phrased over containment and over properties, never over the
wrapper's id and never over a value.** The precedent's own closing rule: the
GREEN step may name the column as it likes and tune every number in it. The one
place this file has to look at an id is when it goes hunting for the wrapper's
CSS rule, and that is a limit of a text-level reader rather than a decision --
stated where it happens.

The readers are the two that already exist -- `_ParentIndex` from
`tests/test_bottom_row_containment.py` and `_declarations_of` /
`_declaration_blocks` from `tests/test_bottom_row_width_bounds.py`. A third
reader with slightly different semantics is how two files come to disagree about
what the same stylesheet says.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from test_bottom_row_containment import INDEX_HTML, Element, _ParentIndex
from test_bottom_row_width_bounds import STYLESHEET, _declaration_blocks, _declarations_of

#: The panel this feature adds, and the list inside it that actually scrolls.
SUMMARY = "session-stats"
SUMMARY_LIST = "session-stats-list"

#: The box it has to share a column with, which is already on screen at F7.
LEGEND = "size-legend"

#: The measured row it must not join. `tests/test_bottom_row_containment.py`
#: owns these three; they are named here only as things to stay out of.
BOTTOM_ROW_IDS = ("hud", "context", "status")

#: The modal that is allowed to paint over the column -- the same bargain
#: `#size-legend` already accepts, and undone by closing the panel.
MODAL = "file-view"


class _DocumentIndex(_ParentIndex):
    """`_ParentIndex`, plus each id's document order and its ancestor chain.

    A subclass rather than a second parser: the nesting is read by exactly the
    code the bottom-row policy reads it with, so the two files cannot come to
    different conclusions about the same document.
    """

    def __init__(self) -> None:
        super().__init__()
        self.order_of: dict[str, int] = {}
        self.ancestors_of: dict[str, tuple[Element, ...]] = {}

    def _open(self, tag: str, attrs: list[tuple[str, str | None]]) -> Element:
        element = super()._open(tag, attrs)
        if element.element_id:
            self.order_of[element.element_id] = element.order
            # The open stack at this moment IS the chain of ancestors.
            self.ancestors_of[element.element_id] = tuple(self._stack)
        return element


def _document() -> _DocumentIndex:
    parser = _DocumentIndex()
    parser.feed(Path(INDEX_HTML).read_text(encoding="utf-8"))
    parser.close()
    return parser


def _require(doc: _DocumentIndex, *ids: str) -> None:
    """Fail with the missing id spelled out, rather than with a KeyError."""
    missing = [name for name in ids if name not in doc.order_of]
    assert missing == [], (
        f"web/index.html carries no {missing} yet, so this policy asserts over "
        "nothing. The summary panel needs an element of its own -- the natural "
        "first implementation puts it in #bottom-bar, which is the one place it "
        "may not go."
    )


def _wrapper_of(doc: _DocumentIndex, element_id: str) -> Element:
    parent = doc.parent_of[element_id]
    assert parent is not None, f"#{element_id} has no parent element at all"
    return parent


def test_the_parser_sees_the_summary_panels_real_nesting() -> None:
    """A guard on the tool, so nothing below can compare a wrong answer with itself.

    The scrolling list sits inside the panel in the page. If the stack were
    mishandled -- a void tag pushed, an end tag ignored -- it would come back as
    a child of the body and every containment assertion here would be vacuous.
    The bottom-row policy opens with the same guard, for the same reason.
    """
    doc = _document()
    _require(doc, SUMMARY, SUMMARY_LIST)

    assert _wrapper_of(doc, SUMMARY_LIST).element_id == SUMMARY, (
        f"#{SUMMARY_LIST} is not read as living inside #{SUMMARY}; the reader is "
        "wrong, so every assertion below would pass over the wrong element"
    )


def test_the_summary_panel_does_not_join_the_measured_bottom_row() -> None:
    """The fourth box does not join the row whose widths were measured.

    `#bottom-bar` is one grid with two side reserves measured in a browser
    against a legend of a known length. A box added to it changes what the
    centre caption may spend, with nothing on screen saying so -- which is what
    `web/index.html` and `CLAUDE.md` both already say about `#size-legend`. The
    natural first implementation puts a new caption there, because that is where
    every other caption on this page lives.
    """
    doc = _document()
    _require(doc, SUMMARY, *BOTTOM_ROW_IDS)

    forbidden = {doc.order_of[name]: f"#{name}" for name in BOTTOM_ROW_IDS}
    shared = _wrapper_of(doc, BOTTOM_ROW_IDS[0])
    forbidden[shared.order] = f"the container of {', '.join('#' + i for i in BOTTOM_ROW_IDS)}"

    offenders = [
        forbidden[ancestor.order]
        for ancestor in doc.ancestors_of[SUMMARY]
        if ancestor.order in forbidden
    ]

    assert offenders == [], (
        f"#{SUMMARY} is drawn inside {offenders}, so it takes width from a row "
        "whose share-out was measured in a browser against three boxes"
    )


def test_the_summary_panel_and_the_size_legend_share_one_container() -> None:
    """Two boxes in one corner are laid out against each other or they overlap.

    `#size-legend` carries no `max-height`, and its error row is a string the
    daemon supplies, so nothing in the document bounds its height: an offset
    chosen to clear it is a guess. Both boxes pinned to `top: 14px; right: 14px`
    is a total overlap for as long as F7 is armed.
    """
    doc = _document()
    _require(doc, SUMMARY, LEGEND)

    summary_parent = _wrapper_of(doc, SUMMARY)
    legend_parent = _wrapper_of(doc, LEGEND)

    assert summary_parent == legend_parent, (
        f"#{SUMMARY} sits in {summary_parent} and #{LEGEND} in {legend_parent}, "
        "so nothing in the document relates their positions"
    )


def test_that_container_is_not_the_body_itself() -> None:
    """A rule written on the body applies to the canvas and every bar on it.

    The body holds the stage, both search bars, the root prompt and the file
    viewer. A container that holds these two and nothing else is what lets the
    corner be laid out as one thing.
    """
    doc = _document()
    _require(doc, SUMMARY, LEGEND)

    parent = _wrapper_of(doc, SUMMARY)

    assert parent.tag != "body", (
        f"#{SUMMARY} is a direct child of the body, so it is positioned against "
        f"the page instead of against #{LEGEND}"
    )


def test_the_stylesheet_reader_sees_the_size_legends_own_declarations() -> None:
    """A guard on the CSS reader, before anything is asserted about absence.

    Two halves, both from the bottom-row policy's own guard. The legend really
    does carry its own rule today, so a reader that found nothing would be
    broken rather than reporting an absence -- and a policy about a *missing*
    property is exactly the kind that a broken reader passes. And
    `#size-legend .row { width: 190px }` is a real declaration that must never be
    credited to the box itself.
    """
    declarations = _declarations_of(f"#{LEGEND}")

    assert declarations, (
        f"the reader no longer finds #{LEGEND}'s own declarations, so the policy "
        "below would report an absence that is really a parsing failure"
    )
    assert declarations.get("width") != "190px", (
        f"a descendant's width was credited to #{LEGEND}; the reader is not "
        "distinguishing the box from what is inside it"
    )


def test_wrapping_the_legend_also_unpins_it_from_the_page() -> None:
    """Wrapping without un-pinning is the easy half-fix, and it changes nothing.

    A `position: fixed` box is positioned against the viewport whatever contains
    it, so a legend left pinned at `top: 14px; right: 14px` inside a new column
    lands in exactly the place the summary panel was put -- the overlap intact,
    the wrapper decorative, and this file green for the shape while the screen is
    unchanged. So the legend's own rule gives up its pinning, and the container
    takes it over.

    `_is_subject` is what makes this readable: `#size-legend .row { ... }` names
    the legend and says nothing about the box.
    """
    doc = _document()
    _require(doc, SUMMARY, LEGEND)

    legend = _declarations_of(f"#{LEGEND}")
    pinned = {name: legend[name] for name in ("position", "top", "right") if name in legend}

    assert pinned == {}, (
        f"#{LEGEND} still pins itself to the viewport with {pinned}; a fixed box "
        "ignores its container, so the column would be decorative and the two "
        "boxes would still be drawn on top of each other"
    )

    wrapper = _wrapper_of(doc, SUMMARY)
    assert wrapper.element_id, (
        "the container carries no id, so this file cannot find its rule. That is "
        "a limit of a text-level CSS reader, not a requirement about naming: give "
        "the container any id and this test reads it."
    )
    assert _declarations_of(f"#{wrapper.element_id}").get("position") == "fixed", (
        "the container does not position itself against the viewport, so the two "
        "boxes it holds are laid out in the document flow behind the canvas"
    )


@pytest.mark.parametrize(
    "bound,unit,why",
    [
        (
            "max-height",
            "vh",
            "32 agents at row height is taller than any window, and the column "
            "would run off the bottom of the screen with the rest of the table "
            "unreachable",
        ),
        (
            "max-width",
            "vw",
            "an agent id is arbitrary text and a path is unbounded, so the panel "
            "would grow left across the graph and over the centred search bar",
        ),
    ],
)
def test_the_summary_panel_bounds_itself_in_viewport_units(
    bound: str, unit: str, why: str
) -> None:
    """Both axes are bounded against the window, never against the content.

    The values are deliberately not pinned -- what the corner can afford is a
    browser measurement nobody here can take, and the tuning must stay free. What
    is pinned is that each bound is expressed against the VIEWPORT: a bound in
    `px` or `em` is a bound against a font, and it is the window that runs out.
    A `calc()`, a `min()` or a bound inside a `@media` query all satisfy this, so
    long as a viewport unit is in it.
    """
    declarations = _declarations_of(f"#{SUMMARY}")

    assert declarations, (
        f"#{SUMMARY} has no rule of its own in the stylesheet at all, so it is "
        "bounded by nothing"
    )
    value = declarations.get(bound, "")
    assert unit in value, (
        f"#{SUMMARY} declares {bound}: {value!r}, which is not measured against "
        f"the window; {why}"
    )


def test_the_column_lets_the_graph_through_and_the_list_still_scrolls() -> None:
    """Both halves of one decision, which is why they are one test.

    `pointer-events: none` on the box, `auto` on the list. `none` on both makes
    45vh of rows unscrollable and every row unclickable -- a panel that is a
    picture of itself. `auto` on the box makes it swallow every drag and click
    across 32vw x 45vh of canvas, and nothing on screen explains why the graph
    went dead under a corner that is mostly empty. Either alone is a defect, so
    neither is worth asserting alone.
    """
    doc = _document()
    _require(doc, SUMMARY, SUMMARY_LIST)

    box = _declarations_of(f"#{SUMMARY}").get("pointer-events")
    inner = _declarations_of(f"#{SUMMARY_LIST}").get("pointer-events")

    assert (box, inner) == ("none", "auto"), (
        f"#{SUMMARY} declares pointer-events: {box!r} and #{SUMMARY_LIST} "
        f"{inner!r}. The box must let the canvas have its drags, and the list "
        "must still take a wheel."
    )


def test_the_modal_paints_over_the_column_by_source_order_alone() -> None:
    """Paint order here IS source order, and that premise is asserted with it.

    The file viewer covers the corner while it is open -- the same bargain
    `#size-legend` accepts, undone by closing the panel. Nothing in this
    stylesheet declares a `z-index`, so among positioned boxes the later one in
    the document paints on top; a column added *after* `#file-view` would be
    drawn over the modal, leaving a summary floating on top of a file the user is
    reading.

    The second half of this test is the premise: the day a `z-index` appears
    anywhere in the stylesheet, source order stops deciding this and the first
    half stops meaning what it says.
    """
    doc = _document()
    _require(doc, SUMMARY, MODAL)

    # The container opens before the box it contains, so this is the container's
    # position too -- asserted through the child, because the container's id is
    # not this file's to pin.
    assert doc.order_of[SUMMARY] < doc.order_of[MODAL], (
        f"#{SUMMARY} is written after #{MODAL} in web/index.html, so with no "
        "z-index anywhere it paints over the open file viewer"
    )

    declared = [
        prelude
        for prelude, body in _declaration_blocks(STYLESHEET.read_text(encoding="utf-8"))
        for declaration in body.split(";")
        if declaration.partition(":")[0].strip().lower() == "z-index"
    ]
    assert declared == [], (
        "the stylesheet now declares a z-index in "
        f"{declared}, so painting is no longer decided by source order and the "
        "assertion above no longer means what it says"
    )
