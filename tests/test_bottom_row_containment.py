"""The three bottom-row boxes must be siblings inside one container.

Motivation, measured in a headless browser against a live daemon: `#hud`,
`#context` and `#status` are three `position: fixed` boxes pinned to the same
`bottom: 10px`, each a direct child of `<body>`, and nothing in the document
relates their widths. They overlap. `getBoundingClientRect`, in CSS px, positive
meaning horizontal overlap:

    viewport   .keys x #context   .keys x #status   #context x #status
    1600              276              -637               -201
    1280              373              -317               -104
     960              438                 3                -18
     900              412                63                 -1
     800              360                23                163

At 960 the observed-root caption is buried completely. The keys caption is 143
characters wide and measures 708 px at every viewport, while the centre box is
placed at half the viewport, so the closed form of the collision is
`12 + 708 > W/2 - 0.45*W/2` -- true for every viewport under about 2618 px.
There is no clean case; the row has simply never been laid out as a row.

A comment in `style.css` claims the boxes cannot reach each other because
`#hud` owns 40vw and `#context` 50vw. That is wrong twice: the budget for a
*centred* box is `left + centre/2 + right <= 100vw`, and `#hud` carries no
40vw cap at all -- the `max-width` sits on `#log` and `#attribution`, never on
the caption that measures 708 px.

These assertions are the structural jaw. They say nothing about *how* the row is
shared (that is CSS, and no unit test can assert it); they say only that the
three boxes are laid out against each other rather than against the page, which
is what makes the overlap unrepresentable instead of merely fixed today. The
arithmetic jaw is `web/tests/bottomRow.test.ts`.

Deliberately phrased over containment alone: the wrapper's id is not pinned, so
the GREEN step may name it as it likes (`bottom-bar` is the suggested name).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML = REPO_ROOT / "web" / "index.html"

#: The three boxes that share the bottom of the page: left, centre, right.
BOTTOM_ROW_IDS = ("hud", "context", "status")

#: Elements HTML never closes; they must not be pushed as parents, or every
#: element after `<input>` would be reported as living inside it.
VOID_TAGS = frozenset(
    {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    }
)


@dataclass(frozen=True)
class Element:
    """One start tag, identified by its position in the document.

    `order` is what makes two `<div>`s comparable: parents are compared by
    identity, and equal tags with equal ids would otherwise compare equal.
    """

    order: int
    tag: str
    attrs: dict[str, str] = field(compare=False, default_factory=dict)

    @property
    def element_id(self) -> str:
        return self.attrs.get("id", "")

    def __str__(self) -> str:
        return f"<{self.tag}#{self.element_id}>" if self.element_id else f"<{self.tag}>"


class _ParentIndex(HTMLParser):
    """Record, for every element carrying an id, the element that contains it."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._stack: list[Element] = []
        self._order = 0
        self.parent_of: dict[str, Element | None] = {}

    def _open(self, tag: str, attrs: list[tuple[str, str | None]]) -> Element:
        self._order += 1
        element = Element(
            order=self._order,
            tag=tag,
            attrs={name: value or "" for name, value in attrs},
        )
        if element.element_id:
            self.parent_of[element.element_id] = self._stack[-1] if self._stack else None
        return element

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        element = self._open(tag, attrs)
        if tag not in VOID_TAGS:
            self._stack.append(element)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._open(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self._stack) - 1, -1, -1):
            if self._stack[index].tag == tag:
                del self._stack[index:]
                return


def _parent_of_bottom_row() -> dict[str, Element | None]:
    parser = _ParentIndex()
    parser.feed(INDEX_HTML.read_text(encoding="utf-8"))
    parser.close()

    missing = [name for name in BOTTOM_ROW_IDS if name not in parser.parent_of]
    assert missing == [], (
        "the page no longer carries these ids, so this policy would pass over "
        f"nothing: {missing}"
    )
    return {name: parser.parent_of[name] for name in BOTTOM_ROW_IDS}


def test_the_parser_sees_the_documents_real_nesting() -> None:
    """A guard on the tool itself, so a broken parser cannot report success.

    `#log` is nested inside `#hud` in the page, and `#status-list` inside
    `#status`. If the stack were mishandled -- a void tag pushed, an end tag
    ignored -- these would come back as children of the body, and every
    assertion below would compare the same wrong answer with itself.
    """
    parser = _ParentIndex()
    parser.feed(INDEX_HTML.read_text(encoding="utf-8"))
    parser.close()

    assert str(parser.parent_of["log"]) == "<div#hud>"
    assert str(parser.parent_of["status-list"]) == "<div#status>"


def test_the_three_bottom_row_boxes_share_one_parent() -> None:
    """Left, centre and right are siblings, or nothing can relate their widths.

    Green while all three sit in the body; it becomes load-bearing the moment a
    wrapper exists, because wrapping two of the three is the easy half-fix.
    """
    parents = _parent_of_bottom_row()

    assert len(set(parents.values())) == 1, (
        "the bottom-row boxes are laid out against different containers: "
        + ", ".join(f"#{name} in {parent}" for name, parent in parents.items())
    )


def test_the_bottom_row_is_wrapped_in_a_container_of_its_own() -> None:
    """That shared parent must not be the body.

    The body holds the canvas, the search bars, the root prompt and the file
    viewer, so a rule about the bottom row written on it applies to all of them.
    A container that holds these three and nothing else is what lets the row be
    laid out as one thing, and it is why the overlap cannot come back by a box
    growing its content.
    """
    parent = _parent_of_bottom_row()["hud"]

    assert parent is not None and parent.tag != "body", (
        "the bottom-row boxes are direct children of the body, so each is "
        "positioned against the page instead of against the other two"
    )
