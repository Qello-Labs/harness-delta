// Exhaustive global-table oracle. No runtime imports from candidate study modules.
import type { StudyDesign, Label, Rational } from '../../scripts/analysis-validation/contracts.js';
import type { EndpointSchedule, EndpointObservation, EndpointDomain } from '../../scripts/analysis-validation/confidence-contracts.js';
import { oracleDesign, fraction } from './analysis-oracle.js';
export { oracleDesign } from './analysis-oracle.js';
export function oracleTables(n: number, l: number): { id: string; schedule: EndpointSchedule }[] {
  const result: { id: string; schedule: EndpointSchedule }[] = [];
  function visit(digits: number[]) {
    if (digits.length === n * 2) {
      const id = digits.reduce((v, d, i) => v + d * l ** i, 0);
      result.push({ id: String(id), schedule: { potentialA: digits.filter((_, i) => i % 2 === 0), potentialB: digits.filter((_, i) => i % 2 === 1) } });
      return;
    }
    for (let value = 0; value < l; value++) visit([...digits, value]);
  }
  visit([]);
  return result.sort((a, b) => Number(a.id) - Number(b.id));
}
export const oracleTarget = (h: EndpointSchedule): Rational =>
  fraction(h.potentialB.reduce((s, x) => s + BigInt(x), 0n) - h.potentialA.reduce((s, x) => s + BigInt(x), 0n), BigInt(h.potentialA.length));
export const oracleObserved = (h: EndpointSchedule, z: readonly Label[]) => z.map((arm, i) => (arm === 'A' ? h.potentialA[i]! : h.potentialB[i]!));
export function oracleIndex(design: StudyDesign, domain: EndpointDomain) {
  const ids = design.strata.flatMap(s => s.blocks.flatMap(b => b.scheduledTaskIds.slice(0, b.observationMask.filter(Boolean).length)));
  const tables = oracleTables(ids.length, domain.endpoint === 'usage' ? 3 : 2),
    support = oracleDesign(design);
  const index = new Map<string, { observation: EndpointObservation; tables: typeof tables }>();
  for (const table of tables)
    for (const row of support) {
      const values = oracleObserved(table.schedule, row.labels),
        key = `${row.labels.join('')}:${values.join(',')}`;
      let entry = index.get(key);
      if (!entry) {
        entry = { observation: { taskIds: ids, labels: row.labels, values }, tables: [] };
        index.set(key, entry);
      }
      entry.tables.push(table);
    }
  return { tables, support, index };
}

// Build every simple schedule's design tail first, then project/maximize through
// the global observation index. Squared rational discrepancies are independent
// of the candidate's common-denominator absolute-integer calculation.
export function oracleCalibration(design: StudyDesign, domain: EndpointDomain) {
  const data = oracleIndex(design, domain),
    n = data.tables[0]!.schedule.potentialA.length,
    m = domain.endpoint === 'usage' ? 2 : 1;
  const tails = new Map<string, Rational[]>();
  let referenceRows = 0;
  for (const table of data.tables) {
    const target = oracleTarget(table.schedule);
    const deviations = data.support.map(row => {
      const outcomes = oracleObserved(table.schedule, row.labels);
      let positive = 0n,
        negative = 0n;
      row.labels.forEach((arm, i) => {
        if (arm === 'A') negative += BigInt(outcomes[i]!);
        else positive += BigInt(outcomes[i]!);
      });
      const stat = fraction(2n * (positive - negative), BigInt(n));
      const difference = fraction(stat.numerator * target.denominator - target.numerator * stat.denominator, stat.denominator * target.denominator);
      return fraction(difference.numerator ** 2n, difference.denominator ** 2n);
    });
    tails.set(
      table.id,
      deviations.map(actual => {
        let numerator = 0n,
          denominator = 1n;
        data.support.forEach((row, i) => {
          referenceRows++;
          const ref = deviations[i]!;
          if (ref.numerator * actual.denominator >= actual.numerator * ref.denominator) {
            numerator = numerator * row.weight.denominator + row.weight.numerator * denominator;
            denominator *= row.weight.denominator;
            const r = fraction(numerator, denominator);
            numerator = r.numerator;
            denominator = r.denominator;
          }
        });
        return fraction(numerator, denominator);
      })
    );
  }
  const observations = new Map<
    string,
    { observation: EndpointObservation; envelopes: { target: Rational; value: Rational; compatibleCount: number; status: 'evaluated' | 'infeasible_target' }[] }
  >();
  for (const [key, entry] of data.index) {
    const position = data.support.findIndex(x => x.labels.join('') === entry.observation.labels.join(''));
    const envelopes = Array.from({ length: 2 * m * n + 1 }, (_, k) => {
      const target = fraction(BigInt(k - m * n), BigInt(n));
      let value = fraction(0n),
        compatibleCount = 0;
      for (const table of entry.tables) {
        const effect = oracleTarget(table.schedule);
        if (effect.numerator * target.denominator !== target.numerator * effect.denominator) continue;
        compatibleCount++;
        const tail = tails.get(table.id)![position]!;
        if (tail.numerator * value.denominator > value.numerator * tail.denominator) value = tail;
      }
      return { target, value, compatibleCount, status: compatibleCount ? ('evaluated' as const) : ('infeasible_target' as const) };
    });
    observations.set(key, { observation: entry.observation, envelopes });
  }
  return { ...data, observations, referenceRows };
}
export function oracleSet(rows: { target: Rational; value: Rational; compatibleCount: number }[], alpha: Rational) {
  const compatibleValues = rows.filter(x => x.compatibleCount !== 0).map(x => x.target);
  const values = rows.filter(x => alpha.numerator * x.value.denominator < x.value.numerator * alpha.denominator).map(x => x.target);
  function width(v: Rational[]) {
    if (!v.length) return null;
    const left = v[0]!,
      right = v[v.length - 1]!;
    return fraction(right.numerator * left.denominator - left.numerator * right.denominator, left.denominator * right.denominator);
  }
  return {
    values,
    compatibleValues,
    lower: values.length ? values[0]! : null,
    upper: values.length ? values[values.length - 1]! : null,
    reason: values.length ? null : 'empty_confidence_set',
    diagnostics: {
      compatibleTargetCount: compatibleValues.length,
      acceptedTargetCount: values.length,
      removedCompatibleTargetCount: compatibleValues.length - values.length,
      compatibilityHullWidth: width(compatibleValues) ?? fraction(0n),
      confidenceHullWidth: width(values),
      noInferentialNarrowing: values.length === compatibleValues.length
    }
  };
}
