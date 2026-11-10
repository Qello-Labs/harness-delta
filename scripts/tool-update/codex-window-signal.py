#!/usr/bin/env python3
from dataclasses import asdict, dataclass
import json
import os
import signal
import subprocess
import sys
from typing import Final

ENV: Final[dict[str, str]] = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "TZ": "UTC"}


class OwnershipError(Exception):
    pass


@dataclass(frozen=True)
class Identity:
    pid: int
    parent: int
    pgid: int
    foreground: int
    uid: int
    session: int
    started: str


def metadata(pid: int) -> Identity:
    text = subprocess.check_output(
        ["/bin/ps", "-o", "pid=,ppid=,pgid=,tpgid=,uid=,lstart=", "-p", str(pid)],
        env=ENV, timeout=0.5, stderr=subprocess.DEVNULL,
    ).decode().strip().split(None, 5)
    if len(text) != 6:
        raise OwnershipError()
    return Identity(
        pid=int(text[0]), parent=int(text[1]), pgid=int(text[2]),
        foreground=int(text[3]), uid=int(text[4]),
        session=os.getsid(pid), started=text[5],
    )


def members(group: int) -> set[int]:
    query = subprocess.run(
        ["/usr/bin/pgrep", "-g", str(group)], env=ENV, timeout=0.5,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
    )
    if query.returncode != 0 or len(query.stdout) > 1024:
        raise OwnershipError()
    return {int(value) for value in query.stdout.split()}


def owned(identity: Identity) -> bool:
    return (
        identity.pid > 1 and identity.parent > 1 and identity.uid == os.getuid()
        and identity.pgid == identity.pid and identity.session == identity.pid
        and identity.foreground == identity.pgid
    )


def inspect(pid: int, parent: int) -> Identity:
    record = metadata(pid)
    if not owned(record) or record.parent != parent or members(record.pgid) != {record.pid}:
        raise OwnershipError()
    if metadata(record.pid) != record:
        raise OwnershipError()
    return record


def parse_launch(raw: bytes) -> Identity:
    data = json.loads(raw)
    if set(data) != {"pid", "parent"} or any(type(value) is not int for value in data.values()):
        raise OwnershipError()
    return inspect(int(data["pid"]), int(data["parent"]))


def parse_signal(raw: bytes) -> Identity:
    data = json.loads(raw)
    if set(data) != set(Identity.__dataclass_fields__):
        raise OwnershipError()
    for key, value in data.items():
        if key != "started" and type(value) is not int:
            raise OwnershipError()
    if not isinstance(data["started"], str) or len(data["started"]) > 128:
        raise OwnershipError()
    expected = Identity(
        pid=int(data["pid"]), parent=int(data["parent"]),
        pgid=int(data["pgid"]), foreground=int(data["foreground"]),
        uid=int(data["uid"]), session=int(data["session"]),
        started=str(data["started"]),
    )
    if not owned(expected):
        raise OwnershipError()
    current = inspect(expected.pid, expected.parent)
    if current != expected or members(current.pgid) != {current.pid} or metadata(current.pid) != expected:
        raise OwnershipError()
    os.killpg(current.pgid, signal.SIGINT)
    return current


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(4097)
        if len(raw) > 4096 or len(sys.argv) != 2:
            raise OwnershipError()
        action = {"inspect": parse_launch, "signal": parse_signal}[sys.argv[1]]
        identity = action(raw)
        print(json.dumps({"identity": asdict(identity), "signal_sent": sys.argv[1] == "signal"}))
        return 0
    except (OwnershipError, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print(json.dumps({"code": "signal_identity_unproven", "signal_sent": False}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
