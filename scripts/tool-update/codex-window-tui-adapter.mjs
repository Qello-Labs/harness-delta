import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownedWindowDirectory, WindowConformanceError, windowRequire } from './codex-window-conformance.mjs';
import { hashFile } from './fixtures.mjs';

const repository = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const owner = join(repository, 'scripts/owned-cli-pty.py');
const helper = join(repository, 'tests/helpers/codex-window-tui-child.mjs');
const adapter = fileURLToPath(import.meta.url);
const signalHelper = join(repository, 'scripts/tool-update/codex-window-signal.py');
const inputBytes = Buffer.from('synthetic-window-input');
const secondInputBytes = Buffer.from('synthetic-window-input-2');
const submitBytes = Buffer.from('\n');
const quitBytes = Buffer.from('QUIT\n');

function pins(copiedHelper) {
  const local = [owner, helper, adapter, signalHelper, copiedHelper]
    .map(path => {
      const stat = lstatSync(path);
      windowRequire(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1048576, 'pin_drift');
      return createHash('sha256').update(readFileSync(path)).digest('hex');
    })
    .join(':');
  return local + ':' + ['/usr/bin/python3', '/bin/ps', '/usr/bin/pgrep', process.execPath].map(path => hashFile(realpathSync(path))).join(':');
}

export function verifyWindowSignalIdentity(expected, observed) {
  const keys = ['pid', 'parent', 'pgid', 'foreground', 'uid', 'session', 'started'];
  windowRequire(
    expected &&
      observed &&
      keys.every(key => expected[key] === observed[key]) &&
      keys.filter(key => key !== 'started').every(key => Number.isSafeInteger(observed[key])) &&
      observed.pid > 1 &&
      observed.parent > 1 &&
      observed.pgid === observed.pid &&
      observed.session === observed.pid &&
      observed.foreground === observed.pgid &&
      typeof observed.started === 'string' &&
      observed.started.length <= 128,
    'signal_identity_unproven'
  );
}

function signalGuardian(action, input, root) {
  return new Promise((resolveResult, reject) => {
    const child = execFile(
      '/usr/bin/python3',
      [signalHelper, action],
      {
        cwd: root,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: root,
          TMPDIR: root,
          LC_ALL: 'C',
          TZ: 'UTC'
        },
        timeout: 2500,
        maxBuffer: 8192,
        encoding: 'utf8'
      },
      (error, stdout) => {
        if (error) {
          reject(new WindowConformanceError('signal_identity_unproven'));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          verifyWindowSignalIdentity(result.identity, result.identity);
          windowRequire(result.signal_sent === (action === 'signal'), 'signal_identity_unproven');
          resolveResult(result);
        } catch {
          reject(new WindowConformanceError('signal_identity_unproven'));
        }
      }
    );
    child.stdin.end(JSON.stringify(input));
  });
}

export function startWindowTui() {
  throw new WindowConformanceError('b1_execution_disabled');
}

function observeOwner(child, state, events, finish) {
  let protocol = '',
    output = '',
    metadataBytes = 0,
    outputBytes = 0;
  const failure = code => {
    state.failure ??= code;
    child.stdio[3].end();
  };
  child.stdout.on('data', bytes => {
    outputBytes += bytes.length;
    if (outputBytes > 65536) {
      failure('output_limit');
      return;
    }
    output += bytes.toString('utf8');
    let index;
    while ((index = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, index).replace(/\r$/, '');
      output = output.slice(index + 1);
      if (line === 'READY' && !state.ready) {
        state.ready = true;
        events.emit('ready');
      } else if (line === 'INPUT_OK' && state.submitted && !state.inputObserved) {
        state.inputObserved = true;
        events.emit('input');
      } else if (line === 'INPUT_2_OK' && state.secondPhase === 'submitted') {
        state.secondPhase = 'observed';
        events.emit('second_input');
      } else if (line === 'INTERRUPTED_OK' && state.signalRequested && !state.interruptionObserved) {
        state.interruptionObserved = true;
        events.emit('interrupted');
      } else failure('synthetic_output_invalid');
    }
    if (output.length > 128) failure('output_limit');
  });
  child.stderr.on('data', bytes => {
    metadataBytes += bytes.length;
    if (metadataBytes > 65536) {
      failure('metadata_limit');
      return;
    }
    protocol += bytes.toString('utf8');
    let index;
    while ((index = protocol.indexOf('\n')) >= 0) {
      const line = protocol.slice(0, index);
      protocol = protocol.slice(index + 1);
      try {
        const record = JSON.parse(line);
        if (record.type === 'spawn' && !state.spawned) {
          windowRequire(Number.isSafeInteger(record.pid) && record.pid > 0 && record.controllingTerminal === true, 'owner_invalid');
          state.spawned = true;
          state.identity = signalGuardian(
            'inspect',
            {
              pid: record.pid,
              parent: child.pid
            },
            state.root
          )
            .then(result => {
              events.emit('signal_ready');
              return result.identity;
            })
            .catch(() => undefined);
        } else if (record.type === 'result' && !state.result) {
          state.result = record;
        } else failure('owner_invalid');
      } catch {
        failure('owner_invalid');
      }
    }
  });
  child.once('error', () => finish(new WindowConformanceError('owner_unavailable')));
  child.once('close', code => {
    const result = state.result;
    const verified =
      result?.ownershipVerified === true &&
      result.terminationVerified === true &&
      result.controllingTerminal === true &&
      result.escapedMemberObserved === false &&
      Number.isSafeInteger(result.ownedMembers) &&
      result.ownedMembers === 1;
    if (!verified || code !== 0 || protocol !== '' || output !== '') {
      finish(new WindowConformanceError('cleanup_unverified'));
    } else if (state.failure) {
      finish(new WindowConformanceError(state.failure));
    } else {
      finish(null, {
        origin: 'synthetic',
        actual_qualification: false,
        normal_quit: state.quit && result.terminationCause === 'root_exit' && result.exitCode === 0,
        signal_sent: state.signalSent,
        interruption_observed: state.interruptionObserved,
        ownership_verified: true,
        identities_gone: true,
        termination_cause: result.terminationCause
      });
    }
  });
  for (const stream of [child.stdin, child.stdout, child.stderr, child.stdio[3]]) {
    stream.on('error', () => failure('observer_lost'));
  }
}

