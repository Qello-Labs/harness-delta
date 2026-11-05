import { buildExchangePackage as build } from '../../src/comparison/exchange/source.js';
import { createTeamSnapshot as create, readTeamSnapshot as read } from '../../src/comparison/reports/team-snapshot.js';
export function buildExchangePackage(...args: Parameters<typeof build>) {
  const p = build(...args);
  if (p.schema_version !== 1) throw new Error('expected_legacy_exchange');
  return p;
}
export function createTeamSnapshot(...args: Parameters<typeof create>) {
  const r = create(...args);
  if (r.schema_version !== 1) throw new Error('expected_legacy_team');
  return r;
}
export function readTeamSnapshot(...args: Parameters<typeof read>) {
  const r = read(...args);
  if (r.schema_version !== 1) throw new Error('expected_legacy_team');
  return r;
}
