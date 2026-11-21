import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ClaudeWindowBinaryOperation, ClaudeWindowBinaryReader } from '../src/claude-process-binary.js';
import { createClaudeWindowFixture } from './helpers/claude-window-fixture.js';

vi.mock('node:child_process', { spy: true });
const pinCalls = vi.hoisted(() => ({ count: 0, at: 0, effect: (): void => undefined }));
vi.mock('../src/claude-process-binary.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/claude-process-binary.js')>();
  return {
    ...actual,
    ClaudeWindowBinaryReader: class extends actual.ClaudeWindowBinaryReader {
      override snapshot(pid: number) {
        if (++pinCalls.count === pinCalls.at) pinCalls.effect();
        return super.snapshot(pid);
      }
    }
  };
});

type Fixture = ReturnType<typeof createClaudeWindowFixture>;
const fixtures: Fixture[] = [];

beforeEach(() => {
  pinCalls.count = 0;
  pinCalls.at = 0;
  pinCalls.effect = () => undefined;
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('real_process_access_forbidden');
  });
  vi.mocked(spawnSync).mockImplementation(() => {
    throw new Error('real_process_access_forbidden');
  });
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('real_process_access_forbidden');
  });
});

afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function fixture() {
  const f = createClaudeWindowFixture();
  fixtures.push(f);
  f.activate();
  f.life.start(f.taskId);
  return f;
}

test('connect verifies the image once while preserving all six pin boundaries', async () => {
  const f = fixture();
  await f.connect();

  expect(pinCalls.count).toBe(6);
  expect(f.binary.operations.filter(operation => operation === 'signature')).toHaveLength(1);
  expect(f.store.all('SELECT * FROM session_bindings')).toHaveLength(1);
});

test('collect verifies the image once while preserving all four pin boundaries', async () => {
  const f = fixture();
  await f.connect();
  f.advance();
  f.append([f.assistant('measured-request')]);
  f.binary.operations.length = 0;
  pinCalls.count = 0;

  await f.collect();

  expect(pinCalls.count).toBe(4);
  expect(f.binary.operations.filter(operation => operation === 'signature')).toHaveLength(1);
  expect(f.payloads()).toHaveLength(1);
});

test('each new collect verifies the same process image again', async () => {
  const f = fixture();
  await f.connect();
  const verifications: number[] = [];

  for (let operation = 0; operation < 2; operation++) {
    f.binary.operations.length = 0;
    await f.collect();
    verifications.push(f.binary.operations.filter(name => name === 'signature').length);
  }

  expect(verifications).toEqual([1, 1]);
  expect(f.payloads()).toEqual([]);
});

test('image drift at the last connect pin preserves stopped diagnostics without committing baseline usage', async () => {
  const f = fixture();
  f.append([f.assistant('baseline-request')]);
  pinCalls.at = 6;
  pinCalls.effect = () => {
    f.binary.state.inode++;
  };

  await expect(f.connect()).rejects.toThrow('binding_executable_changed');

  expect(pinCalls.count).toBe(6);
  expect(f.store.all('SELECT root_session_id FROM ordinary_window_segments')).toHaveLength(1);
  expect(f.store.all('SELECT state,cursor FROM session_bindings')).toEqual([{ state: 'stopped', cursor: null }]);
  expect(f.store.all('SELECT state FROM binding_root_segments')).toEqual([{ state: 'paused' }]);
  expect(f.store.all('SELECT * FROM binding_requests')).toEqual([]);
  expect(f.store.all('SELECT * FROM binding_baseline_exclusions')).toEqual([]);
  expect(f.payloads()).toEqual([]);
});

test.each((['snapshot', 'revalidate'] as const).flatMap(method => ['binding_scope_revoked', 'binding_window_trial_expired'].map(code => ({ method, code }))))(
  'cached $method checks $code before using a pin and poisons the operation',
  ({ method, code }) => {
    const f = fixture();
    const operation = new ClaudeWindowBinaryOperation();
    let active = true;
    const options = {
      adapters: f.binary.adapters,
      operation,
      assertAuthorized: () => {
        if (!active) throw new Error(code);
      }
    };
    const reader = new ClaudeWindowBinaryReader(options);
    const pin = reader.snapshot(3107);
    const nativeCalls = f.binary.operations.length;
    active = false;

    expect(() => ({ snapshot: () => reader.snapshot(3107), revalidate: () => reader.revalidate(pin) })[method]()).toThrow(code);

    active = true;
    expect(() => new ClaudeWindowBinaryReader(options).snapshot(3107)).toThrow('binding_executable_changed');
    expect(f.binary.operations).toHaveLength(nativeCalls);
  }
);

test('one stopped reader prevents another reader from reusing the operation pin', () => {
  const f = fixture();
  const operation = new ClaudeWindowBinaryOperation();
  const options = { adapters: f.binary.adapters, operation, assertAuthorized: () => undefined };
  const first = new ClaudeWindowBinaryReader(options);
  first.snapshot(3107);
  f.binary.state.inode++;

  expect(() => first.snapshot(3107)).toThrow('binding_executable_changed');

  const nativeCalls = f.binary.operations.length;
  expect(() => new ClaudeWindowBinaryReader(options).snapshot(3107)).toThrow('binding_executable_changed');
  expect(f.binary.operations).toHaveLength(nativeCalls);
  expect(f.binary.operations.filter(name => name === 'signature')).toHaveLength(1);
});