function writeInput(child, bytes) {
  return new Promise((resolve, reject) => {
    child.stdin.write(bytes, error => {
      if (error) reject(new WindowConformanceError('input_failed'));
      else resolve();
    });
  });
}

export function createSyntheticWindowTui(root) {
  ownedWindowDirectory(root);
  const copiedHelper = join(root, 'tui-fixture.mjs');
  writeFileSync(copiedHelper, readFileSync(helper), {
    flag: 'wx',
    mode: 0o600
  });
  const frozen = pins(copiedHelper);
  const events = new EventEmitter();
  const state = {
    ready: false,
    baseline: false,
    submitted: false,
    inputObserved: false,
    secondPhase: 'unarmed',
    quit: false,
    stopped: false,
    root,
    signalRequested: false,
    signalSent: false,
    interruptionObserved: false
  };
  let child, timer, finish;
  const completed = new Promise((resolve, reject) => {
    finish = (error, value) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
  });
  const live = () => windowRequire(child && !state.stopped && !state.result, 'case_stopped');
  const stop = () => {
    state.stopped = true;
    child?.stdio[3].end();
  };
  return Object.freeze({
    events,
    completed,
    start() {
      windowRequire(!child, 'reservation_reused');
      windowRequire(pins(copiedHelper) === frozen, 'pin_drift');
      const config = {
        command: process.execPath,
        args: [copiedHelper],
        cwd: root,
        durationMs: 10000,
        terminationMs: 5000,
        termGraceMs: 2000,
        rows: 24,
        columns: 80
      };
      child = spawn('/usr/bin/python3', [owner, JSON.stringify(config)], {
        cwd: root,
        env: {
          PATH: '/usr/bin:/bin',
          LC_ALL: 'C',
          TZ: 'UTC',
          HOME: root,
          TMPDIR: root
        },
        stdio: ['pipe', 'pipe', 'pipe', 'pipe']
      });
      observeOwner(child, state, events, finish);
      timer = setTimeout(() => {
        stop();
        finish(new WindowConformanceError('cleanup_unverified'));
      }, 15500);
    },
    releaseSyntheticBaseline() {
      live();
      windowRequire(state.ready && !state.baseline, 'baseline_missing');
      state.baseline = true;
    },
    releaseSyntheticSecondInput() {
      live();
      windowRequire(state.inputObserved && state.secondPhase === 'unarmed' && !state.signalRequested && !state.quit, 'completion_missing');
      state.secondPhase = 'armed';
    },
    async submit() {
      live();
      windowRequire(state.baseline, 'baseline_missing');
      windowRequire(!state.submitted || state.secondPhase === 'armed', 'input_reused');
      const bytes = state.submitted ? secondInputBytes : inputBytes;
      if (state.submitted) state.secondPhase = 'submitted';
      state.submitted = true;
      try {
        await writeInput(child, Buffer.concat([bytes, submitBytes]));
        live();
      } catch (error) {
        stop();
        throw error;
      }
    },
    async quit() {
      live();
      windowRequire(state.inputObserved && state.secondPhase !== 'submitted' && !state.quit, 'completion_missing');
      state.quit = true;
      try {
        await writeInput(child, quitBytes);
      } catch (error) {
        stop();
        throw error;
      }
    },
    interrupt() {
      live();
      windowRequire(!state.signalRequested, 'signal_reused');
      windowRequire(state.baseline && state.inputObserved && state.identity, 'signal_identity_unproven');
      windowRequire(pins(copiedHelper) === frozen, 'pin_drift');
      state.signalRequested = true;
      return (async () => {
        try {
          const expected = await state.identity;
          windowRequire(expected, 'signal_identity_unproven');
          // The signal action revalidates the frozen identity before delivery.
          const sent = await signalGuardian('signal', expected, root);
          verifyWindowSignalIdentity(expected, sent.identity);
          state.signalSent = sent.signal_sent;
        } catch (error) {
          stop();
          throw error;
        }
      })();
    },
    stop
  });
}
