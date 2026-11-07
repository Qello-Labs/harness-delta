import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import type { ChildReadinessObservation } from '../../src/binding/binding-child-readiness.js';

async function fixture() {
  const module = await import('../../src/qualification/binding-readiness-probe.js').catch(() => null);
  expect(module, 'approved private acknowledgment channel is not implemented').not.toBeNull();
  const root = mkdtempSync(join(tmpdir(), 'hd-synthetic-readiness-channel-'));
  const directory = join(root, 'channel');
  mkdirSync(directory, { mode: 0o700 });
  const instanceId = randomUUID();
  const receiptId = randomUUID();
  const attemptId = randomUUID();
  const recordedAt = new Date().toISOString();
  const selection = { taskId: randomUUID(), rootSessionId: randomUUID(), generation: 1 };
  const event: ChildReadinessObservation = {
    phase: 'hold_entered',
    attemptId,
    ...selection,
    starts: [{ receiptId, agentId: 'synthetic', recordedAt }],
    elapsedMs: 0,
    deadline: new Date(Date.parse(recordedAt) + 2000).toISOString(),
    boundary: null
  };
  let active = true;
  const sink = module!.createReadinessProbeSink({ directory, instanceId, selection, currentScope: () => active });
  const waiting = { directory, instanceId, receiptId, recordedAt, generation: 1, currentScope: () => active };
  return {
    ...module!,
    root,
    directory,
    instanceId,
    receiptId,
    attemptId,
    recordedAt,
    selection,
    event,
    sink,
    waiting,
    setActive: (value: boolean) => {
      active = value;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

test('only the matching single-use receipt and observer instance releases the selected Start hook', async () => {
  const f = await fixture();
  try {
    f.sink(f.event);
    const result = await f.waitForReadinessProbeHold(f.waiting);
    expect(result.status).toBe('acknowledged');
    expect(result.attemptId).toBe(f.attemptId);
    expect((await f.waitForReadinessProbeHold(f.waiting)).status).toBe('inconclusive');
    f.sink({ ...f.event, phase: 'rebaseline_complete', elapsedMs: 30, boundary: new Date(Date.parse(f.recordedAt) + 30).toISOString() });
    const record = JSON.parse(readFileSync(join(f.directory, f.receiptId + '.complete.json'), 'utf8')) as Record<string, unknown>;
    expect(record.phase).toBe('rebaseline_complete');
    expect(JSON.stringify(record)).not.toContain('synthetic');
    expect(JSON.stringify(record)).not.toContain(f.selection.taskId);
    expect(JSON.stringify(record)).not.toContain(f.selection.rootSessionId);
    expect(Object.keys(record).sort()).toEqual(
      ['attempt_id', 'boundary', 'deadline', 'elapsed_ms', 'generation', 'instance_id', 'phase', 'schema_version'].sort()
    );
  } finally {
    f.cleanup();
  }
});

test.each(['observer', 'generation', 'deadline'] as const)('mismatched %s acknowledgment cannot release the hook', async mismatch => {
  const f = await fixture();
  try {
    f.sink(f.event);
    const options = {
      ...f.waiting,
      ...(mismatch === 'observer'
        ? { instanceId: randomUUID() }
        : mismatch === 'generation'
          ? { generation: 2 }
          : { recordedAt: new Date(Date.parse(f.recordedAt) - 10000).toISOString() })
    };
    expect((await f.waitForReadinessProbeHold(options)).status).toBe('inconclusive');
  } finally {
    f.cleanup();
  }
});

test('foreign, multiple, inactive and malformed observations produce no acknowledgment', async () => {
  const f = await fixture();
  try {
    f.sink({ ...f.event, taskId: randomUUID() });
    f.sink({ ...f.event, starts: [...f.event.starts, { ...f.event.starts[0]!, receiptId: randomUUID() }] });
    f.sink({ ...f.event, elapsedMs: Infinity });
    f.setActive(false);
    f.sink(f.event);
    expect(existsSync(join(f.directory, f.receiptId + '.hold.json'))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test.each(['symbolic', 'hard', 'corrupt'] as const)('unsafe %s acknowledgment releases inconclusively without altering it', async fault => {
  const f = await fixture();
  try {
    f.sink(f.event);
    const ack = join(f.directory, f.receiptId + '.hold.json');
    const original = readFileSync(ack);
    if (fault === 'symbolic') {
      rmSync(ack);
      writeFileSync(join(f.root, 'target'), original, { mode: 0o600 });
      symlinkSync(join(f.root, 'target'), ack);
    }
    if (fault === 'hard') linkSync(ack, join(f.root, 'linked'));
    if (fault === 'corrupt') writeFileSync(ack, '{', { mode: 0o600 });
    expect((await f.waitForReadinessProbeHold(f.waiting)).status).toBe('inconclusive');
    expect(readFileSync(ack)).toEqual(fault === 'corrupt' ? Buffer.from('{') : original);
  } finally {
    f.cleanup();
  }
});

test('absent acknowledgment has a finite hook-release budget and scope revocation releases immediately', async () => {
  const f = await fixture();
  try {
    const began = performance.now();
    expect((await f.waitForReadinessProbeHold({ ...f.waiting, maxWaitMs: 40 })).status).toBe('inconclusive');
    expect(performance.now() - began).toBeGreaterThanOrEqual(35);
    expect(performance.now() - began).toBeLessThan(500);
    const other = { ...f.waiting, receiptId: randomUUID() };
    const waiting = f.waitForReadinessProbeHold(other);
    await delay(20);
    f.setActive(false);
    expect((await waiting).status).toBe('inconclusive');
  } finally {
    f.cleanup();
  }
});

test('the maximum requested wait is capped at 500 ms without renewing callback budgets', async () => {
  const f = await fixture();
  const budgets: number[] = [];
  try {
    const began = performance.now();
    const result = await f.waitForReadinessProbeHold({
      ...f.waiting,
      maxWaitMs: 10000,
      currentScope: remaining => {
        budgets.push(remaining ?? Infinity);
        return true;
      }
    });
    expect(result.status).toBe('inconclusive');
    expect(performance.now() - began).toBeGreaterThanOrEqual(450);
    expect(performance.now() - began).toBeLessThan(1000);
    expect(budgets.length).toBeGreaterThan(2);
    expect(budgets.every((value, index) => value <= 500 && (index === 0 || value <= budgets[index - 1]!))).toBe(true);
  } finally {
    f.cleanup();
  }
});

test('a different attempt, revoked scope or replaced channel cannot produce completion evidence', async () => {
  const f = await fixture();
  try {
    f.sink(f.event);
    const completion = { ...f.event, phase: 'rebaseline_complete' as const, elapsedMs: 30, boundary: new Date(Date.parse(f.recordedAt) + 30).toISOString() };
    f.sink({ ...completion, attemptId: randomUUID() });
    f.setActive(false);
    f.sink(completion);
    f.setActive(true);
    expect(existsSync(join(f.directory, f.receiptId + '.complete.json'))).toBe(false);
    renameSync(f.directory, join(f.root, 'original'));
    mkdirSync(f.directory, { mode: 0o700 });
    f.sink(f.event);
    expect(existsSync(join(f.directory, f.receiptId + '.hold.json'))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test('a full channel skips new control evidence without altering existing artifacts', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 8; i++) writeFileSync(join(f.directory, randomUUID() + '.claim'), '{"schema_version":1}', { mode: 0o600 });
    f.sink(f.event);
    expect(existsSync(join(f.directory, f.receiptId + '.hold.json'))).toBe(false);
    expect((await f.waitForReadinessProbeHold(f.waiting)).status).toBe('inconclusive');
  } finally {
    f.cleanup();
  }
});
