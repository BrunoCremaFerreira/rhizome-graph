"""Reading `web/src/` from pytest, because there is no TypeScript source harness.

Not a test file (the name keeps pytest from collecting it), and not a good place
to be. It exists because several contracts this project states about the front
end are contracts about *where a name appears* rather than about what a function
answers -- "no shiki outside `highlight.ts`", "`Notification` is named in exactly
one module", "the reset handler clears the alarms" -- and the front-end suite has
no way to express them: `grep -rln "readFileSync\\|readFile" web/tests/` returns
nothing, vitest here runs with `environment: "node"` but no test reads a source
file, and there is no TypeScript parser available to either suite. Every one of
those contracts exists today as prose in a comment and in `CLAUDE.md`, and prose
is not a jaw.

So the scan is done here, in the suite that already parses Python sources for the
same kind of rule (`tests/test_checkouts.py` over `checkouts.py`,
`tests/test_daemon_environment_boundary.py` over `daemon/server.py`).

**Three limits, stated once so no caller has to restate them.**

  * **A text scan sees no structure.** It cannot tell a call inside a handler
    from the same call anywhere else in the file, it cannot see nesting, and it
    cannot see whether a name is inside a comment or a string. Every assertion
    built on it is therefore about a *spelling*.
  * **A spelling is not a behaviour.** Which is why every test using this module
    must carry a one-sentence header saying so, and naming the behavioural test
    that pins the behaviour. A scan that is described as a behavioural test is
    worse than no scan: it makes the missing test look present.
  * **It is only worth having where a behavioural test is impossible.**
    `main.ts` is the composition root and carries no test by doctrine;
    `renderer.ts` needs a GL context. Anywhere a pure module could hold the
    decision instead, the answer is to extract the pure module and test that --
    which is this project's own stated move.
"""

from __future__ import annotations

from pathlib import Path

#: The front end's sources, resolved from this file rather than from the
#: process's working directory: the suite is run from the checkout root, from
#: `tests/`, and by an editor, and all three must read the same file.
WEB_SRC = Path(__file__).resolve().parent.parent / "web" / "src"


def read_src(name: str) -> str:
    """The text of `web/src/<name>`.

    A missing file is an `AssertionError` naming the path, not an `OSError`: a
    module that was renamed or never written is the thing the caller is asking
    about, and the failure should read as the answer rather than as an accident
    in the harness.
    """
    target = WEB_SRC / name
    if not target.is_file():
        raise AssertionError(
            f"there is no {target}. A source-level contract can only be asserted "
            "over a file that exists; if the module was renamed, this test names "
            "the old name."
        )
    return target.read_text(encoding="utf-8")


def index_of(text: str, needle: str) -> int:
    """Where `needle` first appears in `text`, or an `AssertionError` saying it does not.

    Returned as an index rather than as a boolean because the only ordering
    question a text scan can answer is "does this name appear between those two
    names", and a caller that has to write `text.find(...)` itself gets `-1` --
    which compares as "before everything" and quietly satisfies the very
    ordering it was meant to check.
    """
    found = text.find(needle)
    if found < 0:
        raise AssertionError(
            f"{needle!r} does not appear in the source at all. This is a scan "
            "over text: it pins a spelling, so a rename of the thing it names "
            "is exactly what it reports."
        )
    return found
