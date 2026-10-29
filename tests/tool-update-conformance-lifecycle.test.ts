import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { startOwnedWorker, verifyOwner } from '../scripts/tool-update/conformance.mjs';
import { awaitSupervisor, bounded, observedProcess, repository } from '../scripts/tool-update/fixtures.mjs';
import { fixture } from './tool-update-conformance-fixture.js';

describe('owned synthetic child lifecycle', { concurrent: false }, () => {
  it('accepts only the supervisor terminal and live fd3 channel for a synthetic worker', async () => {
    const root = fixture();
    const code = `import{assertSupervisedWorker}from${JSON.stringify(join(repository, 'scripts/tool-update/fixtures.mjs'))};assertSupervisedWorker();`;
    const launched = observedProcess('/usr/bin/python3', [join(repository, 'scripts/owned-cli-pty.py'), JSON.stringify({
      command: realpathSync(process.execPath), args: ['--input-type=module', '-e', code],
      cwd: root, durationMs: 5000, terminationMs: 3000, termGraceMs: 100,
    })], { cwd: root, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    let protocol = '';
    launched.child.stdout?.resume();
    launched.child.stderr?.on('data', (bytes: Buffer) => { protocol += bytes.toString(); });
    const control = launched.child.stdio[3];
    try {
      const exit = await bounded(launched.closed, 9000);
      const result: unknown = JSON.parse(protocol.trim().split('\n').at(-1) ?? '{}');
      expect(verifyOwner(result, exit).tracked_identities_gone).toBe(true);
    } finally { if (control instanceof Writable) control.end(); }
  }, 10000);
  it('rejects a direct synthetic worker without supervisor channels', async () => {
    const code = `import{assertSupervisedWorker,safeCode}from${JSON.stringify(join(repository, 'scripts/tool-update/fixtures.mjs'))};try{assertSupervisedWorker()}catch(error){process.stdout.write(safeCode(error));process.exitCode=1}`;
    const launched = observedProcess(realpathSync(process.execPath), ['--input-type=module', '-e', code]);
    let stdout = '';
    launched.child.stdout?.on('data', (bytes: Buffer) => { stdout += bytes.toString(); });
    expect((await bounded(launched.closed, 3000))[0]).toBe(1);
    expect(stdout).toBe('ownership_invalid');
  });
  it('subscribes to close before a short synthetic child is launched', async () => {
    const launched = observedProcess(realpathSync(process.execPath), ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    expect((await bounded(launched.closed, 3000))[0]).toBe(0);
  });
  it('fails acceptance when body success lacks tracked disappearance proof', () => {
    expect(() => verifyOwner({ status: 'completed', exitCode: 0, ownershipVerified: true,
      terminationVerified: false, controllingTerminal: true, ownedMembers: 1 }, [0, null])).toThrow('cleanup_unverified');
  });
  it('rejects partial initialization without a controlling-terminal ownership result', () => {
    expect(() => verifyOwner({ status: 'completed', exitCode: 0, ownershipVerified: true,
      terminationVerified: true, controllingTerminal: false, ownedMembers: 1 }, [0, null])).toThrow('cleanup_unverified');
  });
  it('closes fd3 on observer loss and reclaims a synthetic child', async () => {
    const root = fixture();
    const launched = observedProcess('/usr/bin/python3', [join(repository, 'scripts/owned-cli-pty.py'), JSON.stringify({
      command: realpathSync(process.execPath), args: ['-e', 'process.stdin.resume();process.stdout.write("READY\\n");'],
      cwd: root, durationMs: 5000, terminationMs: 3000, termGraceMs: 100,
    })], { cwd: root, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const child = launched.child;
    const control = child.stdio[3];
    if (!child.stdout || !child.stderr || !(control instanceof Writable)) throw new Error('synthetic_stream_missing');
    let protocol = '';
    child.stderr.on('data', (bytes: Buffer) => { protocol += bytes.toString(); });
    const ready = once(child.stdout, 'data');
    try { await bounded(ready, 2000); control.end(); await bounded(launched.closed, 5000); }
    finally { control.end(); }
    const result: unknown = JSON.parse(protocol.trim().split('\n').at(-1) ?? '{}');
    expect(result).toMatchObject({ status: 'stopped', terminationCause: 'control', ownershipVerified: true, terminationVerified: true });
  }, 10000);
  it('fails closed and closes control when worker output is not the metadata protocol', async () => {
    const root = fixture();
    const owner = startOwnedWorker({ command: realpathSync(process.execPath),
      args: ['-e', 'process.stdin.resume();process.stdout.write("SYNTHETIC-PRIVATE-NOT-JSON\\n");'],
      cwd: root, durationMs: 5000, terminationMs: 3000, termGraceMs: 100 });
    let protocol = '';
    owner.child.stderr?.on('data', (bytes: Buffer) => { protocol += bytes.toString(); });
    await expect(owner.completed).rejects.toThrow('observer_lost');
    const result: unknown = JSON.parse(protocol.trim().split('\n').at(-1) ?? '{}');
    expect(result).toMatchObject({ terminationCause: 'control', ownershipVerified: true, terminationVerified: true });
  }, 10000);
  it('retains a validated worker failure code after verified cleanup', async () => {
    const root = fixture();
    const owner = startOwnedWorker({ command: realpathSync(process.execPath),
      args: ['-e', 'process.stdout.write(JSON.stringify({kind:"failure",code:"collector_mismatch"})+"\\n");process.exitCode=1;'],
      cwd: root, durationMs: 5000, terminationMs: 3000, termGraceMs: 100 });
    await expect(owner.completed).rejects.toThrow('collector_mismatch');
  }, 10000);
  it('kills and awaits an exact supervisor stand-in that ignores fd3 after the watchdog', async () => {
    let ready: Promise<unknown> | undefined;
    const launched = observedProcess(realpathSync(process.execPath), ['-e',
      'process.on("message",()=>{});process.send({ready:true});'],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ipc'] }, child => { ready = once(child, 'message'); });
    if (!ready) throw new Error('synthetic_readiness_missing');
    await bounded(ready, 2000);
    try {
      await expect(awaitSupervisor(launched, 1, 100)).rejects.toThrow('cleanup_unverified');
      expect((await bounded(launched.closed, 2000))[1]).toBe('SIGKILL');
    } finally {
      if (launched.child.exitCode === null && launched.child.signalCode === null) launched.child.kill('SIGKILL');
      await bounded(launched.closed, 2000);
    }
  });
  it('reclaims a known descendant after an event-confirmed process group escape', async () => {
    const root = fixture(), supervisor = join(root, 'owner.py');
    // Instrument metadata already observed by the unchanged ownership algorithm.
    // These subscriptions replace timing guesses; they grant no extra ownership.
    const original = readFileSync(join(repository, 'scripts/owned-cli-pty.py'), 'utf8');
    const admission = '            known[fresh[0]] = fresh';
    const escape = '    escape_seen = escape_seen or current[2] != pid';
    expect(original.includes(admission) && original.includes(escape)).toBe(true);
    writeFileSync(supervisor, original.replace(admission,
      admission + "\n            emit({'type': 'synthetic_owned', 'pid': fresh[0]})").replace(escape,
      escape + "\n    if current[2] != pid: emit({'type': 'synthetic_escape'})"));
    const payload = `import os,signal,sys
read_fd,write_fd=os.pipe()
child=os.fork()
if child==0:
 os.close(write_fd)
 os.read(read_fd,1)
 os.setpgid(0,0)
 signal.pause()
 os._exit(0)
os.close(read_fd)
sys.stdin.readline()
os.write(write_fd,b'1')
sys.stdin.readline()
os._exit(0)
`;
    const launched = observedProcess('/usr/bin/python3', [supervisor, JSON.stringify({
      command: '/usr/bin/python3', args: ['-u', '-c', payload], cwd: root,
      durationMs: 7000, terminationMs: 5000, termGraceMs: 300,
    })], { cwd: root, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] },
    child => child.once('spawn', () => {
      let pending = '', sent = false;
      child.stderr?.on('data', (bytes: Buffer) => {
        pending += bytes.toString();
        let index;
        while ((index = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, index); pending = pending.slice(index + 1);
          const row: unknown = JSON.parse(line);
          if (typeof row !== 'object' || row === null || !('type' in row)) return;
          if (row.type === 'synthetic_owned' && !sent) { sent = true; child.stdin?.write('escape\n'); }
          if (row.type === 'synthetic_escape') child.stdin?.write('quit\n');
        }
      });
    }));
    const control = launched.child.stdio[3];
    let protocol = '';
    launched.child.stdout?.resume();
    launched.child.stderr?.on('data', (bytes: Buffer) => { protocol += bytes.toString(); });
    try { await bounded(launched.closed, 14000); }
    finally { if (control instanceof Writable) control.end(); }
    const result: unknown = JSON.parse(protocol.trim().split('\n').at(-1) ?? '{}');
    expect(result, protocol).toMatchObject({ terminationCause: 'root_exit', escapedMemberObserved: true,
      ownershipVerified: true, terminationVerified: true, ownedMembers: 2 });
  }, 16000);
});
