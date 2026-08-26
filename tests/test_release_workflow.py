"""The GitHub Actions workflow that builds the .deb, checked as text.

Motivation. `packaging/build-deb.sh` already produces the package and already
refuses the ways it can be produced wrongly; what a workflow adds is a machine
nobody configured by hand, and that is exactly where the package's own
correctness quietly stops holding. The script derives two things from the
interpreter that runs it -- the `Depends: python3 (>= 3.N), (<< 3.N+1)` range and
the minor version the vendored virtualenv is bound to -- so *which Python the
runner has* is not a detail of the CI environment, it is a field in the shipped
control file. A runner image that moves under us changes the dependency range of
a release with no diff anywhere in this repository.

**This host cannot run a workflow.** There is no `act`, no runner, and no way to
reach GitHub from here, so nothing below proves the pipeline works. What it pins
is the handful of choices that are decisions rather than syntax, in the same
spirit as `tests/test_homebrew_formula.py`: the runner pin, the absence of
`setup-python`, that the front end is built before the package and that the
package is built by the script rather than reimplemented in YAML, that the
suites gate the release, and that nothing outside `actions/*` is trusted with
the checkout. Whether the workflow parses as YAML, whether the action versions
resolve, and whether the release step has the permissions GitHub actually wants
all wait for a real run.

There is no YAML parser in this project's dependencies -- the daemon has two and
the hook has none -- so the file is read as text, exactly as `start.sh` is in
`tests/test_start_script.py`. A regex over YAML is a poor parser; it is used here
only for line-shaped facts (`runs-on:`, `uses:`), never for structure.

Style: Arrange-Act-Assert, one property per test.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

#: GitHub only runs what is under `.github/workflows/`; a workflow anywhere else
#: is an inert file that reviews as done.
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "release.yml"

#: The runner image, pinned to a release rather than to the moving alias. The
#: package brackets `python3` to the minor version that BUILT it, so when
#: `ubuntu-latest` next rolls forward the .deb starts demanding an interpreter
#: the target machine may not have -- silently, since the build still succeeds.
#: 24.04 is noble, which is python3.12, which is the range debian/control carries.
RUNNER = "ubuntu-24.04"

#: The one script allowed to assemble a package. A workflow that inlines
#: `dpkg-deb --build` grows a second definition of the layout, and the one that
#: ships is then the one nobody reviewed.
BUILD_SCRIPT = "packaging/build-deb.sh"

#: The script being CALLED, which is what the ordering tests below are really
#: asking about. Matching the bare name instead finds the file's own header
#: comment, several steps above every command -- so the ordering assertions
#: compared the position of a sentence about the script with the position of the
#: build that must precede it, and failed on a workflow that was in fact right.
BUILD_INVOCATION = f"run: {BUILD_SCRIPT}"


def _workflow_text() -> str:
    assert WORKFLOW.is_file(), (
        f"{WORKFLOW.relative_to(REPO_ROOT)} does not exist; GitHub runs nothing "
        "that is not under .github/workflows/"
    )
    return WORKFLOW.read_text(encoding="utf-8")


def _used_actions(text: str) -> list[str]:
    """Every `uses:` value, which is every third party in the supply chain."""
    return [found.group(1) for found in re.finditer(r"^\s*uses:\s*(\S+)", text, re.MULTILINE)]


def test_the_workflow_sits_where_github_looks_for_it() -> None:
    """`.github/workflows/release.yml`, or it never runs."""
    assert WORKFLOW.is_file(), f"{WORKFLOW.relative_to(REPO_ROOT)} does not exist"


def test_the_runner_is_pinned_to_a_release_not_to_latest() -> None:
    """`ubuntu-latest` would silently rewrite the package's python3 range.

    This is the sharpest thing in the file. `build-deb.sh` reads
    `sys.version_info[1]` from the interpreter running it and writes the bound
    into DEBIAN/control, so the runner image IS a packaging decision.
    """
    text = _workflow_text()

    runners = re.findall(r"^\s*runs-on:\s*(\S+)", text, re.MULTILINE)

    assert runners, "the workflow declares no runs-on at all"
    assert all(runner == RUNNER for runner in runners), (
        f"the workflow runs on {runners!r}; it must pin {RUNNER!r}, because the "
        "interpreter on the runner decides the python3 range the .deb declares"
    )


def test_the_workflow_does_not_install_its_own_python() -> None:
    """`actions/setup-python` would defeat the pin above.

    It puts an interpreter on PATH that has nothing to do with the one the
    target machine has, and `build-deb.sh` would bracket the package to *that*
    minor version. The distribution's python3 is the whole point.
    """
    text = _workflow_text()

    assert "setup-python" not in text, (
        "the workflow uses actions/setup-python; the .deb must be built by the "
        "distribution's own python3, which is the interpreter its Depends range "
        "names and the one the vendored virtualenv is bound to"
    )


def test_the_front_end_is_built_before_the_package() -> None:
    """`build-deb.sh` refuses without web/dist, and web/dist is gitignored.

    A checkout carries no built front end, so a workflow that skips the build
    produces no package at all -- and if the refusal were ever relaxed, a
    package that serves a blank page while reporting success.
    """
    text = _workflow_text()

    build_index = text.find("vite build")
    if build_index < 0:
        build_index = text.find("npm run build")
    package_index = text.find(BUILD_INVOCATION)

    assert build_index >= 0, "the workflow never builds the front end"
    assert package_index >= 0, f"the workflow never runs {BUILD_SCRIPT}"
    assert build_index < package_index, (
        "the workflow calls the packaging script before building the front end; "
        "web/dist is gitignored, so at that moment there is nothing to package"
    )


def test_the_node_install_respects_the_lock_file() -> None:
    """`npm ci`, never `npm install`.

    `npm install` resolves afresh and writes package-lock.json, so a release
    could ship a dependency tree nobody committed -- and this project has
    already seen npm 10 strip fields out of that lock on an ordinary install.
    """
    text = _workflow_text()

    assert "npm ci" in text, "the workflow does not install the front end with `npm ci`"
    assert not re.search(r"npm\s+install\b", text), (
        "the workflow runs `npm install`, which may resolve past the committed "
        "lock file and rewrite it; a release must build what was reviewed"
    )


def test_the_package_is_built_by_the_script_this_repository_reviews() -> None:
    """One definition of the layout, not two."""
    text = _workflow_text()

    assert BUILD_SCRIPT in text, f"the workflow does not call {BUILD_SCRIPT}"
    assert "dpkg-deb --build" not in text, (
        "the workflow assembles a package itself; the layout belongs to "
        f"{BUILD_SCRIPT}, which is the copy under review"
    )


def test_both_suites_run_before_the_package_is_built() -> None:
    """A release must not be the first place a red suite is noticed."""
    text = _workflow_text()

    pytest_index = text.find(".venv/bin/pytest")
    vitest_index = text.find("vitest run")
    package_index = text.find(BUILD_INVOCATION)

    assert pytest_index >= 0, "the workflow never runs pytest"
    assert vitest_index >= 0, "the workflow never runs vitest"
    assert max(pytest_index, vitest_index) < package_index, (
        "the workflow packages before it tests; the point of gating a release "
        "on the suites is that the package is never built from a red tree"
    )


def test_the_built_package_leaves_the_runner() -> None:
    """A .deb that exists only inside a finished job was never produced.

    Uploading it as an artifact is what makes a `workflow_dispatch` run useful
    to a human, and it is the only way a non-tag build can be inspected at all.
    """
    text = _workflow_text()

    assert "actions/upload-artifact" in text, (
        "the workflow builds a package and uploads nothing; nobody can reach it"
    )


def test_a_release_is_created_only_for_a_tag() -> None:
    """Every push must not publish. The tag is the decision to release.

    The trigger and the release step are both checked, because either one alone
    is enough to get this wrong: a `push:` on branches that reached the release
    step would publish every commit.
    """
    text = _workflow_text()

    assert re.search(r"tags:\s*\n\s*-\s*['\"]?v", text), (
        "the workflow has no tag trigger; a release is cut by tagging"
    )
    assert "startsWith(github.ref, 'refs/tags/')" in text, (
        "the release step is not conditioned on the ref being a tag, so an "
        "ordinary run would publish"
    )


def test_the_tag_is_checked_against_the_changelog_version() -> None:
    """The asset's name comes from debian/changelog, not from the tag.

    `build-deb.sh` reads the version off the first line of the changelog, so a
    tag that disagrees produces a release called v26.08.002 carrying
    rhizome-graph_26.08.001_amd64.deb. Nothing downstream notices.
    """
    text = _workflow_text()

    assert "debian/changelog" in text, (
        "the workflow never reads debian/changelog, so nothing checks that the "
        "tag names the version the package will actually carry"
    )


def test_the_release_number_format_is_enforced() -> None:
    """YY.MM.NNN, or YY.MM.NNN-BB for a bugfix -- CLAUDE.md's rule 5.

    A rule that lives only in prose is a rule the next release breaks. The
    pattern is checked here as a pattern, not by matching a particular release,
    so it keeps holding when the month turns.
    """
    text = _workflow_text()

    found = re.search(r"\[0-9\]\{2\}\\?\.\[0-9\]\{2\}\\?\.\[0-9\]\{3\}", text)

    assert found, (
        "the workflow does not check the release number against the "
        "YY.MM.NNN[-BB] shape CLAUDE.md mandates"
    )


def test_nothing_outside_actions_is_trusted_with_the_checkout() -> None:
    """Supply chain: only first-party actions.

    Creating a release needs no third party -- `gh` is preinstalled on the
    runner and takes GITHUB_TOKEN -- so the usual release action buys nothing
    and adds a repository that can read the token.
    """
    text = _workflow_text()

    outsiders = [name for name in _used_actions(text) if not name.startswith("actions/")]

    assert not outsiders, (
        f"the workflow uses {outsiders!r}; the release step needs no third "
        "party, since `gh release create` is preinstalled on the runner"
    )


def test_write_permission_is_granted_where_it_is_needed_and_not_wider() -> None:
    """`contents: write` is what publishing a release costs, and the whole cost.

    Declared explicitly rather than inherited: a workflow with no `permissions`
    block takes whatever the repository's default is, which in an older
    repository is write to everything.
    """
    text = _workflow_text()

    assert re.search(r"^\s*permissions:", text, re.MULTILINE), (
        "the workflow declares no permissions block, so it runs with whatever "
        "the repository default happens to be"
    )
    assert "contents: write" in text, (
        "no job may create a release without contents: write"
    )
    for forbidden in ("packages: write", "id-token: write", "actions: write"):
        assert forbidden not in text, (
            f"the workflow grants {forbidden}, which building a .deb does not need"
        )
