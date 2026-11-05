// Independent full-word enumeration and arithmetic. Only structural types are shared.
import type { AssignmentMass, Label, Rational, StudyDesign } from '../../scripts/analysis-validation/contracts.js';
export function fraction(n: bigint, d = 1n): Rational {
  if (d <= 0n) throw new Error('oracle_invalid_fraction');
  const gcd = (x: bigint, y: bigint): bigint => (y === 0n ? x : gcd(y, x % y));
  const g = gcd(n < 0n ? -n : n, d);
  return { numerator: n / g, denominator: d / g };
}
export const oracleAdd = (a: Rational, b: Rational) => fraction(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
export function fullWords(b: number): Label[][] {
  if (![2, 4, 6, 8].includes(b)) throw new Error('oracle_invalid_design');
  const result: Label[][] = [];
  // Enumerate bit masks, not sequential conditional probabilities.
  for (let mask = 0; mask < 2 ** b; mask++) {
    const row: Label[] = Array.from({ length: b }, (_, i) => (mask & (1 << i) ? 'A' : 'B'));
    if (row.filter(x => x === 'A').length === b / 2) result.push(row);
  }
  return result.sort((a, b) => a.join('').localeCompare(b.join('')));
}
export function oracleDesign(design: StudyDesign): AssignmentMass[] {
  if (
    Object.keys(design).sort().join(',') !== 'blockSize,strata' ||
    ![2, 4, 6, 8].includes(design.blockSize) ||
    !Array.isArray(design.strata) ||
    design.strata.length < 1 ||
    design.strata.length > 2
  )
    throw new Error('oracle_invalid_design');
  const ids = new Set<string>(),
    blocks = new Set<string>(),
    strata = new Set<string>();
  let n = 0,
    combos = 1,
    blockCount = 0;
  for (const s of design.strata) {
    if (Object.keys(s).sort().join(',') !== 'blocks,stratumId' || strata.has(s.stratumId) || s.blocks.length < 1) throw new Error('oracle_invalid_design');
    strata.add(s.stratumId);
    for (const [j, b] of s.blocks.entries()) {
      if (
        Object.keys(b).sort().join(',') !== 'blockId,observationMask,scheduledTaskIds' ||
        blocks.has(b.blockId) ||
        b.scheduledTaskIds.length !== design.blockSize ||
        b.observationMask.length !== design.blockSize
      )
        throw new Error('oracle_invalid_design');
      blocks.add(b.blockId);
      let closed = false;
      for (let i = 0; i < design.blockSize; i++) {
        const id = b.scheduledTaskIds[i]!;
        if (typeof id !== 'string' || !id || ids.has(id) || typeof b.observationMask[i] !== 'boolean') throw new Error('oracle_invalid_design');
        ids.add(id);
        if (!b.observationMask[i]) closed = true;
        else {
          if (closed) throw new Error('oracle_invalid_design');
          n++;
        }
      }
      if (closed && j < s.blocks.length - 1) throw new Error('oracle_invalid_design');
      combos *= fullWords(design.blockSize).length;
      blockCount++;
    }
  }
  if (combos > 4096 || n > 16 || blockCount > 4) throw new Error('oracle_resource_limit');
  let full: Label[][] = [[]];
  for (const s of design.strata)
    for (const b of s.blocks) {
      const count = b.observationMask.filter(Boolean).length;
      full = full.flatMap(left => fullWords(design.blockSize).map(word => [...left, ...word.slice(0, count)]));
    }
  const counts = new Map<string, number>();
  for (const row of full) counts.set(row.join(''), (counts.get(row.join('')) ?? 0) + 1);
  if (n * counts.size ** 2 > 1_000_000) throw new Error('oracle_operation_limit');
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => ({ labels: [...key] as Label[], weight: fraction(BigInt(count), BigInt(full.length)) }));
}
export function oracleStatistic(labels: readonly Label[], values: readonly number[]): Rational {
  if (!values.length || labels.length !== values.length || values.some(x => !Number.isSafeInteger(x) || x < 0) || labels.some(x => !['A', 'B'].includes(x)))
    throw new Error('oracle_invalid_outcomes');
  const arms = { A: 0n, B: 0n };
  labels.forEach((arm, i) => {
    arms[arm] += BigInt(values[i]!);
  });
  return fraction(arms.B * 2n - arms.A * 2n, BigInt(values.length));
}
export function oracleRealize(labels: readonly Label[], population: readonly { yA: number; yB: number }[]): number[] {
  if (labels.length !== population.length || labels.some(x => !['A', 'B'].includes(x))) throw new Error('oracle_invalid_outcomes');
  return labels.map((arm, i) => {
    const task = population[i]!;
    if (![task.yA, task.yB].every(x => Number.isSafeInteger(x) && x >= 0)) throw new Error('oracle_invalid_outcomes');
    return arm === 'B' ? task.yB : task.yA;
  });
}
export function oracleTail(rows: readonly AssignmentMass[], values: readonly number[], observed: readonly Label[]): Rational {
  let sum = fraction(0n);
  const keys = new Set<string>();
  for (const row of rows) {
    if (
      row.labels.length !== values.length ||
      row.weight.denominator <= 0n ||
      row.weight.numerator <= 0n ||
      row.weight.numerator > row.weight.denominator ||
      keys.has(row.labels.join(''))
    )
      throw new Error('oracle_invalid_support');
    keys.add(row.labels.join(''));
    sum = oracleAdd(sum, row.weight);
  }
  if (sum.numerator !== sum.denominator || !keys.has(observed.join(''))) throw new Error('oracle_invalid_support');
  const actual = oracleStatistic(observed, values);
  let result = fraction(0n);
  for (const row of rows) {
    const t = oracleStatistic(row.labels, values);
    // Compare squared fractions rather than candidate absolute-value implementation.
    if (t.numerator ** 2n * actual.denominator ** 2n >= actual.numerator ** 2n * t.denominator ** 2n) result = oracleAdd(result, row.weight);
  }
  return result;
}
