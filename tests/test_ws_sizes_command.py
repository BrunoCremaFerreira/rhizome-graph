"""Contract tests (RED) for the `sizes` command on the WebSocket.

Motivation: `COMMAND_KINDS` is a closed four-tuple and `parse_command` demands a
string `path` on every frame except a `search`, which demands a string `query`.
A command that names **nothing at all** therefore has no shape here: it parses
to `None` and is dropped without an answer. The size mode (F7) is exactly that
command -- "how big is everything you are drawing?" -- and the alternatives are
worse in ways worth recording. Smuggled through the `file` kind it would make
`resolve_inside` run on a path that means nothing; pushed unasked at connect
time it would put a walk of the whole tree into every browser's first paint for
a mode almost nobody arms.

So the parser learns a fifth kind that carries no argument, and this file is
built as two jaws around that widening:

  * The **regression jaw** (section 1) re-asserts, verbatim, the exact-equality
    assertions over the parsed dict for all four existing kinds
    (`tests/test_ws_commands.py`, `tests/test_ws_control_token.py`,
    `tests/test_ws_search_command.py`). They pass today, and they are what makes
    the widening provably additive: this is a security-adjacent parser, and the
    whole token gate turns on the difference between an absent token and an
    empty one. Copied rather than imported, so none of those files moves.
  * The **widening** (sections 2 and 3): a `sizes` frame parses to three keys and
    no fourth, with `path: ""` -- the echo field both gates put into their
    refusal, exactly as a `search` does. It is the only command in this protocol
    that turns no string from the network into anything, which is the whole of
    its security story: there is no containment check to add because there is
    nothing to contain, and `resolve_inside` must not be made to look as if it
    is involved.

Three behaviours beyond the parser:

  * **The fifth kind grows no path around the two gates** (section 4). A `sizes`
    refused by the token gate never reaches `measure_sizes`, and a right token
    from a non-loopback peer is refused just the same. The zero-call assertions
    are kept honest by a positive control in the same section -- without it they
    would pass for a daemon that never measures anything at all.
  * **A `sizes` is answered from its own branch and never falls through to the
    `setRoot` tail** (section 5). That tail is why `handle_command`'s docstring
    states the rule: a `sizes` carries the empty path, which `resolve_root`
    would happily turn into somewhere. The two "nothing moved" assertions there
    pass today for the trivial reason that nothing is answered at all; they are
    the jaw that stops the implementation of the branch from moving them.
  * **An answer about an abandoned root is answered anyway** (section 6), empty
    and with the reason -- `content_search`'s rule, not `publish_status`'s.
    Status may drop a stale frame because the switch publishes a fresh one of
    its own; a dropped `sizes` reply strands the browser's `pending` flag with
    no second reply coming, and this kind has no echo field a late answer could
    be recognized by.

Expected to FAIL until `COMMAND_KINDS` holds a fifth kind, `parse_command` has
its `sizes` branch, and `handle_command` answers one.

Style: Arrange-Act-Assert, one failure reason per test.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from daemon import server
from daemon.server import Session, _handle_ws_client, parse_command


def _run(coro):
    return asyncio.run(asyncio.wait_for(coro, timeout=30))


def _sizes_wire_frame(token: object = None, **extra: object) -> str:
    """One `sizes` frame off the wire, with no token at all when it is `None`."""
    payload: dict = {"kind": "sizes"}
    payload.update(extra)
    if token is not None:
        payload["token"] = token
    return json.dumps(payload)


def _sizes_command(token: str = "") -> dict:
    """What `parse_command` is expected to hand `handle_command`."""
    return {"kind": "sizes", "path": "", "token": token}


def _measured_frame(files: list[dict], truncated: bool = False, error: str = "") -> dict:
    """The answer shape, spelled out here rather than imported.

    `rhizome_graph.sizes` is specified by `tests/test_sizes.py` and does not
    exist yet; importing it would redden this file for the wrong reason.
    """
    return {
        "kind": "sizes",
        "files": files,
        "truncated": truncated,
        "error": error,
    }


class _FakeClient:
    """Just enough of a connection: an address, a `send`, and frames to deliver.

    A copy of the helper in `tests/test_ws_commands.py`, deliberately: it mocks
    only the socket underneath the daemon, so what runs here is the real
    dispatch.
    """

    def __init__(self, *frames: str, host: str = "127.0.0.1") -> None:
        self.remote_address = (host, 54321)
        self.sent: list[str] = []
        self._inbound = list(frames)

    async def send(self, message: str) -> None:
        self.sent.append(message)

    def __aiter__(self):
        async def iterator():
            for frame in self._inbound:
                yield frame

        return iterator()

    def frames(self) -> list[dict]:
        return [json.loads(message) for message in self.sent]

    def kinds(self) -> list[str]:
        return [frame.get("kind") for frame in self.frames()]


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    (tmp_path / "a.txt").write_text("some bytes\n", encoding="utf-8")
    return tmp_path


@pytest.fixture()
def session(monkeypatch: pytest.MonkeyPatch, project: Path) -> Session:
    """A daemon with the ordinary gate: loopback only, and its own token."""
    monkeypatch.delenv("RHIZOME_ALLOW_REMOTE_CONTROL", raising=False)
    monkeypatch.delenv("RHIZOME_TOKEN", raising=False)
    return Session(str(project), str(project))


@pytest.fixture()
def remote_session(monkeypatch: pytest.MonkeyPatch, project: Path) -> Session:
    """A daemon deliberately opted out of the address check."""
    monkeypatch.delenv("RHIZOME_ALLOW_REMOTE_CONTROL", raising=False)
    monkeypatch.delenv("RHIZOME_TOKEN", raising=False)
    return Session(str(project), str(project), allow_remote=True)


def _answer(client: "_FakeClient") -> dict:
    """The one frame this client was sent: asserted to exist, then read.

    Reaching straight for `frames()[0]` turns "nothing was answered" into an
    `IndexError` several lines away from the property being specified.
    """
    frames = client.frames()
    assert len(frames) == 1, f"expected exactly one answer, got {client.sent!r}"
    return frames[0]


def _replay_kinds(session: Session) -> list[str]:
    """What a browser connecting right now would be told, kind by kind."""
    return [json.loads(message).get("kind") for message in session.hub.replay_messages()]


def _recording_measure(calls: list, files: "list[dict] | None" = None):
    """A stand-in for `measure_sizes` that records every call it receives."""

    async def spy(root, *args, **kwargs):
        calls.append(root)
        return _measured_frame(list(files or []))

    return spy


# --- 1. the regression jaw: the four existing kinds parse as they do today ---
#
# Verbatim copies. If one of these ever has to change, the change is a decision
# about the wire protocol, not a detail of adding a fifth kind.

def test_a_complete_command_is_understood():
    # The empty `token` is spelled out rather than left off: a frame carrying no
    # token parses to the empty one, and the whole gate turns on the difference
    # between that and a token that matches (see `tests/test_ws_control_token.py`).
    # Exact equality over the whole mapping is what keeps that observable here.
    assert parse_command('{"kind":"complete","path":"~/proj"}') == {
        "kind": "complete",
        "path": "~/proj",
        "token": "",
    }


def test_a_set_root_command_is_understood():
    assert parse_command('{"kind":"setRoot","path":"/srv/other"}') == {
        "kind": "setRoot",
        "path": "/srv/other",
        "token": "",
    }


def test_a_file_command_is_understood():
    assert parse_command('{"kind":"file","path":"src/app.ts"}') == {
        "kind": "file",
        "path": "src/app.ts",
        "token": "",
    }


def test_a_search_command_is_understood():
    # `path: ""` is deliberate and load-bearing rather than filler: both gates
    # echo `command["path"]` into their refusal, so the key has to be there, and
    # a search has no path to put in it.
    assert parse_command('{"kind":"search","query":"needle"}') == {
        "kind": "search",
        "path": "",
        "query": "needle",
        "token": "",
    }


def test_the_token_is_carried_through_to_the_command():
    assert parse_command('{"kind":"file","path":"a.txt","token":"s3cret"}') == {
        "kind": "file",
        "path": "a.txt",
        "token": "s3cret",
    }


def test_a_frame_with_no_token_yields_an_empty_one():
    # Parsed, not refused: the frame is well-formed and the refusal belongs to
    # the gate, which owes the browser a reason it can show.
    assert parse_command('{"kind":"file","path":"a.txt"}') == {
        "kind": "file",
        "path": "a.txt",
        "token": "",
    }


def test_a_search_command_carries_its_token_like_every_other_kind():
    assert parse_command('{"kind":"search","query":"needle","token":"s3cret"}') == {
        "kind": "search",
        "path": "",
        "query": "needle",
        "token": "s3cret",
    }


def test_a_file_command_may_prefer_text():
    # Exact equality, like every other assertion about this mapping: the key is
    # here because the frame carried a value this daemon understands.
    assert parse_command('{"kind":"file","path":"a.txt","prefer":"text"}') == {
        "kind": "file",
        "path": "a.txt",
        "prefer": "text",
        "token": "",
    }


def test_an_unknown_kind_is_still_not_a_command():
    # The tuple widens by exactly one name; a client from another version is
    # still not an instruction.
    assert parse_command('{"kind":"shutdown","path":"/"}') is None


# --- 2. the widening: a command may name nothing at all ---------------------

def test_a_sizes_command_is_understood():
    # Three keys and no fourth. `path: ""` because both gates echo it in their
    # refusal, and this kind has nothing to put there -- it is the only command
    # in this protocol that turns no string from the network into anything.
    assert parse_command('{"kind":"sizes"}') == {
        "kind": "sizes",
        "path": "",
        "token": "",
    }


def test_a_sizes_command_carries_its_token_like_every_other_kind():
    assert parse_command('{"kind":"sizes","token":"s3cret"}') == {
        "kind": "sizes",
        "path": "",
        "token": "s3cret",
    }


# --- 3. the kind names nothing, so a field it does not use is not fatal -----

def test_a_sizes_command_ignores_a_path_it_would_never_use():
    # Not refused: the branch returns before the path check, because there is no
    # path here to be wrong. Refusing would make a stray key from an older page
    # cost the user the whole mode.
    assert parse_command('{"kind":"sizes","path":42}') == {
        "kind": "sizes",
        "path": "",
        "token": "",
    }


def test_a_sizes_command_ignores_a_query_it_would_never_use():
    # The other direction of the same rule: a fourth key appears only when this
    # daemon understands it *for that kind*, and this kind understands none.
    assert parse_command('{"kind":"sizes","query":"x"}') == {
        "kind": "sizes",
        "path": "",
        "token": "",
    }


def test_a_sizes_command_still_collapses_a_hostile_token_to_the_empty_one():
    # The token rule is the parser's, not the kind's: whatever is not a string
    # becomes the empty token, which `token_matches` always refuses.
    command = parse_command('{"kind":"sizes","token":42}')

    assert command is not None and command["token"] == ""


# --- 4. the fifth kind grows no path around the two gates -------------------

def test_a_sizes_with_no_token_is_refused_with_a_reason(session: Session):
    # Silence reads as a hung page, and the page is holding a `pending` flag
    # that only an answer -- or a second F7 -- can clear.
    client = _FakeClient(_sizes_wire_frame())

    _run(_handle_ws_client(session.hub, session, client))

    assert client.kinds() == ["rootError"]


def test_a_sizes_refused_by_the_token_gate_never_walks_the_tree(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # Walking and stat-ing the whole observed tree is both expensive and
    # revealing: the answer names every file under the root.
    calls: list = []
    monkeypatch.setattr(server, "measure_sizes", _recording_measure(calls), raising=False)
    client = _FakeClient(_sizes_wire_frame("guessed-it"))

    _run(_handle_ws_client(session.hub, session, client))

    assert calls == []


def test_the_right_token_does_not_let_a_remote_peer_ask_for_sizes(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # A proxy cannot forward the token, but a colleague reading it off a shared
    # screen can paste it. Loopback-only still holds for this kind too.
    calls: list = []
    monkeypatch.setattr(server, "measure_sizes", _recording_measure(calls), raising=False)
    client = _FakeClient(_sizes_wire_frame(session.token), host="192.168.1.50")

    _run(_handle_ws_client(session.hub, session, client))

    assert calls == []
    assert "sizes" not in client.kinds()


def test_a_wrong_token_is_refused_even_with_remote_control_opened_up(
    remote_session: Session, monkeypatch: pytest.MonkeyPatch
):
    # Opting out of the address check is not opting out of authentication.
    calls: list = []
    monkeypatch.setattr(server, "measure_sizes", _recording_measure(calls), raising=False)
    client = _FakeClient(_sizes_wire_frame("guessed-it"), host="192.168.1.50")

    _run(_handle_ws_client(remote_session.hub, remote_session, client))

    assert calls == []
    assert "sizes" not in client.kinds()


def test_a_loopback_sizes_carrying_the_token_reaches_the_measurement(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # The positive control for the three zero-call assertions above: without it
    # they would pass for a daemon that never measures anything at all, and a
    # spy nobody reaches records nothing whatever the gate does.
    calls: list = []
    monkeypatch.setattr(server, "measure_sizes", _recording_measure(calls), raising=False)
    client = _FakeClient(_sizes_wire_frame(session.token))

    _run(_handle_ws_client(session.hub, session, client))

    assert calls == [session.root]


# --- 5. answered from its own branch, never through the setRoot tail --------

def test_a_sizes_is_answered_with_the_measurement(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(
        server,
        "measure_sizes",
        _recording_measure([], files=[{"path": "a.txt", "bytes": 11}]),
        raising=False,
    )
    client = _FakeClient()

    _run(session.handle_command(_sizes_command(), client))

    assert _answer(client) == _measured_frame([{"path": "a.txt", "bytes": 11}])


def test_a_sizes_does_not_repoint_the_daemon(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # The jaw, and the reason `handle_command`'s docstring states the rule: a
    # `sizes` carries the empty path, which `resolve_root` would happily turn
    # into somewhere. It passes today only because nothing is answered at all.
    monkeypatch.setattr(server, "measure_sizes", _recording_measure([]), raising=False)
    root_before = session.root
    client = _FakeClient()

    _run(session.handle_command(_sizes_command(), client))

    assert session.root == root_before


def test_a_sizes_never_tells_the_browsers_to_clear_their_graph(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # The other half of the same jaw, observed where a client would see it: a
    # `reset` in the replay wipes the graph of every browser that connects next.
    monkeypatch.setattr(server, "measure_sizes", _recording_measure([]), raising=False)
    client = _FakeClient()

    _run(session.handle_command(_sizes_command(), client))

    assert "reset" not in _replay_kinds(session)


# --- 6. an abandoned root is answered anyway, and this is not `publish_status`

def _measure_switching_root(session: Session, new_root: str, files: list[dict]):
    """A `measure_sizes` that answers about a root the session has left."""

    async def fake(root, *args, **kwargs):
        session.root = new_root
        return _measured_frame(list(files))

    return fake


def test_a_measurement_of_a_root_that_is_no_longer_observed_names_no_files(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # This kind has no echo field, so a late answer cannot be recognized as late
    # by its content: the daemon's own root re-read is what makes an adopted
    # frame necessarily one about the project on screen.
    monkeypatch.setattr(
        server,
        "measure_sizes",
        _measure_switching_root(session, "/elsewhere", [{"path": "gone.txt", "bytes": 9}]),
        raising=False,
    )
    client = _FakeClient()

    _run(session.handle_command(_sizes_command(), client))

    assert _answer(client)["files"] == []


def test_a_measurement_of_an_abandoned_root_is_still_answered(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # The difference from `publish_status`, and the reason it is a difference:
    # status may drop a stale answer because the switch publishes a fresh frame
    # of its own, while a dropped reply leaves the browser's `pending` flag set
    # forever with no second reply coming -- and a mode that can never be
    # re-entered is a mode that has wedged.
    monkeypatch.setattr(
        server,
        "measure_sizes",
        _measure_switching_root(session, "/elsewhere", [{"path": "gone.txt", "bytes": 9}]),
        raising=False,
    )
    client = _FakeClient()

    _run(session.handle_command(_sizes_command(), client))

    assert client.kinds() == ["sizes"]


def test_the_abandoned_root_answer_says_why_it_is_empty(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # An empty answer with no reason reads as "this project has no files",
    # which is a wrong answer rather than a missing one.
    monkeypatch.setattr(
        server,
        "measure_sizes",
        _measure_switching_root(session, "/elsewhere", [{"path": "gone.txt", "bytes": 9}]),
        raising=False,
    )
    client = _FakeClient()

    _run(session.handle_command(_sizes_command(), client))

    assert "changed" in _answer(client)["error"].lower()


def test_a_measurement_of_the_root_still_observed_keeps_its_files(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # The guard must cost the ordinary measurement nothing: the root has not
    # moved, so the answer is about the project on screen.
    monkeypatch.setattr(
        server,
        "measure_sizes",
        _recording_measure([], files=[{"path": "a.txt", "bytes": 11}]),
        raising=False,
    )
    client = _FakeClient()

    _run(session.handle_command(_sizes_command(), client))

    assert _answer(client)["files"] == [{"path": "a.txt", "bytes": 11}]


# --- 7. the answer goes to the client that asked, and to nobody else --------

def test_the_measurement_reaches_the_client_that_asked_for_it(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(
        server,
        "measure_sizes",
        _recording_measure([], files=[{"path": "a.txt", "bytes": 11}]),
        raising=False,
    )
    asker = _FakeClient()

    _run(session.handle_command(_sizes_command(), asker))

    assert asker.kinds() == ["sizes"]


def test_no_other_viewer_is_sent_the_measurement(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    """`_send`, not the hub: one browser's F7 must not recolour another's graph.

    The mode is per-viewer state, and a second client that never armed it would
    be handed a frame it has no reason to hold -- one file entry per node of the
    tree, at that.
    """
    monkeypatch.setattr(
        server,
        "measure_sizes",
        _recording_measure([], files=[{"path": "a.txt", "bytes": 11}]),
        raising=False,
    )
    asker = _FakeClient()
    onlooker = _FakeClient()

    async def scenario() -> list[str]:
        await session.hub.register(onlooker)
        delivered = len(onlooker.sent)
        await session.handle_command(_sizes_command(), asker)
        return onlooker.sent[delivered:]

    afterwards = _run(scenario())

    assert afterwards == []
