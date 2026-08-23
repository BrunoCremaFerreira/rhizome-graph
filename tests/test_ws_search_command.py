"""Contract tests (RED) for the `search` command on the WebSocket.

Motivation: `parse_command` demands a string `path` on **every** frame and
`COMMAND_KINDS` is a closed three-tuple, so there is no shape at all for a
command whose payload is text that is not a path. The content search has exactly
that shape -- a query -- and the tempting shortcut, shipping it in `path`, is a
lie that both gates in `_handle_ws_client` and everyone who ever reads them has
to un-learn: those two echo `command["path"]` back in their refusal, so a query
smuggled through it would be quoted at the user as the path that was refused.

So the parser learns a fourth kind and one conditional key, and this file is
built as two jaws around that widening:

  * The **regression jaw** (section 1) re-asserts, verbatim, the five existing
    exact-equality assertions over the parsed dict (`tests/test_ws_commands.py`
    and `tests/test_ws_control_token.py`). They pass today. An unconditional
    `query` key -- the obvious implementation -- breaks all five for no
    behavioural reason, and one of them says in its own comment why the
    exactness is deliberate: the whole token gate turns on the difference
    between an absent token and an empty one. Copied rather than imported, so
    neither of those files moves.
  * The **widening** (sections 2 and 3): a `search` frame parses, with
    `path: ""` so the gates keep their echo field and stay literally unchanged,
    and `query` present only because this frame carried one this daemon
    understands.

Two behaviours beyond the parser:

  * **The fourth kind grows no path around the gates** (section 4). A `search`
    refused by the token gate is answered with a reason and never reaches
    `content_search` at all -- reading every file under the root is the most
    expensive thing this daemon does and the most revealing thing it says. The
    zero-call assertions are kept honest by a positive control in the same
    section: the same spy, allowed through, is called exactly once.
  * **An abandoned root is answered anyway** (section 5), and that is where this
    differs from `publish_status`, deliberately. Status *drops* a stale answer
    because the switch has already published a fresh frame; a search has no such
    second publisher, so a dropped reply leaves the browser's `pending` flag set
    forever with nothing coming to clear it. The honest version is an empty
    frame carrying the reason.

Style: Arrange-Act-Assert, one failure reason per test.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from daemon import server
from daemon.server import Session, _handle_ws_client, parse_command
from rhizome_graph.content_search import FileMatches, search_frame


def _run(coro):
    return asyncio.run(asyncio.wait_for(coro, timeout=30))


def _search_frame(query: object, token: object = None) -> str:
    """One `search` frame off the wire, with no token at all when it is `None`."""
    payload: dict = {"kind": "search", "query": query}
    if token is not None:
        payload["token"] = token
    return json.dumps(payload)


def _search_command(query: str, token: str = "") -> dict:
    """What `parse_command` is expected to hand `handle_command`."""
    return {"kind": "search", "path": "", "query": query, "token": token}


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
    (tmp_path / "a.txt").write_text("needle in here\n", encoding="utf-8")
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


def _recording_search(calls: list, files=(), truncated: bool = False):
    """A stand-in for `content_search` that records every call it receives."""

    async def spy(root, query, *args, **kwargs):
        calls.append((root, query))
        return search_frame(query, list(files), truncated, "")

    return spy


# --- 1. the regression jaw: the three existing kinds parse as they do today --
#
# Verbatim copies. If one of these ever has to change, the change is a decision
# about the wire protocol, not a detail of adding a fourth kind.

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


def test_a_query_on_a_file_command_is_not_carried_into_the_parsed_dict():
    # The other direction of the same rule: a fourth key appears only when this
    # daemon understands it *for that kind*. A `file` frame that happens to carry
    # a query is a `file` frame, and widening its dict would break the five
    # assertions above from the far side.
    assert parse_command('{"kind":"file","path":"a.txt","query":"needle"}') == {
        "kind": "file",
        "path": "a.txt",
        "token": "",
    }


# --- 2. the widening: a frame may carry a query ----------------------------

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


def test_a_search_command_carries_its_token_like_every_other_kind():
    assert parse_command('{"kind":"search","query":"needle","token":"s3cret"}') == {
        "kind": "search",
        "path": "",
        "query": "needle",
        "token": "s3cret",
    }


def test_the_query_is_handed_on_exactly_as_typed():
    # No trimming and no folding here: `content_search` owns the ASCII fold, and
    # the answer echoes this text so the panel can tell whether it still matches
    # what the box contains.
    command = parse_command('{"kind":"search","query":"  Needle  "}')

    assert command is not None and command["query"] == "  Needle  "


def test_an_empty_query_is_still_a_command():
    # Refusing it here would be the parser deciding a policy that belongs to
    # `search_tree`, which answers no files for an empty query. The page must get
    # a reply either way, or its `pending` flag never clears.
    assert parse_command('{"kind":"search","query":""}') == {
        "kind": "search",
        "path": "",
        "query": "",
        "token": "",
    }


# --- 3. the required field is per kind -------------------------------------

def test_a_search_command_without_a_query_is_not_a_command():
    assert parse_command('{"kind":"search"}') is None


def test_a_search_command_whose_query_is_not_a_string_is_not_a_command():
    # It reaches `str.translate` and a `bytes` encode; a number arriving there
    # would raise inside the task serving that browser.
    assert parse_command('{"kind":"search","query":42}') is None


def test_a_search_command_still_collapses_a_hostile_token_to_the_empty_one():
    # The token rule is the parser's, not the kind's: whatever is not a string
    # becomes the empty token, which `token_matches` always refuses.
    command = parse_command('{"kind":"search","query":"x","token":42}')

    assert command is not None and command["token"] == ""


def test_a_search_command_does_not_need_a_path():
    # The old rule -- a string `path` on every frame -- is what has to give way.
    # A search that had to name a path would be a search of one file.
    assert parse_command('{"kind":"search","query":"needle"}') is not None


# --- 4. the fourth kind grows no path around the two gates ------------------

def test_a_search_with_no_token_is_refused_with_a_reason(session: Session):
    # Silence reads as a hung page, and the page is holding a `pending` flag.
    client = _FakeClient(_search_frame("needle"))

    _run(_handle_ws_client(session.hub, session, client))

    assert client.kinds() == ["rootError"]
    assert "searchResult" not in client.kinds()


def test_a_search_refused_by_the_token_gate_never_reads_a_single_file(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # The gate is what stands between an open port and a grep of the whole
    # project, which is both the most expensive thing this daemon does and the
    # most revealing thing it says.
    calls: list = []
    monkeypatch.setattr(server, "content_search", _recording_search(calls), raising=False)
    client = _FakeClient(_search_frame("needle", "guessed-it"))

    _run(_handle_ws_client(session.hub, session, client))

    assert calls == []


def test_the_right_token_does_not_let_a_remote_peer_search(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # A proxy cannot forward the token, but a colleague reading it off a shared
    # screen can paste it. Loopback-only still holds for this kind too.
    calls: list = []
    monkeypatch.setattr(server, "content_search", _recording_search(calls), raising=False)
    client = _FakeClient(_search_frame("needle", session.token), host="192.168.1.50")

    _run(_handle_ws_client(session.hub, session, client))

    assert calls == []
    assert "searchResult" not in client.kinds()


def test_a_wrong_token_is_refused_even_with_remote_control_opened_up(
    remote_session: Session, monkeypatch: pytest.MonkeyPatch
):
    # Opting out of the address check is not opting out of authentication.
    calls: list = []
    monkeypatch.setattr(server, "content_search", _recording_search(calls), raising=False)
    client = _FakeClient(_search_frame("needle", "guessed-it"), host="192.168.1.50")

    _run(_handle_ws_client(remote_session.hub, remote_session, client))

    assert calls == []
    assert "searchResult" not in client.kinds()


def test_a_loopback_search_carrying_the_token_reaches_the_search(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # The positive control for the three zero-call assertions above: without it
    # they would pass for a daemon that never calls `content_search` at all, and
    # a spy nobody reaches records nothing whatever the gate does.
    calls: list = []
    monkeypatch.setattr(server, "content_search", _recording_search(calls), raising=False)
    client = _FakeClient(_search_frame("needle", session.token))

    _run(_handle_ws_client(session.hub, session, client))

    assert calls == [(session.root, "needle")]


def test_the_allowed_search_is_answered_with_its_result(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(
        server,
        "content_search",
        _recording_search([], files=[FileMatches("a.txt", 2)]),
        raising=False,
    )
    client = _FakeClient(_search_frame("needle", session.token))

    _run(_handle_ws_client(session.hub, session, client))

    assert "searchResult" in client.kinds()


# --- 5. an abandoned root is answered anyway, and this is not `publish_status`

def _search_switching_root(session: Session, new_root: str, files):
    """A `content_search` that answers about a root the session has left."""

    async def fake(root, query, *args, **kwargs):
        session.root = new_root
        return search_frame(query, list(files), False, "")

    return fake


def test_a_search_of_a_root_that_is_no_longer_observed_names_no_files(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # Those rows are not merely stale, they are clickable, and `resolve_inside`
    # refuses every one of them under the new root: the panel would be offering
    # files the very next click errors on.
    monkeypatch.setattr(
        server,
        "content_search",
        _search_switching_root(session, "/elsewhere", [FileMatches("gone.txt", 3)]),
        raising=False,
    )
    client = _FakeClient()

    _run(session.handle_command(_search_command("needle"), client))

    assert _answer(client)["files"] == []


def test_a_search_of_an_abandoned_root_is_still_answered(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # The difference from `publish_status`, and the reason it is a difference:
    # status may drop a stale answer because the switch publishes a fresh frame
    # of its own, while a dropped search reply leaves the browser's `pending`
    # flag set forever with no second reply coming.
    monkeypatch.setattr(
        server,
        "content_search",
        _search_switching_root(session, "/elsewhere", [FileMatches("gone.txt", 3)]),
        raising=False,
    )
    client = _FakeClient()

    _run(session.handle_command(_search_command("needle"), client))

    assert client.kinds() == ["searchResult"]


def test_the_abandoned_root_answer_says_why_it_is_empty(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # An empty answer with no reason reads as "this project does not contain it",
    # which is a wrong answer rather than a missing one.
    monkeypatch.setattr(
        server,
        "content_search",
        _search_switching_root(session, "/elsewhere", [FileMatches("gone.txt", 3)]),
        raising=False,
    )
    client = _FakeClient()

    _run(session.handle_command(_search_command("needle"), client))

    assert "changed" in _answer(client)["error"].lower()


def test_the_abandoned_root_answer_still_echoes_the_query(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # The page matches the reply against the query still in its box; an answer it
    # cannot recognize is an answer it will not apply.
    monkeypatch.setattr(
        server,
        "content_search",
        _search_switching_root(session, "/elsewhere", [FileMatches("gone.txt", 3)]),
        raising=False,
    )
    client = _FakeClient()

    _run(session.handle_command(_search_command("needle"), client))

    assert _answer(client)["query"] == "needle"


def test_a_search_of_the_root_still_observed_keeps_its_files(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # The guard must cost the ordinary search nothing: the root has not moved, so
    # the answer is about the project on screen.
    monkeypatch.setattr(
        server,
        "content_search",
        _recording_search([], files=[FileMatches("a.txt", 2)]),
        raising=False,
    )
    client = _FakeClient()

    _run(session.handle_command(_search_command("needle"), client))

    assert _answer(client)["files"] == [{"path": "a.txt", "count": 2}]


def test_a_search_does_not_repoint_the_daemon(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # The dispatch used to read "`complete`, else treat it as a `setRoot`". A
    # fourth kind falling through that would swap the observed project for a
    # refusal about a path that is not a directory -- and a search carries the
    # empty path, which resolves to somewhere.
    root_before = session.root
    monkeypatch.setattr(server, "content_search", _recording_search([]), raising=False)
    client = _FakeClient()

    _run(session.handle_command(_search_command("needle"), client))

    assert session.root == root_before


# --- 6. the answer goes to the client that asked, and to nobody else --------

def test_a_search_command_is_answered_to_the_client_that_asked(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # Never broadcast: one viewer searching must not throw a result list over
    # everybody else's screen. Same technique as the `file` command's test.
    monkeypatch.setattr(
        server,
        "content_search",
        _recording_search([], files=[FileMatches("a.txt", 2)]),
        raising=False,
    )
    client = _FakeClient()

    _run(session.handle_command(_search_command("needle"), client))

    assert client.kinds() == ["searchResult"]


def test_another_viewer_of_the_same_daemon_is_told_nothing(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # The half the single-client assertion cannot see: `_send`, not the hub.
    monkeypatch.setattr(
        server,
        "content_search",
        _recording_search([], files=[FileMatches("a.txt", 2)]),
        raising=False,
    )
    asker = _FakeClient()
    bystander = _FakeClient()

    async def scenario():
        await session.hub.register(bystander)
        await session.handle_command(_search_command("needle"), asker)

    _run(scenario())

    assert "searchResult" not in bystander.kinds()


# --- 7. the `file` command grows one conditional key: prefer ---------------
#
# `file_view` returns a diff whenever `git diff HEAD --` is non-empty, which is
# three lines of context around one edit. That is the right answer for the click
# the status panel makes and the wrong one for a content match at line 220 of a
# dirty file: the panel would open a document that does not contain the line the
# counter is counting. So the caller says which question it is asking, and it
# says it on the existing `file` command rather than on a fourth read route --
# a second one would be a second place a path from the network becomes an open
# file descriptor.
#
# Only the exact string "text" has an effect. Absent, junk, non-string: all mean
# today's diff-first chain, because the worst case of that reading is a diff
# where text was wanted, and the worst case of the other is a read route reached
# by accident.
#
# The key is conditional for the reason `query` is: the five assertions in
# section 1 are exact equality over the whole mapping, and an unconditional
# `prefer` would break every one of them for no behavioural reason.

def _file_command(path: str, prefer: object = None, token: str = "") -> dict:
    """What `parse_command` is expected to hand `handle_command` for a click."""
    command = {"kind": "file", "path": path, "token": token}
    if prefer is not None:
        command["prefer"] = prefer
    return command


def _recording_file_view(calls: list):
    """A stand-in for `file_view` that records how it was called.

    Tolerant of a positional `allow_diff` on purpose: what is being specified is
    the value that reaches the module, not the spelling of the call.
    """

    async def spy(root, path, *args, **kwargs):
        calls.append({"root": root, "path": path, "args": args, "kwargs": kwargs})
        return {"kind": "fileView", "path": path, "mode": "text", "content": ""}

    return spy


def _allow_diff_of(call: dict) -> bool:
    """The `allow_diff` that reached `file_view`, keyword or positional."""
    if "allow_diff" in call["kwargs"]:
        return call["kwargs"]["allow_diff"]
    if len(call["args"]) > 1:
        return call["args"][1]
    return True


def test_a_file_command_may_prefer_text():
    # Exact equality, like every other assertion about this mapping: the key is
    # here because the frame carried a value this daemon understands.
    assert parse_command('{"kind":"file","path":"a.txt","prefer":"text"}') == {
        "kind": "file",
        "path": "a.txt",
        "prefer": "text",
        "token": "",
    }


def test_a_file_command_preferring_a_diff_carries_no_prefer_key():
    # "diff" is not a value this daemon understands -- the diff-first chain is
    # what happens when nothing was asked for -- so the key does not appear.
    assert parse_command('{"kind":"file","path":"a.txt","prefer":"diff"}') == {
        "kind": "file",
        "path": "a.txt",
        "token": "",
    }


def test_a_non_string_prefer_is_dropped_rather_than_refusing_the_command():
    # Refusing would leave the panel with no answer at all over a frame that
    # names a perfectly good path. Fail-safe means falling back, not failing.
    assert parse_command('{"kind":"file","path":"a.txt","prefer":42}') == {
        "kind": "file",
        "path": "a.txt",
        "token": "",
    }


def test_an_unknown_prefer_string_is_dropped_too():
    # Only the exact string has an effect; nothing here is a prefix match or a
    # case fold.
    assert parse_command('{"kind":"file","path":"a.txt","prefer":"TEXT"}') == {
        "kind": "file",
        "path": "a.txt",
        "token": "",
    }


def test_a_prefer_on_another_kind_is_not_carried_into_the_parsed_dict():
    # The key belongs to `file`, the way `query` belongs to `search`. A
    # completion has nothing to prefer.
    assert parse_command('{"kind":"complete","path":"~/proj","prefer":"text"}') == {
        "kind": "complete",
        "path": "~/proj",
        "token": "",
    }


def test_a_file_command_preferring_text_reaches_file_view_with_the_diff_off(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    calls: list = []
    monkeypatch.setattr(server, "file_view", _recording_file_view(calls))
    client = _FakeClient()

    _run(session.handle_command(_file_command("a.txt", prefer="text"), client))

    assert len(calls) == 1 and _allow_diff_of(calls[0]) is False


def test_an_ordinary_file_command_reaches_file_view_with_the_diff_on(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # The status-panel click, unchanged: no `prefer` key, so the diff-first
    # chain, which is what keeps a deleted row openable.
    calls: list = []
    monkeypatch.setattr(server, "file_view", _recording_file_view(calls))
    client = _FakeClient()

    _run(session.handle_command(_file_command("a.txt"), client))

    assert len(calls) == 1 and _allow_diff_of(calls[0]) is True


def test_a_file_command_preferring_a_diff_reaches_file_view_with_the_diff_on(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # The parser dropped the key, so this arrives indistinguishable from a plain
    # click -- pinned here because "prefer" is the word a future caller will
    # reach for when it means "diff", and it must land on the safe side.
    calls: list = []
    monkeypatch.setattr(server, "file_view", _recording_file_view(calls))
    client = _FakeClient()

    _run(session.handle_command(_file_command("a.txt", prefer="diff"), client))

    assert len(calls) == 1 and _allow_diff_of(calls[0]) is True


def test_the_preferred_text_answer_still_goes_only_to_the_client_that_asked(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # The new key changes what is read, never who is told.
    monkeypatch.setattr(server, "file_view", _recording_file_view([]))
    asker = _FakeClient()
    bystander = _FakeClient()

    async def scenario():
        await session.hub.register(bystander)
        await session.handle_command(_file_command("a.txt", prefer="text"), asker)

    _run(scenario())

    assert asker.kinds() == ["fileView"] and bystander.kinds() == []


def test_a_file_command_preferring_text_is_still_refused_without_a_token(
    session: Session, monkeypatch: pytest.MonkeyPatch
):
    # The gate is per frame, not per kind of read. A new key must not become a
    # new way in.
    calls: list = []
    monkeypatch.setattr(server, "file_view", _recording_file_view(calls))
    frame = json.dumps({"kind": "file", "path": "a.txt", "prefer": "text"})
    client = _FakeClient(frame)

    _run(_handle_ws_client(session.hub, session, client))

    assert calls == []
