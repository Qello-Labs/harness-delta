#!/usr/bin/env python3
"""One private PTY/process owner. fd3 EOF survives a lost Node observer.
Only fresh descendants' PID/UID/start/group metadata is sampled; no args/content.
No claim about unknowable escaped processes or backend cancellation is made.
"""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

cfg = json.loads(sys.argv[1])
started = time.monotonic()
deadline = started + cfg['durationMs'] / 1000
uid = os.getuid()
ps_env = dict(os.environ, LC_ALL='C', TZ='UTC')
known = {}
absent = set()
proofs = {}
groups = set()
ownership_failed = False
cleanup_until = None
cleanup_exhausted = False
escape_seen = False
group_changes = []
group_changes_truncated = False
# An observer that stops draining output must not block the independent deadline.
os.set_blocking(1, False)

def emit(value):
    sys.stderr.write(json.dumps(value) + '\n')
    sys.stderr.flush()

def metadata(pid):
    global cleanup_exhausted, ownership_failed
    try:
        timeout = .2 if cleanup_until is None else min(.2, cleanup_until - time.monotonic())
        if timeout <= 0:
            cleanup_exhausted = True
            return None
        text = subprocess.check_output(['ps', '-o', 'pid=,ppid=,pgid=,uid=,lstart=', '-p', str(pid)], env=ps_env, timeout=timeout, stderr=subprocess.DEVNULL).decode().strip().split(None, 4)
        if len(text) != 5:
            ownership_failed = True
            if cleanup_until is not None:
                cleanup_exhausted = True
            return None
        return (int(text[0]), int(text[1]), int(text[2]), int(text[3]), text[4])
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        # ps exit 1 means the exact PID is absent; timeout/query failure does not.
        if isinstance(error, subprocess.CalledProcessError) and error.returncode == 1:
            if pid in known:
                absent.add(pid)
        else:
            ownership_failed = True
            if cleanup_until is not None:
                cleanup_exhausted = True
        return None

def identity_matches(record, current):
    return current is not None and current[0] == record[0] and current[3:] == record[3:]

def same(record):
    global ownership_failed
    if record[0] in absent:
        return False  # A positively absent identity cannot return; PID reuse is foreign.
    current = metadata(record[0])
    if current is not None and not identity_matches(record, current):
        ownership_failed = True
    return identity_matches(record, current)

def note_group_change(previous, current):
    global group_changes_truncated, escape_seen
    groups.add(current[2])
    escape_seen = escape_seen or current[2] != pid
    if previous is not None and previous[2] == current[2]:
        return
    if previous is None and current[2] == pid:
        return
    if len(group_changes) >= 16:
        group_changes_truncated = True
        return
    # Only metadata already sampled for owned members; no extra query or content.
    parent = proofs.get(current[0])
    group_changes.append({'pid': current[0], 'ppid': current[1], 'uid': current[3],
                          'startedAt': current[4],
                          'fromPgid': previous[2] if previous else None,
                          'toPgid': current[2], 'parentPid': parent[0] if parent else None,
                          'parentUid': parent[3] if parent else None,
                          'parentStartedAt': parent[4] if parent else None,
                          'sampleOffsetMs': int((time.monotonic() - started) * 1000)})

