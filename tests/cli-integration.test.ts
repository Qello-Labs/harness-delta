import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, vi } from 'vitest';
import { main } from '../src/cli.js';
import { Store } from '../src/store.js';

test('CLI register/link/foreground collect/human outcome/report/delete keeps raw content out', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-flow-'));
  const file = join(root, 'local.db');
  const source = join(root, 'source.jsonl');
  const run = (args: string[]) => main(['--db', file, ...args]);
  let collecting: Promise<number> | undefined;
  try {
    expect(await run(['project', 'add', 'p1', '--root', root])).toBe(0);
    expect(
      await run([
        'task',
        'register',
        't1',
        '--project',
        'p1',
        '--type',
        'feature',
        '--size',
        'small',
        '--assignee',
        'u1',
        '--product',
        'codex',
        '--model',
        'synthetic',
        '--criteria',
        'c1'
      ])
    ).toBe(0);
    expect(await run(['task', 'start', 't1'])).toBe(0);
    writeFileSync(
      source,
      JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: root, source: 'exec', cli_version: '0.156.1', private: 'PRIVATE_SENTINEL' } }) + '\n'
    );
    expect(await run(['session', 'link', 's1', '--task', 't1', '--source', source, '--product', 'codex', '--version', '0.156.1'])).toBe(0);
    collecting = run(['collect', '--task', 't1', '--interval', '100']);
    await delay(30);
    const started = new Date().toISOString();
    const rows = [
      { type: 'event_msg', timestamp: started, payload: { type: 'task_started', turn_id: 'turn1' } },
      { type: 'turn_context', payload: { model: 'synthetic' } },
      {
        type: 'event_msg',
        timestamp: started,
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 30, reasoning_output_tokens: 0 } }
        }
      }
    ];
    appendFileSync(source, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    await delay(180);
    process.emit('SIGINT');
    expect(await collecting).toBe(0);
    collecting = undefined;
    expect(await run(['task', 'first-complete', 't1'])).toBe(0);
    expect(await run(['task', 'assess-first', 't1', '--result', 'success'])).toBe(0);
    expect(await run(['task', 'finalize', 't1', '--outcome', 'success', '--met', 'c1'])).toBe(0);
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(value => {
      output += String(value);
      return true;
    });
    try {
      expect(await run(['report', 'task', 't1', '--cutoff', new Date().toISOString()])).toBe(0);
    } finally {
      write.mockRestore();
    }
    expect(JSON.parse(output) as unknown).toMatchObject({ outcome: 'success', first_success: true, usage: { partial_tokens: 130, complete_tokens: null } });
    expect(output).not.toContain('PRIVATE_SENTINEL');
    expect(output).not.toContain(root);
    const store = new Store(file);
    try {
      expect(JSON.stringify(store.all('SELECT * FROM events'))).not.toContain('PRIVATE_SENTINEL');
      expect(store.eventCount()).toBe(1);
    } finally {
      store.close();
    }
    expect(await run(['delete', 'task', 't1'])).toBe(0);
    const deleted = new Store(file);
    try {
      expect(deleted.eventCount()).toBe(0);
      expect(deleted.get('SELECT id FROM tombstones WHERE kind=? AND id=?', ['task', 't1'])).toBeDefined();
    } finally {
      deleted.close();
    }
  } finally {
    if (collecting) {
      process.emit('SIGINT');
      await collecting;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI rejects an out-of-window session version without a session row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-unregistered-'));
  const file = join(root, 'local.db');
  const run = (args: string[]) => main(['--db', file, ...args]);
  const errors: string[] = [];
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(value => {
    errors.push(String(value));
    return true;
  });
  try {
    expect(await run(['project', 'add', 'p1', '--root', root])).toBe(0);
    expect(
      await run([
        'task',
        'register',
        't1',
        '--project',
        'p1',
        '--type',
        'feature',
        '--size',
        'small',
        '--assignee',
        'u1',
        '--product',
        'codex',
        '--model',
        'synthetic',
        '--criteria',
        'c1'
      ])
    ).toBe(0);
    expect(
      await run([
        'session',
        'link',
        's9',
        '--task',
        't1',
        '--source',
        '/synthetic/does-not-exist-unregistered.jsonl',
        '--product',
        'codex',
        '--version',
        '0.164.0'
      ])
    ).toBe(2);
    expect(errors.join('')).toBe('unsupported\n');
    const store = new Store(file);
    try {
      expect(store.all('SELECT id FROM sessions')).toEqual([]);
    } finally {
      store.close();
    }
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
