import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { Store } from '../../src/store.js';
import { assignmentInput, assignmentTime, beforeRecruitment, protocol, variantA, variantB } from '../helpers/comparison-fixture.js';

test('CLI synthetic assignment to human outcome is durable, with fixture-only usage and no collection bypass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'comparison-cli-'));
  const file = join(root, 'local.db');
  const run = (args: string[]) => main(['--db', file, ...args]);
  const config = (name: string, input: unknown) => {
    const path = join(root, `${name}.json`);
    writeFileSync(path, JSON.stringify(input));
    return path;
  };
  let output = '';
  let errors = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(value => {
    output += String(value);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(value => {
    errors += String(value);
    return true;
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(beforeRecruitment));
  try {
    expect(await run(['project', 'add', 'project-1', '--root', root])).toBe(0);
    expect(await run(['variant', 'register', '--config', config('a', variantA)])).toBe(0);
    expect(await run(['variant', 'register', '--config', config('b', variantB)])).toBe(0);
    expect(await run(['comparison', 'register', '--config', config('protocol', protocol)])).toBe(0);
    expect(await run(['comparison', 'freeze', protocol.id])).toBe(0);
    vi.setSystemTime(new Date(assignmentTime));
    expect(await run(['comparison', 'assign', '--config', config('task', assignmentInput)])).toBe(0);
    const receipt = JSON.parse(output) as { assignment_id: string; assigned_variant_id: string; task_id: string; reused: boolean };
    expect(receipt).toMatchObject({ task_id: 'task-1', reused: false });
    expect(['variant-a', 'variant-b']).toContain(receipt.assigned_variant_id);
    output = '';
    expect(await run(['comparison', 'assign', '--config', join(root, 'task.json')])).toBe(0);
    expect(JSON.parse(output) as unknown).toMatchObject({ assignment_id: receipt.assignment_id, reused: true });
    expect(await run(['task', 'start', 'task-1'])).toBe(2);
    expect(
      await run([
        'task',
        'confirm-config',
        '--config',
        config('confirmation', {
          schema_version: 1,
          id: 'confirmation-1',
          task_id: 'task-1',
          occurred_at: assignmentTime,
          evidence_method: 'self_attested',
          actual_variant_id: receipt.assigned_variant_id,
          product: 'synthetic',
          product_version: '1.0.0',
          model: 'synthetic-model',
          reasoning_setting: 'none',
          environment_id: 'environment-1'
        })
      ])
    ).toBe(0);
    expect(await run(['task', 'start', 'task-1'])).toBe(0);
    const instructionPath = join(root, 'instructions.md');
    writeFileSync(instructionPath, 'SYNTHETIC_INSTRUCTION_SENTINEL');
    expect(
      await run([
        'task',
        'confirm-config',
        '--config',
        config('mechanical', {
          schema_version: 1,
          id: 'mechanical-1',
          task_id: 'task-1',
          evidence_method: 'selected_artifact_hash',
          actual_variant_id: receipt.assigned_variant_id,
          product: 'synthetic',
          product_version: '1.0.0',
          model: 'synthetic-model',
          reasoning_setting: 'none',
          environment_id: 'environment-1'
        }),
        '--artifact',
        `instructions=${instructionPath}`
      ])
    ).toBe(0);
    // Test fixture injection only: the production CLI intentionally cannot link synthetic sources.
    const store = new Store(file);
    try {
      store.execute('INSERT INTO sessions(id,project_id,task_id) VALUES (?,?,?)', ['session-1', 'project-1', 'task-1']);
      store.putEvent({
        id: 'usage-1',
        task_id: 'task-1',
        project_id: 'project-1',
        session_id: 'session-1',
        source_key: 'synthetic:1',
        occurred_at: assignmentTime,
        payload: {
          kind: 'usage',
          product: 'synthetic',
          product_version: '1.0.0',
          model: 'synthetic-model',
          epoch: 'epoch-1',
          input_total: { status: 'observed', value: 100, reason: null },
          cached_input: { status: 'observed', value: 20, reason: null },
          output_total: { status: 'observed', value: 30, reason: null },
          reasoning_output: { status: 'unmeasurable', value: null, reason: 'unsupported' }
        }
      });
    } finally {
      store.close();
    }
    expect(
      await run(['session', 'link', 'not-supported', '--task', 'task-1', '--source', join(root, 'not-read'), '--product', 'synthetic', '--version', '1.0.0'])
    ).toBe(2);
    expect(await run(['task', 'first-complete', 'task-1'])).toBe(0);
    expect(await run(['task', 'assess-first', 'task-1', '--result', 'failed'])).toBe(0);
    expect(await run(['task', 'rework', 'task-1'])).toBe(0);
    expect(await run(['task', 'finalize', 'task-1', '--outcome', 'success', '--met', 'criterion-1'])).toBe(0);
    output = '';
    expect(await run(['report', 'task', 'task-1', '--cutoff', assignmentTime])).toBe(0);
    expect(JSON.parse(output) as unknown).toMatchObject({
      outcome: 'success',
      first_success: false,
      rework_count: 1,
      usage: { partial_tokens: 130, complete_tokens: null },
      cost: null
    });
    expect(output).not.toContain(root);
    output = '';
    expect(await run(['task', 'config-history', 'task-1'])).toBe(0);
    expect(JSON.parse(output) as unknown).toMatchObject({
      assignment_id: receipt.assignment_id,
      confirmations: [{ evidence_method: 'self_attested' }, { evidence_method: 'selected_artifact_hash', verification_status: 'mismatch' }]
    });
    expect(output).not.toContain(root);
    expect(output).not.toContain('SYNTHETIC_INSTRUCTION_SENTINEL');
    output = '';
    expect(await run(['comparison', 'show', protocol.id])).toBe(0);
    expect(output).not.toMatch(/pending_variants|seed|next_index/);
    expect(await run(['delete', 'task', 'task-1'])).toBe(0);
    output = '';
    expect(await run(['comparison', 'show', protocol.id])).toBe(0);
    expect(JSON.parse(output) as unknown).toMatchObject({ status: 'invalidated_by_deletion', real_allocation_enabled: false });
    expect(errors).toBe('configuration_confirmation_required\ninvalid_input\n  at (root): invalid_value\n');
  } finally {
    vi.useRealTimers();
    stdout.mockRestore();
    stderr.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI private fields and arbitrary real readiness flags fail without echoing values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'comparison-cli-private-'));
  const file = join(root, 'local.db');
  let output = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(value => {
    output += String(value);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(value => {
    output += String(value);
    return true;
  });
  try {
    const path = join(root, 'private.json');
    writeFileSync(path, JSON.stringify({ ...variantA, instructions: 'PRIVATE_SENTINEL' }));
    expect(await main(['--db', file, 'variant', 'register', '--config', path])).toBe(2);
    writeFileSync(path, JSON.stringify({ ...protocol, analysis_validated: true }));
    expect(await main(['--db', file, 'comparison', 'register', '--config', path])).toBe(2);
    expect(output).toBe('invalid_comparison_input\ninvalid_comparison_input\n');
    const store = new Store(file);
    try {
      expect(store.all('SELECT * FROM comparison_variants')).toEqual([]);
      expect(store.all('SELECT * FROM comparison_protocols')).toEqual([]);
    } finally {
      store.close();
    }
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