def discover():
    global escape_seen, ownership_failed
    pending = list(known.values())
    for record in pending:
        if record[0] in absent:
            continue
        # PGID/PPID may change while PID/UID/start remain the same owned member.
        # Refresh mutable groups instead of treating a known escape as exit.
        if cleanup_until is None:
            current = metadata(record[0])
            if current is None:
                continue
            if not identity_matches(record, current):
                ownership_failed = True
                return False
            note_group_change(record, current)
            known[record[0]] = current
            escape_seen = escape_seen or current[2] != pid
        try:
            timeout = .2 if cleanup_until is None else min(.2, cleanup_until - time.monotonic())
            if timeout <= 0:
                return False
            query = subprocess.run(['pgrep', '-P', str(record[0])], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, check=False)
            if query.returncode not in (0, 1):
                return False
            children = query.stdout.split()
        except (OSError, subprocess.SubprocessError):
            return False
        if cleanup_until is not None:
            # No admission or signal follows a no-children result. Do not resample
            # leaf identities here; signal authorization will freshly check them.
            if not children:
                continue
            current = metadata(record[0])
            if not identity_matches(record, current):
                ownership_failed = True
                return False
            note_group_change(record, current)
            known[record[0]] = current
            escape_seen = escape_seen or current[2] != pid
        for child in children:
            # The pending pass refreshes known identities. setdefault never replaced
            # them, so rereading them here provided no additional discovery evidence.
            if int(child) in known:
                if int(child) in absent:
                    ownership_failed = True
                    return False
                continue
            fresh = metadata(int(child))
            if fresh is None:
                continue  # Exact child absence grants no new identity.
            parent = metadata(record[0])
            if not identity_matches(record, parent) or fresh[1] != record[0] or fresh[3] != uid:
                ownership_failed = True
                return False
            proofs[fresh[0]] = parent
            note_group_change(None, fresh)
            known[fresh[0]] = fresh
        if len(known) > 32:
            return False
    return True

def verified_group_members(group):
    """Scoped membership only. A group number alone never authorizes a signal."""
    global ownership_failed
    try:
        timeout = .2 if cleanup_until is None else min(.2, cleanup_until - time.monotonic())
        if timeout <= 0:
            raise TimeoutError()
        query = subprocess.run(['pgrep', '-g', str(group)], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, timeout=timeout, check=False)
        if query.returncode not in (0, 1) or query.returncode == 1 and query.stdout:
            raise ValueError()
        members = {}
        member_ids = {int(value) for value in query.stdout.split()}
        if len(member_ids) > 32 or query.returncode == 0 and not member_ids:
            raise ValueError()
        if not member_ids:
            return {}
        # Leader identity is sampled last, immediately before group authorization.
        for member in sorted(member_ids, key=lambda value: value == group):
            record = known.get(member)
            if record is None or member in absent or member != pid and proofs.get(member) is None:
                raise ValueError()
            current = metadata(member)
            if not identity_matches(record, current) or current[2] != group:
                raise ValueError()
            note_group_change(record, current)
            known[member] = current
            members[member] = current
        timeout = .2 if cleanup_until is None else min(.2, cleanup_until - time.monotonic())
        if timeout <= 0:
            raise TimeoutError()
        after = subprocess.run(['pgrep', '-g', str(group)], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, timeout=timeout, check=False)
        if after.returncode not in (0, 1) or after.returncode == 1 and after.stdout or {int(value) for value in after.stdout.split()} != member_ids:
            raise ValueError()
        return members
    except (OSError, subprocess.SubprocessError, ValueError):
        ownership_failed = True
        return None

