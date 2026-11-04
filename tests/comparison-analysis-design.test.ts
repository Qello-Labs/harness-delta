import { expect, test } from 'vitest';
import { enumerateDesign } from '../scripts/analysis-validation/design.js';
const design = (b: number, r: number) => ({
  blockSize: b as StudyDesign['blockSize'],
  strata: [
    {
      stratumId: 'z',
      blocks: [{ blockId: 'z', scheduledTaskIds: Array.from({ length: b }, (_, i) => `t${i}`), observationMask: Array.from({ length: b }, (_, i) => i < r) }]
    }
  ]
});
test('induced b4 r2 prefix law retains unequal completion multiplicities', () => {
  expect(enumerateDesign(design(4, 2))).toEqual([
    { labels: ['A', 'A'], weight: { numerator: 1n, denominator: 6n } },
    { labels: ['A', 'B'], weight: { numerator: 1n, denominator: 3n } },
    { labels: ['B', 'A'], weight: { numerator: 1n, denominator: 3n } },
    { labels: ['B', 'B'], weight: { numerator: 1n, denominator: 6n } }
  ]);
});
test('invalid designs reject with stable codes', () => {
  expect(() => enumerateDesign(design(3, 2))).toThrow('invalid_design');
  const gap = design(4, 2);
  gap.strata[0]!.blocks[0]!.observationMask = [true, false, true, false];
  expect(() => enumerateDesign(gap)).toThrow('non_prefix');
});

import { oracleDesign, fullWords } from './helpers/analysis-oracle.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { assignTask } from '../src/allocation.js';
import { freezeProtocol, registerProtocol, registerVariant } from '../src/comparison.js';
import { assignmentInput, assignmentTime, beforeRecruitment, protocol, seedProject, variantA, variantB } from './helpers/comparison-fixture.js';
import type { StudyDesign } from '../scripts/analysis-validation/contracts.js';
const pair = (b: number, r: number, sameStratum = true): StudyDesign => {
  const first = design(b, b),
    second = design(b, r).strata[0]!;
  second.stratumId = 'a';
  second.blocks[0]!.blockId = 'a';
  second.blocks[0]!.scheduledTaskIds = second.blocks[0]!.scheduledTaskIds.map(x => `x${x}`);
  if (sameStratum) first.strata[0]!.blocks.push(...second.blocks);
  else first.strata.push(second);
  return first;
};
test('all block sizes and every prefix exactly match independently counted full words', () => {
  for (const b of [2, 4, 6, 8]) for (let r = 0; r <= b; r++) expect(enumerateDesign(design(b, r))).toEqual(oracleDesign(design(b, r)));
  expect(enumerateDesign(design(4, 3)).some(row => row.labels.join('') === 'AAA')).toBe(false);
  expect(enumerateDesign(design(2, 1))).toEqual([
    { labels: ['A'], weight: { numerator: 1n, denominator: 2n } },
    { labels: ['B'], weight: { numerator: 1n, denominator: 2n } }
  ]);
  for (const d of [pair(4, 4), pair(4, 1), pair(4, 2, false)]) expect(enumerateDesign(d)).toEqual(oracleDesign(d));
  expect(enumerateDesign(pair(4, 4))).toHaveLength(36);
  const different = pair(4, 2, false);
  different.strata[0]!.blocks[0]!.observationMask = [true, false, false, false];
  expect(enumerateDesign(different)).toEqual(oracleDesign(different));
});
test('bounds reject full queue and tail work separately; identities and layout cannot be inferred', () => {
  expect(() => enumerateDesign(pair(8, 0))).toThrow('resource_limit');
  expect(() => enumerateDesign(pair(6, 6))).toThrow('operation_limit');
  const duplicate = pair(4, 1);
  duplicate.strata[0]!.blocks[1]!.scheduledTaskIds[0] = 't0';
  expect(() => enumerateDesign(duplicate)).toThrow('duplicate_id');
  const order = pair(4, 1);
  order.strata[0]!.blocks.reverse();
  expect(() => enumerateDesign(order)).toThrow('invalid_block_order');
  expect(() => enumerateDesign({ ...design(4, 2), order: 'unknown' })).toThrow('invalid_design');
  expect(() => enumerateDesign({ ...design(4, 2), strata: [] })).toThrow('invalid_design');
});
// This exhaustive restart check creates 98 SQLite databases; CI filesystem
// latency needs a separate budget without reducing the oracle coverage.
test('each oracle full queue matches committed receipt order across restart without reading future slots', () => {
  for (const b of [2, 4, 6, 8])
    for (const word of fullWords(b)) {
      const root = mkdtempSync(join(tmpdir(), 'analysis-allocator-')),
        file = join(root, 'synthetic.db');
      let store = new Store(file);
      try {
        seedProject(store);
        registerVariant(store, variantA);
        registerVariant(store, variantB);
        registerProtocol(store, { ...protocol, block_size: b });
        freezeProtocol(store, protocol.id, beforeRecruitment);
        const receipts = [];
        for (let i = 0; i < b; i++) {
          if (i === Math.floor(b / 2)) {
            store.close();
            store = new Store(file);
          }
          const receipt = assignTask(
            store,
            { ...assignmentInput, task_id: `t-${i}`, logical_task_id: `l-${i}` },
            { clock: () => assignmentTime, shuffle: () => word.map(x => (x === 'A' ? 'variant-a' : 'variant-b')) }
          );
          receipts.push(receipt);
          expect(receipt.allocation_index).toBe(i);
          expect(receipt.assigned_variant_id).toBe(word[i] === 'A' ? 'variant-a' : 'variant-b');
          expect(
            store.get<{ allocation_index: number }>('SELECT allocation_index FROM comparison_assignments WHERE task_id=?', [`t-${i}`])?.allocation_index
          ).toBe(i);
        }
        expect(new Set(receipts.map(x => x.block_id)).size).toBe(1);
        expect(JSON.stringify(receipts)).not.toMatch(/pending_variants|future|seed/);
      } finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
}, 20_000);