def group_exists(group):
    try:
        os.killpg(group, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

ack_read, ack_write = os.pipe()
pid, master = pty.fork()
if pid == 0:
    try:
        os.close(ack_read)
        tty = os.open('/dev/tty', os.O_RDWR)
        os.close(tty)
        os.write(ack_write, b'TTY')
        os.close(ack_write)
        os.chdir(cfg['cwd'])
        os.execv(cfg['command'], [cfg['command']] + cfg['args'])
    except BaseException:
        os._exit(121)
root_exit = None
status = 'failed'
termination_cause = 'owner_error'
coverage = False
tty_verified = False
try:
    # Every fallible parent setup/ack/emission after fork is under cleanup.
    root = metadata(pid)
    if root:
        known[pid] = root
        proofs[pid] = None  # Direct unreaped fork child, not inferred ancestry.
    groups.add(pid)
    os.close(ack_write)
    ready = select.select([ack_read], [], [], 1)[0]
    tty_verified = bool(ready and os.read(ack_read, 3) == b'TTY')
    os.close(ack_read)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', cfg.get('rows', 24), cfg.get('columns', 80), 0, 0))
    emit({'type': 'spawn', 'pid': pid, 'controllingTerminal': tty_verified})
    status = 'completed'
    coverage = bool(root and tty_verified)
    while True:
        coverage = discover() and coverage
        ended, result = os.waitpid(pid, os.WNOHANG)
        if ended:
            root_exit = os.waitstatus_to_exitcode(result)
            status = 'completed' if root_exit == 0 else 'failed'
            termination_cause = 'root_exit'
            break
        if time.monotonic() >= deadline:
            status = 'timed_out'
            termination_cause = 'deadline'
            break
        readable = select.select([master, 0, 3], [], [], .02)[0]
        if 3 in readable:
            # Explicit stop AND parent death/pipe EOF both terminate the native.
            os.read(3, 32)
            status = 'stopped'
            termination_cause = 'control'
            break
        if 0 in readable:
            data = os.read(0, 4096)
            if data:
                os.write(master, data)
        if master in readable:
            try:
                data = os.read(master, 65536)
                if data:
                    os.write(1, data)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
except BaseException:
    status = 'failed'
    termination_cause = 'owner_error'
    coverage = False
finally:
    cleanup_started = time.monotonic()
    cleanup_until = cleanup_started + cfg['terminationMs'] / 1000
    coverage = discover() and coverage
    def reap():
        global root_exit
        if root_exit is None:
            ended, result = os.waitpid(pid, os.WNOHANG)
            if ended:
                root_exit = os.waitstatus_to_exitcode(result)
    def send(sig):
        global escape_seen, ownership_failed
        signaled = set()
        # Every current group member must have independently established ownership.
        # A missing leader permits individual identity-checked signals only.
        for group in list(groups):
            members = verified_group_members(group)
            if not members:
                continue
            if group in members:
                try:
                    os.killpg(group, sig)
                    signaled.update(members)
                except OSError:
                    pass
            else:
                for member in members:
                    try:
                        os.kill(member, sig)
                        signaled.add(member)
                    except OSError:
                        pass
        for record in list(known.values()):
            if record[0] in signaled or record[0] in absent:
                continue
            current = metadata(record[0])
            if current is not None and not identity_matches(record, current):
                ownership_failed = True
            if identity_matches(record, current):
                note_group_change(record, current)
                known[record[0]] = current
                escape_seen = escape_seen or current[2] != pid
                try:
                    os.kill(record[0], sig)
                    signaled.add(record[0])
                except OSError:
                    pass
        # The unreaped fork child cannot have its PID reused. Metadata loss permits
        # this exact individual fallback only, never an unproved group signal.
        if root_exit is None and pid not in signaled:
            try:
                os.kill(pid, sig)
            except OSError:
                pass
        reap()
    until = cleanup_until
    # Discovery and TERM authorization spend the same grace, not a second clock.
    grace = min(until, cleanup_started + cfg['termGraceMs'] / 1000)
    send(signal.SIGTERM)
    while any(group_exists(g) for g in groups) and time.monotonic() < grace:
        reap()
        time.sleep(.01)
    send(signal.SIGKILL)
    members_absent = False
    while time.monotonic() < until:
        reap()
        if root_exit is not None and not any(group_exists(g) for g in groups):
            members_absent = not any(same(record) for record in known.values())
            if members_absent:
                break
        time.sleep(.01)
    # Reaping is nonblocking and remains necessary even if query work exhausted
    # the polling budget. Exhaustion/query failure can never prove disappearance.
    reap()
    if not members_absent:
        members_absent = not any(same(record) for record in known.values())
    ownership_verified = coverage and not ownership_failed
    verified = ownership_verified and root_exit is not None and not any(group_exists(g) for g in groups) and members_absent and not cleanup_exhausted and time.monotonic() <= until
    escaped = escape_seen
    try:
        emit({'type': 'result', 'status': status if verified else 'failed', 'pid': pid, 'exitCode': root_exit, 'terminationVerified': verified, 'ownershipVerified': ownership_verified, 'controllingTerminal': tty_verified, 'escapedMemberObserved': escaped, 'ownedMembers': len(known), 'terminationCause': termination_cause, 'groupChanges': group_changes, 'groupChangesTruncated': group_changes_truncated})
    except BrokenPipeError:
        pass  # Observer lost; teardown still completed in this independent owner.
    os.close(master)
